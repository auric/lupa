import { Log } from '../services/loggingService';

/**
 * Custom error class for timeout errors.
 * Use `instanceof TimeoutError` for robust error type checking.
 */
export class TimeoutError extends Error {
    readonly isTimeout = true;
    readonly timeoutMs: number;
    readonly operation: string;

    constructor(operation: string, timeoutMs: number) {
        super(`${operation} timed out after ${timeoutMs}ms`);
        this.name = 'TimeoutError';
        this.operation = operation;
        this.timeoutMs = timeoutMs;
        // Maintain proper stack trace in V8 environments
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, TimeoutError);
        }
    }
}

/**
 * Type guard to check if an error is a TimeoutError.
 * Handles both instanceof checks and cross-module boundary cases where
 * instanceof may fail due to different module instances.
 */
export function isTimeoutError(error: unknown): error is TimeoutError {
    if (error instanceof TimeoutError) {
        return true;
    }
    // Fallback for cross-module boundaries where instanceof may fail
    return (
        typeof error === 'object' &&
        error !== null &&
        'isTimeout' in error &&
        (error as { isTimeout: unknown }).isTimeout === true
    );
}

/**
 * Wraps a promise with a timeout.
 *
 * IMPORTANT: This uses Promise.race, which means the underlying operation
 * is NOT cancelled - it continues running in the background. This is a
 * limitation of VS Code's LSP commands which don't accept CancellationToken.
 *
 * For operations that can be cancelled, use withTimeoutAndToken instead.
 *
 * @param promise The promise to wrap
 * @param timeoutMs Timeout in milliseconds
 * @param operation Description of the operation for error messages
 * @returns The promise result or throws on timeout
 */
export function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    operation: string
): Promise<T> {
    let timedOut = false;
    let resolved = false;
    let timeoutId: NodeJS.Timeout | undefined;
    const startTime = Date.now();

    const timeoutPromise = new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => {
            if (!resolved) {
                timedOut = true;
                reject(new TimeoutError(operation, timeoutMs));
            }
        }, timeoutMs);
    });

    // Track when the original promise completes (even after timeout)
    promise
        .then(() => {
            resolved = true;
            if (timedOut) {
                const totalTime = Date.now() - startTime;
                Log.debug(
                    `[Abandoned] ${operation} completed after ${totalTime}ms (was rejected at ${timeoutMs}ms)`
                );
            }
        })
        .catch(() => {
            resolved = true;
            if (timedOut) {
                const totalTime = Date.now() - startTime;
                Log.debug(
                    `[Abandoned] ${operation} failed after ${totalTime}ms (was rejected at ${timeoutMs}ms)`
                );
            }
        });

    return Promise.race([promise, timeoutPromise]).finally(() => {
        resolved = true;
        // Clear the timeout to prevent memory leaks and unnecessary timer execution
        if (timeoutId !== undefined) {
            clearTimeout(timeoutId);
        }
    });
}
