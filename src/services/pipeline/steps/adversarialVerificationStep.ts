import { AdversarialVerifier } from '../../adversarialVerifier';
import { dismissHypothesesForDroppedFinding } from '../pipelineUtils';
import type {
    PipelineContext,
    PipelineStep,
    PipelineStepResult,
} from '../pipelineTypes';

export function createAdversarialVerificationStep(): PipelineStep {
    return {
        name: 'adversarial-verification',
        label: 'Adversarial Verification',
        description:
            'Spawns adversarial subagents with investigation tools + submit_verdict (no record_finding) to challenge findings',
        kind: 'llm-subagent',

        shouldRun(context: PipelineContext): boolean {
            return context.findingStore.size > 0;
        },

        async execute(context: PipelineContext): Promise<PipelineStepResult> {
            const findingIdsBefore = new Set(
                context.findingStore.getAll().map((f) => f.id)
            );

            const adversarialVerifier = new AdversarialVerifier();
            const adversarialResult = await adversarialVerifier.verify(
                context.findingStore,
                context.calibrationProfile,
                context.subagentExecutor,
                context.parsedDiff,
                context.executionContext.cancellationToken,
                context.progressCallback
                    ? (msg) => context.progressCallback!(msg, 0.5)
                    : undefined
            );

            for (const id of findingIdsBefore) {
                if (!context.findingStore.getById(id)) {
                    dismissHypothesesForDroppedFinding(
                        id,
                        context.executionContext.reasoningChain,
                        'Finding refuted by adversarial verification'
                    );
                }
            }

            return {
                findingsDropped: adversarialResult.refuted,
                findingsDowngraded: [],
                toolCallRecords: adversarialResult.toolCallRecords,
            };
        },
    };
}
