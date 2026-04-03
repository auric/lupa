import { Log } from '../../loggingService';
import { INVESTIGATION_TOOLS } from '../../../models/toolConstants';
import { filterTools } from '../pipelineUtils';
import type {
    PipelineContext,
    PipelineStep,
    PipelineStepResult,
} from '../pipelineTypes';

const CHALLENGE_BUDGET = 15;
const MIN_FILES_FOR_NONTRIVIAL_PR = 5;

export function createZeroFindingChallengeStep(): PipelineStep {
    return {
        name: 'zero-finding-challenge',
        label: 'Zero-Finding Challenge',
        description:
            'Challenges any model that reports 0 findings on non-trivial PRs',
        kind: 'llm-conversation',

        shouldRun(context: PipelineContext): boolean {
            return (
                context.findingStore.size === 0 &&
                context.parsedDiff.length >= MIN_FILES_FOR_NONTRIVIAL_PR
            );
        },

        async execute(context: PipelineContext): Promise<PipelineStepResult> {
            Log.info(
                `Zero-finding challenge: model reported 0 findings on non-trivial ${context.parsedDiff.length}-file PR`
            );

            const investigationDisabled =
                context.disabledToolNames &&
                INVESTIGATION_TOOLS.some((t) =>
                    context.disabledToolNames!.has(t)
                );

            const investigatedCount =
                context.executionContext.investigatedFiles?.size ?? 0;

            const investigateInstruction = investigationDisabled
                ? '• You do NOT have direct investigation tools. Use run_subagent_batch to delegate investigation of skipped files to subagents'
                : '• If you skipped files, investigate them now with get_file_diff and find_symbol';

            context.conversationManager.addUserMessage(
                `ZERO FINDINGS ALERT — You reviewed ${context.parsedDiff.length} changed files ` +
                    `(investigated ${investigatedCount} via tools) and recorded 0 findings. ` +
                    `On a PR of this size with substantive code changes, this is unusual.\n\n` +
                    `Before finalizing:\n` +
                    `• Re-examine each file group for potential logic errors, missing error handling, or security issues\n` +
                    `${investigateInstruction}\n` +
                    `• Record any genuine findings you may have overlooked with record_finding\n` +
                    `• If truly no issues exist, that is acceptable — but verify you checked thoroughly\n\n` +
                    `Then call submit_review again.`
            );

            const tools = filterTools(context.availableTools, [
                'retract_finding',
            ]);

            await context.conversationRunner.run(
                {
                    systemPrompt: context.systemPrompt,
                    maxIterations: CHALLENGE_BUDGET,
                    tools,
                    disabledToolNames: context.disabledToolNames,
                    label: 'Zero-Finding Challenge',
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
