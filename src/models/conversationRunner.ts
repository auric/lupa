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
    /**
     * Called after each iteration's tool calls complete.
     * Receives the names of tools that were executed in the current iteration.
     * Can return a message to inject into the conversation before the next LLM turn
     * (e.g., coverage gap reports after subagent rounds).
     */
    afterToolCalls?: (toolNames: string[]) => string | undefined;
    /**
     * Mutable set of tool names to exclude from subsequent iterations.
     * The afterToolCalls callback can add names to this set via closure
     * to programmatically restrict which tools the LLM can call.
     * Used by the recursive root to disable investigation tools after orientation.
     */
    disabledToolNames?: Set<string>;
    /**
     * Called before accepting a no-tool-call response as final (non-explicit-completion mode).
     * If it returns a string, that message is injected and the conversation continues.
     * If it returns undefined, the response is accepted as final.
     * Receives the set of tool names called so far and the current iteration.
     * Used by subagents to enforce minimum investigation depth.
     */
    beforeAcceptingResponse?: (
        toolNamesCalled: Set<string>,
        iteration: number,
        maxIterations: number
    ) => string | undefined;
    /**
     * If true, the scoped ToolExecutor will ONLY resolve tools from the local
     * tools list — no fallback to the global registry. Use for sandboxed
     * conversations (e.g., self-reflection scoring) that should never execute
     * arbitrary tools.
     */
    restrictToLocalTools?: boolean;
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
    private currentExecutor!: ToolExecutor;
    private _hitMaxIterations = false;
    private _hitRateLimit = false;
    private _hitQuotaExhausted = false;
    private _wasCancelled = false;
    private _iterationsUsed = 0;

    /** Maximum number of consecutive rate-limit retries before giving up */
    private static readonly MAX_RATE_LIMIT_RETRIES = 5;
    /** Maximum consecutive "Response too long" retries before giving up */
    private static readonly MAX_RESPONSE_TOO_LONG_RETRIES = 2;
    /** Maximum consecutive non-recoverable errors before breaking the loop */
    private static readonly MAX_CONSECUTIVE_ERRORS = 3;
    /** Initial backoff delay in ms for rate-limited requests */
    private static readonly INITIAL_BACKOFF_MS = 2000;
    /** Maximum backoff delay in ms */
    private static readonly MAX_BACKOFF_MS = 60000;

    constructor(
        private readonly client: ILLMClient,
        private readonly toolExecutor: ToolExecutor
    ) {}

    /** Whether the last run() exited due to reaching the max iteration limit. */
    get hitMaxIterations(): boolean {
        return this._hitMaxIterations;
    }

    /** Whether the last run() exited due to rate-limit retry exhaustion or quota exhaustion. */
    get hitRateLimit(): boolean {
        return this._hitRateLimit;
    }

    /** Whether the last run() exited due to quota exhaustion (non-recoverable). */
    get hitQuotaExhausted(): boolean {
        return this._hitQuotaExhausted;
    }

    /** Whether the last run() exited due to cancellation. */
    get wasCancelled(): boolean {
        return this._wasCancelled;
    }

    /** Number of iterations (LLM turns) used in the last run(). */
    get iterationsUsed(): number {
        return this._iterationsUsed;
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
        let rateLimitRetries = 0;
        let responseTooLongRetries = 0;
        let consecutiveErrors = 0;
        let lastSubstantiveResponse = '';
        let windDownInjected = false;
        let windDownNudged = false;
        let urgentWindDownNudged = false;
        let explicitCompletionWarned = false;
        let explicitCompletionUrgent = false;
        const WIND_DOWN_THRESHOLD = 0.85;
        const URGENT_WIND_DOWN_THRESHOLD = 0.92;
        const EXPLICIT_COMPLETION_WARNING_THRESHOLD = 0.8;
        const EXPLICIT_COMPLETION_URGENT_THRESHOLD = 0.92;
        const FINAL_BUFFER_ITERATIONS = 2;
        const windDownIteration = Math.floor(
            config.maxIterations * WIND_DOWN_THRESHOLD
        );
        const urgentWindDownIteration = Math.floor(
            config.maxIterations * URGENT_WIND_DOWN_THRESHOLD
        );
        const explicitWarningIteration = Math.floor(
            config.maxIterations * EXPLICIT_COMPLETION_WARNING_THRESHOLD
        );
        const explicitUrgentIteration = Math.floor(
            config.maxIterations * EXPLICIT_COMPLETION_URGENT_THRESHOLD
        );
        // Only buffer multiple final iterations when budget is large enough
        // to justify the overhead (>10 iterations).
        const finalBufferStart =
            config.maxIterations > 10
                ? config.maxIterations - FINAL_BUFFER_ITERATIONS + 1
                : config.maxIterations;
        const MAX_COMPLETION_NUDGES = 2;
        const logPrefix = config.label ? `[${config.label}]` : '[Conversation]';
        this._hitMaxIterations = false;
        this._hitRateLimit = false;
        this._hitQuotaExhausted = false;
        this._wasCancelled = false;
        this._iterationsUsed = 0;
        const toolNamesCalled = new Set<string>();

        const executionContext = this.toolExecutor.getExecutionContext();
        const previousToolExecutor = executionContext.toolExecutor;
        this.currentExecutor = this.toolExecutor.createScoped(config.tools, {
            restrictToLocal: config.restrictToLocalTools,
        });

        try {
            while (iteration < config.maxIterations) {
                iteration++;
                this._iterationsUsed = iteration;
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
                    const vscodeTools = config.tools
                        .filter(
                            (tool) => !config.disabledToolNames?.has(tool.name)
                        )
                        .map((tool) => tool.getVSCodeTool());

                    // Early wind-down nudge at ~85% of budget for subagents.
                    // Prompt-based budget management doesn't work — LLMs can't count
                    // iterations. This code-injected message gives a concrete signal.
                    if (
                        !config.requiresExplicitCompletion &&
                        iteration === windDownIteration &&
                        !windDownNudged
                    ) {
                        windDownNudged = true;
                        const remaining = config.maxIterations - iteration;
                        conversation.addUserMessage(
                            `Budget check: You have used ${iteration} of ${config.maxIterations} iterations (${remaining} remaining). ` +
                                `Continue investigating if needed, but begin consolidating your findings soon.`
                        );
                        Log.info(
                            `${logPrefix} Wind-down nudge injected at iteration ${iteration}/${config.maxIterations}`
                        );
                    }

                    // Urgent wind-down nudge at ~92% — escalate urgency.
                    // Only fires if not already in the final buffer zone
                    // (where tools are removed anyway).
                    if (
                        !config.requiresExplicitCompletion &&
                        iteration === urgentWindDownIteration &&
                        iteration < finalBufferStart &&
                        !urgentWindDownNudged
                    ) {
                        urgentWindDownNudged = true;
                        const remaining = config.maxIterations - iteration;
                        conversation.addUserMessage(
                            `⚠️ URGENT: Only ${remaining} iteration(s) remaining out of ${config.maxIterations}. ` +
                                `Stop starting new investigations. Wrap up your current analysis and ` +
                                `produce your complete findings immediately. ` +
                                `A thorough partial answer is far more valuable than running out of budget with no written findings.`
                        );
                        Log.info(
                            `${logPrefix} Urgent wind-down nudge injected at iteration ${iteration}/${config.maxIterations}`
                        );
                    }

                    // Budget-awareness nudges for explicit-completion conversations.
                    // Unlike subagent wind-down, we never remove tools — the LLM
                    // needs them (e.g. submit_review) to complete its task.
                    if (
                        config.requiresExplicitCompletion &&
                        iteration === explicitWarningIteration &&
                        !explicitCompletionWarned
                    ) {
                        explicitCompletionWarned = true;
                        const remaining = config.maxIterations - iteration;
                        conversation.addUserMessage(
                            `Budget warning: You have used ${iteration} of ${config.maxIterations} iterations (${remaining} remaining). ` +
                                `Finalize your current work and call submit_review soon to ensure your progress is saved.`
                        );
                        Log.info(
                            `${logPrefix} Explicit-completion budget warning at iteration ${iteration}/${config.maxIterations}`
                        );
                    }

                    if (
                        config.requiresExplicitCompletion &&
                        iteration === explicitUrgentIteration &&
                        !explicitCompletionUrgent
                    ) {
                        explicitCompletionUrgent = true;
                        const remaining = config.maxIterations - iteration;
                        conversation.addUserMessage(
                            `⚠️ URGENT: Only ${remaining} iteration(s) remaining out of ${config.maxIterations}. ` +
                                `You MUST call submit_review NOW. If you do not submit before the budget runs out, ` +
                                `your work will not be saved. Call submit_review immediately with your current results.`
                        );
                        Log.info(
                            `${logPrefix} Explicit-completion urgent warning at iteration ${iteration}/${config.maxIterations}`
                        );
                    }

                    // Final buffer: remove tools and force text response for
                    // the last N iterations of non-explicit-completion conversations
                    // (subagents). Giving 2 iterations instead of 1 provides a
                    // retry opportunity if the first forced-text response is poor.
                    const isInFinalBuffer =
                        !config.requiresExplicitCompletion &&
                        iteration >= finalBufferStart;

                    if (isInFinalBuffer && !windDownInjected) {
                        windDownInjected = true;
                        conversation.addUserMessage(
                            'You are in your final iterations — no more tool calls are available. Please provide your complete findings as a text response. ' +
                                'Summarize everything you have found so far. A partial answer is better than no answer.'
                        );
                    }

                    const effectiveTools =
                        isInFinalBuffer || windDownInjected ? [] : vscodeTools;

                    let messages = this.prepareMessagesForLLM(
                        config.systemPrompt,
                        conversation
                    );

                    // Initialize token validator if not already done
                    if (!this.tokenValidator) {
                        const currentModel =
                            await this.client.getCurrentModel();
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
                        const cleanup =
                            await this.tokenValidator.cleanupContext(
                                messages.slice(1),
                                config.systemPrompt
                            );

                        // Rebuild conversation with cleaned messages
                        conversation.clearHistory();
                        for (const message of cleanup.cleanedMessages) {
                            if (message.role === 'user') {
                                conversation.addUserMessage(
                                    message.content || ''
                                );
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
                            tools: effectiveTools,
                        },
                        token
                    );

                    // Reset retry counters after successful API call.
                    // Without this, a later error would continue from
                    // the old retry count and prematurely exhaust retries.
                    rateLimitRetries = 0;
                    consecutiveErrors = 0;
                    responseTooLongRetries = 0;

                    if (token.isCancellationRequested) {
                        Log.info(`${logPrefix} Cancelled by user`);
                        this._wasCancelled = true;
                        return '';
                    }

                    conversation.addAssistantMessage(
                        response.content || null,
                        response.toolCalls
                    );

                    // Track last substantive response for graceful degradation.
                    // Threshold filters trivial LLM responses like "OK." or "Error." so
                    // the fallback message delivered on rate-limit exhaustion or max-iterations
                    // contains actual review content.
                    const MIN_SUBSTANTIVE_RESPONSE_LENGTH = 50;
                    if (
                        response.content &&
                        response.content.trim().length >
                            MIN_SUBSTANTIVE_RESPONSE_LENGTH
                    ) {
                        lastSubstantiveResponse = response.content;
                    }

                    // Re-check cancellation before processing branching logic —
                    // token may have fired during response processing
                    if (token.isCancellationRequested) {
                        Log.info(
                            `${logPrefix} Cancelled during response processing`
                        );
                        this._wasCancelled = true;
                        return '';
                    }

                    if (response.toolCalls && response.toolCalls.length > 0) {
                        // Reset nudge counter - model is cooperating with tool calls
                        completionNudgeCount = 0;

                        let toolCalls = response.toolCalls;

                        // Defense-in-depth: block tool calls for disabled tools.
                        // The LLM shouldn't know about disabled tools (they're excluded
                        // from the tool list), but guard against hallucinated names.
                        if (config.disabledToolNames?.size) {
                            const blocked = toolCalls.filter((tc) =>
                                config.disabledToolNames!.has(tc.function.name)
                            );
                            if (blocked.length > 0) {
                                const names = blocked
                                    .map((tc) => tc.function.name)
                                    .join(', ');
                                Log.warn(
                                    `${logPrefix} Blocked ${blocked.length} disabled tool call(s): ${names}`
                                );
                                for (const tc of blocked) {
                                    conversation.addToolMessage(
                                        tc.id || `blocked_${tc.function.name}`,
                                        `Error: Tool '${tc.function.name}' is not available.`
                                    );
                                }
                                toolCalls = toolCalls.filter(
                                    (tc) =>
                                        !config.disabledToolNames!.has(
                                            tc.function.name
                                        )
                                );
                                if (toolCalls.length === 0) {
                                    continue;
                                }
                            }
                        }

                        // Track tool names for investigation depth checks
                        for (const tc of toolCalls) {
                            toolNamesCalled.add(tc.function.name);
                        }

                        const result = await this.handleToolCalls(
                            toolCalls,
                            conversation,
                            handler,
                            logPrefix
                        );

                        // Check cancellation after tool execution completes —
                        // tools may finish normally even when the token fires mid-execution
                        if (token.isCancellationRequested) {
                            Log.info(
                                `${logPrefix} Cancelled after tool execution`
                            );
                            this._wasCancelled = true;
                            return '';
                        }

                        // If submit_review was called, return its content as the final review
                        if (result.finalReview) {
                            Log.info(
                                `${logPrefix} Completed via submit_review tool`
                            );
                            return result.finalReview;
                        }

                        // Post-tool-call hook: inject coverage gaps or other messages
                        if (config.afterToolCalls) {
                            const toolNames = toolCalls.map(
                                (tc) => tc.function.name
                            );
                            const injectedMessage =
                                config.afterToolCalls(toolNames);
                            if (injectedMessage) {
                                conversation.addUserMessage(injectedMessage);
                                Log.info(
                                    `${logPrefix} Injected post-tool-call message (${injectedMessage.length} chars)`
                                );
                            }
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

                        if (completionNudgeCount === 1) {
                            // First no-tool-call response: the LLM may be synthesizing
                            // subagent results or reasoning before making more tool calls.
                            // Use a soft message that encourages continuing investigation.
                            Log.info(
                                `${logPrefix} No tool calls (${completionNudgeCount}/${MAX_COMPLETION_NUDGES}). ` +
                                    `Content preview: "${contentPreview}...". ` +
                                    `Ending: "...${contentEnding}". Soft continue (not nudging submit_review yet).`
                            );
                            conversation.addUserMessage(
                                'Continue investigating. When you have completed a thorough analysis, ' +
                                    'call `submit_review` to deliver your findings.'
                            );
                        } else {
                            Log.info(
                                `${logPrefix} No tool calls (${completionNudgeCount}/${MAX_COMPLETION_NUDGES}). ` +
                                    `Content preview: "${contentPreview}...". ` +
                                    `Ending: "...${contentEnding}". Nudging to use submit_review.`
                            );
                            conversation.addUserMessage(
                                'To complete your review, call the `submit_review` tool with your full review content. ' +
                                    'If you still have analysis to do, continue using the available tools.'
                            );
                        }
                        continue;
                    }

                    // For subagents and other contexts, check investigation depth before accepting
                    if (config.beforeAcceptingResponse) {
                        const nudge = config.beforeAcceptingResponse(
                            toolNamesCalled,
                            iteration,
                            config.maxIterations
                        );
                        if (nudge) {
                            Log.info(
                                `${logPrefix} Investigation depth check: injecting nudge at iteration ${iteration}`
                            );
                            conversation.addUserMessage(nudge);
                            continue;
                        }
                    }

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

                    // True quota exhaustion (HTTP 402, ChatQuotaExceeded):
                    // Free-user monthly quota depleted — no retry will help until reset.
                    if (this.isQuotaExhaustedError(error)) {
                        Log.error(
                            `${logPrefix} Monthly quota exhausted (ChatQuotaExceeded) — stopping immediately`
                        );
                        this._hitQuotaExhausted = true;
                        this._hitRateLimit = true;
                        return (
                            lastSubstantiveResponse ||
                            'Copilot monthly quota exhausted. Please wait for your quota to reset.'
                        );
                    }

                    // Rate limit (HTTP 429): backoff and retry WITHOUT burning an iteration.
                    // VS Code surfaces this as LanguageModelError with name='ChatRateLimited'.
                    // This covers both transient rate limits and quota-flavored throttles
                    // ("exceeded your Copilot token usage") which use the same HTTP 429
                    // and are equally temporary despite the scary wording.
                    if (this.isRateLimitError(error)) {
                        rateLimitRetries++;
                        if (
                            rateLimitRetries >
                            ConversationRunner.MAX_RATE_LIMIT_RETRIES
                        ) {
                            Log.error(
                                `${logPrefix} Rate limit: exceeded ${ConversationRunner.MAX_RATE_LIMIT_RETRIES} retries, giving up`
                            );
                            this._hitRateLimit = true;
                            return (
                                lastSubstantiveResponse ||
                                'Rate limited by the API after multiple retries. Please try again later.'
                            );
                        }

                        const backoffMs = Math.min(
                            ConversationRunner.INITIAL_BACKOFF_MS *
                                Math.pow(2, rateLimitRetries - 1),
                            ConversationRunner.MAX_BACKOFF_MS
                        );
                        Log.warn(
                            `${logPrefix} Rate limited (attempt ${rateLimitRetries}/${ConversationRunner.MAX_RATE_LIMIT_RETRIES}), ` +
                                `waiting ${backoffMs}ms before retry`
                        );

                        // Don't count rate-limit retries as iterations
                        iteration--;
                        this._iterationsUsed = iteration;

                        await this.sleepWithCancellation(backoffMs, token);
                        if (token.isCancellationRequested) {
                            this._wasCancelled = true;
                            return '';
                        }
                        continue;
                    }

                    // Reset rate limit counter on non-rate-limit errors
                    rateLimitRetries = 0;

                    // "Response too long" — model output exceeded the API's
                    // output-token limit.  Retrying blindly just burns iterations
                    // because the model tends to produce the same long response.
                    // Give it up to MAX_RESPONSE_TOO_LONG_RETRIES chances with
                    // explicit guidance to shorten output, then give up.
                    if (this.isResponseTooLongError(error)) {
                        responseTooLongRetries++;
                        if (
                            responseTooLongRetries >
                            ConversationRunner.MAX_RESPONSE_TOO_LONG_RETRIES
                        ) {
                            Log.error(
                                `${logPrefix} Response too long: exceeded ${ConversationRunner.MAX_RESPONSE_TOO_LONG_RETRIES} retries, giving up`
                            );
                            return (
                                lastSubstantiveResponse ||
                                'The model consistently generated responses that exceeded the maximum length. ' +
                                    'Please try with a simpler query or a model with a larger output window.'
                            );
                        }

                        Log.warn(
                            `${logPrefix} Response too long (attempt ${responseTooLongRetries}/${ConversationRunner.MAX_RESPONSE_TOO_LONG_RETRIES}), ` +
                                `adding conciseness guidance`
                        );

                        // Don't count as iteration — the model never finished
                        iteration--;
                        this._iterationsUsed = iteration;

                        conversation.addAssistantMessage(
                            'My previous response was too long and was rejected by the API. ' +
                                'I must be much more concise. I will use tool calls for individual actions ' +
                                'instead of generating long text output.'
                        );
                        continue;
                    }

                    // Reset response-too-long counter on unrelated errors
                    responseTooLongRetries = 0;

                    // Context overflow: the conversation exceeded the model's max tokens.
                    // Each retry adds more tokens, making it progressively worse — break immediately.
                    if (this.isContextOverflowError(error)) {
                        Log.error(
                            `${logPrefix} Context overflow at iteration ${iteration} — stopping to prevent token spiral`
                        );
                        return (
                            lastSubstantiveResponse ||
                            "The conversation exceeded the model's context limit. Partial results may be available."
                        );
                    }

                    // Conversation history corruption: orphaned tool messages without
                    // a preceding assistant message with tool_calls. This is unrecoverable
                    // for this conversation — every subsequent request will fail identically.
                    if (this.isConversationCorruptionError(error)) {
                        Log.error(
                            `${logPrefix} Conversation history corrupted (orphaned tool messages) — stopping`
                        );
                        return (
                            lastSubstantiveResponse ||
                            'The conversation history became corrupted. Partial results may be available.'
                        );
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

                    // Track consecutive errors to prevent infinite error loops.
                    // Some API errors (e.g., malformed conversation state) repeat
                    // identically every iteration, burning budget without progress.
                    consecutiveErrors++;
                    if (
                        consecutiveErrors >=
                        ConversationRunner.MAX_CONSECUTIVE_ERRORS
                    ) {
                        Log.error(
                            `${logPrefix} ${consecutiveErrors} consecutive errors — stopping to prevent infinite error loop`
                        );
                        return (
                            lastSubstantiveResponse ||
                            `Stopped after ${consecutiveErrors} consecutive errors. Last error: ${getErrorMessage(error)}`
                        );
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
            return (
                lastSubstantiveResponse ||
                'Conversation reached maximum iterations with no findings.'
            );
        } finally {
            executionContext.toolExecutor = previousToolExecutor;
        }
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
     * Check if an error is a true quota exhaustion error (HTTP 402).
     * VS Code surfaces this as a LanguageModelError with name='ChatQuotaExceeded'
     * when the monthly premium request quota is depleted. This is distinct from
     * ChatRateLimited (HTTP 429) which is always a temporary burst throttle.
     */
    private isQuotaExhaustedError(error: unknown): boolean {
        if (!(error instanceof Error)) {
            return false;
        }
        const constructorName = error.constructor?.name ?? '';
        const name = error.name ?? '';
        return (
            constructorName === 'ChatQuotaExceeded' ||
            constructorName.includes('QuotaExceeded') ||
            name === 'ChatQuotaExceeded' ||
            name.includes('QuotaExceeded')
        );
    }

    /**
     * Check if an error is a "Response too long" error from the VS Code Copilot API.
     * This occurs when the model's output exceeds the API's maximum output token limit.
     * Retrying without guidance just produces the same overlong response.
     */
    private isResponseTooLongError(error: unknown): boolean {
        if (!(error instanceof Error)) {
            return false;
        }
        const message = error.message ?? '';
        return (
            message.includes('Response too long') ||
            message.includes('response_too_long') ||
            message.includes('ResponseTooLong')
        );
    }

    /**
     * Check if an error is a rate limit error from the VS Code Copilot API.
     * VS Code surfaces this as a LanguageModelError with name='ChatRateLimited'
     * (HTTP 429). This covers both transient rate limits and quota-flavored
     * throttles ("exceeded your Copilot token usage") — both are temporary
     * despite the scary wording on the latter.
     */
    private isRateLimitError(error: unknown): boolean {
        if (!(error instanceof Error)) {
            return false;
        }
        const constructorName = error.constructor?.name ?? '';
        const name = error.name ?? '';
        const message = error.message ?? '';
        return (
            constructorName === 'ChatRateLimited' ||
            constructorName.includes('RateLimited') ||
            name === 'ChatRateLimited' ||
            name.includes('RateLimited') ||
            message.includes('rate limit') ||
            message.includes('Rate limit') ||
            message.includes('RateLimited')
        );
    }

    /**
     * Check if an error indicates the conversation exceeded the model's context window.
     * This is unrecoverable in the current conversation — each retry adds more tokens
     * to the error messages, creating a progressively worsening spiral.
     */
    private isContextOverflowError(error: unknown): boolean {
        if (!(error instanceof Error)) {
            return false;
        }
        const message = error.message ?? '';
        return (
            message.includes('maximum context length') ||
            message.includes('context_length_exceeded')
        );
    }

    /**
     * Check if an error indicates conversation history corruption.
     * This occurs when tool-role messages appear without a preceding assistant
     * message containing tool_calls (e.g., after an error during tool execution
     * that corrupts the message sequence). Unrecoverable for this conversation.
     */
    private isConversationCorruptionError(error: unknown): boolean {
        if (!(error instanceof Error)) {
            return false;
        }
        const message = error.message ?? '';
        return (
            message.includes("role 'tool' must be a response to") ||
            message.includes('tool_use result') ||
            message.includes('tool result without')
        );
    }

    /**
     * Sleep for a specified duration, aborting early if cancellation is requested.
     */
    private sleepWithCancellation(
        ms: number,
        token: vscode.CancellationToken
    ): Promise<void> {
        if (token.isCancellationRequested) {
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            const timer = setTimeout(resolve, ms);
            let cleanupTimer: NodeJS.Timeout | undefined;
            const disposable = token.onCancellationRequested(() => {
                clearTimeout(timer);
                clearTimeout(cleanupTimer);
                disposable.dispose();
                resolve();
            });
            // Clean up listener when timer fires normally
            cleanupTimer = setTimeout(() => disposable.dispose(), ms + 1);
        });
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
        const results = await this.currentExecutor.executeTools(toolRequests);
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
        this._hitRateLimit = false;
        this._hitQuotaExhausted = false;
        this._wasCancelled = false;
    }
}
