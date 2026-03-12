import * as z from 'zod';
import * as vscode from 'vscode';
import { BaseTool } from './baseTool';
import { ToolResult, toolSuccess, toolError } from '../types/toolResultTypes';
import { ExecutionContext } from '../types/executionContext';
import { Log } from '../services/loggingService';
import { AdversarialPromptGenerator } from '../prompts/adversarialPromptGenerator';
import { FINDING_SEVERITIES } from '../types/findingTypes';
import { isCancellationError } from '../utils/asyncUtils';
import { getErrorMessage } from '../utils/errorUtils';
import type { FindingStore } from '../sessions/findingStore';

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

        // Calibration gate: dismissive models must call validate_claim before submitting.
        // EXCEPTION: If subagents already recorded findings in FindingStore, they performed
        // their own validation — waive the gate to prevent the parent from using forced
        // validate_claim calls to disprove subagent findings.
        const profile = context.calibrationProfile;
        const store = context.findingStore;
        const subagentsRecordedFindings = store && store.size > 0;

        if (
            profile.minValidateClaimBeforeSubmit > 0 &&
            !subagentsRecordedFindings
        ) {
            const validateClaimCalls =
                context.toolCallCounts.get('validate_claim') ?? 0;
            if (validateClaimCalls < profile.minValidateClaimBeforeSubmit) {
                return toolError(
                    `Review rejected: you have not called validate_claim yet (${validateClaimCalls} calls, minimum ${profile.minValidateClaimBeforeSubmit} required). ` +
                        'Go back and use validate_claim to verify at least one hypothesis with LSP ground truth before submitting. ' +
                        'If all hypotheses were disproved by validate_claim, you may then submit an approval.'
                );
            }
        }

        // FindingStore gate: if subagents recorded findings, the review must address them
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

        // Adversarial verification gate: verify findings before accepting the review
        if (store && store.size > 0 && context.subagentExecutor) {
            const adversarialResult = await this.runAdversarialGate(
                store,
                context
            );
            if (adversarialResult) {
                return adversarialResult;
            }
        }

        return toolSuccess(args.review_content, { isCompletion: true });
    }

    private async runAdversarialGate(
        store: FindingStore,
        context: ExecutionContext
    ): Promise<ToolResult | undefined> {
        const profile = context.calibrationProfile;
        const threshold = profile.adversarialVerificationThreshold;

        const thresholdIndex = FINDING_SEVERITIES.indexOf(threshold);
        const findingsToVerify = FINDING_SEVERITIES.filter(
            (_, i) => i <= thresholdIndex
        ).flatMap((s) => store.getBySeverity(s));

        if (findingsToVerify.length === 0) {
            return undefined;
        }

        const adversarialGen = new AdversarialPromptGenerator();
        const refutedTitles: string[] = [];

        for (let i = 0; i < findingsToVerify.length; i++) {
            const finding = findingsToVerify[i]!;
            if (context.cancellationToken.isCancellationRequested) {
                throw new vscode.CancellationError();
            }

            try {
                const adversarialTask =
                    adversarialGen.generateSystemPrompt(finding);
                const budget = profile.adversarialBudget;

                const result = await context.subagentExecutor!.execute(
                    {
                        task: adversarialTask,
                        context: `Finding to verify: "${finding.title}" in ${finding.file}:${finding.lineRange[0]}-${finding.lineRange[1]}`,
                    },
                    context.cancellationToken,
                    i + 1,
                    {
                        agentId: `adversarial-${i + 1}`,
                        childBudget: budget,
                        calibrationProfile: profile,
                    }
                );

                const verdict = this.parseAdversarialVerdict(result.response);
                if (verdict !== 'CONFIRMED') {
                    store.remove(finding.id);
                    refutedTitles.push(finding.title);
                    Log.info(
                        `Adversarial ${verdict}: ${finding.title} — removed`
                    );
                } else {
                    Log.info(`Adversarial CONFIRMED: ${finding.title}`);
                }
            } catch (error) {
                if (isCancellationError(error)) {
                    throw error;
                }
                Log.warn(
                    `Adversarial verification failed for ${finding.title}: ${getErrorMessage(error)}`
                );
                store.remove(finding.id);
                refutedTitles.push(finding.title);
            }
        }

        if (refutedTitles.length > 0) {
            const titles = refutedTitles.map((t) => `  - ${t}`).join('\n');
            return toolError(
                `Review rejected: adversarial verification refuted ${refutedTitles.length} finding(s):\n${titles}\n\n` +
                    'These findings have been removed from the FindingStore. ' +
                    'Rewrite your review WITHOUT these findings and call submit_review again. ' +
                    'If no findings remain, submit an approval.'
            );
        }

        return undefined;
    }

    private parseAdversarialVerdict(
        response: string
    ): 'REFUTED' | 'CONFIRMED' | 'UNCERTAIN' {
        const upper = response.toUpperCase();
        if (
            upper.includes('VERDICT: REFUTED') ||
            upper.includes('VERDICT:REFUTED')
        ) {
            return 'REFUTED';
        }
        if (
            upper.includes('VERDICT: CONFIRMED') ||
            upper.includes('VERDICT:CONFIRMED')
        ) {
            return 'CONFIRMED';
        }
        if (
            upper.includes('VERDICT: UNCERTAIN') ||
            upper.includes('VERDICT:UNCERTAIN')
        ) {
            return 'UNCERTAIN';
        }
        if (/\bREFUTED\b/.test(upper) && !/\bCONFIRMED\b/.test(upper)) {
            return 'REFUTED';
        }
        if (/\bCONFIRMED\b/.test(upper) && !/\bREFUTED\b/.test(upper)) {
            return 'CONFIRMED';
        }
        return 'UNCERTAIN';
    }
}
