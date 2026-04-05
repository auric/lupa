import { Log } from '../../loggingService';
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

            context.conversationManager.addUserMessage(parts.join(' '));

            const rewriteTools = context.availableTools.filter((t) =>
                REWRITE_ALLOWED_TOOLS.has(t.name)
            );

            context.rewrittenAnalysis = await context.conversationRunner.run(
                {
                    systemPrompt: context.systemPrompt,
                    maxIterations: REWRITE_BUDGET,
                    tools: rewriteTools,
                    disabledToolNames: context.disabledToolNames,
                    label: 'Rewrite Phase',
                    requiresExplicitCompletion: true,
                },
                context.conversationManager,
                context.executionContext.cancellationToken,
                context.handler
            );

            return {
                findingsDropped: [],
                findingsDowngraded: [],
                toolCallRecords: [],
            };
        },
    };
}
