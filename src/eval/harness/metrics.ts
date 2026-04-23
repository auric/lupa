import {
    FINDING_SEVERITIES,
    type FindingSeverity,
} from '../../types/findingTypes';
import type {
    AggregateStats,
    PerFixtureAggregate,
    PerModelAggregate,
    ResolutionMetricStatus,
    SingleRun,
} from './types';

/**
 * Aggregate raw per-(fixture, model, seed) runs into per-model and per-fixture
 * summary statistics. Means/stddevs are computed over the ok subset only;
 * failed runs are counted separately via the `failures` field.
 */
export function aggregate(runs: readonly SingleRun[]): {
    perFixture: PerFixtureAggregate[];
    perModel: PerModelAggregate[];
} {
    const perFixture: PerFixtureAggregate[] = [];
    const byFixture = groupBy(runs, (r) => r.fixture);
    const fixtureNames = Array.from(byFixture.keys()).sort();
    for (const fixture of fixtureNames) {
        const fixtureRuns = byFixture.get(fixture)!;
        const kind = fixtureRuns[0]!.kind;
        const byModel = groupBy(fixtureRuns, (r) => r.model);
        const perModel: PerModelAggregate[] = [];
        for (const model of Array.from(byModel.keys()).sort()) {
            perModel.push(aggregateModel(model, byModel.get(model)!));
        }
        perFixture.push({ fixture, kind, perModel });
    }

    const perModelOverall: PerModelAggregate[] = [];
    const byModelAll = groupBy(runs, (r) => r.model);
    for (const model of Array.from(byModelAll.keys()).sort()) {
        perModelOverall.push(aggregateModel(model, byModelAll.get(model)!));
    }

    return { perFixture, perModel: perModelOverall };
}

function aggregateModel(
    model: string,
    runs: readonly SingleRun[]
): PerModelAggregate {
    const ok = runs.filter((r) => r.ok);
    const precision = meanStddev(
        ok.map((r) => r.match?.precision ?? 0).filter(isFinite)
    );
    const recall = meanStddev(
        ok.map((r) => r.match?.recall ?? 0).filter(isFinite)
    );
    const f1 = meanStddev(ok.map((r) => r.match?.f1 ?? 0).filter(isFinite));
    const resolutionRate = aggregateResolutionRate(ok);
    const iterations = meanStddev(
        ok.map((r) => r.result?.telemetry.iterations ?? 0)
    );
    const promptTokens = meanStddev(
        ok.map((r) => r.result?.telemetry.promptTokens ?? 0)
    );
    const completionTokens = meanStddev(
        ok.map((r) => r.result?.telemetry.completionTokens ?? 0)
    );
    // TODO(quest-8.1): plumb token costs once AnalysisEngine exposes them
    const costUsd = meanStddev(ok.map(() => 0));
    const wallClockMs = meanStddev(ok.map((r) => r.durationMs));

    return {
        model,
        precision,
        recall,
        f1,
        resolutionRate,
        resolutionRateBySeverity: aggregateResolutionRateBySeverity(ok),
        iterations,
        promptTokens,
        completionTokens,
        costUsd,
        wallClockMs,
        runs: runs.length,
        failures: runs.length - ok.length,
    };
}

/**
 * Computes mean and population standard deviation.
 *
 * Returns `NaN` for both `mean` and `stddev` when the input array is empty.
 */
export function meanStddev(values: readonly number[]): AggregateStats {
    const n = values.length;
    if (n === 0) {
        return {
            count: 0,
            mean: Number.NaN,
            stddev: Number.NaN,
            invalidCount: 0,
            noFindingsCount: 0,
        };
    }
    if (n === 1) {
        return {
            count: 1,
            mean: values[0]!,
            stddev: 0,
            invalidCount: 0,
            noFindingsCount: 0,
        };
    }
    let sum = 0;
    for (const v of values) {
        sum += v;
    }
    const mean = sum / n;
    let sqSum = 0;
    for (const v of values) {
        const d = v - mean;
        sqSum += d * d;
    }
    return {
        count: n,
        mean,
        stddev: Math.sqrt(sqSum / n),
        invalidCount: 0,
        noFindingsCount: 0,
    };
}

/**
 * Computes aggregate resolution rate over a set of runs.
 *
 * Runs without resolution data map to `NaN`. These values are filtered out
 * via `Number.isFinite` before computing aggregates. Consequently, the
 * resolution rate may be based on fewer data points than precision/recall/f1,
 * which fall back to `0` for missing data rather than `NaN`.
 */
function aggregateResolutionRate(runs: readonly SingleRun[]): AggregateStats {
    const values: number[] = [];
    let invalidCount = 0;
    let noFindingsCount = 0;

    for (const run of runs) {
        const status = getRunResolutionMetricStatus(run);
        if (status === 'valid') {
            const rate = run.resolution?.resolutionRate ?? Number.NaN;
            if (Number.isFinite(rate)) {
                values.push(rate);
            } else {
                invalidCount++;
            }
            continue;
        }

        if (status === 'invalid-skipped') {
            invalidCount++;
            continue;
        }

        noFindingsCount++;
    }

    return withResolutionStatusCounts(values, invalidCount, noFindingsCount);
}

function aggregateResolutionRateBySeverity(
    runs: readonly SingleRun[]
): Partial<Record<FindingSeverity, AggregateStats>> {
    const result: Partial<Record<FindingSeverity, AggregateStats>> = {};
    for (const severity of FINDING_SEVERITIES) {
        const values: number[] = [];
        let invalidCount = 0;
        let noFindingsCount = 0;

        for (const run of runs) {
            if (run.resolutionWarning) {
                if (
                    run.result != null &&
                    run.result.findings.some(
                        (finding) => finding.severity === severity
                    )
                ) {
                    invalidCount++;
                } else {
                    noFindingsCount++;
                }
                continue;
            }

            const bucket = run.resolution?.bySeverity[severity];
            const status = bucket?.metricStatus ?? 'no-findings';
            if (status === 'valid') {
                const rate = bucket?.resolutionRate ?? Number.NaN;
                if (Number.isFinite(rate)) {
                    values.push(rate);
                } else {
                    invalidCount++;
                }
                continue;
            }

            if (status === 'invalid-skipped') {
                invalidCount++;
                continue;
            }

            noFindingsCount++;
        }

        result[severity] = withResolutionStatusCounts(
            values,
            invalidCount,
            noFindingsCount
        );
    }
    return result;
}

function getRunResolutionMetricStatus(run: SingleRun): ResolutionMetricStatus {
    if (run.resolutionWarning) {
        return run.result == null || run.result.findings.length === 0
            ? 'no-findings'
            : 'invalid-skipped';
    }
    return run.resolution?.metricStatus ?? 'no-findings';
}

function withResolutionStatusCounts(
    values: readonly number[],
    invalidCount: number,
    noFindingsCount: number
): AggregateStats {
    const stats = meanStddev(values);
    return { ...stats, invalidCount, noFindingsCount };
}

function groupBy<T, K>(
    items: readonly T[],
    keyFn: (item: T) => K
): Map<K, T[]> {
    const out = new Map<K, T[]>();
    for (const item of items) {
        const k = keyFn(item);
        const bucket = out.get(k);
        if (bucket) {
            bucket.push(item);
        } else {
            out.set(k, [item]);
        }
    }
    return out;
}

function isFinite(n: number): boolean {
    return Number.isFinite(n);
}
