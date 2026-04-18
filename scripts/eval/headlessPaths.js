/**
 * Shared filesystem locations used by the headless setup and launcher
 * scripts. Centralized here so both agree on where the persistent VS Code
 * profile, extensions directory, and download cache live.
 *
 * All paths are gitignored under `.vscode-test/`.
 */

const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '.vscode-test');

const USER_DATA_DIR = path.join(ROOT, 'lupa-headless-profile');
const EXTENSIONS_DIR = path.join(ROOT, 'lupa-headless-extensions');
const VSCODE_CACHE_DIR = path.join(ROOT, 'vscode');
const SETUP_MARKER = path.join(ROOT, '.lupa-headless-ready');

const REQUIRED_EXTENSIONS = ['GitHub.copilot', 'GitHub.copilot-chat'];

module.exports = {
    USER_DATA_DIR,
    EXTENSIONS_DIR,
    VSCODE_CACHE_DIR,
    SETUP_MARKER,
    REQUIRED_EXTENSIONS,
};
