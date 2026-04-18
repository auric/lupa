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
const SENTINEL_PATH = path.join(ROOT, '.lupa-headless-last.json');
const PROFILE_SETTINGS_PATH = path.join(USER_DATA_DIR, 'User', 'settings.json');

const REQUIRED_EXTENSIONS = ['GitHub.copilot-chat'];

/**
 * Baseline settings written into the headless profile to keep the spawned
 * window non-interactive: workspace-trust banner, update checks, telemetry
 * prompts, welcome screen, and extension-recommendation toasts are all
 * suppressed so the only UI the operator may ever need to click is the
 * one-time "Allow Lupa to use Copilot?" consent on first run.
 */
const PROFILE_SETTINGS = {
    'security.workspace.trust.enabled': false,
    'security.workspace.trust.startupPrompt': 'never',
    'security.workspace.trust.banner': 'never',
    'update.mode': 'none',
    'extensions.autoUpdate': false,
    'extensions.autoCheckUpdates': false,
    'extensions.ignoreRecommendations': true,
    'telemetry.telemetryLevel': 'off',
    'workbench.startupEditor': 'none',
    'workbench.tips.enabled': false,
    'git.autofetch': false,
    'git.autoRepositoryDetection': false,
};

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

/**
 * Merges the baseline PROFILE_SETTINGS into the profile's settings.json
 * without clobbering any additional keys the user may have set in the
 * interactive setup window. Idempotent: safe to call on every launch.
 */
function ensureProfileSettings() {
    fs.mkdirSync(path.dirname(PROFILE_SETTINGS_PATH), { recursive: true });
    let existing = {};
    try {
        const raw = fs.readFileSync(PROFILE_SETTINGS_PATH, 'utf8');
        existing = JSON.parse(raw);
        if (!existing || typeof existing !== 'object') {
            existing = {};
        }
    } catch (err) {
        if (err && err.code !== 'ENOENT') {
            // Corrupt JSON — rewrite rather than refuse to launch.
            existing = {};
        }
    }
    const merged = { ...existing, ...PROFILE_SETTINGS };
    fs.writeFileSync(
        PROFILE_SETTINGS_PATH,
        JSON.stringify(merged, null, 4) + '\n'
    );
}

module.exports = {
    USER_DATA_DIR,
    EXTENSIONS_DIR,
    VSCODE_CACHE_DIR,
    SETUP_MARKER,
    SENTINEL_PATH,
    PROFILE_SETTINGS_PATH,
    REQUIRED_EXTENSIONS,
    resolveInstalledExtensionPath,
    ensureProfileSettings,
};
