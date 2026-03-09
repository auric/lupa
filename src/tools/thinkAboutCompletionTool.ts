import * as z from 'zod';
import * as vscode from 'vscode';
import { BaseTool } from './baseTool';
import { ToolResult, toolSuccess } from '../types/toolResultTypes';
import { ExecutionContext } from '../types/executionContext';
import { flexibleStringArrayNonEmpty } from './schemaHelpers';

const Recommendation = z.enum([
    'approve',
    'approve_with_suggestions',
    'request_changes',
    'block_merge',
]);

/**
 * Pre-submit checkpoint tool. Forces the LLM to draft a summary, verify
 * file coverage, and declare a recommendation before calling submit_review.
 *
 * Simplified to 5 flat fields for maximum adoption by all models.
 */
export class ThinkAboutCompletionTool extends BaseTool {
    name = 'think_about_completion';
    description =
        'Pre-submit checkpoint. Draft your summary, verify file coverage, and declare your recommendation. ' +
        'For each finding, ask: would I bet my reputation this is a real bug? If not, drop it. ' +
        'CALL THIS before submit_review.';

    schema = z
        .object({
            summary_draft: z
                .string()
                .min(20)
                .describe(
                    'Draft 2-3 sentence summary of what this PR does and your overall assessment'
                ),
            issues_count: z
                .number()
                .int()
                .min(0)
                .describe('Total number of issues found across all severities'),
            files_analyzed: flexibleStringArrayNonEmpty.describe(
                'List of files reviewed (directly or via sub-agent delegation)'
            ),
            files_in_diff: z
                .number()
                .int()
                .min(1)
                .describe('Total number of files in the diff'),
            recommendation: Recommendation.describe(
                'approve, approve_with_suggestions, request_changes, or block_merge'
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

        const {
            summary_draft,
            issues_count,
            files_analyzed,
            files_in_diff,
            recommendation,
        } = args;

        const coveragePercent = Math.round(
            (files_analyzed.length / files_in_diff) * 100
        );

        let guidance = '## Completion Reflection\n\n';

        guidance += `### Summary Draft\n> ${summary_draft}\n\n`;
        guidance += `### Issues Found: ${issues_count}\n\n`;

        guidance += `### Coverage\n`;
        guidance += `- Files analyzed: ${files_analyzed.length}/${files_in_diff} (${coveragePercent}%)\n`;
        if (coveragePercent < 100) {
            guidance += `- ⚠️ Not all files analyzed\n`;
        }
        guidance += '\n';

        guidance += `### Recommendation: ${recommendation.replace(/_/g, ' ').toUpperCase()}\n\n`;

        if (coveragePercent < 100) {
            guidance += `**Action**: Spawn additional sub-agents or use \`get_file_diff\` to cover remaining ${files_in_diff - files_analyzed.length} file(s) before submitting.\n\n`;
        }

        guidance +=
            '**Pre-submit self-challenge** (do this mentally for each finding):\n';
        guidance +=
            '1. Is this MECHANICAL (duplication, API misuse, type error) or INTENT-BASED (design disagreement)?\n';
        guidance +=
            '2. For intent-based findings: did you search for comments/docs explaining the design?\n';
        guidance +=
            '3. Can you name the SPECIFIC tool call that confirmed this finding?\n';
        guidance += '4. Did you attempt to disprove it? What was the result?\n';
        guidance += '5. Would a developer familiar with this codebase agree?\n';
        guidance +=
            '\nDrop any finding where the answer to #5 is likely "by design."\n\n';
        guidance +=
            '**Action**: Call `submit_review` now with your complete review.\n';

        return toolSuccess(guidance);
    }
}
