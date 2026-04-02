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

    for (const step of steps) {
        if (
            context.executionContext.cancellationToken
                .isCancellationRequested &&
            step.kind !== 'programmatic'
        ) {
            records.push({
                name: step.name,
                label: step.label,
                kind: step.kind,
                status: 'cancelled',
                durationMs: 0,
            });
            continue;
        }

        if (!step.shouldRun(context)) {
            records.push({
                name: step.name,
                label: step.label,
                kind: step.kind,
                status: 'skipped',
                durationMs: 0,
            });
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

            // Record remaining steps as not-reached for telemetry/Phase UI
            const failedIdx = steps.indexOf(step);
            for (let i = failedIdx + 1; i < steps.length; i++) {
                const remaining = steps[i]!;
                records.push({
                    name: remaining.name,
                    label: remaining.label,
                    kind: remaining.kind,
                    status: 'not-reached',
                    durationMs: 0,
                });
            }
            break;
        }
        const durationMs = Math.round(performance.now() - start);

        // Accumulate dropped titles into shared context
        if (result.findingsDropped.length > 0) {
            context.droppedTitles.push(...result.findingsDropped);
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
