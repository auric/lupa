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

            context.selfReflectionScores = reflectionResult.scores;

            return {
                findingsDropped: reflectionResult.dropped,
                findingsDowngraded: [],
                toolCallRecords: [],
            };
        },
    };
}
