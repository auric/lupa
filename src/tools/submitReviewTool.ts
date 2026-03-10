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
        'Zero findings IS valid — but only after genuine investigation with hypothesis generation and at least one validate_claim call.';

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

        // Calibration gate: dismissive models must call validate_claim before submitting
        const profile = context.calibrationProfile;
        if (profile && profile.minValidateClaimBeforeSubmit > 0) {
            const validateClaimCalls =
                context.toolCallCounts?.get('validate_claim') ?? 0;
            if (validateClaimCalls < profile.minValidateClaimBeforeSubmit) {
                return toolError(
                    `Review rejected: you have not called validate_claim yet (${validateClaimCalls} calls, minimum ${profile.minValidateClaimBeforeSubmit} required). ` +
                        'Go back and use validate_claim to verify at least one hypothesis with LSP ground truth before submitting. ' +
                        'If all hypotheses were disproved by validate_claim, you may then submit an approval.'
                );
            }
        }

        return toolSuccess(args.review_content, { isCompletion: true });
    }
}
