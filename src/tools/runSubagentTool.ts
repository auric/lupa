import * as z from 'zod';
import * as vscode from 'vscode';
import { BaseTool } from './baseTool';
import { SubagentLimits, SubagentErrors } from '../models/toolConstants';
import { RecursionConstants } from '../sessions/recursiveStateManager';
import type { SubagentResult } from '../types/modelTypes';
import { ToolResult, toolSuccess, toolError } from '../types/toolResultTypes';
import { ExecutionContext } from '../types/executionContext';
import { Log } from '../services/loggingService';
import { WorkspaceSettingsService } from '../services/workspaceSettingsService';
import { isCancellationError } from '../utils/asyncUtils';
import { getErrorMessage } from '../utils/errorUtils';
import type { RecursiveStateManager } from '../sessions/recursiveStateManager';

/**
 * Tool that spawns isolated subagent investigations.
 * Delegates execution to SubagentExecutor, tracks usage via SubagentSessionManager.
 *
 * Both SubagentExecutor and SubagentSessionManager are obtained from ExecutionContext
 * (created per-analysis) for concurrency safety.
 */
export class RunSubagentTool extends BaseTool {
    name = 'run_subagent';
    description = `Spawn a focused investigation sub-agent for deep analysis.

Sub-agents run autonomously with their own tool access and return structured findings.
When diff tools are available (RLM approach), sub-agents can examine PR changes directly via get_file_diff.

⚡ PARALLEL: You can make MULTIPLE run_subagent calls in the same response — they execute in parallel. Spawn ALL sub-agents at once, do NOT call run_subagent one at a time.

📋 TASK TEMPLATE:
"Review [concern] in [files]:
Questions:
1. [Specific question about code/changes]
2. [Specific question about code/changes]
Files: [file1.ts, file2.ts]
Focus on: [key functions/classes]"

RULES:
- Include specific file paths — sub-agents examine the files you assign
- Target 2-4 files per sub-agent for thorough review
- Sub-agents CANNOT run tests or execute code
- ALWAYS spawn ALL sub-agents in the same response (parallel execution)

MANDATORY when: 4+ files to review, security-critical code, complex dependency chains.`;

    schema: z.ZodObject<{
        task: z.ZodString;
        context: z.ZodOptional<z.ZodString>;
    }>;

    constructor(private readonly workspaceSettings: WorkspaceSettingsService) {
        super();

        this.schema = z.object({
            task: z
                .string()
                .min(
                    SubagentLimits.MIN_TASK_LENGTH,
                    SubagentErrors.taskTooShort(SubagentLimits.MIN_TASK_LENGTH)
                )
                .describe(
                    'Detailed investigation task. Include: ' +
                        '1) WHAT to investigate (specific question or concern), ' +
                        '2) WHERE to look (relevant files, directories, symbols), ' +
                        '3) WHAT to return (expected deliverables).'
                ),
            context: z
                .string()
                .optional()
                .describe(
                    'Relevant context from your current analysis: code snippets, file paths, findings, or symbol names.'
                ),
        });
    }

    async execute(
        args: z.infer<typeof this.schema>,
        context: ExecutionContext
    ): Promise<ToolResult> {
        if (context.cancellationToken.isCancellationRequested) {
            throw new vscode.CancellationError();
        }

        // Get per-analysis dependencies from ExecutionContext
        const executor = context.subagentExecutor;
        const sessionManager = context.subagentSessionManager;
        const recursiveState = context.recursiveState as
            | RecursiveStateManager
            | undefined;
        const currentDepth = context.currentDepth ?? 0;
        const currentAgentId = context.currentAgentId ?? 'root';

        if (!executor || !sessionManager) {
            return toolError(
                'Subagent execution requires ExecutionContext with subagentExecutor and subagentSessionManager. This is an internal error.'
            );
        }

        const validationResult = this.schema.safeParse(args);
        if (!validationResult.success) {
            return toolError(
                validationResult.error.issues.map((e) => e.message).join(', ')
            );
        }

        const { task, context: taskContext } = validationResult.data;
        const maxSubagents = this.workspaceSettings.getMaxSubagentsPerSession();

        // Hard limit: session manager tracks total spawns across all depths.
        if (!sessionManager.canSpawn()) {
            Log.warn(
                `Subagent spawn rejected: session limit reached (${maxSubagents})`
            );
            return toolError(SubagentErrors.maxExceeded(maxSubagents));
        }

        // Recursive budget guard: check depth and per-agent budget limits.
        if (recursiveState) {
            const guard = recursiveState.canSpawnChild(currentAgentId);
            if (!guard.allowed) {
                Log.warn(
                    `Subagent spawn rejected by RecursiveStateManager: ${guard.reason}`
                );
                return toolError(
                    guard.reason ?? 'Cannot spawn child agent at this depth'
                );
            }
        }

        const subagentId = sessionManager.recordSpawn();
        const remaining = sessionManager.getRemainingBudget();
        Log.info(
            `Subagent #${subagentId} spawned (${sessionManager.getCount()}/${maxSubagents}, ${remaining} remaining)`
        );

        let childAgentId: string | undefined;
        let childBudget: number | undefined;
        if (recursiveState) {
            childBudget = recursiveState.allocateChildBudget(currentAgentId);
            try {
                childAgentId = recursiveState.registerAgent(
                    currentAgentId,
                    task,
                    childBudget
                );
            } catch (error) {
                sessionManager.rollbackSpawn();
                Log.error(
                    `Failed to register agent in recursive tree: ${getErrorMessage(error)}`
                );
                return toolError(
                    `Failed to register subagent: ${getErrorMessage(error)}`
                );
            }
            recursiveState.startAgent(childAgentId);
        }

        // Compute subagent execution timeout.
        // In recursive mode (childBudget defined): proportional to iteration budget,
        // allowing ~30s per iteration with a 2-minute minimum floor.
        // In flat mode: use the configured requestTimeoutSeconds.
        const timeoutMs =
            childBudget !== undefined
                ? Math.max(
                      RecursionConstants.MIN_SUBAGENT_TIMEOUT_MS,
                      childBudget * RecursionConstants.TIMEOUT_PER_ITERATION_MS
                  )
                : this.workspaceSettings.getRequestTimeoutSeconds() * 1000;

        // Subagent needs a combined cancellation signal: cancel on parent cancellation OR timeout.
        // We can't add timeout to the parent token (would cancel the entire analysis), so we
        // create a local source and link it to the parent via sessionManager.
        // Local variable (not instance) prevents race condition with parallel subagents.
        const cancellationTokenSource = new vscode.CancellationTokenSource();
        const parentCancellationDisposable =
            sessionManager.registerSubagentCancellation(
                cancellationTokenSource
            );
        let cancelledByTimeout = false;
        const timeoutHandle = setTimeout(() => {
            cancelledByTimeout = true;
            cancellationTokenSource.cancel();
        }, timeoutMs);

        try {
            const result = await executor.execute(
                {
                    task,
                    context: taskContext,
                },
                cancellationTokenSource.token,
                subagentId,
                {
                    recursionDepth: currentDepth + 1,
                    agentId: childAgentId,
                    recursiveState,
                    parsedDiff: context.parsedDiff,
                    subagentSessionManager: sessionManager,
                    childBudget,
                }
            );

            clearTimeout(timeoutHandle);

            if (recursiveState && childAgentId) {
                if (result.success) {
                    recursiveState.completeAgent(childAgentId);
                } else if (result.error === 'cancelled') {
                    recursiveState.cancelAgent(childAgentId);
                } else {
                    recursiveState.failAgent(
                        childAgentId,
                        result.error ?? 'Unknown error'
                    );
                }
            }

            if (!result.success && result.error === 'cancelled') {
                // Only attribute to timeout if parent wasn't also cancelled.
                // Race condition: timeout timer can fire while executor unwinds
                // from parent cancellation, setting cancelledByTimeout incorrectly.
                if (
                    cancelledByTimeout &&
                    !context.cancellationToken.isCancellationRequested
                ) {
                    return toolError(SubagentErrors.timeout(timeoutMs));
                }
                return toolError('Subagent was cancelled');
            }

            if (!result.success && result.error === 'max_iterations') {
                const actualMaxIterations =
                    childBudget ?? this.workspaceSettings.getMaxIterations();
                const maxIterMsg = SubagentErrors.maxIterations(
                    result.toolCallsMade,
                    actualMaxIterations
                );
                // Include partial response so parent LLM can use findings gathered so far
                const partialFindings = result.response?.trim();
                return toolError(
                    partialFindings
                        ? `${maxIterMsg}\n\nPartial findings:\n${partialFindings}`
                        : maxIterMsg
                );
            }

            // Any other failure (LLM errors, service errors, etc.)
            if (!result.success) {
                sessionManager.rollbackSpawn();
                return toolError(
                    SubagentErrors.failed(result.error || 'Unknown error')
                );
            }

            return toolSuccess(this.formatResult(result, subagentId), {
                nestedToolCalls: result.toolCalls,
            });
        } catch (error) {
            clearTimeout(timeoutHandle);

            if (recursiveState && childAgentId) {
                if (isCancellationError(error)) {
                    recursiveState.cancelAgent(childAgentId);
                } else {
                    recursiveState.failAgent(
                        childAgentId,
                        getErrorMessage(error)
                    );
                }
            }

            if (isCancellationError(error)) {
                throw error;
            }

            if (
                cancelledByTimeout &&
                !context.cancellationToken.isCancellationRequested
            ) {
                return toolError(SubagentErrors.timeout(timeoutMs));
            }

            const errorMessage = getErrorMessage(error);
            sessionManager.rollbackSpawn();
            return toolError(SubagentErrors.failed(errorMessage));
        } finally {
            parentCancellationDisposable?.dispose();
            cancellationTokenSource.dispose();
        }
    }

    /**
     * Format successful subagent result for parent LLM consumption.
     */
    private formatResult(result: SubagentResult, subagentId: number): string {
        return (
            `## Subagent #${subagentId} Investigation Complete\n\n` +
            `**Tool calls made:** ${result.toolCallsMade}\n\n` +
            `---\n\n${result.response}`
        );
    }
}
