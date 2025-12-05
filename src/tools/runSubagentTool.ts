import { z } from 'zod';
import * as vscode from 'vscode';
import { BaseTool } from './baseTool';
import { SubagentExecutor } from '../services/subagentExecutor';
import { SubagentSessionManager } from '../services/subagentSessionManager';
import { SubagentLimits, SubagentErrors } from '../models/toolConstants';
import type { SubagentResult } from '../types/modelTypes';
import { ToolResult, toolSuccess, toolError } from '../types/toolResultTypes';
import { Log } from '../services/loggingService';

/**
 * Tool that spawns isolated subagent investigations.
 * Delegates execution to SubagentExecutor, tracks usage via SubagentSessionManager.
 */
export class RunSubagentTool extends BaseTool {
    name = 'run_subagent';
    description = `Spawn an isolated agent for complex, multi-file investigations.

**When to use:**
- Deep analysis spanning multiple files or components
- Impact assessment requiring extensive usage tracing
- Complex pattern discovery across the codebase
- When investigation would clutter your main context

**When NOT to use (use direct tools instead):**
- Simple symbol lookups → use find_symbol
- Reading a single file → use read_file
- Quick pattern search → use search_for_pattern

**Writing effective tasks:**
Include: 1) WHAT to investigate, 2) WHERE to look, 3) WHAT to return

Example: "Investigate JWT handling in src/auth/. Check signature validation, timing protection, expiry handling. Return: Security issues with severity and line numbers."`;

    schema = z.object({
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
            .max(SubagentLimits.MAX_TOOL_CALLS)
            .default(SubagentLimits.DEFAULT_TOOL_CALLS)
            .optional()
            .describe(
                `Maximum tool calls for the subagent (default: ${SubagentLimits.DEFAULT_TOOL_CALLS}, max: ${SubagentLimits.MAX_TOOL_CALLS}). ` +
                'Increase for complex investigations, decrease for focused lookups.'
            )
    });

    private cancellationTokenSource: vscode.CancellationTokenSource | null = null;

    constructor(
        private readonly executor: SubagentExecutor,
        private readonly sessionManager: SubagentSessionManager
    ) {
        super();
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

        this.sessionManager.recordSpawn();
        const remaining = this.sessionManager.getRemainingBudget();
        Log.info(`Subagent spawned (${this.sessionManager.getCount()}/${SubagentLimits.MAX_PER_SESSION}, ${remaining} remaining)`);

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
                this.cancellationTokenSource.token
            );

            clearTimeout(timeoutHandle);
            return toolSuccess(this.formatResult(result));

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
     */
    private formatResult(result: SubagentResult): string {
        if (!result.success) {
            return `## Subagent Investigation Failed\n\nError: ${result.error}\n\nTool calls made: ${result.toolCallsMade}`;
        }

        let output = `## Subagent Investigation Complete\n\n`;
        output += `**Tool calls made:** ${result.toolCallsMade}\n\n`;

        if (result.summary) {
            output += `### Summary\n${result.summary}\n\n`;
        }

        if (result.findings) {
            output += `### Detailed Findings\n${result.findings}\n\n`;
        }

        if (result.answer) {
            output += `### Answer\n${result.answer}\n`;
        }

        return output;
    }
}
