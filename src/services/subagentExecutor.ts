import * as vscode from 'vscode';
import { ConversationManager } from '../models/conversationManager';
import { ConversationRunner } from '../models/conversationRunner';
import { ToolRegistry } from '../models/toolRegistry';
import { ToolExecutor } from '../models/toolExecutor';
import { CopilotModelManager } from '../models/copilotModelManager';
import { SubagentPromptGenerator } from '../prompts/subagentPromptGenerator';
import {
    SubagentLimits,
    RECURSIVE_CHILD_DISALLOWED_TOOLS,
} from '../models/toolConstants';
import { SubagentStreamAdapter } from '../models/subagentStreamAdapter';
import type { SubagentTask, SubagentResult } from '../types/modelTypes';
import type {
    ToolCallRecord,
    AnalysisProgressCallback,
    SubagentProgressContext,
} from '../types/toolCallTypes';
import type { ChatToolCallHandler } from '../types/chatTypes';
import type { ITool } from '../tools/ITool';
import type { ToolResultMetadata } from '@/types/toolResultTypes';
import type { RecursiveStateManager } from '../sessions/recursiveStateManager';
import type { ExecutionContext } from '../types/executionContext';
import type { DiffHunk } from '../types/contextTypes';
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
    constructor(
        private readonly modelManager: CopilotModelManager,
        private readonly toolRegistry: ToolRegistry,
        private readonly promptGenerator: SubagentPromptGenerator,
        private readonly workspaceSettings: WorkspaceSettingsService,
        private readonly chatHandler?: ChatToolCallHandler,
        private readonly progressCallback?: AnalysisProgressCallback,
        private readonly progressContext?: SubagentProgressContext
    ) {}

    /**
     * Report progress with main analysis context prefix.
     */
    private reportProgress(message: string, increment?: number): void {
        if (!this.progressCallback) {
            return;
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
        const canRecurse = depth < maxDepth;

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
            const filteredTools = this.filterTools(canRecurse);
            const filteredRegistry = this.createFilteredRegistry(filteredTools);

            // Build execution context for the child.
            // When canRecurse: include subagentExecutor and subagentSessionManager
            // so the child's RunSubagentTool can spawn its own children.
            const childContext: ExecutionContext = {
                cancellationToken: token,
                subagentExecutor: canRecurse ? this : undefined,
                subagentSessionManager: undefined, // Session manager is on the parent; child uses its own budget via RecursiveStateManager
                recursiveState: options?.recursiveState,
                currentDepth: options?.recursiveState ? depth : undefined,
                currentAgentId: options?.agentId,
                parsedDiff: options?.parsedDiff,
            };

            const toolExecutor = new ToolExecutor(
                filteredRegistry,
                this.workspaceSettings,
                childContext
            );
            const conversationRunner = new ConversationRunner(
                this.modelManager,
                toolExecutor
            );

            const maxIterations = this.workspaceSettings.getMaxIterations();
            const systemPrompt = this.promptGenerator.generateSystemPrompt(
                task,
                filteredTools,
                maxIterations,
                canRecurse
            );

            conversation.addUserMessage(`Please investigate: ${task.task}`);

            // Track tool calls made by the subagent with full details
            const toolCalls: ToolCallRecord[] = [];

            // Create subagent stream adapter for prefixed tool progress in chat UI
            // This shows tool calls with "🔹 #N: Reading file..." format
            const subagentAdapter = this.chatHandler
                ? new SubagentStreamAdapter(this.chatHandler, subagentId, depth)
                : undefined;

            // Run the conversation loop with labeled logging and progress reporting
            const response = await conversationRunner.run(
                {
                    systemPrompt,
                    maxIterations,
                    tools: filteredTools,
                    label: logLabel,
                },
                conversation,
                token,
                {
                    onIterationStart: (current, max) => {
                        // Report to VS Code progress bar (command palette flow).
                        // Chat UI iteration is suppressed by SubagentStreamAdapter's no-op onIterationStart.
                        this.reportProgress(
                            `Sub-analysis (${current}/${max})...`,
                            0.1
                        );
                    },
                    onToolCallStart: (
                        toolName,
                        args,
                        toolIndex,
                        totalTools
                    ) => {
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
                    `${logLabel} Reached max iterations after ${duration}ms with ${toolCallsMade} tool calls`
                );
                return {
                    success: false,
                    response,
                    toolCallsMade,
                    toolCalls,
                    error: 'max_iterations',
                };
            }

            // Check cancellation using the runner's boolean flag rather than
            // comparing the response string, avoiding any risk of false detection.
            if (conversationRunner.wasCancelled) {
                Log.warn(
                    `${logLabel} Cancelled after ${duration}ms with ${toolCallsMade} tool calls`
                );
                return {
                    success: false,
                    response: '',
                    toolCallsMade,
                    toolCalls,
                    error: 'cancelled',
                };
            }

            Log.info(
                `${logLabel} Completed in ${duration}ms with ${toolCallsMade} tool calls`
            );

            return {
                success: true,
                response,
                toolCallsMade,
                toolCalls,
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
