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

        const { issues_count, files_analyzed, files_in_diff, recommendation } =
            args;

        const coveragePercent = Math.round(
            (files_analyzed.length / files_in_diff) * 100
        );

        const coverageNote =
            coveragePercent < 100
                ? ` ⚠️ ${files_in_diff - files_analyzed.length} file(s) uncovered — investigate before submitting.`
                : '';

        // Inject FindingStore summary so the model can't silently drop findings
        const store = context.findingStore;
        let findingStoreNote = '';
        if (store && store.size > 0) {
            const findings = store.getAll();
            const summary = findings
                .map(
                    (f) => `  - [${f.id}] ${f.severity}: ${f.title} (${f.file})`
                )
                .join('\n');
            findingStoreNote =
                `\n\n📋 Your investigation team recorded ${store.size} finding(s) in the finding store:\n${summary}\n` +
                `These findings were recorded by your sub-agents based on tool evidence. ` +
                `You MUST include each in your review OR explicitly retract it with retract_finding if you have NEW counter-evidence. ` +
                `Do NOT silently drop findings that your team recorded.`;
        }

        return toolSuccess(
            `✅ Reflection recorded. ${files_analyzed.length}/${files_in_diff} files (${coveragePercent}%), ` +
                `${issues_count} issue(s), recommendation: ${recommendation}.${coverageNote} ` +
                `Pre-submit: for each finding, verify it's MECHANICAL (not intent-based), name the confirming tool call, ` +
                `confirm disproof was attempted. Drop anything "by design." Now call submit_review.${findingStoreNote}`
        );
    }
}
