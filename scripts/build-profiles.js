/**
 * Build profile configuration for dev/production filtering.
 *
 * Profiles:
 * - production: Public release, strips dev features
 * - internal: Full-featured build for testing/dogfooding
 */

/** Command patterns to filter from production builds (lowercase) */
const DEV_COMMAND_PATTERNS = ['tooltesting', 'testwebview'];

/**
 * Determine if a command should be kept based on build profile.
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

module.exports = { shouldKeepCommand };
