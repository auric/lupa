import type * as vscode from 'vscode';
import type { ToolCallMessage } from '../types/modelTypes';
import { TokenConstants } from './tokenConstants';
import { Log } from '../services/loggingService';

/**
 * Result of token validation check
 */
export interface TokenValidationResult {
    /** Total token count of all messages */
    totalTokens: number;
    /** Maximum tokens allowed for this model */
    maxTokens: number;
    /** Whether messages exceed context warning threshold */
    exceedsWarningThreshold: boolean;
    /** Whether messages exceed maximum context window */
    exceedsMaxTokens: boolean;
    /** Suggested action to take */
    suggestedAction: 'continue' | 'remove_old_context' | 'request_final_answer';
}

/**
 * Result of context cleanup operation
 */
export interface ContextCleanupResult {
    /** Messages after cleanup */
    cleanedMessages: ToolCallMessage[];
    /** Number of tool results removed */
    toolResultsRemoved: number;
    /** Number of assistant messages removed */
    assistantMessagesRemoved: number;
    /** Whether a context full message was added */
    contextFullMessageAdded: boolean;
}

/**
 * Simple token validator for tool calling context management
 * Handles token counting and context window management without complex truncation
 */
export class TokenValidator {
    constructor(private model: vscode.LanguageModelChat) {}

    /**
     * Validate token count for a conversation
     * @param messages Messages to validate
     * @param systemPrompt System prompt to include in count
     * @returns Validation result with suggested action
     */
    async validateTokens(
        messages: ToolCallMessage[],
        systemPrompt: string
    ): Promise<TokenValidationResult> {
        try {
            // Count tokens for system prompt
            const systemTokens = await this.model.countTokens(systemPrompt);
            
            // Count tokens for all messages
            let messageTokens = 0;
            for (const message of messages) {
                messageTokens += await this.countMessageTokens(message);
            }

            const totalTokens = systemTokens + messageTokens;
            const maxTokens = this.model.maxInputTokens || TokenConstants.DEFAULT_MAX_INPUT_TOKENS;
            const warningThreshold = Math.floor(maxTokens * TokenConstants.CONTEXT_WARNING_RATIO);

            const exceedsWarningThreshold = totalTokens >= warningThreshold;
            const exceedsMaxTokens = totalTokens >= maxTokens;

            let suggestedAction: TokenValidationResult['suggestedAction'] = 'continue';
            if (exceedsMaxTokens) {
                suggestedAction = 'request_final_answer';
            } else if (exceedsWarningThreshold) {
                suggestedAction = 'remove_old_context';
            }

            return {
                totalTokens,
                maxTokens,
                exceedsWarningThreshold,
                exceedsMaxTokens,
                suggestedAction
            };

        } catch (error) {
            Log.error('Error validating tokens:', error);
            // Return conservative result on error
            return {
                totalTokens: 0,
                maxTokens: TokenConstants.DEFAULT_MAX_INPUT_TOKENS,
                exceedsWarningThreshold: false,
                exceedsMaxTokens: false,
                suggestedAction: 'continue'
            };
        }
    }

    /**
     * Clean up context by removing oldest tool results and corresponding assistant messages
     * @param messages Messages to clean up
     * @param systemPrompt System prompt for token calculation
     * @param targetUtilization Target context utilization (0.8 = 80%)
     * @returns Cleanup result with modified messages
     */
    async cleanupContext(
        messages: ToolCallMessage[],
        systemPrompt: string,
        targetUtilization: number = 0.8
    ): Promise<ContextCleanupResult> {
        const maxTokens = this.model.maxInputTokens || TokenConstants.DEFAULT_MAX_INPUT_TOKENS;
        const targetTokens = Math.floor(maxTokens * targetUtilization);

        let cleanedMessages = [...messages];
        let toolResultsRemoved = 0;
        let assistantMessagesRemoved = 0;
        let contextFullMessageAdded = false;

        try {
            // Continue removing oldest tool interactions until we're under target
            while (cleanedMessages.length > 0) {
                const validation = await this.validateTokens(cleanedMessages, systemPrompt);
                
                if (validation.totalTokens <= targetTokens) {
                    break;
                }

                // Find oldest tool result to remove
                const removalResult = this.removeOldestToolInteraction(cleanedMessages);
                
                if (!removalResult.found) {
                    // No more tool interactions to remove
                    break;
                }

                cleanedMessages = removalResult.messages;
                toolResultsRemoved += removalResult.toolResultsRemoved;
                assistantMessagesRemoved += removalResult.assistantMessagesRemoved;
            }

            // Add context full message if we removed any tool interactions
            if (toolResultsRemoved > 0 || assistantMessagesRemoved > 0) {
                cleanedMessages.push({
                    role: 'user',
                    content: TokenConstants.TOOL_CONTEXT_MESSAGES.CONTEXT_FULL,
                    toolCallId: undefined,
                    toolCalls: undefined
                });
                contextFullMessageAdded = true;
            }

        } catch (error) {
            Log.error('Error during context cleanup:', error);
        }

        return {
            cleanedMessages,
            toolResultsRemoved,
            assistantMessagesRemoved,
            contextFullMessageAdded
        };
    }

    /**
     * Check if a response size is within acceptable limits
     * @param responseText Response text to check
     * @returns True if within limits, false otherwise
     */
    isResponseSizeAcceptable(responseText: string): boolean {
        return responseText.length <= TokenConstants.MAX_TOOL_RESPONSE_CHARS;
    }

    /**
     * Count tokens for a single message
     * @param message Message to count tokens for
     * @returns Token count
     */
    private async countMessageTokens(message: ToolCallMessage): Promise<number> {
        let tokens = TokenConstants.TOKEN_OVERHEAD_PER_MESSAGE;

        // Count content tokens
        if (message.content) {
            tokens += await this.model.countTokens(message.content);
        }

        // Count tool call tokens (rough estimate)
        if (message.toolCalls && message.toolCalls.length > 0) {
            for (const toolCall of message.toolCalls) {
                // Tool call overhead: id + function name + arguments
                const toolCallText = JSON.stringify(toolCall);
                tokens += await this.model.countTokens(toolCallText);
            }
        }

        return tokens;
    }

    /**
     * Remove the oldest tool interaction (tool result + corresponding assistant message)
     * @param messages Messages to search through
     * @returns Result of removal operation
     */
    private removeOldestToolInteraction(messages: ToolCallMessage[]): {
        found: boolean;
        messages: ToolCallMessage[];
        toolResultsRemoved: number;
        assistantMessagesRemoved: number;
    } {
        // Find oldest tool result message
        const toolResultIndex = messages.findIndex(msg => msg.role === 'tool');
        
        if (toolResultIndex === -1) {
            return {
                found: false,
                messages,
                toolResultsRemoved: 0,
                assistantMessagesRemoved: 0
            };
        }

        const toolResult = messages[toolResultIndex];
        const newMessages = [...messages];
        let toolResultsRemoved = 0;
        let assistantMessagesRemoved = 0;

        // Remove the tool result
        newMessages.splice(toolResultIndex, 1);
        toolResultsRemoved = 1;

        // Find and remove the corresponding assistant message with tool calls
        // Look backwards from the tool result to find the assistant message
        for (let i = toolResultIndex - 1; i >= 0; i--) {
            const msg = messages[i];
            if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
                // Check if this assistant message contains the tool call that produced our result
                const hasMatchingToolCall = msg.toolCalls.some(
                    call => call.id === toolResult.toolCallId
                );
                
                if (hasMatchingToolCall) {
                    // Remove this assistant message (adjust index since we already removed tool result)
                    const adjustedIndex = i < toolResultIndex ? i : i - 1;
                    newMessages.splice(adjustedIndex, 1);
                    assistantMessagesRemoved = 1;
                    break;
                }
            }
        }

        return {
            found: true,
            messages: newMessages,
            toolResultsRemoved,
            assistantMessagesRemoved
        };
    }
}