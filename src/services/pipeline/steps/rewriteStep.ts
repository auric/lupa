import { Log } from '../../loggingService';
import {
    commitPipelinePhaseState,
    runGuardedConversationPhase,
} from '../pipelineUtils';
import { emptyStepResult } from '../pipelineTypes';
import type {
    PipelineStep,
    PipelineContext,
    PipelineStepResult,
} from '../pipelineTypes';

const REWRITE_BUDGET = 25;
const REWRITE_ALLOWED_TOOLS = new Set([
    'think',
    'submit_review',
    'retract_finding',
]);

export function createRewriteStep(): PipelineStep {
    return {
        name: 'rewrite',
        label: 'Rewrite Review',
        description:
            'Re-enters conversation to rewrite review without dropped findings. ' +
            'think, submit_review, and retract_finding tools are available.',
        kind: 'llm-conversation',

        shouldRun(context: PipelineContext): boolean {
            return (
                context.droppedTitles.length > 0 ||
                context.downgradedTitles.length > 0
            );
        },

        async execute(context: PipelineContext): Promise<PipelineStepResult> {
            const hasDropped = context.droppedTitles.length > 0;
            const hasDowngraded = context.downgradedTitles.length > 0;

            Log.info(
                `Post-analysis: ${context.droppedTitles.length} dropped, ${context.downgradedTitles.length} downgraded — re-entering conversation for rewrite`
            );

            const parts: string[] = [];
            if (hasDropped) {
                const droppedList = context.droppedTitles
                    .map((t) => `"${t}"`)
                    .join(', ');
                parts.push(
                    `Post-analysis verification has removed ${context.droppedTitles.length} finding(s): ${droppedList}. ` +
                        'These findings failed evidence audit, programmatic validation, or adversarial verification. ' +
                        'Rewrite your review WITHOUT these removed findings.'
                );
            }
            if (hasDowngraded) {
                const downgradedList = context.downgradedTitles
                    .map((t) => `"${t}"`)
                    .join(', ');
                parts.push(
                    `Post-analysis verification has downgraded the severity of ${context.downgradedTitles.length} finding(s): ${downgradedList}. ` +
                        'Update these findings to reflect their new (lower) severity levels.'
                );
            }
            parts.push('Then call submit_review.');

            // Ensure rollback target reflects current finding store
            // (programmatic steps may have dropped findings since pipeline creation)
            context.lastCommittedFindingStoreSnapshot =
                context.findingStore.createSnapshot();

            const rollbackConversationHistory =
                context.conversationManager.getHistory();
            const rollbackFindingSnapshot =
                context.lastCommittedFindingStoreSnapshot;

            const rollbackReviewText = context.lastCommittedReviewText;
            const rollbackSelfReflectionScores = structuredClone(
                context.lastCommittedSelfReflectionScores ?? []
            );
            context.conversationManager.addUserMessage(parts.join(' '));

            const rewriteTools = context.availableTools.filter((t) =>
                REWRITE_ALLOWED_TOOLS.has(t.name)
            );

            let rewriteResult: string;
            let completion;
            try {
                ({ latestReview: rewriteResult, completion } =
                    await runGuardedConversationPhase({
                        context,
                        label: 'Rewrite Phase',
                        maxIterations: REWRITE_BUDGET,
                        tools: rewriteTools,
                        rollbackFindingStoreToSnapshot: rollbackFindingSnapshot,
                        rollbackConversationHistory,
                    }));
            } catch (error) {
                context.rewrittenAnalysis = rollbackReviewText;
                context.selfReflectionScores = rollbackSelfReflectionScores;
                throw error;
            }

            if (!completion.completed) {
                context.rewrittenAnalysis = rollbackReviewText;
                context.selfReflectionScores = rollbackSelfReflectionScores;
                Log.warn(
                    `Rewrite phase ${completion.reason} — preserving original analysis text`
                );
                return emptyStepResult({
                    budgetExhausted: completion.budgetExhausted,
                    summary: `Rewrite incomplete: conversation ${completion.reason}. Original review preserved.`,
                });
            }

            context.rewrittenAnalysis = rewriteResult;
            context.selfReflectionScores = context.selfReflectionScores.filter(
                (score) =>
                    context.findingStore.getById(score.findingId) !== undefined
            );
            commitPipelinePhaseState(context, rewriteResult);

            return emptyStepResult();
        },
    };
}
