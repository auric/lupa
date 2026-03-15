import * as z from 'zod';
import * as vscode from 'vscode';
import { BaseTool } from './baseTool';
import { ToolResult, toolSuccess, toolError } from '../types/toolResultTypes';
import { ExecutionContext } from '../types/executionContext';

/**
 * Explicit completion signal for PR review analysis.
 *
 * This tool solves the problem of some models responding with planning
 * messages ("I will review X") without tool calls, which would otherwise
 * be misinterpreted as the final review.
 *
 * The ConversationRunner treats this tool specially:
 * - When called, it extracts the review content and terminates the loop
 * - The review content becomes the final output (no additional formatting)
 */
export class SubmitReviewTool extends BaseTool {
    name = 'submit_review';
    description =
        'Submit your final PR review. Call this as the FINAL step when all analysis is complete. ' +
        'BEFORE calling: (1) verify you generated hypotheses at checkpoint #1 and investigated each with tools, ' +
        '(2) for EACH finding verify you can name the tool call that confirmed it and attempted disproof, ' +
        '(3) verify all files in the changed files list were examined. ' +
        'Zero findings IS valid — but only after genuine investigation with hypothesis generation.';

    /**
     * Minimum 20 chars is intentionally lower than reviewExtractionUtils' 50-char
     * threshold. When the model explicitly calls this tool, we trust its intent.
     * Extraction requires stricter validation because the model didn't call properly.
     */
    schema = z
        .object({
            review_content: z
                .string()
                .min(20)
                .describe(
                    'The complete markdown-formatted review following the output format specification. ' +
                        'Each finding must have Evidence and Disproof Attempted sections. ' +
                        'Omit empty categories. If no findings survived verification, submit an approval.'
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

        const store = context.findingStore;
        const subagentsRecordedFindings = store && store.size > 0;

        // Gate 4: FindingStore gate — if subagents recorded findings, the review must address them
        if (subagentsRecordedFindings) {
            const findings = store.getAll();
            const reviewLower = args.review_content.toLowerCase();

            // Check if any recorded finding is completely absent from review text
            const missingFindings = findings.filter((f) => {
                // Check if the finding's title or file is mentioned in the review
                const titleWords = f.title
                    .toLowerCase()
                    .split(/\s+/)
                    .filter((w) => w.length > 3);
                const titleMentioned = titleWords.some((word) =>
                    reviewLower.includes(word)
                );
                const fileMentioned = reviewLower.includes(
                    f.file.toLowerCase()
                );
                return !titleMentioned && !fileMentioned;
            });

            if (missingFindings.length > 0) {
                const missing = missingFindings
                    .map(
                        (f) => `[${f.id}] ${f.severity}: ${f.title} (${f.file})`
                    )
                    .join('\n  ');
                return toolError(
                    `Review rejected: your investigation team recorded ${store.size} finding(s), but ${missingFindings.length} are missing from your review:\n  ${missing}\n\n` +
                        'You MUST either include each finding in your review OR explicitly call retract_finding with a reason. ' +
                        'Do NOT silently drop findings that were recorded with tool evidence.'
                );
            }
        }

        return toolSuccess(args.review_content, { isCompletion: true });
    }
}
