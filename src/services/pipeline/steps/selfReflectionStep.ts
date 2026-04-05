import { Log } from '../../loggingService';
import type {
    PipelineStep,
    PipelineContext,
    PipelineStepResult,
} from '../pipelineTypes';
import { runSelfReflection } from '../../selfReflectionScorer';

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

            const preReflectionMessageCount =
                context.conversationManager.getMessageCount();

            const reflectionResult = await runSelfReflection({
                findingStore: context.findingStore,
                parsedDiff: context.parsedDiff,
                calibrationProfile: context.calibrationProfile,
                conversationManager: context.conversationManager,
                conversationRunner: context.conversationRunner,
                systemPrompt: context.systemPrompt,
                token: context.executionContext.cancellationToken,
                handler: context.handler,
            });

            context.conversationManager.truncateToMessageCount(
                preReflectionMessageCount
            );

            // Only include scores for findings that survived the drop threshold.
            // Dropped findings are removed from findingStore by runSelfReflection,
            // so filter to those still present.
            context.selfReflectionScores = reflectionResult.scores.filter(
                (s) => context.findingStore.getById(s.findingId) !== undefined
            );

            const wasCancelled = context.conversationRunner.wasCancelled;
            const hitMax = context.conversationRunner.hitMaxIterations;
            const hitRate = context.conversationRunner.hitRateLimit;
            const degraded = context.conversationRunner.degraded;

            let reason: string | undefined;
            if (wasCancelled || hitMax || hitRate || degraded) {
                reason = wasCancelled
                    ? 'was cancelled'
                    : hitRate
                      ? 'hit rate limit'
                      : hitMax
                        ? 'hit iteration limit'
                        : `exited abnormally (${context.conversationRunner.exitReason ?? 'unknown'})`;
                Log.warn(
                    `Self-reflection scoring ${reason} — ${context.selfReflectionScores.length} of ${reflectionResult.scores.length} scores kept`
                );
            }

            return {
                findingsDropped: reflectionResult.dropped,
                findingsDowngraded: [],
                toolCallRecords: [],
                budgetExhausted: hitMax,
                summary: reason
                    ? `Self-reflection incomplete: conversation ${reason}. Partial scores applied, unscored findings kept.`
                    : undefined,
            };
        },
    };
}
