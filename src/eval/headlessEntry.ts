import * as fs from 'node:fs';
import * as vscode from 'vscode';
import type { PRAnalysisCoordinator } from '../services/prAnalysisCoordinator';
import { runHeadlessResolutionJudge } from './headlessJudge';
import { runHeadless } from './headlessRunner';
import {
    LUPA_HEADLESS_ARGS_ENV,
    LUPA_HEADLESS_SENTINEL_ENV,
} from './headlessConstants';
import {
    createHeadlessDeadline,
    formatHeadlessTimeoutMessage,
    normalizeModelIdentifier,
    requireRemainingHeadlessBudgetMs,
} from './headlessShared';

/**
 * Environment-variable contract shared with scripts/eval/launchHeadless.js.
 * When LUPA_HEADLESS_MODE is '1', the extension's activate() hook kicks off
 * an analysis run instead of wiring up the interactive UI. Results and exit
 * status are communicated to the parent launcher via:
 *   - the optional --out JSON file (args.out),
 *   - a sentinel file at LUPA_HEADLESS_SENTINEL (exit code + error message).
 *
 * The env-var names and isHeadlessMode() live in headlessConstants.ts so
 * activation-time callers (ServiceManager) can branch on headless mode
 * without transitively loading the full headless runtime. They are re-
 * exported here to preserve the existing import path for other consumers.
 */
export {
    LUPA_HEADLESS_MODE_ENV,
    LUPA_HEADLESS_ARGS_ENV,
    LUPA_HEADLESS_SENTINEL_ENV,
    isHeadlessMode,
} from './headlessConstants';

/**
 * Guards against VS Code respawning the extension host and re-triggering
 * `runHeadlessFromEnv`. VS Code restarts the exthost automatically when it
 * exits, which would re-activate Lupa and start another analysis — so we
 * short-circuit and quit immediately if a run has already been attempted
 * in the VS Code main process's lifetime (tracked via the sentinel file).
 */
let headlessRunStarted = false;

interface HeadlessArgs {
    mode: 'analysis' | 'resolution-judge';
    workspace: string;
    model: string;
    timeoutMs: number;
    deadlineAt?: number;
    out: string | null;
    silent: boolean;
    base?: string;
    head?: string;
    seed?: number;
    payload?: string;
}

/**
 * Validate the JSON shape produced by scripts/eval/headlessArgs.js. A
 * malformed env var otherwise surfaces as a cryptic downstream error;
 * catching it here lets the outer try/catch write a diagnostic sentinel.
 */
function validateHeadlessArgs(raw: unknown): HeadlessArgs {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error(`${LUPA_HEADLESS_ARGS_ENV} must be a JSON object`);
    }
    const o = raw as Record<string, unknown>;
    const modeRaw = o.mode;
    const mode = modeRaw === undefined ? 'analysis' : modeRaw;
    if (mode !== 'analysis' && mode !== 'resolution-judge') {
        throw new Error(
            `${LUPA_HEADLESS_ARGS_ENV}.mode must be 'analysis' or 'resolution-judge'`
        );
    }
    const requireString = (k: string): string => {
        const v = o[k];
        if (typeof v !== 'string' || v.length === 0) {
            throw new Error(
                `${LUPA_HEADLESS_ARGS_ENV}.${k} must be a non-empty string`
            );
        }
        return v;
    };
    const requirePositiveNumber = (k: string): number => {
        const v = o[k];
        if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
            throw new Error(
                `${LUPA_HEADLESS_ARGS_ENV}.${k} must be a finite positive number`
            );
        }
        return v;
    };
    const seedRaw = o.seed;
    if (
        seedRaw !== undefined &&
        (typeof seedRaw !== 'number' || !Number.isFinite(seedRaw))
    ) {
        throw new Error(
            `${LUPA_HEADLESS_ARGS_ENV}.seed must be a number or undefined`
        );
    }
    const outRaw = o.out;
    if (outRaw !== undefined && outRaw !== null && typeof outRaw !== 'string') {
        throw new Error(
            `${LUPA_HEADLESS_ARGS_ENV}.out must be a string, null, or undefined`
        );
    }
    const deadlineAtRaw = o.deadlineAt;
    if (
        deadlineAtRaw !== undefined &&
        deadlineAtRaw !== null &&
        (typeof deadlineAtRaw !== 'number' ||
            !Number.isFinite(deadlineAtRaw) ||
            deadlineAtRaw <= 0)
    ) {
        throw new Error(
            `${LUPA_HEADLESS_ARGS_ENV}.deadlineAt must be a finite positive number, null, or undefined`
        );
    }
    const silentRaw = o.silent;
    if (silentRaw !== undefined && typeof silentRaw !== 'boolean') {
        throw new Error(
            `${LUPA_HEADLESS_ARGS_ENV}.silent must be a boolean or undefined`
        );
    }
    if (mode === 'resolution-judge') {
        const payload = o.payload;
        if (typeof payload !== 'string' || payload.length === 0) {
            throw new Error(
                `${LUPA_HEADLESS_ARGS_ENV}.payload must be a non-empty string`
            );
        }
        return {
            mode,
            workspace: requireString('workspace'),
            model: requireString('model'),
            payload,
            timeoutMs: requirePositiveNumber('timeoutMs'),
            deadlineAt:
                typeof deadlineAtRaw === 'number' ? deadlineAtRaw : undefined,
            out: typeof outRaw === 'string' ? outRaw : null,
            silent: silentRaw === true,
        };
    }

    return {
        mode,
        workspace: requireString('workspace'),
        base: requireString('base'),
        head: requireString('head'),
        model: requireString('model'),
        seed: typeof seedRaw === 'number' ? seedRaw : 0,
        timeoutMs: requirePositiveNumber('timeoutMs'),
        deadlineAt:
            typeof deadlineAtRaw === 'number' ? deadlineAtRaw : undefined,
        out: typeof outRaw === 'string' ? outRaw : null,
        silent: silentRaw === true,
    };
}

/**
 * Waits for Copilot's language-model provider to register. Registration is
 * asynchronous (auth check, token refresh, service handshake), so the first
 * selectChatModels() call often sees an empty list. Combines event-driven
 * wake-up with a 1 s polling fallback, bounded by timeoutMs.
 */
async function waitForCopilotModels(
    timeoutMs: number,
    requestedIdentifier: string,
    token: vscode.CancellationToken
): Promise<vscode.LanguageModelChat[]> {
    const normalizedRequestedIdentifier =
        normalizeModelIdentifier(requestedIdentifier);
    const requestedVendor = normalizedRequestedIdentifier.split('/')[0] ?? '';
    const matchesRequestedModel = (model: vscode.LanguageModelChat): boolean =>
        normalizeModelIdentifier(`${model.vendor}/${model.id}`) ===
        normalizedRequestedIdentifier;

    const initial = (
        await vscode.lm.selectChatModels({ vendor: requestedVendor })
    ).filter(matchesRequestedModel);
    if (initial.length > 0) {
        return initial;
    }

    if (token.isCancellationRequested) {
        return [];
    }

    return new Promise((resolve) => {
        let settled = false;
        let event: vscode.Disposable | undefined;
        let cancellation: vscode.Disposable | undefined;
        let interval: ReturnType<typeof setInterval> | undefined;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const cleanup = () => {
            if (settled) {
                return;
            }
            settled = true;
            event?.dispose();
            cancellation?.dispose();
            if (interval) {
                clearInterval(interval);
            }
            if (timeout) {
                clearTimeout(timeout);
            }
        };
        const finish = (models: vscode.LanguageModelChat[]) => {
            if (settled) {
                return;
            }
            cleanup();
            resolve(models);
        };
        const check = async () => {
            if (settled) {
                return;
            }
            if (token.isCancellationRequested) {
                finish([]);
                return;
            }
            try {
                const found = (
                    await vscode.lm.selectChatModels({
                        vendor: requestedVendor,
                    })
                ).filter(matchesRequestedModel);
                if (found.length > 0) {
                    finish(found);
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
        event = vscode.lm.onDidChangeChatModels(() => {
            void check();
        });
        cancellation = token.onCancellationRequested(() => {
            finish([]);
        });
        interval = setInterval(() => {
            void check();
        }, 1000);
        timeout = setTimeout(() => {
            finish([]);
        }, timeoutMs);
    });
}

async function awaitWithCancellation<T>(
    promise: Promise<T>,
    token: vscode.CancellationToken,
    timeoutMessage: string
): Promise<T> {
    if (token.isCancellationRequested) {
        throw new Error(timeoutMessage);
    }

    return await new Promise<T>((resolve, reject) => {
        const subscription = token.onCancellationRequested(() => {
            subscription.dispose();
            reject(new Error(timeoutMessage));
        });
        promise.then(
            (value) => {
                subscription.dispose();
                resolve(value);
            },
            (error) => {
                subscription.dispose();
                reject(error);
            }
        );
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
        const args = validateHeadlessArgs(JSON.parse(rawArgs));
        const requestedIdentifier = normalizeModelIdentifier(args.model);
        const deadlineAt =
            args.deadlineAt ?? createHeadlessDeadline(args.timeoutMs);

        const cts = new vscode.CancellationTokenSource();
        const timeoutHandle =
            args.timeoutMs > 0
                ? setTimeout(
                      () => cts.cancel(),
                      Math.max(0, deadlineAt - Date.now())
                  )
                : undefined;

        try {
            const services = await awaitWithCancellation(
                coordinator.waitForInitialization(),
                cts.token,
                formatHeadlessTimeoutMessage(
                    args.timeoutMs,
                    'before initialization completed'
                )
            );

            const models = await awaitWithCancellation(
                waitForCopilotModels(
                    requireRemainingHeadlessBudgetMs(
                        args.timeoutMs,
                        deadlineAt,
                        `while waiting for ${requestedIdentifier}`
                    ),
                    requestedIdentifier,
                    cts.token
                ),
                cts.token,
                formatHeadlessTimeoutMessage(
                    args.timeoutMs,
                    `while waiting for ${requestedIdentifier}`
                )
            );
            if (models.length === 0) {
                throw new Error(
                    `Requested model ${requestedIdentifier} was not available before timeout. If this is the first run, ` +
                        'approve the "Allow Lupa to use Copilot?" prompt in the spawned window. ' +
                        'Otherwise re-run `npm run headless:setup` and complete the model sign-in/setup.'
                );
            }

            if (args.mode === 'analysis') {
                const result = await awaitWithCancellation(
                    runHeadless(
                        {
                            workspaceRoot: args.workspace,
                            baseRef: args.base!,
                            headRef: args.head!,
                            modelIdentifier: args.model,
                            seed: args.seed ?? 0,
                            timeoutMs: args.timeoutMs,
                            deadlineAt,
                            cancellationToken: cts.token,
                        },
                        services
                    ),
                    cts.token,
                    formatHeadlessTimeoutMessage(
                        args.timeoutMs,
                        `during analysis for ${args.base!}..${args.head!}`
                    )
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
            } else {
                const result = await awaitWithCancellation(
                    runHeadlessResolutionJudge(
                        {
                            workspaceRoot: args.workspace,
                            modelIdentifier: args.model,
                            timeoutMs: args.timeoutMs,
                            deadlineAt,
                            payloadPath: args.payload!,
                            cancellationToken: cts.token,
                        },
                        services
                    ),
                    cts.token,
                    formatHeadlessTimeoutMessage(
                        args.timeoutMs,
                        'during resolution judging'
                    )
                );
                if (args.out) {
                    fs.writeFileSync(args.out, JSON.stringify(result, null, 2));
                }
                if (!args.silent) {
                    process.stdout.write(
                        `Resolution judge complete: ${result.verdict} (${result.modelId})\n`
                    );
                }
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
