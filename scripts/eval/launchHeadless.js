#!/usr/bin/env node
/**
 * Headless entry launcher for Lupa's analysis engine.
 *
 * Spawns VS Code directly (not via @vscode/test-electron's runTests) with
 * Lupa and GitHub.copilot-chat both loaded via --extensionDevelopmentPath.
 * Lupa's activate() hook detects LUPA_HEADLESS_MODE=1 and runs the analysis
 * in-process, then issues `workbench.action.quit` and writes a sentinel file
 * with the final exit code.
 *
 * Test mode (`--extensionTestsPath`) is deliberately avoided: the Copilot
 * extension's LanguageModelAccess refuses to register `vscode.lm` providers
 * under ExtensionMode.Test, which would block the analysis from reaching
 * any model even when Copilot Chat itself works in the spawned window.
 *
 * Usage:
 *   node scripts/eval/launchHeadless.js \
 *     --workspace <path> --model <vendor/id> \
 *     [--mode analysis --base <ref> --head <ref> --seed <n>] \
 *     [--mode resolution-judge --payload <jsonPath>] \
 *     [--timeout <ms>] [--deadline-at <unixMs>] [--out <jsonPath>] [--silent]
 *
 * First-time setup: run `npm run headless:setup` to provision the profile
 * and sign in to Copilot. On the first real run, an "Allow Lupa to use
 * Copilot?" prompt will appear in the spawned window; approve once — the
 * decision persists in the dedicated profile.
 *
 * Exit codes: 0 on analysis completion (any finding count), 1 on fatal
 * runtime error, 2 on CLI argument errors.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { downloadAndUnzipVSCode } = require('@vscode/test-electron');
const { parseHeadlessArgs, HeadlessArgError } = require('./headlessArgs');
const {
    USER_DATA_DIR,
    EXTENSIONS_DIR,
    VSCODE_CACHE_DIR,
    SETUP_MARKER,
    SENTINEL_PATH,
    resolveInstalledExtensionPath,
    ensureProfileSettings,
} = require('./headlessPaths');

const WATCHDOG_OVERHEAD_MS = 60_000;
const WATCHDOG_SIGTERM_GRACE_MS = 5_000;
const WATCHDOG_POST_SIGNAL_RETRY_MS = WATCHDOG_SIGTERM_GRACE_MS + 2_000;
const WATCHDOG_POST_SIGNAL_EXIT_DEADLINE_MS = 20_000;
const posixKillEscalationHandles = new WeakMap();
const posixKillCleanupRegistered = new WeakSet();

function ensureLauncherDeadlineAt(args, now = Date.now()) {
    if (typeof args.deadlineAt === 'number') {
        return args.deadlineAt;
    }

    args.deadlineAt = now + args.timeoutMs;
    return args.deadlineAt;
}

function createPostSignalWatchdog(onForceKill, onForceExit) {
    let activeSignal = 'signal';
    let retryTimeoutHandle;
    let exitTimeoutHandle;

    const scheduleRetry = () => {
        retryTimeoutHandle = setTimeout(() => {
            process.stderr.write(
                `Post-signal watchdog: VS Code did not exit within ${WATCHDOG_POST_SIGNAL_RETRY_MS}ms after ${activeSignal}; force-killing process tree again.\n`
            );
            onForceKill();
            scheduleRetry();
        }, WATCHDOG_POST_SIGNAL_RETRY_MS);
        retryTimeoutHandle.unref?.();
    };

    const scheduleForcedExit = () => {
        exitTimeoutHandle = setTimeout(() => {
            process.stderr.write(
                `Post-signal watchdog: VS Code still had not exited ${WATCHDOG_POST_SIGNAL_EXIT_DEADLINE_MS}ms after ${activeSignal}; force-exiting launcher.\n`
            );
            if (retryTimeoutHandle) {
                clearTimeout(retryTimeoutHandle);
                retryTimeoutHandle = undefined;
            }
            exitTimeoutHandle = undefined;
            onForceKill();
            onForceExit();
        }, WATCHDOG_POST_SIGNAL_EXIT_DEADLINE_MS);
        exitTimeoutHandle.unref?.();
    };

    return {
        arm(signal) {
            activeSignal = signal;
            if (!retryTimeoutHandle) {
                scheduleRetry();
            }
            if (!exitTimeoutHandle) {
                scheduleForcedExit();
            }
        },
        clear() {
            if (retryTimeoutHandle) {
                clearTimeout(retryTimeoutHandle);
                retryTimeoutHandle = undefined;
            }
            if (exitTimeoutHandle) {
                clearTimeout(exitTimeoutHandle);
                exitTimeoutHandle = undefined;
            }
        },
    };
}

function requireLauncherDeadlineRemaining(args, phase, now = Date.now()) {
    const remainingMs = ensureLauncherDeadlineAt(args, now) - now;
    if (remainingMs <= 0) {
        throw new Error(`Headless launcher deadline elapsed ${phase}.`);
    }

    return remainingMs;
}

function createLauncherDeadlineError(phase) {
    return new Error(`Headless launcher deadline elapsed ${phase}.`);
}

function throwIfLauncherDeadlineAborted(signal, phase) {
    if (!signal?.aborted) {
        return;
    }

    if (signal.reason instanceof Error) {
        throw signal.reason;
    }

    throw createLauncherDeadlineError(phase);
}

async function runWithinLauncherDeadline(args, phase, work) {
    const remainingMs = requireLauncherDeadlineRemaining(args, phase);
    const deadlineError = createLauncherDeadlineError(phase);
    const abortController = new AbortController();
    let timeoutHandle;
    const deadlineExceeded = new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => {
            abortController.abort(deadlineError);
            reject(deadlineError);
        }, remainingMs);
        timeoutHandle.unref?.();
    });

    try {
        return await Promise.race([
            Promise.resolve().then(() => work(abortController.signal)),
            deadlineExceeded,
        ]);
    } finally {
        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
        }
    }
}

async function removeFileIfPresent(filePath) {
    try {
        await fs.promises.unlink(filePath);
    } catch (err) {
        if (!err || err.code !== 'ENOENT') {
            throw err;
        }
    }
}

async function cleanupSentinelFiles(signal, phase) {
    throwIfLauncherDeadlineAborted(signal, phase);
    await removeFileIfPresent(SENTINEL_PATH);
    throwIfLauncherDeadlineAborted(signal, phase);
    await removeFileIfPresent(SENTINEL_PATH + '.tmp');
    throwIfLauncherDeadlineAborted(signal, phase);
}

function forwardTerminationSignal(sig, state, child, postSignalWatchdog) {
    state.forwardedSignal = sig;
    state.forwardedSignalExitCode = sig === 'SIGINT' ? 130 : 143;
    if (state.watchdog) {
        clearTimeout(state.watchdog);
        state.watchdog = undefined;
    }
    postSignalWatchdog.arm(sig);
    killProcessTree(child);
}

async function main() {
    let args;
    try {
        args = parseHeadlessArgs(process.argv.slice(2));
    } catch (err) {
        if (err instanceof HeadlessArgError) {
            process.stderr.write(`${err.message}\n`);
            process.exit(2);
        }
        throw err;
    }

    if (!fs.existsSync(SETUP_MARKER)) {
        process.stderr.write(
            'Headless profile not initialized or setup did not complete. ' +
                'Run `npm run headless:setup` first.\n'
        );
        process.exit(1);
    }

    const copilotChatPath = resolveInstalledExtensionPath(
        'github.copilot-chat'
    );
    if (!copilotChatPath || !fs.existsSync(copilotChatPath)) {
        process.stderr.write(
            'GitHub.copilot-chat is not installed in the headless profile. ' +
                'Run `npm run headless:setup` to install it.\n'
        );
        process.exit(1);
    }

    const repoRoot = path.resolve(__dirname, '..', '..');

    // Resolve filesystem args relative to the launcher's CWD before handing
    // them to VS Code, whose child CWD is its install folder rather than
    // the user's shell. Leaving them relative would resolve against
    // `.vscode-test/vscode/vscode-win32-*/` and fail with ENOENT.
    args.workspace = path.resolve(args.workspace);
    if (args.out) {
        args.out = path.resolve(args.out);
    }
    if (args.payload) {
        args.payload = path.resolve(args.payload);
    }

    const executablePath = await runWithinLauncherDeadline(
        args,
        'during VS Code download and headless profile setup',
        async (signal) => {
            const downloadedExecutablePath = await downloadAndUnzipVSCode({
                version: 'stable',
                cachePath: VSCODE_CACHE_DIR,
            });
            throwIfLauncherDeadlineAborted(
                signal,
                'during VS Code download and headless profile setup'
            );

            // Merge the baseline non-interactive settings into the profile on
            // every launch so existing profiles pick up new suppressions
            // automatically.
            ensureProfileSettings();
            throwIfLauncherDeadlineAborted(
                signal,
                'during VS Code download and headless profile setup'
            );

            await cleanupSentinelFiles(
                signal,
                'during VS Code download and headless profile setup'
            );

            return downloadedExecutablePath;
        }
    );

    const launchArgs = [
        '--user-data-dir=' + USER_DATA_DIR,
        '--extensions-dir=' + EXTENSIONS_DIR,
        '--extensionDevelopmentPath=' + repoRoot,
        '--extensionDevelopmentPath=' + copilotChatPath,
        '--disable-extensions',
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-updates',
        '--disable-telemetry',
        args.workspace,
    ];

    const childEnv = {
        ...process.env,
        LUPA_HEADLESS_MODE: '1',
        LUPA_HEADLESS_ARGS: JSON.stringify(args),
        LUPA_HEADLESS_SENTINEL: SENTINEL_PATH,
    };

    requireLauncherDeadlineRemaining(args, 'before starting VS Code');

    const child = spawn(executablePath, launchArgs, {
        env: childEnv,
        stdio: 'inherit',
        windowsHide: false,
        // On POSIX, become a process-group leader so killProcessTree can
        // signal the entire VS Code helper tree via a negative PID. Windows
        // uses taskkill /F /T instead; `detached` has different semantics
        // there (spawns a new console) so leave it off.
        detached: process.platform !== 'win32',
    });

    const signalState = {
        forwardedSignal: null,
        forwardedSignalExitCode: undefined,
        watchdog: undefined,
    };
    const postSignalWatchdog = createPostSignalWatchdog(
        () => killProcessTree(child),
        () => process.exit(signalState.forwardedSignalExitCode ?? 1)
    );

    // `detached: true` on POSIX puts the child in its own process group, so
    // terminal Ctrl-C no longer reaches it via the TTY foreground pgid — the
    // launcher must forward operator signals explicitly. Harmless on Windows.
    for (const sig of ['SIGINT', 'SIGTERM']) {
        process.on(sig, () => {
            forwardTerminationSignal(
                sig,
                signalState,
                child,
                postSignalWatchdog
            );
        });
    }

    const watchdogMs = getLauncherWatchdogMs(args);
    signalState.watchdog = setTimeout(() => {
        process.stderr.write(
            `Watchdog: VS Code did not exit within ${watchdogMs}ms; killing process tree.\n`
        );
        killProcessTree(child);
    }, watchdogMs);

    const childExitCode = await new Promise((resolve) => {
        child.on('exit', (code) => resolve(code ?? 1));
        child.on('error', (err) => {
            process.stderr.write(`Failed to spawn VS Code: ${err.message}\n`);
            resolve(1);
        });
    });
    if (signalState.watchdog) {
        clearTimeout(signalState.watchdog);
    }
    postSignalWatchdog.clear();

    process.exit(
        signalState.forwardedSignalExitCode ??
            readSentinelExitCode(childExitCode)
    );
}

function getLauncherWatchdogMs(args) {
    return (
        Math.max(0, ensureLauncherDeadlineAt(args) - Date.now()) +
        WATCHDOG_OVERHEAD_MS
    );
}

function clearPendingPosixKillEscalation(child) {
    const handle = posixKillEscalationHandles.get(child);
    if (!handle) {
        return;
    }
    clearTimeout(handle);
    posixKillEscalationHandles.delete(child);
}

function registerPosixKillCleanup(child) {
    if (posixKillCleanupRegistered.has(child)) {
        return;
    }

    const clear = () => {
        clearPendingPosixKillEscalation(child);
    };
    child.on('exit', clear);
    child.on('close', clear);
    posixKillCleanupRegistered.add(child);
}

/**
 * VS Code spawns a tree of helper processes (extension host, pty host, file
 * watchers, crash reporter). On Windows, child.kill() only terminates the
 * top-level PID, leaving helpers to hold locks on the profile directory —
 * use `taskkill /F /T` to kill the whole tree. On POSIX, spawn with
 * `detached: true` makes the child a process-group leader so a negative-PID
 * signal reaches every helper it spawned; SIGTERM first, then SIGKILL after
 * a short grace.
 */
function killProcessTree(child) {
    if (!child.pid) {
        return;
    }
    if (process.platform === 'win32') {
        try {
            execFileSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], {
                stdio: 'ignore',
                windowsHide: true,
            });
        } catch {
            child.kill('SIGKILL');
        }
        return;
    }
    const groupSignal = (signal) => {
        try {
            process.kill(-child.pid, signal);
            return true;
        } catch (err) {
            if (err && err.code === 'ESRCH') {
                // Group already gone; nothing to do.
                return true;
            }
            // Fall back to a direct child signal (e.g. EPERM, or the child
            // never became a group leader for some reason).
            try {
                child.kill(signal);
            } catch {
                // already gone
            }
            return false;
        }
    };
    registerPosixKillCleanup(child);
    groupSignal('SIGTERM');
    if (posixKillEscalationHandles.has(child)) {
        return;
    }

    const escalationHandle = setTimeout(() => {
        posixKillEscalationHandles.delete(child);
        groupSignal('SIGKILL');
    }, WATCHDOG_SIGTERM_GRACE_MS);
    escalationHandle.unref?.();
    posixKillEscalationHandles.set(child, escalationHandle);
}

function readSentinelExitCode(childExitCode) {
    let raw;
    try {
        raw = fs.readFileSync(SENTINEL_PATH, 'utf8');
    } catch {
        process.stderr.write(
            'Headless run exited without writing a sentinel file. ' +
                'The extension likely failed to activate; check the VS Code ' +
                'window output for details.\n'
        );
        return childExitCode !== 0 ? childExitCode : 1;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        process.stderr.write(`Headless sentinel is not valid JSON: ${raw}\n`);
        return 1;
    }
    // Surface the error payload on stderr so the eval harness's stderr-tail
    // capture can report the real cause instead of only the pre-spawn
    // @vscode/test-electron banner. Electron on Windows doesn't route
    // extension-host output to the launcher's inherited stdio, so without
    // this step any runtime failure inside runHeadlessFromEnv is opaque.
    if (typeof parsed.error === 'string' && parsed.error.length > 0) {
        process.stderr.write(`[headless error] ${parsed.error}\n`);
    }
    return typeof parsed.exitCode === 'number' ? parsed.exitCode : 1;
}

if (require.main === module) {
    main().catch((err) => {
        const msg = err && err.message ? err.message : String(err);
        process.stderr.write(`Headless launcher crashed: ${msg}\n`);
        process.exit(1);
    });
}

module.exports = {
    createPostSignalWatchdog,
    ensureLauncherDeadlineAt,
    forwardTerminationSignal,
    getLauncherWatchdogMs,
    requireLauncherDeadlineRemaining,
    runWithinLauncherDeadline,
    WATCHDOG_POST_SIGNAL_RETRY_MS,
    WATCHDOG_POST_SIGNAL_EXIT_DEADLINE_MS,
    WATCHDOG_SIGTERM_GRACE_MS,
};
