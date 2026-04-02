import { Log } from '../../loggingService';
import type {
    PipelineStep,
    PipelineContext,
    PipelineStepResult,
} from '../types';

const REWRITE_BUDGET = 10;
const REWRITE_ALLOWED_TOOLS = new Set(['think', 'submit_review']);

export function createRewriteStep(): PipelineStep {
    return {
        name: 'rewrite',
        label: 'Rewrite Review',
        description:
            'Re-enters conversation to rewrite review without dropped findings. ' +
            'Only think and submit_review tools are available.',
        kind: 'llm-conversation',

        shouldRun(context: PipelineContext): boolean {
            return context.droppedTitles.length > 0;
        },

        async execute(context: PipelineContext): Promise<PipelineStepResult> {
            Log.info(
                `Post-analysis dropped ${context.droppedTitles.length} finding(s), re-entering conversation for rewrite`
            );

            const droppedList = context.droppedTitles
                .map((t) => `"${t}"`)
                .join(', ');

            context.conversationManager.addUserMessage(
                `Post-analysis verification has removed ${context.droppedTitles.length} finding(s): ${droppedList}. ` +
                    'These findings failed evidence audit, programmatic validation, or adversarial verification. ' +
                    'Rewrite your review WITHOUT these removed findings, then call submit_review.'
            );

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
                context.token,
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
