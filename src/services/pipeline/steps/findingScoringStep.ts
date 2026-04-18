import { Log } from '../../loggingService';
import { scoreFinding } from '../../findingScorer';
import type { ScoringContext } from '../../findingScorer';
import {
    dismissHypothesesForDroppedFinding,
    downgradeSeverity,
} from '../pipelineUtils';
import type {
    PipelineContext,
    PipelineStep,
    PipelineStepResult,
} from '../pipelineTypes';

export function createFindingScoringStep(): PipelineStep {
    return {
        name: 'finding-scoring',
        label: 'Finding Scoring',
        description:
            'Composite scoring with 10 signals (11 with feedbackHistory) — drops or downgrades findings below quality thresholds',
        kind: 'programmatic',

        shouldRun(context: PipelineContext): boolean {
            return context.findingStore.size > 0;
        },

        async execute(context: PipelineContext): Promise<PipelineStepResult> {
            const findingsDropped: string[] = [];
            const findingsDowngraded: string[] = [];

            context.progressCallback?.('Scoring findings...', 0.7);

            const allToolCalls = [
                ...context.toolCallRecords,
                ...context.additionalToolCallRecords,
            ];
            const baseScoringContext: ScoringContext = {
                toolCallRecords: allToolCalls,
                calibrationProfile: context.calibrationProfile,
            };

            const modelName = context.calibrationProfile.name;
            const findings = context.findingStore.getAll();
            const scores = findings.map((finding) => {
                const ctx: ScoringContext = { ...baseScoringContext };
                if (context.feedbackStore) {
                    const stats = context.feedbackStore.getStats(
                        finding.category,
                        modelName
                    );
                    ctx.feedbackRejectionRate =
                        context.feedbackStore.getRejectionRate(
                            finding.category,
                            modelName
                        );
                    ctx.feedbackTotalEntries = stats.total;
                }
                return scoreFinding(finding, ctx);
            });

            for (const score of scores) {
                if (score.recommendation === 'drop') {
                    const finding = context.findingStore.getById(
                        score.findingId
                    );
                    if (finding) {
                        findingsDropped.push(finding.title);
                        context.findingStore.remove(score.findingId);
                        dismissHypothesesForDroppedFinding(
                            score.findingId,
                            context.executionContext.reasoningChain,
                            'Finding dropped by finding scoring'
                        );
                        Log.info(
                            `FindingScorer: dropped "${finding.title}" (score: ${score.overallScore})`
                        );
                    }
                } else if (score.recommendation === 'downgrade') {
                    const finding = context.findingStore.getById(
                        score.findingId
                    );
                    if (finding) {
                        const newSeverity = downgradeSeverity(finding.severity);
                        if (newSeverity) {
                            const oldSeverity = finding.severity;
                            findingsDowngraded.push(finding.title);
                            context.findingStore.updateSeverity(
                                score.findingId,
                                newSeverity
                            );
                            Log.info(
                                `FindingScorer: downgraded "${finding.title}" ${oldSeverity} → ${newSeverity} (score: ${score.overallScore})`
                            );
                        }
                    }
                }
            }

            return { findingsDropped, findingsDowngraded, toolCallRecords: [] };
        },
    };
}
