import { z } from 'zod';
import * as vscode from 'vscode';
import { BaseTool } from './baseTool';
import { SubagentExecutor } from '../services/subagentExecutor';
import { SubagentSessionManager } from '../services/subagentSessionManager';
import { SubagentLimits, SubagentErrors } from '../models/toolConstants';
import type { SubagentResult } from '../types/modelTypes';
import { ToolResult, toolSuccess, toolError } from '../types/toolResultTypes';
import { Log } from '../services/loggingService';
import { WorkspaceSettingsService } from '../services/workspaceSettingsService';

/**
 * Tool that spawns isolated subagent investigations.
 * Delegates execution to SubagentExecutor, tracks usage via SubagentSessionManager.
 */
export class RunSubagentTool extends BaseTool {
    name = 'run_subagent';
    description = `Spawn a focused investigation agent for complex, multi-file analysis.

MANDATORY when:
- PR has 4+ files → parallelize analysis
- Security-sensitive code (auth, crypto, user data)
- Complex dependency chains (3+ files to trace)

MUST provide in context parameter: Relevant code snippets from the diff!
Subagents CANNOT see the diff—you must pass the code they need to investigate.

Task format: WHAT to investigate, WHERE to look, WHAT to return.
Example: "Investigate error handling in OrderService.processPayment. Check: try/catch coverage, error logging, user-facing messages. Return: gaps with file:line and severity."`;

    private maxIterationsFromSettings: number;

    schema: z.ZodObject<{
        task: z.ZodString;
        context: z.ZodOptional<z.ZodString>;
        max_iterations: z.ZodOptional<z.ZodDefault<z.ZodNumber>>;
    }>;

    private cancellationTokenSource: vscode.CancellationTokenSource | null = null;

    constructor(
        private readonly executor: SubagentExecutor,
        private readonly sessionManager: SubagentSessionManager,
        private readonly workspaceSettings: WorkspaceSettingsService
    ) {
        super();
        this.maxIterationsFromSettings = this.workspaceSettings.getMaxIterations();

        this.schema = z.object({
            task: z.string()
                .min(SubagentLimits.MIN_TASK_LENGTH, SubagentErrors.taskTooShort(SubagentLimits.MIN_TASK_LENGTH))
                .describe(
                    'Detailed investigation task. Include: ' +
                    '1) WHAT to investigate (specific question or concern), ' +
                    '2) WHERE to look (relevant files, directories, symbols), ' +
                    '3) WHAT to return (expected deliverables).'
                ),
            context: z.string().optional().describe(
                'Relevant context from your current analysis: code snippets, file paths, findings, or symbol names.'
            ),
            max_iterations: z.number()
                .min(1)
                .max(this.maxIterationsFromSettings)
                .default(this.maxIterationsFromSettings)
                .optional()
                .describe(
                    `Maximum iterations for the subagent (default: ${this.maxIterationsFromSettings}). ` +
                    'Increase for complex investigations, decrease for focused lookups.'
                )
        });
    }

    async execute(args: z.infer<typeof this.schema>): Promise<ToolResult> {
        const validationResult = this.schema.safeParse(args);
        if (!validationResult.success) {
            return toolError(validationResult.error.issues.map(e => e.message).join(', '));
        }

        const { task, context, max_iterations } = validationResult.data;
        const maxSubagents = this.workspaceSettings.getMaxSubagentsPerSession();
        const timeoutMs = this.workspaceSettings.getSubagentTimeoutMs();

        if (!this.sessionManager.canSpawn()) {
            Log.warn(`Subagent spawn rejected: session limit reached (${maxSubagents})`);
            return toolError(SubagentErrors.maxExceeded(maxSubagents));
        }

        const subagentId = this.sessionManager.recordSpawn();
        const remaining = this.sessionManager.getRemainingBudget();
        Log.info(`Subagent #${subagentId} spawned (${this.sessionManager.getCount()}/${maxSubagents}, ${remaining} remaining)`);

        this.cancellationTokenSource = new vscode.CancellationTokenSource();
        const timeoutHandle = setTimeout(() => {
            this.cancellationTokenSource?.cancel();
        }, timeoutMs);

        try {
            const result = await this.executor.execute(
                {
                    task,
                    context,
                    maxIterations: max_iterations
                },
                this.cancellationTokenSource.token,
                subagentId
            );

            clearTimeout(timeoutHandle);

            // Check if cancelled (timeout or user)
            if (!result.success && result.error === 'cancelled') {
                if (this.cancellationTokenSource?.token.isCancellationRequested) {
                    return toolError(SubagentErrors.timeout(timeoutMs));
                }
                return toolError('Subagent was cancelled');
            }

            return toolSuccess(
                this.formatResult(result, subagentId),
                { nestedToolCalls: result.toolCalls }
            );

        } catch (error) {
            clearTimeout(timeoutHandle);

            if (this.cancellationTokenSource?.token.isCancellationRequested) {
                return toolError(SubagentErrors.timeout(timeoutMs));
            }

            const errorMessage = error instanceof Error ? error.message : String(error);
            return toolError(SubagentErrors.failed(errorMessage));

        } finally {
            this.cancellationTokenSource?.dispose();
            this.cancellationTokenSource = null;
        }
    }

    /**
     * Format subagent result for parent LLM consumption.
     * Returns the raw response with minimal metadata - parent LLM interprets naturally.
     */
    private formatResult(result: SubagentResult, subagentId: number): string {
        if (!result.success) {
            return `## Subagent #${subagentId} Failed\n\nError: ${result.error}\n\nTool calls made: ${result.toolCallsMade}`;
        }

        return `## Subagent #${subagentId} Investigation Complete\n\n` +
            `**Tool calls made:** ${result.toolCallsMade}\n\n` +
            `---\n\n${result.response}`;
    }
}
