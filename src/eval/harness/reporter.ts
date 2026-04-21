import path from 'node:path';
import fs from 'node:fs/promises';
import { RESULTS_ROOT } from './constants';
import { aggregate } from './metrics';
import type {
    AggregateStats,
    HarnessReport,
    PerModelAggregate,
    SingleRun,
} from './types';

const ERROR_MESSAGE_TRUNCATE = 200;

export interface ReporterInputs {
    runs: readonly SingleRun[];
    models: readonly string[];
    seeds: number;
    fixtures: readonly string[];
    generatedAt: Date;
    gitSha: string;
}

export async function writeReport(
    inputs: ReporterInputs
): Promise<{ jsonPath: string; markdownPath: string }> {
    const stamp = inputs.generatedAt
        .toISOString()
        .replace(/\..+$/, '')
        .replace('T', '_')
        .replace(/:/g, '-');
    const shortSha = inputs.gitSha.slice(0, 7);
    const baseName = `${stamp}-${shortSha}`;

    await fs.mkdir(RESULTS_ROOT, { recursive: true });

    const { perFixture, perModel } = aggregate(inputs.runs);

    const report: HarnessReport = {
        generatedAt: inputs.generatedAt.toISOString(),
        gitSha: inputs.gitSha,
        models: [...inputs.models],
        seeds: inputs.seeds,
        fixtures: [...inputs.fixtures],
        perFixture,
        perModel,
        rawRuns: [...inputs.runs],
    };

    const jsonPath = path.join(RESULTS_ROOT, `${baseName}.json`);
    await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');

    const markdownPath = path.join(RESULTS_ROOT, `${baseName}.md`);
    await fs.writeFile(markdownPath, renderMarkdown(stamp, report), 'utf8');

    return { jsonPath, markdownPath };
}

function renderMarkdown(stamp: string, report: HarnessReport): string {
    const lines: string[] = [];
    lines.push(`# Lupa eval — ${stamp}`);
    lines.push('');
    lines.push(
        `**Git**: \`${report.gitSha.slice(0, 7)}\`  **Seeds**: ${report.seeds}  ` +
            `**Fixtures**: ${report.fixtures.length}  **Models**: ${report.models.join(', ')}`
    );
    lines.push('');
    lines.push('## Summary (per model, across all fixtures)');
    lines.push('');
    lines.push(
        '| Model | Precision | Recall | F1 | Iters | PromptTok | ComplTok | Cost$ | Wall(s) | Runs | Fail |'
    );
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
    for (const m of report.perModel) {
        lines.push(renderOverallRow(m));
    }
    lines.push('');
    lines.push('## Per-fixture breakdown');
    lines.push('');
    for (const pf of report.perFixture) {
        lines.push(`### ${pf.kind}/${pf.fixture}`);
        lines.push('| Model | Precision | Recall | F1 | Iters | Runs |');
        lines.push('|---|---|---|---|---|---|');
        for (const m of pf.perModel) {
            lines.push(renderFixtureRow(m));
        }
        lines.push('');
    }
    lines.push('## Failures');
    lines.push('');
    const failures = report.rawRuns.filter((r) => !r.ok);
    if (failures.length === 0) {
        lines.push('(none)');
    } else {
        for (const f of failures) {
            const msg = (f.errorMessage ?? '').slice(0, ERROR_MESSAGE_TRUNCATE);
            lines.push(
                `- ${f.kind}/${f.fixture} × ${f.model} × seed=${f.seed}: ${msg}`
            );
        }
    }
    lines.push('');
    return lines.join('\n');
}

function renderOverallRow(m: PerModelAggregate): string {
    return (
        `| ${m.model} | ${fmtStats(m.precision, 2)} | ${fmtStats(m.recall, 2)} | ` +
        `${fmtStats(m.f1, 2)} | ${fmtStats(m.iterations, 1)} | ` +
        `${fmtStats(m.promptTokens, 0)} | ${fmtStats(m.completionTokens, 0)} | ` +
        `${fmtStats(m.costUsd, 2)} | ${fmtSeconds(m.wallClockMs)} | ` +
        `${m.runs} | ${m.failures} |`
    );
}

function renderFixtureRow(m: PerModelAggregate): string {
    return (
        `| ${m.model} | ${fmtStats(m.precision, 2)} | ${fmtStats(m.recall, 2)} | ` +
        `${fmtStats(m.f1, 2)} | ${fmtStats(m.iterations, 1)} | ${m.runs} |`
    );
}

function fmtStats(s: AggregateStats, digits: number): string {
    if (s.count === 0 || Number.isNaN(s.mean)) {
        return '—';
    }
    if (s.stddev > 0) {
        return `${s.mean.toFixed(digits)} ± ${s.stddev.toFixed(digits)}`;
    }
    return s.mean.toFixed(digits);
}

function fmtSeconds(s: AggregateStats): string {
    if (s.count === 0 || Number.isNaN(s.mean)) {
        return '—';
    }
    const meanSec = s.mean / 1_000;
    if (s.stddev > 0) {
        const stddevSec = s.stddev / 1_000;
        return `${meanSec.toFixed(1)} ± ${stddevSec.toFixed(1)}`;
    }
    return meanSec.toFixed(1);
}
