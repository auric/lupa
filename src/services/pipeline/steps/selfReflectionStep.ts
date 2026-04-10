import { Log } from '../../loggingService';
import {
    runSelfReflection,
    type SelfReflectionResult,
} from '../../selfReflectionScorer';
import { emptyStepResult } from '../pipelineTypes';
import {
    capturePipelinePhaseState,
    classifyConversationCompletion,
    commitPipelinePhaseState,
    createBufferedHandler,
    dismissHypothesesForDroppedFinding,
    restoreConversationHistory,
    restorePipelinePhaseState,
} from '../pipelineUtils';
import type {
    PipelineContext,
    PipelineStep,
    PipelineStepResult,
} from '../pipelineTypes';

export function createSelfReflectionStep(): PipelineStep {
    return {
        name: 'self-reflection',
        label: 'Self-Reflection Scoring',
        description:
            'LLM scores each finding for confidence via score_finding tool. ' +
            'Low-confidence findings are dropped.',
        kind: 'llm-conversation',

        shouldRun(context: PipelineContext): boolean {
            return context.findingStore.size > 0;
        },

        async execute(context: PipelineContext): Promise<PipelineStepResult> {
            context.progressCallback?.('Self-reflection scoring...', 0.75);

            const preReflectionHistory =
                context.conversationManager.getHistory();
            const rollbackState = capturePipelinePhaseState(context, {
                conversationHistory: preReflectionHistory,
                findingStoreSnapshot: context.findingStore.createSnapshot(),
                selfReflectionScores: context.selfReflectionScores,
            });
            const { handler: phaseHandler, flushCompletions } =
                createBufferedHandler(context.handler);

            let reflectionResult: SelfReflectionResult;
            try {
                reflectionResult = await runSelfReflection({
                    findingStore: context.findingStore,
                    parsedDiff: context.parsedDiff,
                    calibrationProfile: context.calibrationProfile,
                    conversationManager: context.conversationManager,
                    conversationRunner: context.conversationRunner,
                    systemPrompt: context.systemPrompt,
                    token: context.executionContext.cancellationToken,
                    handler: phaseHandler,
                });
            } catch (error) {
                restorePipelinePhaseState(context, rollbackState);
                throw error;
            }

            const completion = classifyConversationCompletion(
                context.conversationRunner
            );
            if (!completion.completed) {
                restorePipelinePhaseState(context, rollbackState);
                Log.warn(
                    `Self-reflection scoring ${completion.reason} — preserving original self-reflection state`
                );

                return emptyStepResult({
                    budgetExhausted: completion.budgetExhausted,
                    summary: `Self-reflection incomplete: conversation ${completion.reason}. Original self-reflection state preserved.`,
                });
            }

            restoreConversationHistory(
                context.conversationManager,
                preReflectionHistory
            );

            const kept: typeof reflectionResult.scores = [];
            for (const score of reflectionResult.scores) {
                if (context.findingStore.getById(score.findingId)) {
                    kept.push(score);
                } else {
                    dismissHypothesesForDroppedFinding(
                        score.findingId,
                        context.executionContext.reasoningChain,
                        'Finding dropped by self-reflection scoring'
                    );
                }
            }
            context.selfReflectionScores = kept;

            flushCompletions();

            commitPipelinePhaseState(
                context,
                context.rewrittenAnalysis ??
                    context.lastCommittedReviewText ??
                    ''
            );

            return {
                findingsDropped: reflectionResult.dropped,
                findingsDowngraded: [],
                toolCallRecords: [],
            };
        },
    };
}
