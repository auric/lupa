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
    description = `Spawn an isolated agent for complex, multi-file investigations. USE THIS for deep analysis to avoid cluttering your main context.

**STRONGLY RECOMMENDED when:**
- PR touches 3+ files → delegate component-specific investigations
- Need to trace impact across multiple modules
- Security/performance concerns requiring deep code inspection
- Complex dependency chains need tracing

**NOT needed for:**
- Single symbol lookup → use find_symbol directly
- Reading one file → use read_file directly
- Quick regex search → use search_for_pattern directly

**Task format:** Include WHAT to investigate, WHERE to look, WHAT to return.
Example: "Investigate error handling in src/api/. For each endpoint: check try/catch coverage, error response format, logging. Return: list of gaps with file:line references."`;

    private maxIterationsFromSettings: number;

    schema: z.ZodObject<{
        task: z.ZodString;
        context: z.ZodOptional<z.ZodString>;
        max_tool_calls: z.ZodOptional<z.ZodDefault<z.ZodNumber>>;
    }>;

    private cancellationTokenSource: vscode.CancellationTokenSource | null = null;

    constructor(
        private readonly executor: SubagentExecutor,
        private readonly sessionManager: SubagentSessionManager,
        private readonly workspaceSettings: WorkspaceSettingsService
    ) {
        super();
        this.maxIterationsFromSettings = this.workspaceSettings.getMaxIterations();

        // Build schema with dynamic defaults from settings
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
            max_tool_calls: z.number()
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

        const { task, context, max_tool_calls } = validationResult.data;

        // Check session limits
        if (!this.sessionManager.canSpawn()) {
            Log.warn(`Subagent spawn rejected: session limit reached (${SubagentLimits.MAX_PER_SESSION})`);
            return toolError(SubagentErrors.maxExceeded(SubagentLimits.MAX_PER_SESSION));
        }

        // Record spawn and get the subagent ID for logging
        const subagentId = this.sessionManager.recordSpawn();
        const remaining = this.sessionManager.getRemainingBudget();
        Log.info(`Subagent #${subagentId} spawned (${this.sessionManager.getCount()}/${SubagentLimits.MAX_PER_SESSION}, ${remaining} remaining)`);

        // Create cancellation token for timeout
        this.cancellationTokenSource = new vscode.CancellationTokenSource();

        // Set up timeout
        const timeoutHandle = setTimeout(() => {
            this.cancellationTokenSource?.cancel();
        }, SubagentLimits.TIMEOUT_MS);

        try {
            const result = await this.executor.execute(
                {
                    task,
                    context,
                    maxToolCalls: max_tool_calls
                },
                this.cancellationTokenSource.token,
                subagentId
            );

            clearTimeout(timeoutHandle);

            // Include nested tool calls in metadata for webview display
            return toolSuccess(
                this.formatResult(result, subagentId),
                { nestedToolCalls: result.toolCalls }
            );

        } catch (error) {
            clearTimeout(timeoutHandle);

            if (this.cancellationTokenSource?.token.isCancellationRequested) {
                return toolError(SubagentErrors.timeout(SubagentLimits.TIMEOUT_MS));
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
