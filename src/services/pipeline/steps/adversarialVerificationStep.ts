import { AdversarialVerifier } from '../../adversarialVerifier';
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
            const findingsDropped: string[] = [];

            const adversarialVerifier = new AdversarialVerifier();
            const adversarialResult = await adversarialVerifier.verify(
                context.findingStore,
                context.calibrationProfile,
                context.subagentExecutor,
                context.parsedDiff,
                context.token,
                context.progressCallback
                    ? (msg) => context.progressCallback!(msg, 0.5)
                    : undefined
            );

            if (adversarialResult.refuted.length > 0) {
                findingsDropped.push(...adversarialResult.refuted);
            }

            return {
                findingsDropped,
                findingsDowngraded: [],
                toolCallRecords: adversarialResult.toolCallRecords,
            };
        },
    };
}
