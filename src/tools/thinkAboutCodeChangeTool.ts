import * as z from 'zod';
import * as vscode from 'vscode';
import { BaseTool } from './baseTool';
import { ToolResult, toolSuccess } from '../types/toolResultTypes';
import { ExecutionContext } from '../types/executionContext';
import { flexibleStringArray } from './schemaHelpers';

const Verdict = z.enum(['no_issues', 'needs_investigation', 'likely_issue']);

/**
 * Lightweight code reasoning tool. Forces the LLM to think out loud about
 * a code change before deciding what to do next.
 *
 * Uses a flat schema with only 4 fields to maximize adoption by all models
 * (GPT-4.1, GPT-5 mini, etc.). The `analysis` free-text field is where
 * the LLM externalizes its reasoning — preventing it from jumping to
 * conclusions without structured thought.
 *
 * Follows the same pattern as other think_about_* tools.
 */
export class ThinkAboutCodeChangeTool extends BaseTool {
    name = 'think_about_code_change';
    description =
        'Think out loud about a code change after reading its diff. ' +
        'CALL THIS after reading each file diff to structure your analysis — ' +
        'what changed, what could go wrong, and what to investigate next. ' +
        'Prevents jumping to conclusions without reasoning.';

    schema = z
        .object({
            file: z.string().describe('File path being analyzed'),
            analysis: z
                .string()
                .describe(
                    'Your reasoning about this change: what changed, why it matters, what could go wrong, what looks correct'
                ),
            identified_risks: flexibleStringArray.describe(
                'Specific risks or potential issues identified (empty array if none found)'
            ),
            verdict: Verdict.describe(
                'Your assessment: no_issues (move on), needs_investigation (use tools to verify), likely_issue (investigate then record finding)'
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

        const { file, analysis, identified_risks, verdict } = args;

        let guidance = `## Code Change Analysis: \`${file}\`\n\n`;
        guidance += `### Your Reasoning\n${analysis}\n\n`;

        if (identified_risks.length > 0) {
            guidance += `### Identified Risks (${identified_risks.length})\n`;
            guidance += identified_risks.map((r) => `- ⚠️ ${r}`).join('\n');
            guidance += '\n\n';
        }

        guidance += `### Verdict: ${verdict.replace(/_/g, ' ').toUpperCase()}\n\n`;

        switch (verdict) {
            case 'needs_investigation':
                guidance +=
                    '**Next**: Use `find_symbol`, `find_usages`, or `search_for_pattern` to verify your concerns. ' +
                    'Only call `record_finding` after tool-backed verification.\n';
                break;
            case 'likely_issue':
                guidance +=
                    '**Next**: Investigate with tools to confirm, then call `record_finding` with evidence. ' +
                    'Try to disprove the issue first — if you cannot, it survives.\n';
                break;
            case 'no_issues':
                guidance +=
                    '**Next**: Move to the next file or area in your plan.\n';
                break;
        }

        return toolSuccess(guidance);
    }
}
