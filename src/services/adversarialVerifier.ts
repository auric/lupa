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
import { AsyncSemaphore } from '../utils/asyncSemaphore';
import type { ToolCallRecord } from '../types/toolCallTypes';
import { SubmitVerdictTool } from '../tools/submitVerdictTool';

export type AdversarialProgressCallback = (message: string) => void;

export interface AdversarialResult {
    confirmed: string[];
    refuted: string[];
    uncertain: string[];
    toolCallRecords: ToolCallRecord[];
}

/**
 * Runs adversarial verification on findings as visible subagents.
 *
 * Each finding is verified by a dedicated adversarial subagent that gets
 * full investigation tools including diff access. Findings that are refuted
 * are removed from the FindingStore. Uncertain findings (errors, timeouts,
 * ambiguous output) are kept in the store but reported separately.
 */
export class AdversarialVerifier {
    private readonly adversarialGen = new AdversarialPromptGenerator();

    /** Max parallel adversarial subagents to avoid API rate-limit bursts. */
    private static readonly CONCURRENCY_LIMIT = 3;

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
            return {
                confirmed: [],
                refuted: [],
                uncertain: [],
                toolCallRecords: [],
            };
        }

        const toVerify = findingsToVerify.map((finding, index) => ({
            finding,
            index,
        }));

        progressCallback?.(
            `Adversarial verification of ${toVerify.length} finding(s) in parallel...`
        );
        Log.info(
            `Adversarial verification: ${toVerify.length} finding(s) to verify in parallel`
        );

        let completed = 0;
        const totalToVerify = toVerify.length;
        const semaphore = new AsyncSemaphore(
            AdversarialVerifier.CONCURRENCY_LIMIT
        );

        // Launch all verifications with bounded concurrency
        const results = await Promise.allSettled(
            toVerify.map(async ({ finding, index }) => {
                await semaphore.acquire(token);
                try {
                    if (token.isCancellationRequested) {
                        throw new vscode.CancellationError();
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
                } finally {
                    semaphore.release();
                }
            })
        );

        // Propagate cancellation after allSettled so callers observe it
        if (token.isCancellationRequested) {
            throw new vscode.CancellationError();
        }

        // Process results sequentially after all complete
        const confirmed: string[] = [];
        const refuted: string[] = [];
        const uncertain: string[] = [];
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
                confirmed.push(finding.title);
            } else if (verdict === 'REFUTED') {
                findingStore.remove(finding.id);
                refuted.push(finding.title);
            } else {
                Log.info(
                    `Adversarial uncertain for "${finding.title}" — keeping finding`
                );
                uncertain.push(finding.title);
            }
        }

        if (refuted.length > 0 || uncertain.length > 0) {
            Log.info(
                `Adversarial verification: ${confirmed.length} confirmed, ${refuted.length} refuted, ${uncertain.length} uncertain`
            );
        }

        return { confirmed, refuted, uncertain, toolCallRecords };
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
            const submitVerdictTool = new SubmitVerdictTool();

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
                    additionalTools: [submitVerdictTool],
                }
            );

            const verdict = this.extractVerdict(
                result.toolCalls,
                result.response
            );
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

    private extractVerdict(
        toolCalls: ToolCallRecord[],
        responseText: string
    ): 'CONFIRMED' | 'REFUTED' | 'UNCERTAIN' {
        // Primary: extract from submit_verdict tool call
        const verdictCall = toolCalls.find(
            (tc) => tc.toolName === 'submit_verdict'
        );
        if (verdictCall) {
            const verdict = (verdictCall.arguments as Record<string, unknown>)
                .verdict as string;
            if (
                verdict === 'CONFIRMED' ||
                verdict === 'REFUTED' ||
                verdict === 'UNCERTAIN'
            ) {
                return verdict;
            }
        }

        // Fallback: parse from response text (in case model didn't call the tool)
        return this.parseVerdictFromText(responseText);
    }

    private parseVerdictFromText(
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
