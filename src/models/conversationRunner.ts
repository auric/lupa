import * as vscode from 'vscode';
import { ConversationManager } from './conversationManager';
import { ToolExecutor, type ToolExecutionRequest } from './toolExecutor';
import { ILLMClient } from './ILLMClient';
import { CopilotApiError } from './copilotModelManager';
import { TokenValidator } from './tokenValidator';
import type { ToolCallMessage, ToolCall } from '../types/modelTypes';
import type { ToolResultMetadata } from '../types/toolResultTypes';
import { Log } from '../services/loggingService';
import { ITool } from '../tools/ITool';
import { extractReviewFromMalformedToolCall } from '../utils/reviewExtractionUtils';
import { isCancellationError } from '../utils/asyncUtils';
import { getErrorMessage } from '../utils/errorUtils';

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
    /**
     * If true, the conversation must complete via a tool with isCompletion metadata
     * (e.g., submit_review). The runner will nudge the LLM to call the completion tool
     * if it tries to respond without tool calls.
     *
     * Use for main PR analysis where structured completion is required.
     * Subagents and exploration modes can complete with direct responses.
     */
    requiresExplicitCompletion?: boolean;
}

/**
 * Callback interface for handling tool call side effects.
 * Enables the caller to record tool calls without ConversationRunner knowing about the specifics.
 */
export interface ToolCallHandler {
    /** Called when a tool execution starts, with parsed args for message formatting */
    onToolCallStart?: (
        toolName: string,
        args: Record<string, unknown>,
        toolIndex: number,
        totalTools: number
    ) => void;

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
 * Result from handling tool calls.
 */
interface HandleToolCallsResult {
    /** If submit_review was called, contains the final review content */
    finalReview?: string;
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
    private _hitMaxIterations = false;
    private _wasCancelled = false;

    constructor(
        private readonly client: ILLMClient,
        private readonly toolExecutor: ToolExecutor
    ) {}

    /** Whether the last run() exited due to reaching the max iteration limit. */
    get hitMaxIterations(): boolean {
        return this._hitMaxIterations;
    }

    /** Whether the last run() exited due to cancellation. */
    get wasCancelled(): boolean {
        return this._wasCancelled;
    }

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
        let completionNudgeCount = 0;
        const MAX_COMPLETION_NUDGES = 2;
        const logPrefix = config.label ? `[${config.label}]` : '[Conversation]';
        this._hitMaxIterations = false;
        this._wasCancelled = false;

        while (iteration < config.maxIterations) {
            iteration++;
            Log.info(
                `${logPrefix} Iteration ${iteration}/${config.maxIterations}`
            );

            if (token.isCancellationRequested) {
                Log.info(
                    `${logPrefix} Cancelled before iteration ${iteration}`
                );
                this._wasCancelled = true;
                return '';
            }

            handler?.onIterationStart?.(iteration, config.maxIterations);

            try {
                const vscodeTools = config.tools.map((tool) =>
                    tool.getVSCodeTool()
                );
                let messages = this.prepareMessagesForLLM(
                    config.systemPrompt,
                    conversation
                );

                // Initialize token validator if not already done
                if (!this.tokenValidator) {
                    const currentModel = await this.client.getCurrentModel();
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
                    messages = this.prepareMessagesForLLM(
                        config.systemPrompt,
                        conversation
                    );
                } else if (
                    validation.suggestedAction === 'remove_old_context'
                ) {
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
                            conversation.addAssistantMessage(
                                message.content,
                                message.toolCalls
                            );
                        } else if (message.role === 'tool') {
                            conversation.addToolMessage(
                                message.toolCallId || '',
                                message.content || ''
                            );
                        }
                    }

                    messages = this.prepareMessagesForLLM(
                        config.systemPrompt,
                        conversation
                    );

                    if (cleanup.contextFullMessageAdded) {
                        Log.info(
                            `${logPrefix} Context cleanup: removed ${cleanup.toolResultsRemoved} tool results and ${cleanup.assistantMessagesRemoved} assistant messages`
                        );
                    }
                }

                const response = await this.client.sendRequest(
                    {
                        messages,
                        tools: vscodeTools,
                    },
                    token
                );

                if (token.isCancellationRequested) {
                    Log.info(`${logPrefix} Cancelled by user`);
                    this._wasCancelled = true;
                    return '';
                }

                conversation.addAssistantMessage(
                    response.content || null,
                    response.toolCalls
                );

                if (response.toolCalls && response.toolCalls.length > 0) {
                    // Reset nudge counter - model is cooperating with tool calls
                    completionNudgeCount = 0;

                    const result = await this.handleToolCalls(
                        response.toolCalls,
                        conversation,
                        handler,
                        logPrefix
                    );

                    // If submit_review was called, return its content as the final review
                    if (result.finalReview) {
                        Log.info(
                            `${logPrefix} Completed via submit_review tool`
                        );
                        return result.finalReview;
                    }

                    continue;
                }

                // No tool calls - check if explicit completion is required
                // Main analysis requires submit_review; subagents/exploration can complete directly
                if (config.requiresExplicitCompletion) {
                    completionNudgeCount++;

                    // After MAX_COMPLETION_NUDGES attempts, accept the response to prevent infinite loops
                    if (completionNudgeCount > MAX_COMPLETION_NUDGES) {
                        Log.warn(
                            `${logPrefix} Model did not call submit_review after ${MAX_COMPLETION_NUDGES} nudges. Accepting response as final.`
                        );

                        // Try to extract review content from malformed tool call attempts
                        const extractedReview =
                            extractReviewFromMalformedToolCall(
                                response.content
                            );
                        if (extractedReview) {
                            Log.info(
                                `${logPrefix} Extracted review content from malformed tool call`
                            );
                            return extractedReview;
                        }

                        return (
                            response.content ||
                            'Analysis completed but model did not use submit_review tool.'
                        );
                    }

                    const contentPreview =
                        response.content?.substring(0, 150) || '(empty)';
                    const contentEnding =
                        response.content && response.content.length > 100
                            ? response.content.slice(-100)
                            : '';
                    Log.info(
                        `${logPrefix} No tool calls (nudge ${completionNudgeCount}/${MAX_COMPLETION_NUDGES}). ` +
                            `Content preview: "${contentPreview}...". ` +
                            `Ending: "...${contentEnding}". Nudging to use submit_review.`
                    );
                    conversation.addUserMessage(
                        'To complete your review, call the `submit_review` tool with your full review content. ' +
                            'If you still have analysis to do, continue using the available tools.'
                    );
                    continue;
                }

                // For subagents and other contexts, accept the response as final
                Log.info(`${logPrefix} Completed successfully`);
                return (
                    response.content ||
                    'Conversation completed but no content returned.'
                );
            } catch (error) {
                // Explicit CancellationError always treated as cancellation
                if (isCancellationError(error)) {
                    Log.info(
                        `${logPrefix} Cancelled during iteration ${iteration}`
                    );
                    this._wasCancelled = true;
                    return '';
                }

                // Token cancelled with non-cancellation error: log actual error for diagnostics
                // (helps identify when errors coincide with or are caused by cancellation)
                if (token.isCancellationRequested) {
                    Log.warn(
                        `${logPrefix} Cancelled during iteration ${iteration} ` +
                            `(error while token cancelled: ${getErrorMessage(error)})`
                    );
                    this._wasCancelled = true;
                    return '';
                }

                const fatalError = this.detectFatalError(error);
                if (fatalError) {
                    Log.error(
                        `${logPrefix} Fatal API error [${fatalError.code}]: ${fatalError.message}`,
                        error
                    );
                    vscode.window.showErrorMessage(fatalError.message);
                    throw new CopilotApiError(
                        fatalError.message,
                        fatalError.code
                    );
                }

                const errorMessage = `${logPrefix} Error in iteration ${iteration}: ${getErrorMessage(error)}`;
                Log.error(errorMessage, error);

                // Re-throw service unavailable errors to be handled by caller
                if (
                    error instanceof Error &&
                    error.message.includes('service unavailable')
                ) {
                    throw error;
                }

                conversation.addAssistantMessage(
                    `I encountered an error: ${errorMessage}. Let me try to continue.`
                );

                // An error on the final iteration is intentionally treated as max-iterations:
                // the subagent can't retry regardless, so the parent LLM gets the same signal
                // (with partial findings included via the error message).
                if (iteration >= config.maxIterations) {
                    this._hitMaxIterations = true;
                    return errorMessage;
                }
            }
        }

        Log.warn(
            `${logPrefix} Reached maximum iterations (${config.maxIterations})`
        );
        this._hitMaxIterations = true;
        return 'Conversation reached maximum iterations. The conversation may be incomplete.';
    }

    private isFatalModelError(error: unknown): boolean {
        const result = this.detectFatalError(error);
        return result !== null;
    }

    /**
     * Detect fatal API errors that should stop the conversation immediately.
     * Returns a user-friendly message and error code, or null if not a fatal error.
     */
    private detectFatalError(
        error: unknown
    ): { message: string; code: string } | null {
        if (error instanceof CopilotApiError) {
            return { message: error.message, code: error.code };
        }

        const errorMsg = getErrorMessage(error);

        // Extract and parse JSON from error message (e.g., "400 {...}" or "{...}")
        // Example: 400 {"error":{"message":"Model is not supported for this request.","param":"model","code":"model_not_supported","type":"invalid_request_error"}}
        const jsonMatch = errorMsg.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            return null;
        }

        try {
            const parsed = JSON.parse(jsonMatch[0]);
            const apiError = parsed.error;

            if (!apiError || typeof apiError !== 'object') {
                return null;
            }

            const { code, type, message } = apiError;

            if (code === 'model_not_supported') {
                return {
                    message:
                        'The selected model is not supported. ' +
                        'Please choose a different model.',
                    code: 'model_not_supported',
                };
            }

            if (type === 'invalid_request_error') {
                // Anthropic BYOK: empty system prompt not supported
                if (
                    message?.includes(
                        'system: text content blocks must be non-empty'
                    )
                ) {
                    return {
                        message:
                            'This model requires a system prompt, but the VS Code Language Model API ' +
                            'does not support setting system prompts for third-party models. ' +
                            'This is a known limitation with Anthropic models configured via BYOK. ' +
                            'Please use a Copilot-provided model instead. ' +
                            'See https://github.com/microsoft/vscode/issues/255286 for details.',
                        code: 'invalid_request_error',
                    };
                }

                return {
                    message:
                        `The model returned an API error: ${message || 'Invalid request'}. ` +
                        'This may be a compatibility issue with the selected model. ' +
                        'Please try using a different model.',
                    code: 'invalid_request_error',
                };
            }

            return null;
        } catch {
            return null;
        }
    }

    /**
     * Prepare messages for the LLM including system prompt and conversation history.
     */
    private prepareMessagesForLLM(
        systemPrompt: string,
        conversation: ConversationManager
    ): ToolCallMessage[] {
        const messages: ToolCallMessage[] = [
            {
                role: 'system',
                content: systemPrompt,
                toolCalls: undefined,
                toolCallId: undefined,
            },
        ];

        const history = conversation.getHistory();
        for (const message of history) {
            messages.push({
                role: message.role,
                content: message.content,
                toolCalls: message.toolCalls,
                toolCallId: message.toolCallId,
            });
        }

        return messages;
    }

    /**
     * Execute tool calls and add results to conversation.
     * @returns Object with finalReview if submit_review was called
     */
    private async handleToolCalls(
        toolCalls: ToolCall[],
        conversation: ConversationManager,
        handler?: ToolCallHandler,
        logPrefix = '[Conversation]'
    ): Promise<HandleToolCallsResult> {
        // Log which tools are being called
        const toolNames = toolCalls.map((tc) => tc.function.name).join(', ');
        Log.info(
            `${logPrefix} Executing ${toolCalls.length} tool(s): ${toolNames}`
        );

        // Pre-parse arguments for all tool calls before notifying handlers
        const toolRequests: ToolExecutionRequest[] = toolCalls.map((call) => {
            let parsedArgs: Record<string, unknown> = {};

            try {
                parsedArgs = JSON.parse(call.function.arguments);
            } catch (error) {
                Log.error(
                    `${logPrefix} Failed to parse args for ${call.function.name}: ${call.function.arguments}`,
                    error
                );
            }

            return {
                name: call.function.name,
                args: parsedArgs,
            };
        });

        // Notify handler about tool calls starting (with parsed args for message formatting)
        for (let i = 0; i < toolCalls.length; i++) {
            const toolCall = toolCalls[i]!;
            const toolRequest = toolRequests[i]!;
            handler?.onToolCallStart?.(
                toolCall.function.name,
                toolRequest.args as Record<string, unknown>,
                i,
                toolCalls.length
            );
        }

        const startTime = Date.now();
        const results = await this.toolExecutor.executeTools(toolRequests);
        const endTime = Date.now();
        const avgDuration =
            results.length > 0
                ? Math.floor((endTime - startTime) / results.length)
                : 0;

        let finalReview: string | undefined;

        for (let i = 0; i < results.length; i++) {
            const result = results[i]!;
            const toolCall = toolCalls[i]!;
            const request = toolRequests[i]!;
            const toolCallId = toolCall.id || `tool_call_${i}`;

            const baseContent =
                result.success && result.result
                    ? result.result
                    : `Error: ${result.error || 'Unknown error'}`;

            // Check if this tool signals completion via metadata flag.
            // Design: isCompletion is a boolean signal; the actual content comes from
            // result.result (the tool's data output), not from metadata itself.
            // This separation allows tools to signal completion while keeping content
            // in the standard result.result location for consistency.
            if (result.success && result.metadata?.isCompletion) {
                finalReview = result.result;
            }

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

        return { finalReview };
    }

    /**
     * Reset internal state for reuse.
     */
    reset(): void {
        this.tokenValidator = null;
        this._hitMaxIterations = false;
        this._wasCancelled = false;
    }
}
