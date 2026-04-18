#!/usr/bin/env node
/**
 * Headless entry launcher for Lupa's analysis engine.
 *
 * Spawns a VS Code extension host via @vscode/test-electron, loads the
 * built Lupa extension, and invokes LupaExtensionApi.runHeadless with the
 * parsed CLI args. The actual analysis runs inside the extension host
 * because Copilot's language-model API is only available there.
 *
 * Usage:
 *   node scripts/eval/launchHeadless.js \
 *     --workspace <path> \
 *     --base <ref> \
 *     --head <ref> \
 *     --model <vendor/id> \
 *     [--seed <n>] \
 *     [--timeout <ms>] \
 *     [--out <jsonPath>] \
 *     [--silent]
 *
 * First-time setup: the spawned VS Code instance uses an isolated
 * extensions/auth profile, so Copilot must be installed and signed in
 * once via `npm run headless:setup` before this launcher can reach any
 * language model.
 *
 * Exits 0 on analysis completion regardless of finding count. Exits
 * non-zero on fatal errors (missing workspace, unknown args, launch
 * failure, unhandled exceptions inside the extension host).
 */

const fs = require('node:fs');
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');
const { parseHeadlessArgs, HeadlessArgError } = require('./headlessArgs');
const {
    USER_DATA_DIR,
    EXTENSIONS_DIR,
    VSCODE_CACHE_DIR,
    SETUP_MARKER,
} = require('./headlessPaths');

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

    const repoRoot = path.resolve(__dirname, '..', '..');
    const extensionTestsPath = path.resolve(
        __dirname,
        'extensionTestRunner.js'
    );

    try {
        await runTests({
            version: 'stable',
            cachePath: VSCODE_CACHE_DIR,
            extensionDevelopmentPath: repoRoot,
            extensionTestsPath,
            launchArgs: [
                '--user-data-dir=' + USER_DATA_DIR,
                '--extensions-dir=' + EXTENSIONS_DIR,
                args.workspace,
            ],
            extensionTestsEnv: {
                LUPA_HEADLESS_ARGS: JSON.stringify(args),
            },
        });
        process.exit(0);
    } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        process.stderr.write(`Headless run failed: ${msg}\n`);
        process.exit(1);
    }
}

main().catch((err) => {
    const msg = err && err.message ? err.message : String(err);
    process.stderr.write(`Headless launcher crashed: ${msg}\n`);
    process.exit(1);
});
