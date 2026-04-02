import { Log } from '../../loggingService';
import type {
    PipelineContext,
    PipelineStep,
    PipelineStepResult,
} from '../pipelineTypes';

export function createFindingValidationStep(): PipelineStep {
    return {
        name: 'finding-validation',
        label: 'Finding Validation',
        description:
            'Validates surviving findings against the parsed diff using LSP checks',
        kind: 'programmatic',

        shouldRun(context: PipelineContext): boolean {
            return (
                context.findingStore.size > 0 && context.parsedDiff?.length > 0
            );
        },

        async execute(context: PipelineContext): Promise<PipelineStepResult> {
            const findingsDropped: string[] = [];
            const findingsDowngraded: string[] = [];

            context.progressCallback?.('Validating findings...', 0.5);

            const survivingFindings = context.findingStore.getAll();
            const validation = await context.findingValidator.validate(
                survivingFindings,
                context.parsedDiff,
                context.token
            );

            for (const v of validation.validated) {
                if (v.verdict === 'drop') {
                    findingsDropped.push(v.finding.title);
                    context.findingStore.remove(v.finding.id);
                } else if (v.verdict === 'downgrade' && v.downgradedSeverity) {
                    findingsDowngraded.push(v.finding.title);
                    context.findingStore.updateSeverity(
                        v.finding.id,
                        v.downgradedSeverity
                    );
                }
            }

            let summary: string | undefined;
            if (validation.dropped > 0 || validation.downgraded > 0) {
                summary = `FindingValidator: ${validation.kept} kept, ${validation.downgraded} downgraded, ${validation.dropped} dropped`;
                Log.info(summary);
            }

            return {
                findingsDropped,
                findingsDowngraded,
                toolCallRecords: [],
                summary,
            };
        },
    };
}
