import type {
    PipelineStep,
    PipelineContext,
    PipelineStepResult,
    StepRecord,
} from './pipelineTypes';
import { Log } from '../loggingService';
import { isCancellationError } from '../../utils/asyncUtils';
import { getErrorMessage } from '../../utils/errorUtils';

/**
 * Generic pipeline runner. Iterates steps in order:
 * check shouldRun → time → execute → record.
 */
export async function runPipeline(
    steps: PipelineStep[],
    context: PipelineContext
): Promise<StepRecord[]> {
    const records: StepRecord[] = [];

    function pushSkipRecord(
        step: PipelineStep,
        status: 'skipped' | 'cancelled'
    ): void {
        records.push({
            name: step.name,
            label: step.label,
            kind: step.kind,
            status,
            durationMs: 0,
        });
    }

    for (const step of steps) {
        if (
            context.executionContext.cancellationToken
                .isCancellationRequested &&
            step.kind !== 'programmatic'
        ) {
            pushSkipRecord(step, 'cancelled');
            continue;
        }

        if (context.mainAnalysisDegraded && step.kind === 'llm-conversation') {
            pushSkipRecord(step, 'skipped');
            Log.info(
                `Pipeline: skipping "${step.label}" because main analysis degraded`
            );
            continue;
        }

        if (!step.shouldRun(context)) {
            pushSkipRecord(step, 'skipped');
            Log.info(`Pipeline: skipping "${step.label}"`);
            continue;
        }

        Log.info(`Pipeline: starting "${step.label}"`);
        const start = performance.now();

        let result: PipelineStepResult;
        try {
            result = await step.execute(context);
        } catch (error) {
            if (isCancellationError(error)) {
                throw error;
            }
            const durationMs = Math.round(performance.now() - start);
            records.push({
                name: step.name,
                label: step.label,
                kind: step.kind,
                status: 'failed',
                durationMs,
            });
            Log.warn(
                `Pipeline: "${step.label}" failed after ${durationMs}ms — ${getErrorMessage(error)}`
            );
            continue;
        }
        const durationMs = Math.round(performance.now() - start);

        // Accumulate dropped/downgraded titles into shared context
        if (result.findingsDropped.length > 0) {
            context.droppedTitles.push(...result.findingsDropped);
        }
        if (result.findingsDowngraded.length > 0) {
            context.downgradedTitles.push(...result.findingsDowngraded);
        }

        // Accumulate tool call records
        if (result.toolCallRecords.length > 0) {
            context.additionalToolCallRecords.push(...result.toolCallRecords);
        }

        records.push({
            name: step.name,
            label: step.label,
            kind: step.kind,
            status: 'executed',
            durationMs,
            result,
            budgetExhausted: result.budgetExhausted,
        });

        Log.info(
            `Pipeline: "${step.label}" completed in ${durationMs}ms` +
                (result.findingsDropped.length > 0
                    ? ` (dropped ${result.findingsDropped.length})`
                    : '') +
                (result.summary ? ` — ${result.summary}` : '')
        );
    }

    return records;
}
