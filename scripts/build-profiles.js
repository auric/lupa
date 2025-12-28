/**
 * Build profile configuration - single source of truth for dev/production filtering.
 *
 * Profiles:
 * - production: Public release, strips dev features
 * - internal: Full-featured build for testing/dogfooding
 * - development: Local dev mode (implicit, no packaging)
 */

/** Command patterns to filter from production builds */
const DEV_COMMAND_PATTERNS = ['tooltesting', 'testwebview'];

/** Webview entry points by profile */
const WEBVIEW_ENTRIES = {
    core: ['main'],
    dev: ['main', 'toolTesting'],
};

/**
 * Determine if a command should be filtered based on profile
 * @param {string} commandId - Command ID (e.g., 'lupa.openToolTesting')
 * @param {string} profile - Build profile ('production' | 'internal')
 * @returns {boolean} - true if command should be KEPT
 */
function shouldKeepCommand(commandId, profile) {
    if (profile === 'internal') {
        return true; // Keep all commands for internal builds
    }
    const commandLower = commandId.toLowerCase();
    return !DEV_COMMAND_PATTERNS.some((pattern) =>
        commandLower.includes(pattern)
    );
}

/**
 * Get webview entries for a build profile
 * @param {string} profile - Build profile ('production' | 'internal')
 * @returns {string[]} - Array of webview entry names to include
 */
function getWebviewEntries(profile) {
    return profile === 'internal' ? WEBVIEW_ENTRIES.dev : WEBVIEW_ENTRIES.core;
}

/**
 * Check if running in internal profile
 * @returns {boolean}
 */
function isInternalProfile() {
    return process.env.BUILD_PROFILE === 'internal';
}

module.exports = {
    DEV_COMMAND_PATTERNS,
    WEBVIEW_ENTRIES,
    shouldKeepCommand,
    getWebviewEntries,
    isInternalProfile,
};
