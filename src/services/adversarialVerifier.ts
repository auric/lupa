import * as vscode from 'vscode';
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

export type AdversarialProgressCallback = (message: string) => void;

export interface AdversarialResult {
    confirmed: string[];
    refuted: string[];
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
            return { confirmed: [], refuted: [] };
        }

        progressCallback?.(
            `Adversarial verification of ${findingsToVerify.length} finding(s)...`
        );
        Log.info(
            `Adversarial verification: ${findingsToVerify.length} finding(s) to verify`
        );

        const confirmed: string[] = [];
        const refuted: string[] = [];

        for (let i = 0; i < findingsToVerify.length; i++) {
            const finding = findingsToVerify[i]!;
            if (token.isCancellationRequested) {
                break;
            }

            // Skip re-verification of already-confirmed findings
            if (this.confirmedFindingIds.has(finding.id)) {
                Log.info(
                    `Adversarial skip (already confirmed): ${finding.title}`
                );
                confirmed.push(finding.title);
                continue;
            }

            progressCallback?.(
                `Verifying finding ${i + 1}/${findingsToVerify.length}: ${finding.title}`
            );

            const verdict = await this.verifyFinding(
                finding,
                i,
                calibrationProfile,
                subagentExecutor,
                parsedDiff,
                findingStore,
                token
            );

            if (verdict === 'CONFIRMED') {
                this.confirmedFindingIds.add(finding.id);
                confirmed.push(finding.title);
                progressCallback?.(
                    `Adversarial ${i + 1}/${findingsToVerify.length}: "${finding.title}" — CONFIRMED`
                );
            } else {
                findingStore.remove(finding.id);
                refuted.push(finding.title);
                progressCallback?.(
                    `Adversarial ${i + 1}/${findingsToVerify.length}: "${finding.title}" — REFUTED`
                );
            }
        }

        if (refuted.length > 0) {
            Log.info(
                `Adversarial verification: ${refuted.length} refuted, ${confirmed.length} confirmed`
            );
        }

        return { confirmed, refuted };
    }

    private async verifyFinding(
        finding: RecordedFinding,
        index: number,
        calibrationProfile: ModelCalibrationProfile,
        subagentExecutor: SubagentExecutor,
        parsedDiff: DiffHunk[] | undefined,
        findingStore: FindingStore,
        token: vscode.CancellationToken
    ): Promise<'CONFIRMED' | 'REFUTED' | 'UNCERTAIN'> {
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
                }
            );

            const verdict = this.parseVerdict(result.response);
            Log.info(`Adversarial ${verdict}: ${finding.title}`);
            return verdict;
        } catch (error) {
            if (isCancellationError(error)) {
                throw error;
            }
            Log.warn(
                `Adversarial verification failed for ${finding.title}: ${getErrorMessage(error)}`
            );
            return 'UNCERTAIN';
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
