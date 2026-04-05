import { Log } from '../../loggingService';
import {
    runSelfReflection,
    type SelfReflectionResult,
} from '../../selfReflectionScorer';
import type { ToolCallHandler } from '../../../models/conversationRunner';
import { emptyStepResult } from '../pipelineTypes';
import {
    capturePipelinePhaseState,
    classifyConversationCompletion,
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
            const bufferedToolCallCompletions: Parameters<
                NonNullable<ToolCallHandler['onToolCallComplete']>
            >[] = [];
            const phaseHandler: ToolCallHandler = {
                onIterationStart: context.handler.onIterationStart,
                onToolCallStart: context.handler.onToolCallStart,
                onToolCallComplete: (...args) => {
                    bufferedToolCallCompletions.push(args);
                },
                getContextStatusSuffix: context.handler.getContextStatusSuffix,
            };

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

            context.selfReflectionScores = reflectionResult.scores.filter(
                (score) =>
                    context.findingStore.getById(score.findingId) !== undefined
            );

            for (const completionArgs of bufferedToolCallCompletions) {
                context.handler.onToolCallComplete?.(...completionArgs);
            }

            return {
                findingsDropped: reflectionResult.dropped,
                findingsDowngraded: [],
                toolCallRecords: [],
            };
        },
    };
}
