import * as z from 'zod';
import * as vscode from 'vscode';
import { BaseTool } from './baseTool';
import { SubagentLimits, SubagentErrors } from '../models/toolConstants';
import type { SubagentResult } from '../types/modelTypes';
import { ToolResult, toolSuccess, toolError } from '../types/toolResultTypes';
import { ExecutionContext } from '../types/executionContext';
import { Log } from '../services/loggingService';
import { WorkspaceSettingsService } from '../services/workspaceSettingsService';
import { isCancellationError } from '../utils/asyncUtils';
import { getErrorMessage } from '../utils/errorUtils';

/**
 * Tool that spawns isolated subagent investigations.
 * Delegates execution to SubagentExecutor, tracks usage via SubagentSessionManager.
 *
 * Both SubagentExecutor and SubagentSessionManager are obtained from ExecutionContext
 * (created per-analysis) for concurrency safety.
 */
export class RunSubagentTool extends BaseTool {
    name = 'run_subagent';
    description = `Spawn a focused investigation agent for complex analysis.

📋 USE THIS TEMPLATE:
"Task about [module/file]:
Questions:
1. How does [function] work?
2. Does [function] handle [concern]?
Examine: [function names]"

RULES:
- ONE MODULE per subagent (spawn multiple for multiple modules)
- Questions about CURRENT code only (no "changes", "new", "old")
- Subagent CANNOT run tests or execute code

MANDATORY when: 4+ files, security code, 3+ file dependency chains.`;

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
        const timeoutMs =
            this.workspaceSettings.getRequestTimeoutSeconds() * 1000;

        if (!sessionManager.canSpawn()) {
            Log.warn(
                `Subagent spawn rejected: session limit reached (${maxSubagents})`
            );
            return toolError(SubagentErrors.maxExceeded(maxSubagents));
        }

        const subagentId = sessionManager.recordSpawn();
        const remaining = sessionManager.getRemainingBudget();
        Log.info(
            `Subagent #${subagentId} spawned (${sessionManager.getCount()}/${maxSubagents}, ${remaining} remaining)`
        );

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
                subagentId
            );

            clearTimeout(timeoutHandle);

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
                const maxIterMsg = SubagentErrors.maxIterations(
                    result.toolCallsMade,
                    this.workspaceSettings.getMaxIterations()
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
                return toolError(
                    SubagentErrors.failed(result.error || 'Unknown error')
                );
            }

            return toolSuccess(this.formatResult(result, subagentId), {
                nestedToolCalls: result.toolCalls,
            });
        } catch (error) {
            clearTimeout(timeoutHandle);

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
