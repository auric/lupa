/**
 * Extracts the error message from an unknown error.
 */
export function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    if (
        typeof error === 'object' &&
        error !== null &&
        'message' in error &&
        typeof (error as { message: unknown }).message === 'string'
    ) {
        return (error as { message: string }).message;
    }
    try {
        return String(error);
    } catch {
        try {
            return JSON.stringify(error);
        } catch {
            return Object.prototype.toString.call(error);
        }
    }
}

/** Maximum length for error strings before truncation. */
export const MAX_ERROR_LEN = 500;

/**
 * Truncates an error message to a maximum length, appending an ellipsis
 * indicator when truncation occurs.
 */
export function truncateError(
    error: string | undefined,
    maxLen = MAX_ERROR_LEN
): string {
    if (!error || error.length <= maxLen) {
        return error ?? '';
    }
    const suffix = '... (truncated)';
    const sliceEnd = Math.max(0, maxLen - suffix.length);
    return error.slice(0, sliceEnd) + suffix;
}
