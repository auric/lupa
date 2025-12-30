import * as z from 'zod';
import { BaseTool } from './baseTool';
import { ToolResult, toolSuccess } from '../types/toolResultTypes';
import { ExecutionContext } from '../types/executionContext';
import { SEVERITY } from '../config/chatEmoji';

const CompletionDecision = z.enum(['needs_work', 'ready_to_submit']);

const Recommendation = z.enum([
    'approve',
    'approve_with_suggestions',
    'request_changes',
    'block_merge',
]);

/**
 * Self-reflection tool for main agent: verifies analysis completeness.
 *
 * Forces explicit articulation of the review state rather than passive checklists.
 * Per prompt engineering best practices: "articulation > checklists" -
 * writing explicit statements is more rigorous than checking boxes.
 */
export class ThinkAboutCompletionTool extends BaseTool {
    name = 'think_about_completion';
    description =
        'Articulate your review completeness before submitting. ' +
        'Forces you to draft a summary, count issues, and confirm all files were analyzed.';

    schema = z
        .object({
            summary_draft: z
                .string()
                .min(20)
                .describe(
                    'Draft 2-3 sentence summary of what this PR does and your overall assessment'
                ),
            critical_issues_count: z
                .number()
                .int()
                .min(0)
                .describe('Number of critical/blocking issues found'),
            high_issues_count: z
                .number()
                .int()
                .min(0)
                .describe('Number of high-severity issues found'),
            files_analyzed: z
                .array(z.string())
                .min(1)
                .describe('List of files you analyzed from the diff'),
            files_in_diff: z
                .number()
                .int()
                .min(1)
                .describe('Total number of files in the diff'),
            recommendation: Recommendation.describe(
                'Your recommendation: approve, approve_with_suggestions, request_changes, or block_merge'
            ),
            decision: CompletionDecision.describe(
                'Your decision: needs_work (address gaps first) or ready_to_submit'
            ),
        })
        .strict();

    async execute(
        args: z.infer<typeof this.schema>,
        _context?: ExecutionContext
    ): Promise<ToolResult> {
        const {
            summary_draft,
            critical_issues_count,
            high_issues_count,
            files_analyzed,
            files_in_diff,
            recommendation,
            decision,
        } = args;

        const coveragePercent = Math.round(
            (files_analyzed.length / files_in_diff) * 100
        );
        const hasCritical = critical_issues_count > 0;
        const hasHigh = high_issues_count > 0;

        let guidance = '## Completion Reflection\n\n';

        guidance += `### Summary Draft\n> ${summary_draft}\n\n`;

        guidance += `### Issue Count\n`;
        guidance += `- ${SEVERITY.critical} Critical: ${critical_issues_count}\n`;
        guidance += `- ${SEVERITY.high} High: ${high_issues_count}\n\n`;

        guidance += `### Coverage\n`;
        guidance += `- Files analyzed: ${files_analyzed.length}/${files_in_diff} (${coveragePercent}%)\n`;
        if (coveragePercent < 100) {
            guidance += `- ⚠️ Not all files analyzed\n`;
        }
        guidance += '\n';

        guidance += `### Recommendation: ${recommendation.replace(/_/g, ' ').toUpperCase()}\n`;
        if (hasCritical) {
            guidance += `⚠️ Critical issues found - recommend \`block_merge\` or \`request_changes\`\n`;
        } else if (hasHigh) {
            guidance += `⚠️ High-severity issues found - consider \`request_changes\`\n`;
        }
        guidance += '\n';

        guidance += `### Decision: ${decision.replace(/_/g, ' ').toUpperCase()}\n\n`;

        // Provide guidance based on decision
        if (decision === 'needs_work') {
            guidance += '**Action**: Address gaps before submitting.\n';
            if (coveragePercent < 100) {
                guidance += `- Analyze remaining ${files_in_diff - files_analyzed.length} file(s)\n`;
            }
            guidance += '- Ensure all plan items are complete\n';
            guidance += '- Verify all findings have evidence\n';
        } else {
            guidance += '**Action**: Submit your final review.\n';
            guidance += '- Use the summary draft as your opening\n';
            guidance += '- Organize findings by severity\n';
            guidance += '- Include positive observations\n';
            guidance += '- Ensure proper Markdown formatting with file links\n';
        }

        return toolSuccess(guidance);
    }
}
