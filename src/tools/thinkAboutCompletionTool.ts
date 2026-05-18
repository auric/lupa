import * as z from 'zod';
import * as vscode from 'vscode';
import { BaseTool } from './baseTool';
import { ToolResult, toolSuccess } from '../types/toolResultTypes';
import { ExecutionContext } from '../types/executionContext';
import { flexibleStringArrayNonEmpty } from './schemaHelpers';
import { pathSuffixMatch } from '../utils/pathUtils';
import { normalizeRelativePath } from '../utils/investigationAudit';

const MAX_HYPOTHESIS_TRAIL_CHARS = 2000;

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

        // Cross-reference claimed files_analyzed against actual tool call records.
        // The model may claim to have analyzed files it never investigated with tools.
        let investigationNote = '';
        let uninvestigated: string[] = [];
        if (context.investigatedFiles && context.investigatedFiles.size > 0) {
            uninvestigated = files_analyzed.filter((claimed) => {
                const normalizedClaimed = normalizeRelativePath(claimed);
                return ![...context.investigatedFiles!].some(
                    (actual) =>
                        pathSuffixMatch(normalizedClaimed, actual) ||
                        pathSuffixMatch(actual, normalizedClaimed)
                );
            });
            if (uninvestigated.length > 0) {
                investigationNote =
                    `\n\n⚠️ INVESTIGATION GAP: You claimed to analyze ${uninvestigated.length} file(s) that have NO tool call records: ` +
                    `${uninvestigated.join(', ')}. ` +
                    `You must use read_file, find_symbol, find_usages, search_for_pattern, or validate_claim on a file before claiming you analyzed it. ` +
                    `Go investigate these files before calling submit_review.`;
            }
        }

        context.completionReadiness = {
            coveragePercent,
            uninvestigatedFiles: uninvestigated,
            ready: uninvestigated.length === 0,
        };

        // Inject FindingStore summary with CoVe-style verification prompts
        const store = context.findingStore;
        let findingStoreNote = '';
        if (store && store.size > 0) {
            const findings = store.getAll();
            const summary = findings
                .map(
                    (f, i) =>
                        `  ${i + 1}. [${f.id}] ${f.severity}: ${f.title} (${f.file})\n` +
                        `     Affected: ${f.affectedComponent || 'NOT SPECIFIED'} | Mechanism: ${f.failureMechanism || 'NOT SPECIFIED'}\n` +
                        `     Evidence: ${f.description.length > 150 ? f.description.slice(0, 150) + '...' : f.description}\n` +
                        `     Disproof: ${f.disproof.method || 'NONE PROVIDED'}`
                )
                .join('\n');
            findingStoreNote =
                `\n\n📋 CHAIN-OF-VERIFICATION: Your team recorded ${store.size} finding(s). For EACH finding below, answer these 3 questions:\n` +
                `   (a) What SPECIFIC tool call confirmed it? (name the tool and what it returned)\n` +
                `   (b) What is ONE plausible way this could be intentional or a false positive?\n` +
                `   (c) KEEP or RETRACT? If you cannot answer (a) with a concrete tool output, RETRACT it now.\n\n` +
                `${summary}\n\n` +
                `⚠️ Retract any finding where you cannot cite specific tool output. ` +
                `"I reasoned about it" or "it looks like" is NOT tool evidence. ` +
                `Call retract_finding for each finding that fails this check before calling submit_review.`;
        }

        return toolSuccess(
            `✅ Reflection recorded. ${files_analyzed.length}/${files_in_diff} files (${coveragePercent}%), ` +
                `${issues_count} issue(s), recommendation: ${recommendation}.${coverageNote}${investigationNote} ` +
                `Pre-submit: for each finding, verify it's MECHANICAL (not intent-based), name the confirming tool call, ` +
                `confirm disproof was attempted. Drop anything "by design." Now call submit_review.${findingStoreNote}${this.generateHypothesisTrailNote(context)}`
        );
    }

    /**
     * Generate hypothesis trail from reasoning chain for CoVe integration.
     * Shows which hypotheses were investigated, which were abandoned.
     */
    private generateHypothesisTrailNote(context: ExecutionContext): string {
        const chain = context.reasoningChain;
        if (!chain || chain.getAllHypotheses().length === 0) {
            return '';
        }

        let summary = chain.generateHypothesisTrailSummary();
        if (summary.length > MAX_HYPOTHESIS_TRAIL_CHARS) {
            summary =
                summary.slice(0, MAX_HYPOTHESIS_TRAIL_CHARS) +
                '\n...[truncated]';
        }

        return `\n\n🔗 HYPOTHESIS TRAIL:\n${summary}`;
    }
}
