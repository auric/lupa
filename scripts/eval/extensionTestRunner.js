/**
 * Extension-host entry point loaded by @vscode/test-electron.
 *
 * Runs inside the VS Code extension host process, where `vscode` is a
 * built-in module and Copilot's language-model API is available. Reads
 * the JSON-serialized CLI options from LUPA_HEADLESS_ARGS, activates the
 * Lupa extension, and invokes its runHeadless API.
 *
 * A thrown error here propagates back through runTests() to the launcher
 * and translates into a non-zero process exit.
 */

const vscode = require('vscode');
const fs = require('node:fs');

// Must stay in sync with package.json `publisher` + `name`.
const EXTENSION_ID = 'Auric.lupa';

async function run() {
    const rawArgs = process.env.LUPA_HEADLESS_ARGS;
    if (!rawArgs) {
        throw new Error(
            'LUPA_HEADLESS_ARGS not set; this script must be launched via launchHeadless.js'
        );
    }
    let args;
    try {
        args = JSON.parse(rawArgs);
    } catch (err) {
        throw new Error(
            `LUPA_HEADLESS_ARGS is not valid JSON: ${err && err.message ? err.message : String(err)}`
        );
    }

    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    if (!extension) {
        throw new Error(`Extension ${EXTENSION_ID} not found in host`);
    }
    const api = await extension.activate();
    if (!api || typeof api.runHeadless !== 'function') {
        throw new Error(
            `Extension ${EXTENSION_ID} did not export a runHeadless API`
        );
    }

    const cts = new vscode.CancellationTokenSource();
    let timeoutHandle;
    if (args.timeoutMs && args.timeoutMs > 0) {
        timeoutHandle = setTimeout(() => cts.cancel(), args.timeoutMs);
    }

    try {
        const result = await api.runHeadless({
            workspaceRoot: args.workspace,
            baseRef: args.base,
            headRef: args.head,
            modelIdentifier: args.model,
            seed: args.seed,
            timeoutMs: args.timeoutMs,
            cancellationToken: cts.token,
        });

        if (args.out) {
            fs.writeFileSync(args.out, JSON.stringify(result, null, 2));
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
}

module.exports = { run };
