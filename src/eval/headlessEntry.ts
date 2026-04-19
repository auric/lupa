import * as fs from 'node:fs';
import * as vscode from 'vscode';
import type { PRAnalysisCoordinator } from '../services/prAnalysisCoordinator';
import { runHeadless } from './headlessRunner';

/**
 * Environment-variable contract shared with scripts/eval/launchHeadless.js.
 * When LUPA_HEADLESS_MODE is '1', the extension's activate() hook kicks off
 * an analysis run instead of wiring up the interactive UI. Results and exit
 * status are communicated to the parent launcher via:
 *   - the optional --out JSON file (args.out),
 *   - a sentinel file at LUPA_HEADLESS_SENTINEL (exit code + error message).
 */
export const LUPA_HEADLESS_MODE_ENV = 'LUPA_HEADLESS_MODE';
export const LUPA_HEADLESS_ARGS_ENV = 'LUPA_HEADLESS_ARGS';
export const LUPA_HEADLESS_SENTINEL_ENV = 'LUPA_HEADLESS_SENTINEL';

const COPILOT_WAIT_MS = 30_000;

/**
 * Guards against VS Code respawning the extension host and re-triggering
 * `runHeadlessFromEnv`. VS Code restarts the exthost automatically when it
 * exits, which would re-activate Lupa and start another analysis — so we
 * short-circuit and quit immediately if a run has already been attempted
 * in the VS Code main process's lifetime (tracked via the sentinel file).
 */
let headlessRunStarted = false;

interface HeadlessArgs {
    workspace: string;
    base: string;
    head: string;
    model: string;
    seed: number;
    timeoutMs: number;
    out: string | null;
    silent: boolean;
}

export function isHeadlessMode(): boolean {
    return process.env[LUPA_HEADLESS_MODE_ENV] === '1';
}

/**
 * Waits for Copilot's language-model provider to register. Registration is
 * asynchronous (auth check, token refresh, service handshake), so the first
 * selectChatModels() call often sees an empty list. Combines event-driven
 * wake-up with a 1 s polling fallback, bounded by timeoutMs.
 */
async function waitForCopilotModels(
    timeoutMs: number
): Promise<vscode.LanguageModelChat[]> {
    const initial = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    if (initial.length > 0) {
        return initial;
    }
    return new Promise((resolve) => {
        let settled = false;
        const cleanup = () => {
            settled = true;
            event.dispose();
            clearInterval(interval);
            clearTimeout(timeout);
        };
        const check = async () => {
            if (settled) {
                return;
            }
            try {
                const found = await vscode.lm.selectChatModels({
                    vendor: 'copilot',
                });
                if (!settled && found.length > 0) {
                    cleanup();
                    resolve(found);
                }
            } catch (err) {
                // Fire-and-forget callers (event handler, interval) would
                // otherwise surface rejections as unhandledRejection.
                const msg = err instanceof Error ? err.message : String(err);
                process.stderr.write(
                    `waitForCopilotModels probe failed: ${msg}\n`
                );
            }
        };
        const event = vscode.lm.onDidChangeChatModels(() => {
            void check();
        });
        const interval = setInterval(() => {
            void check();
        }, 1000);
        const timeout = setTimeout(() => {
            if (settled) {
                return;
            }
            cleanup();
            resolve([]);
        }, timeoutMs);
    });
}

function writeSentinel(exitCode: number, error: string | undefined): void {
    const sentinelPath = process.env[LUPA_HEADLESS_SENTINEL_ENV];
    if (!sentinelPath) {
        return;
    }
    const tmpPath = `${sentinelPath}.tmp`;
    try {
        fs.writeFileSync(
            tmpPath,
            JSON.stringify({ exitCode, error: error ?? null }, null, 2)
        );
        // Rename is atomic on the same filesystem. If sentinelPath is on a
        // different filesystem than the tmp file (rare — the launcher
        // controls LUPA_HEADLESS_SENTINEL and colocates it with the tmp),
        // renameSync throws EXDEV and the outer catch reports it via
        // stderr; the launcher then falls back to childExitCode.
        fs.renameSync(tmpPath, sentinelPath);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Failed to write headless sentinel: ${msg}\n`);
        try {
            fs.unlinkSync(tmpPath);
        } catch {
            // tmp may not exist if writeFileSync failed before creating it
        }
    }
}

/**
 * Orchestrates a headless analysis run triggered by the env-var contract.
 * Always attempts to write a sentinel and quit VS Code, regardless of
 * outcome, so the parent launcher never hangs waiting for the process.
 */
export async function runHeadlessFromEnv(
    coordinator: PRAnalysisCoordinator
): Promise<void> {
    if (headlessRunStarted || sentinelExists()) {
        // Likely an extension-host respawn after the previous run issued
        // `workbench.action.quit`. Don't start a second analysis; just ask
        // VS Code to quit again and let the launcher's watchdog clean up
        // if the second quit also stalls.
        try {
            await vscode.commands.executeCommand('workbench.action.quit');
        } catch {
            // Best-effort; the watchdog is the backstop.
        }
        return;
    }
    headlessRunStarted = true;

    let exitCode = 0;
    let errorMsg: string | undefined;

    try {
        const rawArgs = process.env[LUPA_HEADLESS_ARGS_ENV];
        if (!rawArgs) {
            throw new Error(
                `${LUPA_HEADLESS_ARGS_ENV} not set; headless mode requires JSON-serialized args`
            );
        }
        const args = JSON.parse(rawArgs) as HeadlessArgs;

        const services = await coordinator.waitForInitialization();

        const models = await waitForCopilotModels(COPILOT_WAIT_MS);
        if (models.length === 0) {
            throw new Error(
                'No Copilot chat models available after 30s. If this is the first run, ' +
                    'approve the "Allow Lupa to use Copilot?" prompt in the spawned window. ' +
                    'Otherwise re-run `npm run headless:setup` and complete the Copilot sign-in.'
            );
        }

        const cts = new vscode.CancellationTokenSource();
        const timeoutHandle =
            args.timeoutMs > 0
                ? setTimeout(() => cts.cancel(), args.timeoutMs)
                : undefined;

        try {
            const result = await runHeadless(
                {
                    workspaceRoot: args.workspace,
                    baseRef: args.base,
                    headRef: args.head,
                    modelIdentifier: args.model,
                    seed: args.seed,
                    timeoutMs: args.timeoutMs,
                    cancellationToken: cts.token,
                },
                services
            );
            if (args.out) {
                fs.writeFileSync(args.out, JSON.stringify(result, null, 2));
            }
            if (!result.completed) {
                // --out (if any) is already written above so the operator
                // can inspect the partial result. Surface as a non-zero
                // exit via the outer catch: partial findings are unvalidated
                // (PostAnalysisPipeline only runs when completed is true).
                const suffix = args.out
                    ? `see ${args.out} for partial result`
                    : 'rerun with --out <path> to capture partial result';
                throw new Error(
                    `Analysis ended without completing (possible rate-limit, quota exhaustion, or degraded exit); ${suffix}`
                );
            }
            if (!args.silent) {
                process.stdout.write(
                    `Analysis complete: ${result.findings.length} findings, ` +
                        `${result.telemetry.iterations} iterations, ` +
                        `${result.telemetry.toolCalls} tool calls, ` +
                        `${result.telemetry.durationMs}ms\n`
                );
            }
        } finally {
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
            }
            cts.dispose();
        }
    } catch (err) {
        exitCode = 1;
        errorMsg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Headless run failed: ${errorMsg}\n`);
    } finally {
        writeSentinel(exitCode, errorMsg);
        try {
            await vscode.commands.executeCommand('workbench.action.quit');
        } catch {
            // Quit command unavailable in some contexts (e.g. web). The
            // launcher's watchdog will SIGKILL the VS Code process if
            // shutdown does not complete within --timeout + 60s.
        }
    }
}

function sentinelExists(): boolean {
    const sentinelPath = process.env[LUPA_HEADLESS_SENTINEL_ENV];
    if (!sentinelPath) {
        return false;
    }
    try {
        return fs.statSync(sentinelPath).isFile();
    } catch {
        return false;
    }
}
