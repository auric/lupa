#!/usr/bin/env node
/**
 * CLI entry point for the Lupa cross-model eval harness. Runs under vite-node
 * (ESM + TS). Loads labelled fixtures, invokes the headless launcher in a
 * fixture × model × seed grid, scores each run against the expected findings,
 * and writes an aggregated JSON + Markdown report.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { loadFixtures } from '../../src/eval/harness/fixtureLoader';
import { invokeHeadless } from '../../src/eval/harness/runnerInvoker';
import { matchFindings } from '../../src/eval/harness/matcher';
import { writeReport } from '../../src/eval/harness/reporter';
import {
    DEFAULT_MODELS,
    DEFAULT_SEEDS,
    DEFAULT_TIMEOUT_MS,
    REPO_ROOT,
    RESULTS_ROOT,
} from '../../src/eval/harness/constants';
import type {
    FixtureKind,
    LoadedFixture,
    SingleRun,
} from '../../src/eval/harness/types';

const USAGE = `Usage: npm run eval -- [options]

Options:
  --models <csv>       Comma-separated vendor/id identifiers
                       (default: ${DEFAULT_MODELS.join(',')})
  --fixtures <csv>     Fixture kinds: synthetic, real, or both
                       (default: synthetic,real)
  --only <csv>         Subset of fixture names to run
  --seeds <n>          Seeds per (fixture, model) cell (default: ${DEFAULT_SEEDS})
  --timeout <ms>       Per-run timeout passed to the launcher
                       (default: ${DEFAULT_TIMEOUT_MS})
  --bail-on-error      Abort on the first runner failure
  --dry-run            Load fixtures + print the plan; skip runner invocation
  --yes                Skip the interactive confirmation prompt (required for
                       non-interactive / CI use)
  --out-dir <path>     Override where the JSON/Markdown reports are written
                       (default: ${RESULTS_ROOT})
  --silent             Suppress per-run progress lines on stderr
  -h, --help           Print this help and exit 0

By default the harness prints its plan and asks "Proceed? [y/N]" on the
terminal before spawning any VS Code instances. In non-interactive contexts
(no TTY on stdin) it refuses to run unless --yes is passed. Each run
consumes Copilot quota — treat --yes with care.
`;

class CliError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CliError';
    }
}

interface ParsedArgs {
    models: string[];
    fixtures: FixtureKind[];
    only: string[] | undefined;
    seeds: number;
    timeoutMs: number;
    bailOnError: boolean;
    dryRun: boolean;
    yes: boolean;
    outDir: string;
    silent: boolean;
    help: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
    const out: ParsedArgs = {
        models: [...DEFAULT_MODELS],
        fixtures: ['synthetic', 'real'],
        only: undefined,
        seeds: DEFAULT_SEEDS,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        bailOnError: false,
        dryRun: false,
        yes: false,
        outDir: RESULTS_ROOT,
        silent: false,
        help: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!;
        if (a === '--') {
            continue;
        }
        if (a === '-h' || a === '--help') {
            out.help = true;
            continue;
        }
        if (a === '--bail-on-error') {
            out.bailOnError = true;
            continue;
        }
        if (a === '--dry-run') {
            out.dryRun = true;
            continue;
        }
        if (a === '--yes') {
            out.yes = true;
            continue;
        }
        if (a === '--silent') {
            out.silent = true;
            continue;
        }
        if (a === '--models') {
            out.models = parseCsv(argv[++i], a);
            continue;
        }
        if (a === '--fixtures') {
            out.fixtures = parseFixtureKinds(argv[++i], a);
            continue;
        }
        if (a === '--only') {
            out.only = parseCsv(argv[++i], a);
            continue;
        }
        if (a === '--seeds') {
            out.seeds = parsePositiveInt(argv[++i], a);
            continue;
        }
        if (a === '--timeout') {
            out.timeoutMs = parsePositiveInt(argv[++i], a);
            continue;
        }
        if (a === '--out-dir') {
            out.outDir = parseStringValue(argv[++i], a);
            continue;
        }
        throw new CliError(`Unknown flag: ${a}`);
    }
    return out;
}

function parseStringValue(raw: string | undefined, flag: string): string {
    if (raw === undefined) {
        throw new CliError(`${flag} requires a value`);
    }
    if (raw.length === 0) {
        throw new CliError(`${flag} value must be non-empty`);
    }
    return raw;
}

function parseCsv(raw: string | undefined, flag: string): string[] {
    const v = parseStringValue(raw, flag);
    const parts = v
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    if (parts.length === 0) {
        throw new CliError(`${flag} must contain at least one value`);
    }
    return parts;
}

function parseFixtureKinds(
    raw: string | undefined,
    flag: string
): FixtureKind[] {
    const parts = parseCsv(raw, flag);
    const out: FixtureKind[] = [];
    for (const p of parts) {
        if (p !== 'synthetic' && p !== 'real') {
            throw new CliError(
                `${flag}: unknown fixture kind '${p}' (expected 'synthetic' or 'real')`
            );
        }
        if (!out.includes(p)) {
            out.push(p);
        }
    }
    return out;
}

function parsePositiveInt(raw: string | undefined, flag: string): number {
    const v = parseStringValue(raw, flag);
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) {
        throw new CliError(`${flag} must be a positive integer (got '${v}')`);
    }
    return n;
}

async function execCapture(
    cmd: string,
    args: readonly string[]
): Promise<{ stdout: string }> {
    return await new Promise((resolve, reject) => {
        const child = spawn(cmd, [...args], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        child.stdout?.on('data', (d) => {
            stdout += d.toString();
        });
        child.on('error', reject);
        child.on('exit', (code) => {
            if (code === 0) {
                resolve({ stdout });
            } else {
                reject(new Error(`${cmd} exited ${code ?? 'null'}`));
            }
        });
    });
}

async function resolveGitSha(): Promise<string> {
    try {
        const { stdout } = await execCapture('git', [
            '-C',
            REPO_ROOT,
            'rev-parse',
            'HEAD',
        ]);
        return stdout.trim() || 'unknown';
    } catch {
        return 'unknown';
    }
}

function printPlan(args: ParsedArgs, fixtures: readonly LoadedFixture[]): void {
    const total = fixtures.length * args.models.length * args.seeds;
    process.stdout.write(
        `Plan: ${fixtures.length} fixtures × ${args.models.length} models × ${args.seeds} seeds = ${total} runs\n`
    );
    process.stdout.write('Fixtures:\n');
    for (const f of fixtures) {
        process.stdout.write(
            `  - ${f.kind}/${f.name}  (workspaceRoot=${f.workspaceRoot}, base=${f.baseRef}, head=${f.headRef})\n`
        );
    }
    process.stdout.write(`Models: ${args.models.join(', ')}\n`);
    process.stdout.write(`Seeds: ${args.seeds}\n`);
    process.stdout.write(`Timeout: ${args.timeoutMs}ms\n`);
    process.stdout.write(`Out dir: ${args.outDir}\n`);
}

async function relocateReports(
    outDir: string,
    paths: { jsonPath: string; markdownPath: string }
): Promise<{ jsonPath: string; markdownPath: string }> {
    if (path.resolve(outDir) === path.resolve(RESULTS_ROOT)) {
        return paths;
    }
    await fs.mkdir(outDir, { recursive: true });
    const newJson = path.join(outDir, path.basename(paths.jsonPath));
    const newMd = path.join(outDir, path.basename(paths.markdownPath));
    await fs.rename(paths.jsonPath, newJson);
    await fs.rename(paths.markdownPath, newMd);
    return { jsonPath: newJson, markdownPath: newMd };
}

async function promptYesNo(question: string): Promise<boolean> {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stderr,
    });
    try {
        const answer = await new Promise<string>((resolve) => {
            rl.question(question, resolve);
        });
        const normalized = answer.trim().toLowerCase();
        return normalized === 'y' || normalized === 'yes';
    } finally {
        rl.close();
    }
}

async function confirmOrRefuse(
    args: ParsedArgs,
    fixtures: readonly LoadedFixture[]
): Promise<boolean> {
    printPlan(args, fixtures);
    const totalRuns = fixtures.length * args.models.length * args.seeds;
    if (args.yes) {
        return true;
    }
    if (!process.stdin.isTTY) {
        throw new CliError(
            `Refusing to spawn ${totalRuns} analysis runs in a non-interactive ` +
                `context without --yes. Re-run with --yes (to proceed) or --dry-run ` +
                `(to just print the plan).`
        );
    }
    process.stderr.write(
        `\nAbout to invoke ${totalRuns} full Lupa analysis runs. ` +
            `Each run spawns a sandboxed VS Code and consumes Copilot quota.\n`
    );
    return await promptYesNo('Proceed? [y/N] ');
}

async function main(): Promise<number> {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        process.stdout.write(USAGE);
        return 0;
    }

    const fixtures = await loadFixtures({
        kinds: args.fixtures,
        only: args.only,
    });
    if (fixtures.length === 0) {
        throw new CliError(
            'No fixtures matched the given --fixtures/--only filters'
        );
    }

    if (args.dryRun) {
        printPlan(args, fixtures);
        return 0;
    }

    if (!(await confirmOrRefuse(args, fixtures))) {
        process.stderr.write('Aborted.\n');
        return 0;
    }

    const gitSha = await resolveGitSha();

    const runs: SingleRun[] = [];
    for (const fixture of fixtures) {
        for (const model of args.models) {
            for (let seed = 0; seed < args.seeds; seed++) {
                const progress = `${fixture.name} × ${model} × seed=${seed}`;
                if (!args.silent) {
                    process.stderr.write(`[eval] start ${progress}\n`);
                }
                const r = await invokeHeadless({
                    workspaceRoot: fixture.workspaceRoot,
                    baseRef: fixture.baseRef,
                    headRef: fixture.headRef,
                    model,
                    seed,
                    timeoutMs: args.timeoutMs,
                    bailOnError: args.bailOnError,
                });
                const single: SingleRun = r.ok
                    ? {
                          fixture: fixture.name,
                          kind: fixture.kind,
                          model,
                          seed,
                          durationMs: r.durationMs,
                          ok: true,
                          errorMessage: null,
                          result: r.result,
                          match: matchFindings(
                              r.result.findings,
                              fixture.labels.expected_findings
                          ),
                      }
                    : {
                          fixture: fixture.name,
                          kind: fixture.kind,
                          model,
                          seed,
                          durationMs: r.durationMs,
                          ok: false,
                          errorMessage: r.error,
                          result: r.result,
                          match: null,
                      };
                runs.push(single);
                if (!args.silent) {
                    if (single.ok && single.match) {
                        const m = single.match;
                        process.stderr.write(
                            `[eval] done  ${progress} — P=${m.precision.toFixed(2)} ` +
                                `R=${m.recall.toFixed(2)} F1=${m.f1.toFixed(2)} ` +
                                `in ${(single.durationMs / 1000).toFixed(1)}s\n`
                        );
                    } else {
                        const msg = (single.errorMessage ?? '').slice(0, 200);
                        process.stderr.write(
                            `[eval] fail  ${progress} — ${msg}\n`
                        );
                    }
                }
            }
        }
    }

    const paths = await writeReport({
        runs,
        models: args.models,
        seeds: args.seeds,
        fixtures: fixtures.map((f) => f.name),
        generatedAt: new Date(),
        gitSha,
    });
    const { jsonPath, markdownPath } = await relocateReports(
        args.outDir,
        paths
    );

    process.stdout.write(`${markdownPath}\n`);
    process.stdout.write(`${jsonPath}\n`);
    return 0;
}

main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
        if (err instanceof CliError) {
            process.stderr.write(err.message + '\n\n' + USAGE);
            process.exit(2);
        }
        const msg =
            err instanceof Error ? (err.stack ?? err.message) : String(err);
        process.stderr.write(msg + '\n');
        process.exit(1);
    });
