import * as z from 'zod';
import * as vscode from 'vscode';
import { BaseTool } from './baseTool';
import { ToolResult, toolSuccess } from '../types/toolResultTypes';
import { ExecutionContext } from '../types/executionContext';
import { flexibleStringArray } from './schemaHelpers';

/**
 * Structured thinking tool for the LLM to organize reasoning during analysis.
 *
 * Covers context reflection, code change reasoning, investigation
 * progress, or task alignment.
 *
 * Uses a flat schema with 2 required + 2 optional fields to maximize adoption by all models.
 * Replaces: think_about_context, think_about_investigation,
 * think_about_task, and think_about_code_change.
 */
export class ThinkTool extends BaseTool {
    name = 'think';
    description =
        'Record your step-by-step reasoning about code changes, investigation progress, or context gaps. ' +
        'Call after reading each file diff and before investigating further — this is how you organize analysis and catch issues. ' +
        'Captures your analysis, identified risks, and planned next action in a structured format.';

    schema = z.object({
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
        identified_risks: flexibleStringArray
            .describe(
                'Specific risks, concerns, or gaps identified (empty array if none)'
            )
            .optional(),
        next_action: z
            .string()
            .describe(
                'What to do next based on your thinking (e.g., "investigate with find_usages", "move to next file", "record finding")'
            )
            .optional(),
    });

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

        if (identified_risks && identified_risks.length > 0) {
            guidance += `### Identified Risks (${identified_risks.length})\n`;
            guidance += identified_risks.map((r) => `- ⚠️ ${r}`).join('\n');
            guidance += '\n\n';
            guidance += `### Verification Required\n`;
            guidance += `Before recording any risk as a finding, call a tool to attempt disproof:\n`;
            guidance += `- find_usages: Check if callers already handle the risk\n`;
            guidance += `- find_symbol (include_body: true): Read full implementation for mitigations\n`;
            guidance += `- search_for_pattern: Look for existing guards or checks\n`;
            guidance += `Drop any risk you cannot verify with tool evidence.\n\n`;
        } else {
            guidance += `No risks identified — proceed to next area.\n\n`;
        }

        if (next_action) {
            guidance += `### Next Action\n${next_action}\n`;
        }

        return toolSuccess(guidance);
    }
}
