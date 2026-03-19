import type * as vscode from 'vscode';
import { Log } from './loggingService';
import { SubagentExecutor } from './subagentExecutor';
import { AdversarialPromptGenerator } from '../prompts/adversarialPromptGenerator';
import { FindingStore } from '../sessions/findingStore';
import { FINDING_SEVERITIES } from '../types/findingTypes';
import type { RecordedFinding, FindingSeverity } from '../types/findingTypes';
import type { DiffHunk } from '../types/contextTypes';
import type { ModelCalibrationProfile } from '../models/modelCalibration';
import { isCancellationError } from '../utils/asyncUtils';
import { getErrorMessage } from '../utils/errorUtils';
import type { ToolCallRecord } from '../types/toolCallTypes';

export type AdversarialProgressCallback = (message: string) => void;

export interface AdversarialResult {
    confirmed: string[];
    refuted: string[];
    toolCallRecords: ToolCallRecord[];
}

/**
 * Runs adversarial verification on findings as visible subagents.
 *
 * Each finding is verified by a dedicated adversarial subagent that gets
 * full investigation tools including diff access. Findings that cannot be
 * independently confirmed are removed from the FindingStore.
 *
 * Confirmed findings are tracked to prevent re-verification on subsequent
 * rounds (when the main LLM rewrites and resubmits).
 */
export class AdversarialVerifier {
    private readonly adversarialGen = new AdversarialPromptGenerator();
    private readonly confirmedFindingIds = new Set<string>();

    async verify(
        findingStore: FindingStore,
        calibrationProfile: ModelCalibrationProfile,
        subagentExecutor: SubagentExecutor,
        parsedDiff: DiffHunk[] | undefined,
        token: vscode.CancellationToken,
        progressCallback?: AdversarialProgressCallback
    ): Promise<AdversarialResult> {
        const threshold = calibrationProfile.adversarialVerificationThreshold;
        const findingsToVerify = this.getFindingsToVerify(
            findingStore,
            threshold
        );

        if (findingsToVerify.length === 0) {
            return { confirmed: [], refuted: [], toolCallRecords: [] };
        }

        // Separate already-confirmed from new findings
        const alreadyConfirmed: string[] = [];
        const toVerify: { finding: RecordedFinding; index: number }[] = [];
        for (let i = 0; i < findingsToVerify.length; i++) {
            const finding = findingsToVerify[i]!;
            if (this.confirmedFindingIds.has(finding.id)) {
                Log.info(
                    `Adversarial skip (already confirmed): ${finding.title}`
                );
                alreadyConfirmed.push(finding.title);
            } else {
                toVerify.push({ finding, index: i });
            }
        }

        if (toVerify.length === 0) {
            return {
                confirmed: alreadyConfirmed,
                refuted: [],
                toolCallRecords: [],
            };
        }

        progressCallback?.(
            `Adversarial verification of ${toVerify.length} finding(s) in parallel...`
        );
        Log.info(
            `Adversarial verification: ${toVerify.length} finding(s) to verify in parallel`
        );

        let completed = 0;
        const totalToVerify = toVerify.length;

        // Launch all verifications in parallel
        const results = await Promise.allSettled(
            toVerify.map(async ({ finding, index }) => {
                if (token.isCancellationRequested) {
                    throw new Error('Cancelled');
                }
                const { verdict, toolCalls } = await this.verifyFinding(
                    finding,
                    index,
                    calibrationProfile,
                    subagentExecutor,
                    parsedDiff,
                    findingStore,
                    token
                );
                completed++;
                progressCallback?.(
                    `Adversarial: ${completed}/${totalToVerify} verified`
                );
                return { finding, verdict, toolCalls };
            })
        );

        // Process results sequentially after all complete
        const confirmed: string[] = [...alreadyConfirmed];
        const refuted: string[] = [];
        const toolCallRecords: ToolCallRecord[] = [];

        for (const result of results) {
            if (result.status !== 'fulfilled') {
                continue;
            }
            const { finding, verdict, toolCalls } = result.value;

            // Build a synthetic ToolCallRecord for this adversarial agent
            const verdictLabel =
                verdict === 'CONFIRMED'
                    ? '✅ CONFIRMED'
                    : verdict === 'REFUTED'
                      ? '❌ REFUTED'
                      : '❓ UNCERTAIN';
            toolCallRecords.push({
                id: `adversarial-${finding.id}`,
                toolName: 'adversarial_verification',
                arguments: {
                    finding_title: finding.title,
                    finding_severity: finding.severity,
                    finding_file: finding.file,
                },
                result: `${verdictLabel}: ${finding.title}`,
                success: true,
                error: undefined,
                durationMs: undefined,
                timestamp: Date.now(),
                nestedCalls: toolCalls,
            });

            if (verdict === 'CONFIRMED') {
                this.confirmedFindingIds.add(finding.id);
                confirmed.push(finding.title);
            } else if (verdict === 'REFUTED') {
                findingStore.remove(finding.id);
                refuted.push(finding.title);
            } else {
                Log.info(
                    `Adversarial uncertain for "${finding.title}" — keeping finding`
                );
                confirmed.push(finding.title);
            }
        }

        if (refuted.length > 0) {
            Log.info(
                `Adversarial verification: ${refuted.length} refuted, ${confirmed.length} confirmed`
            );
        }

        return { confirmed, refuted, toolCallRecords };
    }

    private async verifyFinding(
        finding: RecordedFinding,
        index: number,
        calibrationProfile: ModelCalibrationProfile,
        subagentExecutor: SubagentExecutor,
        parsedDiff: DiffHunk[] | undefined,
        findingStore: FindingStore,
        token: vscode.CancellationToken
    ): Promise<{
        verdict: 'CONFIRMED' | 'REFUTED' | 'UNCERTAIN';
        toolCalls: ToolCallRecord[];
    }> {
        try {
            const adversarialTask =
                this.adversarialGen.generateSystemPrompt(finding);
            const budget = calibrationProfile.adversarialBudget;

            const result = await subagentExecutor.execute(
                {
                    task: adversarialTask,
                    context: `Finding to verify: "${finding.title}" in ${finding.file}:${finding.lineRange[0]}-${finding.lineRange[1]}`,
                },
                token,
                index + 1,
                {
                    agentId: `adversarial-${index + 1}`,
                    childBudget: budget,
                    calibrationProfile,
                    parsedDiff,
                    findingStore,
                    excludeTools: ['record_finding', 'retract_finding'],
                }
            );

            const verdict = this.parseVerdict(result.response);
            Log.info(`Adversarial ${verdict}: ${finding.title}`);
            return { verdict, toolCalls: result.toolCalls };
        } catch (error) {
            if (isCancellationError(error)) {
                throw error;
            }
            Log.warn(
                `Adversarial verification failed for ${finding.title}: ${getErrorMessage(error)}`
            );
            return { verdict: 'UNCERTAIN', toolCalls: [] };
        }
    }

    private getFindingsToVerify(
        findingStore: FindingStore,
        threshold: FindingSeverity
    ): RecordedFinding[] {
        const thresholdIndex = FINDING_SEVERITIES.indexOf(threshold);
        return FINDING_SEVERITIES.filter((_, i) => i <= thresholdIndex).flatMap(
            (s) => findingStore.getBySeverity(s)
        );
    }

    private parseVerdict(
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
