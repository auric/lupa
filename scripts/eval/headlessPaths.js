/**
 * Shared filesystem locations used by the headless setup and launcher
 * scripts. Centralized here so both agree on where the persistent VS Code
 * profile, extensions directory, and download cache live.
 *
 * All paths are gitignored under `.vscode-test/`.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '.vscode-test');

const USER_DATA_DIR = path.join(ROOT, 'lupa-headless-profile');
const EXTENSIONS_DIR = path.join(ROOT, 'lupa-headless-extensions');
const VSCODE_CACHE_DIR = path.join(ROOT, 'vscode');
const SETUP_MARKER = path.join(ROOT, '.lupa-headless-ready');

const REQUIRED_EXTENSIONS = ['GitHub.copilot-chat'];

/**
 * Resolves the absolute install folder for an extension inside
 * `EXTENSIONS_DIR` by consulting the `extensions.json` manifest VS Code
 * writes on install. The folder name carries a version suffix that
 * changes across updates, so it must be looked up dynamically.
 *
 * @param {string} extensionId Lowercase publisher.name identifier.
 * @returns {string | null} Absolute path, or null if unresolved.
 */
function resolveInstalledExtensionPath(extensionId) {
    const manifestPath = path.join(EXTENSIONS_DIR, 'extensions.json');
    let raw;
    try {
        raw = fs.readFileSync(manifestPath, 'utf8');
    } catch {
        return null;
    }
    let entries;
    try {
        entries = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!Array.isArray(entries)) {
        return null;
    }
    const target = extensionId.toLowerCase();
    const match = entries.find(
        (e) =>
            e &&
            e.identifier &&
            typeof e.identifier.id === 'string' &&
            e.identifier.id.toLowerCase() === target
    );
    if (!match || typeof match.relativeLocation !== 'string') {
        return null;
    }
    return path.join(EXTENSIONS_DIR, match.relativeLocation);
}

module.exports = {
    USER_DATA_DIR,
    EXTENSIONS_DIR,
    VSCODE_CACHE_DIR,
    SETUP_MARKER,
    REQUIRED_EXTENSIONS,
    resolveInstalledExtensionPath,
};
