import * as z from 'zod';
import * as vscode from 'vscode';
import { BaseTool } from './baseTool';
import { ToolResult, toolSuccess } from '../types/toolResultTypes';
import { ExecutionContext } from '../types/executionContext';
import { flexibleStringArray } from './schemaHelpers';

/**
 * Unified thinking tool. Forces the LLM to think out loud at any point
 * during analysis — context reflection, code change reasoning, investigation
 * progress, or task alignment.
 *
 * Uses a flat, 4-field schema to maximize adoption by all models.
 * Replaces: think_about_context, think_about_investigation,
 * think_about_task, and think_about_code_change.
 */
export class ThinkTool extends BaseTool {
    name = 'think';
    description =
        'MANDATORY: Think out loud after EVERY diff read and before conclusions. ' +
        'Your NEXT call after get_file_diff MUST be this tool. ' +
        'Write your reasoning, list risks, decide what to do next.';

    schema = z
        .object({
            topic: z
                .string()
                .describe(
                    'What you are thinking about (e.g., "auth changes in login.ts", "investigation progress", "context gaps")'
                ),
            analysis: z
                .string()
                .describe(
                    'Your reasoning: what you know, what changed, what concerns you, what looks correct'
                ),
            identified_risks: flexibleStringArray.describe(
                'Specific risks, concerns, or gaps identified (empty array if none)'
            ),
            next_action: z
                .string()
                .describe(
                    'What to do next based on your thinking (e.g., "investigate with find_usages", "move to next file", "record finding")'
                ),
        })
        .strict();

    async execute(
        args: z.infer<typeof this.schema>,
        context: ExecutionContext
    ): Promise<ToolResult> {
        if (context.cancellationToken.isCancellationRequested) {
            throw new vscode.CancellationError();
        }

        const { topic, analysis, identified_risks, next_action } = args;

        let guidance = `## Thinking: ${topic}\n\n`;
        guidance += `### Analysis\n${analysis}\n\n`;

        if (identified_risks.length > 0) {
            guidance += `### Identified Risks (${identified_risks.length})\n`;
            guidance += identified_risks.map((r) => `- ⚠️ ${r}`).join('\n');
            guidance += '\n\n';
        }

        guidance += `### Next Action\n${next_action}\n`;

        return toolSuccess(guidance);
    }
}
