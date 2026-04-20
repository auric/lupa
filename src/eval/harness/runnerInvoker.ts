import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { spawn, type ChildProcess, execSync } from 'node:child_process';
import type { HeadlessAnalysisResult } from '../headlessRunner';
import { LAUNCHER_SCRIPT } from './constants';

const MIN_TIMEOUT_MS = 10_000;
const LAUNCHER_HEADROOM_MS = 60_000;
const HARNESS_HEADROOM_MS = 60_000;
const SIGTERM_GRACE_MS = 3_000;
const STDERR_TAIL_CHARS = 2_000;

export interface InvokeHeadlessOptions {
    workspaceRoot: string;
    baseRef: string;
    headRef: string;
    model: string;
    seed: number;
    timeoutMs: number;
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

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lupa-eval-'));
    const outPath = path.join(tmpDir, 'result.json');
    const startedAt = Date.now();

    let watchdog: NodeJS.Timeout | undefined;
    try {
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
            '--out',
            outPath,
            '--silent',
        ];

        const child = spawn(process.execPath, args, { stdio: 'pipe' });
        let stderr = '';
        let stdout = '';
        child.stdout?.on('data', (d) => (stdout += d.toString()));
        child.stderr?.on('data', (d) => (stderr += d.toString()));

        const watchdogMs =
            opts.timeoutMs + LAUNCHER_HEADROOM_MS + HARNESS_HEADROOM_MS;
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

        if (exitCode === 0 && parsed.ok) {
            return { ok: true, result: parsed.result, durationMs };
        }

        let error: string;
        if (watchdogFired) {
            error = `Launcher killed by harness watchdog after ${watchdogMs}ms`;
        } else if (!parsed.ok && parsed.reason === 'missing') {
            error = `Launcher exited ${exitCode} without writing result JSON; stderr tail: ${tailStderr(stderr, stdout)}`;
        } else if (!parsed.ok) {
            error = `Unparseable result JSON: ${parsed.reason}; stderr tail: ${tailStderr(stderr, stdout)}`;
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

type ParsedResult =
    | { ok: true; result: HeadlessAnalysisResult }
    | { ok: false; reason: string };

async function tryReadResult(outPath: string): Promise<ParsedResult> {
    let raw: string;
    try {
        raw = await fs.readFile(outPath, 'utf8');
    } catch {
        return { ok: false, reason: 'missing' };
    }
    try {
        const parsed = JSON.parse(raw) as HeadlessAnalysisResult;
        return { ok: true, result: parsed };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, reason: msg };
    }
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
