import * as vscode from 'vscode';
import { ConversationManager } from './conversationManager';
import { ToolExecutor, type ToolExecutionRequest } from './toolExecutor';
import { CopilotModelManager } from './copilotModelManager';
import { TokenValidator } from './tokenValidator';
import type { ToolCallMessage, ToolCall } from '../types/modelTypes';
import type { ToolResultMetadata } from '../types/toolResultTypes';
import { Log } from '../services/loggingService';
import { ITool } from '../tools/ITool';

/**
 * Configuration for running a conversation loop.
 */
export interface ConversationRunnerConfig {
    /** System prompt for the LLM */
    systemPrompt: string;
    /** Maximum number of conversation iterations */
    maxIterations: number;
    /** Available tools for the LLM (empty array disables tools) */
    tools: ITool[];
    /** Optional label for logging context (e.g., "Main Analysis", "Subagent #1: Security") */
    label?: string;
}

/**
 * Callback interface for handling tool call side effects.
 * Enables the caller to record tool calls without ConversationRunner knowing about the specifics.
 */
export interface ToolCallHandler {
    /** Called when a tool execution starts */
    onToolCallStart?: (toolName: string, toolIndex: number, totalTools: number) => void;

    /** Called after each tool call completes */
    onToolCallComplete?: (
        toolCallId: string,
        toolName: string,
        args: Record<string, unknown>,
        result: string,
        success: boolean,
        error?: string,
        durationMs?: number,
        metadata?: ToolResultMetadata
    ) => void;

    /** Called to get context status suffix for tool responses */
    getContextStatusSuffix?: () => Promise<string>;

    /** Called when a conversation iteration starts */
    onIterationStart?: (current: number, max: number) => void;
}

/**
 * Runs a tool-calling conversation loop.
 * Extracted for reuse by both main analysis and subagents.
 *
 * Responsibilities:
 * - Send messages to LLM
 * - Handle tool calls and add results to conversation
 * - Manage iteration limits
 * - Validate tokens and clean up context when needed
 */
export class ConversationRunner {
    private tokenValidator: TokenValidator | null = null;

    constructor(
        private readonly modelManager: CopilotModelManager,
        private readonly toolExecutor: ToolExecutor
    ) { }

    /**
     * Execute a conversation loop until completion or max iterations.
     * @returns The final response content from the LLM
     */
    async run(
        config: ConversationRunnerConfig,
        conversation: ConversationManager,
        token: vscode.CancellationToken,
        handler?: ToolCallHandler
    ): Promise<string> {
        let iteration = 0;
        const logPrefix = config.label ? `[${config.label}]` : '[Conversation]';

        while (iteration < config.maxIterations) {
            iteration++;
            Log.info(`${logPrefix} Iteration ${iteration}/${config.maxIterations}`);

            if (token.isCancellationRequested) {
                Log.info(`${logPrefix} Cancelled before iteration ${iteration}`);
                return 'Conversation cancelled by user';
            }

            handler?.onIterationStart?.(iteration, config.maxIterations);

            try {
                const vscodeTools = config.tools.map(tool => tool.getVSCodeTool());
                let messages = this.prepareMessagesForLLM(config.systemPrompt, conversation);

                // Initialize token validator if not already done
                if (!this.tokenValidator) {
                    const currentModel = await this.modelManager.getCurrentModel();
                    this.tokenValidator = new TokenValidator(currentModel);
                }

                // Validate token count and handle context limits
                const validation = await this.tokenValidator.validateTokens(
                    messages.slice(1), // Exclude system prompt from validation
                    config.systemPrompt
                );

                if (validation.suggestedAction === 'request_final_answer') {
                    conversation.addUserMessage(
                        'Context window is full. Please provide your final analysis based on the information you have gathered so far.'
                    );
                    messages = this.prepareMessagesForLLM(config.systemPrompt, conversation);
                } else if (validation.suggestedAction === 'remove_old_context') {
                    const cleanup = await this.tokenValidator.cleanupContext(
                        messages.slice(1),
                        config.systemPrompt
                    );

                    // Rebuild conversation with cleaned messages
                    conversation.clearHistory();
                    for (const message of cleanup.cleanedMessages) {
                        if (message.role === 'user') {
                            conversation.addUserMessage(message.content || '');
                        } else if (message.role === 'assistant') {
                            conversation.addAssistantMessage(message.content, message.toolCalls);
                        } else if (message.role === 'tool') {
                            conversation.addToolMessage(message.toolCallId || '', message.content || '');
                        }
                    }

                    messages = this.prepareMessagesForLLM(config.systemPrompt, conversation);

                    if (cleanup.contextFullMessageAdded) {
                        Log.info(`${logPrefix} Context cleanup: removed ${cleanup.toolResultsRemoved} tool results and ${cleanup.assistantMessagesRemoved} assistant messages`);
                    }
                }

                const response = await this.modelManager.sendRequest({
                    messages,
                    tools: vscodeTools
                }, token);

                if (token.isCancellationRequested) {
                    Log.info(`${logPrefix} Cancelled by user`);
                    return 'Conversation cancelled by user';
                }

                conversation.addAssistantMessage(
                    response.content || null,
                    response.toolCalls
                );

                if (response.toolCalls && response.toolCalls.length > 0) {
                    await this.handleToolCalls(response.toolCalls, conversation, handler, logPrefix);
                    continue;
                }

                Log.info(`${logPrefix} Completed successfully`);
                return response.content || 'Conversation completed but no content returned.';

            } catch (error) {
                if (token.isCancellationRequested || error instanceof vscode.CancellationError || (error instanceof Error && error.message?.toLowerCase().includes('cancel'))) {
                    Log.info(`${logPrefix} Cancelled during iteration ${iteration}`);
                    return 'Conversation cancelled by user';
                }

                const errorMessage = `${logPrefix} Error in iteration ${iteration}: ${error instanceof Error ? error.message : String(error)}`;
                Log.error(errorMessage);

                // Re-throw service unavailable errors to be handled by caller
                if (error instanceof Error && error.message.includes('service unavailable')) {
                    throw error;
                }

                conversation.addAssistantMessage(
                    `I encountered an error: ${errorMessage}. Let me try to continue.`
                );

                if (iteration >= config.maxIterations) {
                    return errorMessage;
                }
            }
        }

        Log.warn(`${logPrefix} Reached maximum iterations (${config.maxIterations})`);
        return 'Conversation reached maximum iterations. The conversation may be incomplete.';
    }

    /**
     * Prepare messages for the LLM including system prompt and conversation history.
     */
    private prepareMessagesForLLM(systemPrompt: string, conversation: ConversationManager): ToolCallMessage[] {
        const messages: ToolCallMessage[] = [
            {
                role: 'system',
                content: systemPrompt,
                toolCalls: undefined,
                toolCallId: undefined
            }
        ];

        const history = conversation.getHistory();
        for (const message of history) {
            messages.push({
                role: message.role,
                content: message.content,
                toolCalls: message.toolCalls,
                toolCallId: message.toolCallId
            });
        }

        return messages;
    }

    /**
     * Execute tool calls and add results to conversation.
     */
    private async handleToolCalls(
        toolCalls: ToolCall[],
        conversation: ConversationManager,
        handler?: ToolCallHandler,
        logPrefix = '[Conversation]'
    ): Promise<void> {
        // Log which tools are being called
        const toolNames = toolCalls.map(tc => tc.function.name).join(', ');
        Log.info(`${logPrefix} Executing ${toolCalls.length} tool(s): ${toolNames}`);

        // Notify handler about tool calls starting
        for (let i = 0; i < toolCalls.length; i++) {
            handler?.onToolCallStart?.(toolCalls[i].function.name, i, toolCalls.length);
        }

        const toolRequests: ToolExecutionRequest[] = toolCalls.map(call => {
            let parsedArgs: Record<string, unknown> = {};

            try {
                parsedArgs = JSON.parse(call.function.arguments);
            } catch (error) {
                Log.error(`${logPrefix} Failed to parse args for ${call.function.name}: ${call.function.arguments}`);
            }

            return {
                name: call.function.name,
                args: parsedArgs
            };
        });

        const startTime = Date.now();
        const results = await this.toolExecutor.executeTools(toolRequests);
        const endTime = Date.now();
        const avgDuration = results.length > 0 ? Math.floor((endTime - startTime) / results.length) : 0;

        for (let i = 0; i < results.length; i++) {
            const result = results[i];
            const toolCall = toolCalls[i];
            const toolCallId = toolCall.id || `tool_call_${i}`;
            const request = toolRequests[i];

            const baseContent = result.success && result.result
                ? result.result
                : `Error: ${result.error || 'Unknown error'}`;

            // Get context status suffix if handler provides it
            const contextStatus = handler?.getContextStatusSuffix
                ? await handler.getContextStatusSuffix()
                : '';
            const content = baseContent + contextStatus;

            // Notify handler of tool call completion
            handler?.onToolCallComplete?.(
                toolCallId,
                result.name,
                request.args as Record<string, unknown>,
                baseContent,
                result.success,
                result.error,
                avgDuration,
                result.metadata
            );

            conversation.addToolMessage(toolCallId, content);
        }
    }

    /**
     * Reset internal state for reuse.
     */
    reset(): void {
        this.tokenValidator = null;
    }
}
