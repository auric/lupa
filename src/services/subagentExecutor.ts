import * as vscode from 'vscode';
import { ConversationManager } from '../models/conversationManager';
import { ConversationRunner } from '../models/conversationRunner';
import { ToolRegistry } from '../models/toolRegistry';
import { ToolExecutor } from '../models/toolExecutor';
import type { ILLMClient } from '../models/ILLMClient';
import { SubagentPromptGenerator } from '../prompts/subagentPromptGenerator';
import {
    SubagentLimits,
    RECURSIVE_CHILD_DISALLOWED_TOOLS,
} from '../models/toolConstants';
import { ANALYSIS_LIMITS } from '../models/workspaceSettingsSchema';
import { SubagentStreamAdapter } from '../models/subagentStreamAdapter';
import type { SubagentTask, SubagentResult } from '../types/modelTypes';
import type {
    ToolCallRecord,
    AnalysisProgressCallback,
    SubagentProgressContext,
} from '../types/toolCallTypes';
import type { ChatToolCallHandler } from '../types/chatTypes';
import type { ITool } from '../tools/ITool';
import type { ToolResultMetadata } from '../types/toolResultTypes';
import type { RecursiveStateManager } from '../sessions/recursiveStateManager';
import type { FindingStore } from '../sessions/findingStore';
import type { ExecutionContext } from '../types/executionContext';
import type { DiffHunk } from '../types/contextTypes';
import type { SubagentSessionManager } from './subagentSessionManager';
import {
    type ModelCalibrationProfile,
    DEFAULT_PROFILE,
} from '../models/modelCalibration';
import { Log } from './loggingService';
import { isCancellationError } from '../utils/asyncUtils';
import { getErrorMessage } from '../utils/errorUtils';
import { WorkspaceSettingsService } from './workspaceSettingsService';

/**
 * Options for depth-aware recursive subagent execution.
 */
export interface SubagentExecuteOptions {
    /** Recursion depth of the child being spawned (0-based). */
    recursionDepth?: number;
    /** The agent ID in the recursive state tree. */
    agentId?: string;
    /** Recursive state manager for the analysis (shared across all agents). */
    recursiveState?: RecursiveStateManager;
    /** Parsed diff data for on-demand access via diff tools (RLM approach). */
    parsedDiff?: DiffHunk[];
    /** Session manager from parent — enables child to spawn its own subagents. */
    subagentSessionManager?: SubagentSessionManager;
    /** Allocated iteration budget for this child (used as maxIterations). */
    childBudget?: number;
    /** Shared finding store for the analysis — enables subagents to record findings. */
    findingStore?: FindingStore;
    /** Model calibration profile inherited from parent — adjusts prompt behavior. */
    calibrationProfile: ModelCalibrationProfile;
}

/**
 * Executes subagent investigations with isolated context.
 * Thin wrapper that delegates to ConversationRunner - no loop duplication.
 *
 * Created per-analysis for concurrency safety.
 *
 * Responsibilities:
 * - Create isolated conversation context per investigation
 * - Filter tools to prevent infinite recursion (or enable controlled recursion)
 * - Stream tool calls to parent's chat UI with subagent prefix
 * - Return raw response for parent LLM to interpret
 */
export class SubagentExecutor {
    private recursiveState: RecursiveStateManager | undefined;

    constructor(
        private readonly llmClient: ILLMClient,
        private readonly toolRegistry: ToolRegistry,
        private readonly promptGenerator: SubagentPromptGenerator,
        private readonly workspaceSettings: WorkspaceSettingsService,
        private readonly chatHandler?: ChatToolCallHandler,
        private readonly progressCallback?: AnalysisProgressCallback,
        private readonly progressContext?: SubagentProgressContext
    ) {}

    /**
     * Set the recursive state manager for aggregate progress reporting.
     * Called after construction since RecursiveStateManager may be created later.
     */
    setRecursiveState(state: RecursiveStateManager): void {
        this.recursiveState = state;
    }

    /**
     * Report progress with main analysis context prefix.
     */
    private reportProgress(message: string, increment?: number): void {
        if (!this.progressCallback) {
            return;
        }

        // When recursive state is available, show aggregate agent progress
        if (this.recursiveState) {
            const { running, completed, total } =
                this.recursiveState.getAgentProgress();
            if (total > 0) {
                const mainIter = this.progressContext?.getCurrentIteration();
                const mainMax = this.progressContext?.getMaxIterations();
                const turnPrefix =
                    mainIter && mainMax ? `Turn ${mainIter}/${mainMax} · ` : '';
                this.progressCallback(
                    `${turnPrefix}Agents: ${completed}/${total} done${running > 0 ? `, ${running} analyzing` : ''}`,
                    increment
                );
                return;
            }
        }

        if (this.progressContext) {
            const mainIter = this.progressContext.getCurrentIteration();
            const mainMax = this.progressContext.getMaxIterations();
            this.progressCallback(
                `Turn ${mainIter}/${mainMax} → ${message}`,
                increment
            );
        } else {
            this.progressCallback(message, increment);
        }
    }

    /**
     * Execute an isolated subagent investigation.
     * @param task The investigation task
     * @param token Cancellation token
     * @param subagentId Unique ID for this subagent (for logging)
     * @param options Depth-aware recursion options
     */
    async execute(
        task: SubagentTask,
        token: vscode.CancellationToken,
        subagentId: number,
        options?: SubagentExecuteOptions
    ): Promise<SubagentResult> {
        const startTime = Date.now();
        let toolCallsMade = 0;

        const depth = options?.recursionDepth ?? 0;
        const maxDepth = this.workspaceSettings.getMaxRecursionDepth();
        // Only allow recursion when depth permits, a session manager is available,
        // AND recursive state is tracking the agent tree (legacy mode has no
        // recursiveState, so subagents should not get run_subagent).
        const canRecurse =
            depth < maxDepth &&
            !!options?.subagentSessionManager &&
            !!options?.recursiveState;

        // Create short task label for logging and progress (first 30 chars)
        const taskLabel =
            task.task.length > 30
                ? task.task.substring(0, 30).replace(/\s+/g, ' ').trim() + '...'
                : task.task.replace(/\s+/g, ' ').trim();
        const logLabel = options?.agentId
            ? `Agent ${options.agentId}`
            : `Subagent #${subagentId}`;

        try {
            Log.info(
                `${logLabel} Starting (depth=${depth}, canRecurse=${canRecurse}): "${taskLabel}"`
            );
            this.reportProgress(`Sub-analysis: ${taskLabel}`, 0.5);

            const conversation = new ConversationManager();
            let filteredTools = this.filterTools(canRecurse);

            const filteredRegistry = this.createFilteredRegistry(filteredTools);

            // Use allocated budget as maxIterations when available (recursive mode),
            // otherwise fall back to global setting.
            const maxIterations =
                options?.childBudget ??
                this.workspaceSettings.getMaxIterations();

            // Build execution context for the child.
            // When canRecurse: include subagentExecutor and subagentSessionManager
            // so the child's RunSubagentTool can spawn its own children.
            const childContext: ExecutionContext = {
                cancellationToken: token,
                subagentExecutor: canRecurse ? this : undefined,
                subagentSessionManager: canRecurse
                    ? options?.subagentSessionManager
                    : undefined,
                recursiveState: canRecurse
                    ? options?.recursiveState
                    : undefined,
                currentDepth: depth,
                currentAgentId: options?.agentId,
                parsedDiff: options?.parsedDiff,
                findingStore: options?.findingStore,
                calibrationProfile:
                    options?.calibrationProfile ?? DEFAULT_PROFILE,
                toolCallCounts: new Map(),
            };

            const toolExecutor = new ToolExecutor(
                filteredRegistry,
                childContext,
                maxIterations * ANALYSIS_LIMITS.toolCallMultiplier
            );
            const conversationRunner = new ConversationRunner(
                this.llmClient,
                toolExecutor
            );

            const systemPrompt = this.promptGenerator.generateSystemPrompt(
                task,
                filteredTools,
                maxIterations,
                canRecurse,
                childContext.calibrationProfile
            );

            conversation.addUserMessage(`Please investigate: ${task.task}`);

            // Track tool calls made by the subagent with full details
            const toolCalls: ToolCallRecord[] = [];

            // Track which tool names have been used (populated via onToolCallStart
            // so it's available before getContextStatusSuffix fires)
            const toolNamesUsed = new Set<string>();

            // Track iteration state in closure for iteration countdown
            let currentIteration = 0;

            // Create subagent stream adapter for prefixed tool progress in chat UI
            // This shows tool calls with "🔹 child-1: Reading file..." format
            const subagentAdapter = this.chatHandler
                ? new SubagentStreamAdapter(
                      this.chatHandler,
                      subagentId,
                      options?.agentId
                  )
                : undefined;

            // Track whether we've already nudged the subagent for shallow investigation.
            // Fire at most once to avoid infinite loops if the model repeatedly ignores the nudge.
            let shallowInvestigationNudged = false;
            const ORIENTATION_ONLY_TOOLS = new Set([
                'get_file_diff',
                'list_directory',
            ]);

            // Run the conversation loop with labeled logging and progress reporting
            const response = await conversationRunner.run(
                {
                    systemPrompt,
                    maxIterations,
                    tools: filteredTools,
                    label: logLabel,
                    beforeAcceptingResponse: (
                        toolNamesCalled,
                        iteration,
                        maxIter
                    ) => {
                        // Only nudge once, and only if there's budget remaining
                        if (
                            shallowInvestigationNudged ||
                            iteration >= maxIter - 1
                        ) {
                            return undefined;
                        }
                        // If the subagent only called orientation tools (or no tools),
                        // nudge it to investigate deeper
                        const hasInvestigationTools = [...toolNamesCalled].some(
                            (name) => !ORIENTATION_ONLY_TOOLS.has(name)
                        );
                        if (
                            toolNamesCalled.size > 0 &&
                            !hasInvestigationTools
                        ) {
                            shallowInvestigationNudged = true;
                            return (
                                'You only read the diff without investigating the actual codebase. ' +
                                'Reading diffs is orientation, not investigation. You MUST use tools like ' +
                                '`find_symbol` (with include_body: true), `find_usages`, or `search_for_pattern` ' +
                                'to gather evidence before writing findings. Continue investigating.'
                            );
                        }
                        return undefined;
                    },
                },
                conversation,
                token,
                {
                    onIterationStart: (current, max) => {
                        currentIteration = current;
                        // Report to VS Code progress bar (command palette flow).
                        // Chat UI iteration is suppressed by SubagentStreamAdapter's no-op onIterationStart.
                        this.reportProgress(
                            `Sub-analysis (${current}/${max})...`,
                            0.1
                        );
                    },
                    getContextStatusSuffix: async () => {
                        const remaining = maxIterations - currentIteration;

                        if (remaining <= 2) {
                            return (
                                `\n\n⚠️ **CRITICAL: ${remaining} iteration(s) remaining!** ` +
                                'Produce your COMPLETE findings in your next response. ' +
                                'A partial answer is far more valuable than no answer. ' +
                                'Stop investigating and write up what you have found.'
                            );
                        }

                        // Nudge child to continue investigating if it has only read diffs so far.
                        // onToolCallStart populates toolNamesUsed before this callback fires,
                        // so we reliably know which tools were called in the current batch.
                        const hasInvestigated = [...toolNamesUsed].some(
                            (n) => !ORIENTATION_ONLY_TOOLS.has(n)
                        );
                        if (toolNamesUsed.size > 0 && !hasInvestigated) {
                            if (canRecurse) {
                                return (
                                    '\n\nDiff reading is orientation. If your task spans 4+ files, spawn sub-agents now. ' +
                                    'For 1-3 files, call `find_symbol` (include_body: true) and `find_usages` to investigate changed code before writing findings.'
                                );
                            }
                            return (
                                '\n\nDiff reading is step 1. Now call `find_symbol` (include_body: true) ' +
                                'for changed function implementations, `find_usages` for caller analysis, or ' +
                                '`search_for_pattern` for codebase-wide patterns. ' +
                                'Findings based only on diff content lack the surrounding context needed for accurate review.'
                            );
                        }

                        if (currentIteration >= 3) {
                            return `\n\n[Iteration ${currentIteration}/${maxIterations}]`;
                        }

                        return '';
                    },
                    onToolCallStart: (
                        toolName,
                        args,
                        toolIndex,
                        totalTools
                    ) => {
                        toolNamesUsed.add(toolName);
                        // Forward to subagent adapter for prefixed chat UI display
                        subagentAdapter?.onToolCallStart(
                            toolName,
                            args,
                            toolIndex,
                            totalTools
                        );
                    },
                    onToolCallComplete: (
                        toolCallId: string,
                        toolName: string,
                        args: Record<string, unknown>,
                        result: string,
                        success: boolean,
                        error?: string,
                        durationMs?: number,
                        metadata?: ToolResultMetadata
                    ) => {
                        toolCallsMade++;
                        toolCalls.push({
                            id: toolCallId,
                            toolName,
                            arguments: args,
                            result,
                            success,
                            error,
                            durationMs,
                            timestamp: Date.now(),
                            nestedCalls: metadata?.nestedToolCalls,
                            executionTimeMs: metadata?.executionTimeMs,
                            iterationsUsed: metadata?.iterationsUsed,
                        });
                        // Forward to subagent adapter for chat UI completion feedback
                        subagentAdapter?.onToolCallComplete(
                            toolCallId,
                            toolName,
                            args,
                            result,
                            success,
                            error,
                            durationMs,
                            metadata
                        );
                    },
                }
            );

            const duration = Date.now() - startTime;

            // Check max iterations first — runner completed but hit the limit.
            // This must be checked before cancellation since the token may also
            // be cancelled (e.g., timeout fired while runner was on its last iteration).
            if (conversationRunner.hitMaxIterations) {
                Log.warn(
                    `${logLabel} Reached max iterations (${currentIteration}/${maxIterations}) after ${duration}ms with ${toolCallsMade} tool calls`
                );
                return {
                    success: false,
                    response,
                    toolCallsMade,
                    toolCalls,
                    executionTimeMs: duration,
                    iterationsUsed: conversationRunner.iterationsUsed,
                    error: 'max_iterations',
                };
            }

            // True quota exhaustion (HTTP 402, ChatQuotaExceeded): monthly limit,
            // non-recoverable until reset. Distinct from ChatRateLimited (HTTP 429).
            if (conversationRunner.hitQuotaExhausted) {
                Log.error(
                    `${logLabel} Quota exhausted at iteration ${currentIteration}/${maxIterations} after ${duration}ms with ${toolCallsMade} tool calls`
                );
                return {
                    success: false,
                    response,
                    toolCallsMade,
                    toolCalls,
                    executionTimeMs: duration,
                    iterationsUsed: conversationRunner.iterationsUsed,
                    error: 'quota_exhausted',
                };
            }

            // Rate-limit exhaustion: runner ran out of retries, not iteration budget.
            if (conversationRunner.hitRateLimit) {
                Log.warn(
                    `${logLabel} Rate limited at iteration ${currentIteration}/${maxIterations} after ${duration}ms with ${toolCallsMade} tool calls`
                );
                return {
                    success: false,
                    response,
                    toolCallsMade,
                    toolCalls,
                    executionTimeMs: duration,
                    iterationsUsed: conversationRunner.iterationsUsed,
                    error: 'rate_limited',
                };
            }

            // Check cancellation using the runner's boolean flag rather than
            // comparing the response string, avoiding any risk of false detection.
            if (conversationRunner.wasCancelled) {
                Log.warn(
                    `${logLabel} Cancelled at iteration ${currentIteration}/${maxIterations} after ${duration}ms with ${toolCallsMade} tool calls`
                );
                return {
                    success: false,
                    response: '',
                    toolCallsMade,
                    toolCalls,
                    executionTimeMs: duration,
                    iterationsUsed: conversationRunner.iterationsUsed,
                    error: 'cancelled',
                };
            }

            Log.info(
                `${logLabel} Completed in ${duration}ms (${currentIteration}/${maxIterations} iterations, ${toolCallsMade} tool calls)`
            );

            return {
                success: true,
                response,
                toolCallsMade,
                toolCalls,
                executionTimeMs: duration,
                iterationsUsed: conversationRunner.iterationsUsed,
            };
        } catch (error) {
            if (isCancellationError(error)) {
                throw error;
            }

            const errorMessage = getErrorMessage(error);
            Log.error(`${logLabel} Failed: ${errorMessage}`, error);

            return {
                success: false,
                response: '',
                toolCallsMade,
                toolCalls: [],
                executionTimeMs: Date.now() - startTime,
                error: errorMessage,
            };
        }
    }

    /**
     * Filter tools based on recursion capability.
     * When canRecurse is true, only exclude root-only tools (plan, review, reflection).
     * When canRecurse is false, exclude everything including run_subagent (current flat behavior).
     */
    private filterTools(canRecurse: boolean): ITool[] {
        const disallowed: readonly string[] = canRecurse
            ? RECURSIVE_CHILD_DISALLOWED_TOOLS
            : SubagentLimits.DISALLOWED_TOOLS;

        return this.toolRegistry
            .getAllTools()
            .filter((tool) => !disallowed.includes(tool.name));
    }

    /**
     * Create a filtered registry with only allowed tools.
     */
    private createFilteredRegistry(tools: ITool[]): ToolRegistry {
        const registry = new ToolRegistry();
        for (const tool of tools) {
            registry.registerTool(tool);
        }
        return registry;
    }
}
