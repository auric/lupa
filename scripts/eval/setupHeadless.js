#!/usr/bin/env node
/**
 * One-time interactive setup for the Lupa headless analysis profile.
 *
 * @vscode/test-electron launches an isolated VS Code instance with its own
 * user-data and extensions directories, so the Copilot extension and the
 * user's GitHub auth from their regular VS Code install are not visible to
 * the headless runner. This script provisions a persistent profile that
 * subsequent `npm run headless` invocations reuse:
 *
 *   1. Downloads the cached VS Code (shared with `launchHeadless.js`).
 *   2. Installs GitHub.copilot and GitHub.copilot-chat into the persistent
 *      extensions directory via the VS Code CLI.
 *   3. Launches VS Code interactively against the persistent profile so the
 *      user can complete the "GitHub Copilot: Sign In" flow once.
 *
 * Re-running this script is safe and idempotent; use it again if Copilot
 * auth ever expires.
 */

const fs = require('node:fs');
const { spawn } = require('node:child_process');
const {
    downloadAndUnzipVSCode,
    runVSCodeCommand,
} = require('@vscode/test-electron');
const {
    USER_DATA_DIR,
    EXTENSIONS_DIR,
    VSCODE_CACHE_DIR,
    SETUP_MARKER,
    REQUIRED_EXTENSIONS,
} = require('./headlessPaths');

async function main() {
    process.stdout.write(
        '=== Lupa headless setup — one-time interactive flow ===\n\n'
    );

    try {
        fs.unlinkSync(SETUP_MARKER);
    } catch (err) {
        if (err && err.code !== 'ENOENT') {
            throw err;
        }
    }

    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
    fs.mkdirSync(EXTENSIONS_DIR, { recursive: true });

    process.stdout.write('Downloading VS Code (cached after first run)...\n');
    const executablePath = await downloadAndUnzipVSCode({
        version: 'stable',
        cachePath: VSCODE_CACHE_DIR,
    });
    process.stdout.write(`VS Code executable: ${executablePath}\n\n`);

    for (const ext of REQUIRED_EXTENSIONS) {
        process.stdout.write(`Installing ${ext}...\n`);
        await runVSCodeCommand(
            [
                '--install-extension',
                ext,
                '--user-data-dir=' + USER_DATA_DIR,
                '--extensions-dir=' + EXTENSIONS_DIR,
            ],
            { version: 'stable', cachePath: VSCODE_CACHE_DIR }
        );
        process.stdout.write(`  ✓ ${ext} installed\n`);
    }
    process.stdout.write('\n');

    process.stdout.write(
        'Launching VS Code interactively. Please:\n' +
            '  1. When VS Code opens, run "GitHub Copilot: Sign In" from the command palette.\n' +
            '  2. Complete the GitHub authentication flow in your browser.\n' +
            '  3. Wait until Copilot is active (check the status bar).\n' +
            '  4. Close the VS Code window when done.\n' +
            'This authentication will be reused by all future `npm run headless` runs.\n\n'
    );

    await new Promise((resolve, reject) => {
        const child = spawn(
            executablePath,
            [
                '--user-data-dir=' + USER_DATA_DIR,
                '--extensions-dir=' + EXTENSIONS_DIR,
                '--new-window',
            ],
            { stdio: 'inherit' }
        );
        child.on('error', reject);
        child.on('exit', (code, signal) => {
            if (signal) {
                reject(new Error(`VS Code terminated by signal ${signal}`));
            } else if (code !== null && code !== 0) {
                reject(new Error(`VS Code exited with code ${code}`));
            } else {
                resolve();
            }
        });
    });

    fs.writeFileSync(SETUP_MARKER, new Date().toISOString() + '\n');

    process.stdout.write(
        '\nSetup complete. You can now run `npm run headless -- ' +
            '--workspace ... --base ... --head ... --model ...`.\n'
    );
}

main().catch((err) => {
    const msg = err && err.message ? err.message : String(err);
    process.stderr.write(`Headless setup failed: ${msg}\n`);
    process.exit(1);
});
