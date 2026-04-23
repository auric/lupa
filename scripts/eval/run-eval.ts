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
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadFixtures } from '../../src/eval/harness/fixtureLoader';
import {
    invokeHeadless,
    invokeResolutionJudge,
} from '../../src/eval/harness/runnerInvoker';
import { matchFindings } from '../../src/eval/harness/matcher';
import { writeReport } from '../../src/eval/harness/reporter';
import { classifyResolutionForRun } from '../../src/eval/harness/resolutionClassifier';
import { normalizeModelIdentifier } from '../../src/eval/headlessShared';
import {
    DEFAULT_AUXILIARY_MODEL,
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
    --aux-model <id>     Auxiliary vendor/id for ambiguous resolution judging
                                             (default: ${DEFAULT_AUXILIARY_MODEL})
  --fixtures <csv>     Fixture kinds: synthetic, real, or both
                       (default: synthetic,real)
  --only <csv>         Subset of fixture names to run
  --seeds <n>          Seeds per (fixture, model) cell (default: ${DEFAULT_SEEDS})
    --timeout <ms>       Per-cell eval budget shared by launcher/bootstrap,
                                             exact-model preflight, and analysis/judging
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

export class CliError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CliError';
    }
}

interface ParsedArgs {
    models: string[];
    auxModel: string;
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

const execFileAsync = promisify(execFile);
const MIN_HEADLESS_RUN_TIMEOUT_MS = 10_000;
export const MIN_AUXILIARY_JUDGE_TIMEOUT_MS = 10_000;
export const MAX_AUXILIARY_JUDGE_TIMEOUT_MS = 120_000;

interface AuxiliaryJudgeBudget {
    timeoutMs: number;
    deadlineAt: number;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
    const out: ParsedArgs = {
        models: [...DEFAULT_MODELS],
        auxModel: DEFAULT_AUXILIARY_MODEL,
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
            break;
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
        if (a === '--aux-model') {
            out.auxModel = parseStringValue(argv[++i], a);
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

function normalizeCliModelIdentifier(
    identifier: string,
    flag: '--models' | '--aux-model'
): string {
    try {
        return normalizeModelIdentifier(identifier);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new CliError(`${flag}: ${message}`);
    }
}

export function normalizeCliModelIdentifiers(args: ParsedArgs): ParsedArgs {
    return {
        ...args,
        models: Array.from(
            new Set(
                args.models.map((model) =>
                    normalizeCliModelIdentifier(model, '--models')
                )
            )
        ),
        auxModel: normalizeCliModelIdentifier(args.auxModel, '--aux-model'),
    };
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
    if (parts.length === 1 && parts[0] === 'both') {
        return ['synthetic', 'real'];
    }
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
    if (flag === '--timeout' && n < MIN_HEADLESS_RUN_TIMEOUT_MS) {
        throw new CliError(
            `${flag} must be at least ${MIN_HEADLESS_RUN_TIMEOUT_MS}ms (got '${v}')`
        );
    }
    return n;
}

async function execCapture(
    cmd: string,
    args: readonly string[]
): Promise<{ stdout: string }> {
    const { stdout } = await execFileAsync(cmd, [...args], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
    });
    return { stdout };
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
    process.stdout.write(`Aux model: ${args.auxModel}\n`);
    process.stdout.write(`Seeds: ${args.seeds}\n`);
    process.stdout.write(`Per-cell timeout budget: ${args.timeoutMs}ms\n`);
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
    await moveFile(paths.jsonPath, newJson);
    await moveFile(paths.markdownPath, newMd);
    return { jsonPath: newJson, markdownPath: newMd };
}

async function moveFile(fromPath: string, toPath: string): Promise<void> {
    try {
        await fs.rename(fromPath, toPath);
    } catch (error) {
        const code =
            typeof error === 'object' && error !== null && 'code' in error
                ? String((error as { code?: unknown }).code)
                : undefined;
        if (code !== 'EXDEV') {
            throw error;
        }
        await fs.copyFile(fromPath, toPath);
        await fs.unlink(fromPath);
    }
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

export function getCliArgs(argv: readonly string[]): readonly string[] {
    const directExecutionArgIndex = getDirectExecutionArgIndex(argv);
    if (directExecutionArgIndex === -1) {
        return argv.slice(2);
    }

    const args = argv.slice(directExecutionArgIndex + 1);
    return args[0] === '--' ? args.slice(1) : args;
}

export async function main(
    argv: readonly string[] = getCliArgs(process.argv)
): Promise<number> {
    let args = parseArgs(argv);
    if (args.help) {
        process.stdout.write(USAGE);
        return 0;
    }

    args = normalizeCliModelIdentifiers(args);

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
                const cellStartedAt = Date.now();
                const deadlineAt = cellStartedAt + args.timeoutMs;
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
                    deadlineAt,
                    bailOnError: args.bailOnError,
                });
                const single: SingleRun = r.ok
                    ? (() => {
                          const match = matchFindings(
                              r.result.findings,
                              fixture.labels.expected_findings,
                              fixture.workspaceRoot
                          );
                          return {
                              fixture: fixture.name,
                              kind: fixture.kind,
                              model,
                              seed,
                              durationMs: r.durationMs,
                              cellDurationMs: 0,
                              ok: true,
                              errorMessage: null,
                              resolutionWarning: null,
                              result: r.result,
                              match,
                              resolution: null,
                          };
                      })()
                    : {
                          fixture: fixture.name,
                          kind: fixture.kind,
                          model,
                          seed,
                          durationMs: r.durationMs,
                          cellDurationMs: 0,
                          ok: false,
                          errorMessage: r.error,
                          resolutionWarning: null,
                          result: r.result,
                          match: null,
                          resolution: null,
                      };
                if (single.ok && single.result && single.match) {
                    try {
                        single.resolution = await classifyResolutionForRun({
                            fixture,
                            produced: single.result.findings,
                            match: single.match,
                            timeoutMs: args.timeoutMs,
                            deadlineAt,
                            judgeClient: {
                                judge: async (payload) => {
                                    const judgeBudget =
                                        createAuxiliaryJudgeBudget(deadlineAt);
                                    if (!judgeBudget) {
                                        const err = new Error(
                                            `remaining eval timeout budget is below the auxiliary judge minimum of ${MIN_AUXILIARY_JUDGE_TIMEOUT_MS}ms`
                                        );
                                        (err as any).code = 'JUDGE_UNAVAILABLE';
                                        throw err;
                                    }
                                    const judged = await invokeResolutionJudge({
                                        workspaceRoot: fixture.workspaceRoot,
                                        model: args.auxModel,
                                        payload,
                                        timeoutMs: judgeBudget.timeoutMs,
                                        deadlineAt: judgeBudget.deadlineAt,
                                    });
                                    return judged.result;
                                },
                            },
                        });
                        if (
                            single.resolution.warnings.length > 0 &&
                            !args.silent
                        ) {
                            process.stderr.write(
                                `[eval] warn  ${progress} — resolution proxy skipped ` +
                                    `${single.resolution.skipped}/${single.resolution.attempted} findings due to auxiliary judge infrastructure\n`
                            );
                        }
                    } catch (error) {
                        const message =
                            error instanceof Error
                                ? error.message
                                : String(error);
                        single.resolution = null;
                        single.resolutionWarning = `Resolution proxy unavailable: ${message}`;
                        if (!args.silent) {
                            process.stderr.write(
                                `[eval] warn  ${progress} — resolution classification failed: ${message}\n`
                            );
                        }
                    }
                }
                single.cellDurationMs = Date.now() - cellStartedAt;
                runs.push(single);
                if (!args.silent) {
                    if (single.ok && single.match) {
                        const m = single.match;
                        const resolutionDisplay = single.resolutionWarning
                            ? '⚠'
                            : single.resolution?.metricStatus ===
                                'invalid-skipped'
                              ? '⚠'
                              : Number.isFinite(
                                      single.resolution?.resolutionRate
                                  )
                                ? single.resolution!.resolutionRate.toFixed(2)
                                : '—';
                        process.stderr.write(
                            `[eval] done  ${progress} — P=${m.precision.toFixed(2)} ` +
                                `R=${m.recall.toFixed(2)} F1=${m.f1.toFixed(2)} ` +
                                `RProxy=${resolutionDisplay} ` +
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

export function createAuxiliaryJudgeBudget(
    headlessDeadlineAt: number
): AuxiliaryJudgeBudget | null {
    const now = Date.now();
    const remainingMs = Math.min(
        headlessDeadlineAt - now,
        MAX_AUXILIARY_JUDGE_TIMEOUT_MS
    );
    if (remainingMs < MIN_AUXILIARY_JUDGE_TIMEOUT_MS) {
        return null;
    }
    return {
        timeoutMs: remainingMs,
        deadlineAt: now + remainingMs,
    };
}

function getDirectExecutionArgIndex(argv: readonly string[]): number {
    const modulePath = path.resolve(fileURLToPath(import.meta.url));

    for (let index = 1; index < argv.length; index++) {
        const candidate = argv[index];
        if (!candidate || candidate === '--' || candidate.startsWith('-')) {
            continue;
        }

        const resolvedCandidate = path.resolve(candidate);
        if (
            process.platform === 'win32'
                ? resolvedCandidate.toLowerCase() === modulePath.toLowerCase()
                : resolvedCandidate === modulePath
        ) {
            return index;
        }
    }

    return -1;
}

export function isDirectExecution(
    argv: readonly string[] = process.argv
): boolean {
    return getDirectExecutionArgIndex(argv) !== -1;
}

if (isDirectExecution()) {
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
}
