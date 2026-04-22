import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { spawn, type ChildProcess, execSync } from 'node:child_process';
import type { HeadlessAnalysisResult } from '../headlessRunner';
import {
    getResolutionJudgeResultValidationError,
    type ResolutionJudgePayload,
    type ResolutionJudgeResult,
} from './types';
import { LAUNCHER_SCRIPT } from './constants';
import {
    formatHeadlessTimeoutMessage,
    requireRemainingHeadlessBudgetMs,
} from '../headlessShared';

const MIN_TIMEOUT_MS = 10_000;
const LAUNCHER_HEADROOM_MS = 60_000;
const HARNESS_HEADROOM_MS = 60_000;
const LAUNCHER_POSIX_SIGTERM_GRACE_MS = 5_000;
const SIGTERM_GRACE_MS = LAUNCHER_POSIX_SIGTERM_GRACE_MS + 1_000;
const STDERR_TAIL_CHARS = 2_000;

export interface InvokeHeadlessOptions {
    workspaceRoot: string;
    baseRef: string;
    headRef: string;
    model: string;
    seed: number;
    timeoutMs: number;
    deadlineAt?: number;
    bailOnError: boolean;
}

export type InvokeHeadlessResult =
    | { ok: true; result: HeadlessAnalysisResult; durationMs: number }
    | {
          ok: false;
          error: string;
          durationMs: number;
          result: HeadlessAnalysisResult | null;
      };

export interface InvokeResolutionJudgeOptions {
    workspaceRoot: string;
    model: string;
    payload: ResolutionJudgePayload;
    timeoutMs: number;
    deadlineAt?: number;
}

export interface InvokeResolutionJudgeResult {
    result: ResolutionJudgeResult;
    durationMs: number;
}

export async function invokeHeadless(
    opts: InvokeHeadlessOptions
): Promise<InvokeHeadlessResult> {
    validateRef(opts.baseRef, 'baseRef');
    validateRef(opts.headRef, 'headRef');
    if (opts.timeoutMs < MIN_TIMEOUT_MS) {
        throw new Error(
            `invokeHeadless: timeoutMs must be >= ${MIN_TIMEOUT_MS} (got ${opts.timeoutMs})`
        );
    }

    const startedAt = Date.now();
    let tmpDir: string | undefined;

    let watchdog: NodeJS.Timeout | undefined;
    try {
        // Kind-B (sha:) fixtures are cloned --no-checkout for speed, but
        // Lupa's tools need a working tree to read files. Check out the head
        // SHA before spawning VS Code so get_file_diff and friends have real
        // content. Safe to do sequentially — the eval harness runs fixtures
        // one at a time.
        await ensureHeadCheckout(
            opts.workspaceRoot,
            opts.headRef,
            requireRemainingHeadlessBudgetMs(
                opts.timeoutMs,
                opts.deadlineAt,
                'before pre-launch checkout'
            ),
            opts.timeoutMs
        );

        requireRemainingHeadlessBudgetMs(
            opts.timeoutMs,
            opts.deadlineAt,
            'before launcher preparation completed'
        );

        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lupa-eval-'));
        const outPath = path.join(tmpDir, 'result.json');

        requireRemainingHeadlessBudgetMs(
            opts.timeoutMs,
            opts.deadlineAt,
            'before the launcher started'
        );

        const watchdogMs = getHeadlessWatchdogMs(
            opts.timeoutMs,
            opts.deadlineAt,
            Date.now()
        );
        const args = [
            LAUNCHER_SCRIPT,
            '--workspace',
            opts.workspaceRoot,
            '--base',
            opts.baseRef,
            '--head',
            opts.headRef,
            '--model',
            opts.model,
            '--seed',
            String(opts.seed),
            '--timeout',
            String(opts.timeoutMs),
            ...(opts.deadlineAt !== undefined
                ? ['--deadline-at', String(opts.deadlineAt)]
                : []),
            '--out',
            outPath,
            '--silent',
        ];

        const child = spawn(process.execPath, args, { stdio: 'pipe' });
        let stderr = '';
        let stdout = '';
        child.stdout?.on('data', (d) => (stdout += d.toString()));
        child.stderr?.on('data', (d) => (stderr += d.toString()));

        let watchdogFired = false;
        watchdog = setTimeout(() => {
            watchdogFired = true;
            process.stderr.write(
                `[harness] watchdog: killing launcher after ${watchdogMs}ms\n`
            );
            killTree(child);
        }, watchdogMs);

        const exitCode = await new Promise<number>((resolve) => {
            child.on('exit', (code) => resolve(code ?? 1));
            child.on('error', (err) => {
                stderr += `\n[spawn error] ${err.message}`;
                resolve(1);
            });
        });

        const durationMs = Date.now() - startedAt;
        const parsed = await tryReadResult(outPath);

        if (
            exitCode === 0 &&
            parsed.ok &&
            parsed.result.completed &&
            !watchdogFired
        ) {
            return { ok: true, result: parsed.result, durationMs };
        }

        let error: string;
        if (watchdogFired) {
            error = `Launcher killed by harness watchdog after ${watchdogMs}ms`;
        } else if (exitCode !== 0 && parsed.ok && parsed.result.completed) {
            error = `Launcher exited ${exitCode} after writing a completed analysis result; treating the run as failed so the parsed result is preserved only as error context; stderr tail: ${tailStderr(stderr, stdout)}`;
        } else if (!parsed.ok && parsed.reason === 'missing') {
            error = `Launcher exited ${exitCode} without writing result JSON; stderr tail: ${tailStderr(stderr, stdout)}`;
        } else if (!parsed.ok) {
            error = `Unparseable result JSON: ${parsed.reason}; stderr tail: ${tailStderr(stderr, stdout)}`;
        } else if (!parsed.result.completed) {
            error = `Launcher exited ${exitCode} with an incomplete analysis result; stderr tail: ${tailStderr(stderr, stdout)}`;
        } else {
            error = `Launcher exited ${exitCode}; stderr tail: ${tailStderr(stderr, stdout)}`;
        }

        const result: HeadlessAnalysisResult | null = parsed.ok
            ? parsed.result
            : null;
        const outcome: InvokeHeadlessResult = {
            ok: false,
            error,
            durationMs,
            result,
        };
        if (opts.bailOnError) {
            throw new Error(error);
        }
        return outcome;
    } catch (error) {
        return handleInvokeHeadlessError(opts, startedAt, error);
    } finally {
        if (watchdog !== undefined) {
            clearTimeout(watchdog);
        }
        if (tmpDir !== undefined) {
            await fs
                .rm(tmpDir, { recursive: true, force: true })
                .catch((err) => {
                    process.stderr.write(
                        `[harness] warn: failed to remove temp dir ${tmpDir}: ${err instanceof Error ? err.message : String(err)}\n`
                    );
                });
        }
    }
}

function getHeadlessWatchdogMs(
    timeoutMs: number,
    deadlineAt: number | undefined,
    startedAt: number
): number {
    if (deadlineAt !== undefined) {
        const remainingMs = deadlineAt - startedAt;
        if (remainingMs <= 0) {
            throw new Error(
                'Headless analysis deadline elapsed before the launcher started.'
            );
        }
        return remainingMs + LAUNCHER_HEADROOM_MS + HARNESS_HEADROOM_MS;
    }

    return timeoutMs + LAUNCHER_HEADROOM_MS + HARNESS_HEADROOM_MS;
}

async function ensureHeadCheckout(
    workspaceRoot: string,
    headRef: string,
    checkoutTimeoutMs: number,
    timeoutLabelMs: number
): Promise<void> {
    if (!headRef.startsWith('sha:')) {
        return;
    }
    const sha = headRef.slice('sha:'.length);
    await new Promise<void>((resolve, reject) => {
        const proc = spawn('git', ['checkout', '--force', sha], {
            cwd: workspaceRoot,
            stdio: 'pipe',
        });
        let stderr = '';
        let settled = false;
        const timeoutHandle = setTimeout(() => {
            if (settled) {
                return;
            }
            settled = true;
            try {
                proc.kill('SIGKILL');
            } catch {
                // already gone
            }
            reject(
                new Error(
                    formatHeadlessTimeoutMessage(
                        timeoutLabelMs,
                        'during pre-launch checkout'
                    )
                )
            );
        }, checkoutTimeoutMs);
        proc.stderr?.on('data', (d) => (stderr += d.toString()));
        proc.on('error', (error) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeoutHandle);
            reject(error);
        });
        proc.on('close', (code) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeoutHandle);
            if (code === 0) {
                resolve();
                return;
            }
            reject(
                new Error(
                    `git checkout ${sha} in ${workspaceRoot} failed (exit ${code}): ${stderr.trim()}`
                )
            );
        });
    });
}

function validateRef(ref: string, fieldName: string): void {
    if (typeof ref !== 'string' || ref.length === 0) {
        throw new Error(`${fieldName}: must be a non-empty string`);
    }
    const hasScheme = ref.startsWith('dir:') || ref.startsWith('sha:');
    if (hasScheme) {
        const body = ref.slice(ref.indexOf(':') + 1);
        if (body.length === 0) {
            throw new Error(
                `${fieldName}: empty body after scheme — got '${ref}'`
            );
        }
        return;
    }
    for (let i = 0; i < ref.length; i++) {
        const code = ref.charCodeAt(i);
        if (code <= 0x1f || code === 0x20) {
            throw new Error(
                `${fieldName}: contains whitespace or control characters — got '${ref}'`
            );
        }
    }
}

type ParsedResult = ParsedJsonResult<HeadlessAnalysisResult>;

type ParsedJsonResult<T> =
    | { ok: true; result: T }
    | { ok: false; reason: string };

async function tryReadResult(outPath: string): Promise<ParsedResult> {
    return tryReadJsonResult<HeadlessAnalysisResult>(outPath);
}

async function tryReadJsonResult<T>(
    outPath: string,
    validate?: (value: unknown) => string | null
): Promise<ParsedJsonResult<T>> {
    let raw: string;
    try {
        raw = await fs.readFile(outPath, 'utf8');
    } catch {
        return { ok: false, reason: 'missing' };
    }
    try {
        const parsed = JSON.parse(raw) as unknown;
        const validationError = validate?.(parsed) ?? null;
        if (validationError) {
            return { ok: false, reason: validationError };
        }
        return { ok: true, result: parsed as T };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, reason: msg };
    }
}

export async function invokeResolutionJudge(
    opts: InvokeResolutionJudgeOptions
): Promise<InvokeResolutionJudgeResult> {
    if (opts.timeoutMs < MIN_TIMEOUT_MS) {
        throw new Error(
            `invokeResolutionJudge: timeoutMs must be >= ${MIN_TIMEOUT_MS} (got ${opts.timeoutMs})`
        );
    }

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lupa-eval-judge-'));
    const outPath = path.join(tmpDir, 'result.json');
    const payloadPath = path.join(tmpDir, 'payload.json');
    const startedAt = Date.now();

    let watchdog: NodeJS.Timeout | undefined;
    try {
        await fs.writeFile(payloadPath, JSON.stringify(opts.payload), 'utf8');
        const watchdogMs = getResolutionJudgeWatchdogMs(
            opts.timeoutMs,
            opts.deadlineAt,
            Date.now()
        );
        const args = [
            LAUNCHER_SCRIPT,
            '--mode',
            'resolution-judge',
            '--workspace',
            opts.workspaceRoot,
            '--model',
            opts.model,
            '--payload',
            payloadPath,
            '--timeout',
            String(opts.timeoutMs),
            ...(opts.deadlineAt !== undefined
                ? ['--deadline-at', String(opts.deadlineAt)]
                : []),
            '--out',
            outPath,
            '--silent',
        ];

        const child = spawn(process.execPath, args, { stdio: 'pipe' });
        let stderr = '';
        let stdout = '';
        child.stdout?.on('data', (d) => (stdout += d.toString()));
        child.stderr?.on('data', (d) => (stderr += d.toString()));

        let watchdogFired = false;
        watchdog = setTimeout(() => {
            watchdogFired = true;
            process.stderr.write(
                `[harness] watchdog: killing resolution judge launcher after ${watchdogMs}ms\n`
            );
            killTree(child);
        }, watchdogMs);

        const exitCode = await new Promise<number>((resolve) => {
            child.on('exit', (code) => resolve(code ?? 1));
            child.on('error', (err) => {
                stderr += `\n[spawn error] ${err.message}`;
                resolve(1);
            });
        });

        const durationMs = Date.now() - startedAt;
        const parsed = await tryReadJsonResult<ResolutionJudgeResult>(
            outPath,
            getResolutionJudgeResultValidationError
        );
        if (exitCode === 0 && parsed.ok && !watchdogFired) {
            return { result: parsed.result, durationMs };
        }

        if (watchdogFired) {
            throw new Error(
                `Resolution judge launcher killed by harness watchdog after ${watchdogMs}ms`
            );
        }
        if (exitCode !== 0 && parsed.ok) {
            throw new Error(
                `Resolution judge launcher exited ${exitCode} after writing a valid result payload; treating the judge run as failed for safety; stderr tail: ${tailStderr(stderr, stdout)}`
            );
        }
        if (!parsed.ok && parsed.reason === 'missing') {
            throw new Error(
                `Resolution judge launcher exited ${exitCode} without writing result JSON; stderr tail: ${tailStderr(stderr, stdout)}`
            );
        }
        if (!parsed.ok) {
            throw new Error(
                `Resolution judge JSON was invalid: ${parsed.reason}; stderr tail: ${tailStderr(stderr, stdout)}`
            );
        }
        throw new Error(
            `Resolution judge launcher exited ${exitCode}; stderr tail: ${tailStderr(stderr, stdout)}`
        );
    } finally {
        if (watchdog !== undefined) {
            clearTimeout(watchdog);
        }
        await fs.rm(tmpDir, { recursive: true, force: true }).catch((err) => {
            process.stderr.write(
                `[harness] warn: failed to remove temp dir ${tmpDir}: ${err instanceof Error ? err.message : String(err)}\n`
            );
        });
    }
}

export function getResolutionJudgeWatchdogMs(
    timeoutMs: number,
    deadlineAt: number | undefined,
    startedAt: number
): number {
    if (deadlineAt !== undefined) {
        const remainingMs = deadlineAt - startedAt;
        if (remainingMs <= 0) {
            throw new Error(
                'Resolution judge deadline elapsed before the launcher started.'
            );
        }
        return remainingMs + LAUNCHER_HEADROOM_MS + HARNESS_HEADROOM_MS;
    }

    return timeoutMs + LAUNCHER_HEADROOM_MS + HARNESS_HEADROOM_MS;
}

export function getHarnessSigtermGraceMs(): number {
    return SIGTERM_GRACE_MS;
}

function tailStderr(stderr: string, stdout: string): string {
    const combined = (stderr + stdout).trim();
    if (combined.length <= STDERR_TAIL_CHARS) {
        return combined;
    }
    return '...' + combined.slice(-STDERR_TAIL_CHARS);
}

function killTree(child: ChildProcess): void {
    if (!child.pid) {
        return;
    }
    if (process.platform === 'win32') {
        try {
            execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: 'ignore' });
        } catch {
            try {
                child.kill('SIGKILL');
            } catch {
                // already gone
            }
        }
        return;
    }
    try {
        child.kill('SIGTERM');
    } catch {
        // already gone
    }
    setTimeout(() => {
        try {
            child.kill('SIGKILL');
        } catch {
            // already gone
        }
    }, SIGTERM_GRACE_MS).unref();
}

function handleInvokeHeadlessError(
    opts: InvokeHeadlessOptions,
    startedAt: number,
    error: unknown
): InvokeHeadlessResult {
    const message = error instanceof Error ? error.message : String(error);
    if (opts.bailOnError) {
        throw error instanceof Error ? error : new Error(message);
    }
    return {
        ok: false,
        error: message,
        durationMs: Date.now() - startedAt,
        result: null,
    };
}
