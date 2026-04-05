import { Log } from '../../loggingService';
import { INVESTIGATION_TOOLS } from '../../../models/toolConstants';
import { filterTools } from '../pipelineUtils';
import type {
    PipelineContext,
    PipelineStep,
    PipelineStepResult,
} from '../pipelineTypes';

const WORKFLOW_BUDGET = 30;

export function createWorkflowEnforcementStep(): PipelineStep {
    return {
        name: 'workflow-enforcement',
        label: 'Workflow Enforcement',
        description:
            'Detects workflow gaps (think tool not called, required tools not used, uninvestigated files) and re-enters conversation to complete them',
        kind: 'llm-conversation',

        shouldRun(): boolean {
            return true;
        },

        async execute(context: PipelineContext): Promise<PipelineStepResult> {
            const investigationDisabled =
                context.disabledToolNames &&
                INVESTIGATION_TOOLS.some((t) =>
                    context.disabledToolNames!.has(t)
                );

            const workflowGaps: string[] = [];
            const ec = context.executionContext;

            const thinkToolAvailable = context.availableTools.some(
                (t) => t.name === 'think_about_completion'
            );
            const thinkCalled =
                (ec.toolCallCounts.get('think_about_completion') ?? 0) > 0;
            if (thinkToolAvailable && !thinkCalled) {
                workflowGaps.push(
                    'You did not call think_about_completion to reflect on your findings'
                );
            }

            const requiredTools =
                context.calibrationProfile.investigationProtocol
                    .requiredToolsBeforeDone;
            const availableToolNames = new Set(
                context.availableTools.map((t) => t.name)
            );
            const missingTools = requiredTools.filter(
                (t: string) =>
                    availableToolNames.has(t) &&
                    (ec.toolCallCounts.get(t) ?? 0) === 0
            );
            if (missingTools.length > 0) {
                workflowGaps.push(
                    `Required investigation tools not used: ${missingTools.join(', ')}`
                );
            }

            if (ec.completionReadiness && !ec.completionReadiness.ready) {
                const cr = ec.completionReadiness;
                const investigateInstruction = investigationDisabled
                    ? 'You do NOT have direct investigation tools (read_file, get_file_diff, etc.). ' +
                      'Use run_subagent_batch to delegate investigation of these files to subagents, then call submit_review.'
                    : 'Investigate these files before submitting.';
                workflowGaps.push(
                    `think_about_completion flagged ${cr.uninvestigatedFiles.length} uninvestigated file(s): ${cr.uninvestigatedFiles.join(', ')}. ${investigateInstruction}`
                );
            }

            if (workflowGaps.length > 0) {
                Log.info(
                    `Workflow enforcement: ${workflowGaps.length} gap(s) detected, re-entering for completion`
                );
                const findingCount = context.findingStore.size;
                context.conversationManager.addUserMessage(
                    `WORKFLOW INCOMPLETE — you recorded ${findingCount} finding(s) but skipped required steps:\n` +
                        workflowGaps.map((g) => `• ${g}`).join('\n') +
                        '\n\nComplete these steps NOW, then call submit_review again.'
                );

                const tools = filterTools(context.availableTools, [
                    'retract_finding',
                ]);

                await context.conversationRunner.run(
                    {
                        systemPrompt: context.systemPrompt,
                        maxIterations: WORKFLOW_BUDGET,
                        tools,
                        disabledToolNames: context.disabledToolNames,
                        label: 'Workflow Completion',
                        requiresExplicitCompletion: true,
                    },
                    context.conversationManager,
                    context.executionContext.cancellationToken,
                    context.handler
                );

                const wasCancelled = context.conversationRunner.wasCancelled;
                const hitMax = context.conversationRunner.hitMaxIterations;

                if (wasCancelled || hitMax) {
                    const reason = wasCancelled
                        ? 'was cancelled'
                        : 'hit iteration limit';
                    Log.warn(`Workflow enforcement conversation ${reason}`);
                    return {
                        findingsDropped: [],
                        findingsDowngraded: [],
                        toolCallRecords: [],
                        budgetExhausted: hitMax,
                        summary: `Workflow enforcement incomplete: conversation ${reason}`,
                    };
                }
            }

            return {
                findingsDropped: [],
                findingsDowngraded: [],
                toolCallRecords: [],
            };
        },
    };
}
