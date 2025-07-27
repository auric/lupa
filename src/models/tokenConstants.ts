/**
 * Constants for token management and calculations
 * Centralized configuration for all token-related operations
 */
export class TokenConstants {
    // Token calculation constants - could be made configurable in future
    static readonly TOKEN_OVERHEAD_PER_MESSAGE = 5;
    static readonly FORMATTING_OVERHEAD = 50;
    static readonly SAFETY_MARGIN_RATIO = 0.95; // 5% safety margin

    // Model defaults
    static readonly DEFAULT_MAX_INPUT_TOKENS = 8000;
    static readonly DEFAULT_CACHE_LIFETIME_MS = 5 * 60 * 1000; // 5 minutes

    // Emergency truncation constants
    static readonly EMERGENCY_MIN_TARGET_TOKENS = 100;
    static readonly MAX_FILES_IN_EMERGENCY_SUMMARY = 10;

    // Truncation constants
    static readonly TRUNCATION_MESSAGES = {
        CONTEXT: '\n\n[Context truncated to fit token limit. Some information might be missing.]',
        PARTIAL: '\n\n[File content partially truncated to fit token limit]'
    } as const;

    // Context optimization constants
    static readonly MIN_CONTENT_TOKENS_FOR_PARTIAL = 10;
    static readonly SAFETY_BUFFER_FOR_PARTIAL = 5;
    static readonly CHARS_PER_TOKEN_ESTIMATE = 4.0;
}
