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
