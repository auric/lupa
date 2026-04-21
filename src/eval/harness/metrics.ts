import {
    FINDING_SEVERITIES,
    type FindingSeverity,
} from '../../types/findingTypes';
import type {
    AggregateStats,
    PerFixtureAggregate,
    PerModelAggregate,
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
    const resolutionRate = meanStddev(
        ok
            .map((r) =>
                r.resolution && r.resolution.total > 0
                    ? r.resolution.resolutionRate
                    : Number.NaN
            )
            .filter(isFinite)
    );
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

export function meanStddev(values: readonly number[]): AggregateStats {
    const n = values.length;
    if (n === 0) {
        return { count: 0, mean: Number.NaN, stddev: Number.NaN };
    }
    if (n === 1) {
        return { count: 1, mean: values[0]!, stddev: 0 };
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
    return { count: n, mean, stddev: Math.sqrt(sqSum / n) };
}

function aggregateResolutionRateBySeverity(
    runs: readonly SingleRun[]
): Partial<Record<FindingSeverity, AggregateStats>> {
    const values: Partial<Record<FindingSeverity, number[]>> = {};
    for (const severity of FINDING_SEVERITIES) {
        values[severity] = [];
    }

    for (const run of runs) {
        for (const severity of FINDING_SEVERITIES) {
            const bucket = run.resolution?.bySeverity[severity];
            if (!bucket || bucket.total === 0) {
                continue;
            }
            const rate = bucket.resolutionRate;
            if (Number.isFinite(rate)) {
                values[severity]!.push(rate);
            }
        }
    }

    const result: Partial<Record<FindingSeverity, AggregateStats>> = {};
    for (const severity of FINDING_SEVERITIES) {
        result[severity] = meanStddev(values[severity] ?? []);
    }
    return result;
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
