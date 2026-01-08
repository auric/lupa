import * as vscode from 'vscode';
import { TimeoutError } from '../types/errorTypes';
import { Log } from '../services/loggingService';

/**
 * Wraps a promise with a timeout and proper resource cleanup.
 * The timer is always cleared when the promise settles (success, error, or timeout).
 * Logs when requests are abandoned due to timeout.
 *
 * @param promise The promise to wrap
 * @param timeoutMs Timeout in milliseconds
 * @param operation Description of the operation for error messages
 * @returns The promise result or throws TimeoutError on timeout
 */
export async function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    operation: string
): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
            Log.warn(
                `[Timeout] ${operation} abandoned after ${timeoutMs}ms - underlying operation may continue running`
            );
            reject(TimeoutError.create(operation, timeoutMs));
        }, timeoutMs);
    });

    // Suppress late rejections from underlying promise after timeout wins
    promise.catch(() => {});

    try {
        return await Promise.race([promise, timeoutPromise]);
    } finally {
        if (timeoutId !== undefined) {
            clearTimeout(timeoutId);
        }
    }
}

/**
 * Wraps a promise with timeout AND CancellationToken support.
 * Use this when the operation should be abortable by user action (e.g., stopping analysis).
 *
 * Features:
 * - Timer cleanup on completion (no resource leak)
 * - CancellationToken integration (throws CancellationError when cancelled)
 * - Proper event listener disposal
 * - Logging when request is abandoned
 *
 * @param promise The promise to wrap
 * @param timeoutMs Timeout in milliseconds
 * @param operation Description of the operation for error messages
 * @param token Optional CancellationToken to abort the operation
 * @returns The promise result, or throws TimeoutError/CancellationError
 */
export async function withCancellableTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    operation: string,
    token?: vscode.CancellationToken
): Promise<T> {
    // Early exit if already cancelled
    if (token?.isCancellationRequested) {
        Log.debug(`[Cancellation] ${operation} skipped - already cancelled`);
        throw new vscode.CancellationError();
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let cancellationDisposable: vscode.Disposable | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
            Log.warn(
                `[Timeout] ${operation} abandoned after ${timeoutMs}ms - underlying operation may continue running`
            );
            reject(TimeoutError.create(operation, timeoutMs));
        }, timeoutMs);
    });

    // Suppress late rejections from underlying promise after timeout/cancellation wins
    promise.catch(() => {});

    const racers: Promise<T | never>[] = [promise, timeoutPromise];

    // Add cancellation promise if token provided
    if (token) {
        const cancellationPromise = new Promise<never>((_, reject) => {
            cancellationDisposable = token.onCancellationRequested(() => {
                Log.debug(`[Cancellation] ${operation} cancelled by user`);
                reject(new vscode.CancellationError());
            });
        });
        // Prevent unhandled rejection if token fires after race settles
        cancellationPromise.catch(() => {});
        racers.push(cancellationPromise);
    }

    try {
        return await Promise.race(racers);
    } finally {
        // Always clean up resources
        if (timeoutId !== undefined) {
            clearTimeout(timeoutId);
        }
        cancellationDisposable?.dispose();
    }
}

/**
 * Check if an error is a TimeoutError
 */
export function isTimeoutError(error: unknown): error is TimeoutError {
    return error instanceof TimeoutError;
}

/**
 * Check if an error is a CancellationError (type guard for consistency with isTimeoutError)
 */
export function isCancellationError(
    error: unknown
): error is vscode.CancellationError {
    return error instanceof vscode.CancellationError;
}

/**
 * Creates an AbortController that aborts when the VS Code CancellationToken is cancelled.
 * Returns the AbortController so caller can access both signal and abort().
 * The listener is automatically cleaned up when abort is triggered.
 *
 * @param token Optional VS Code CancellationToken
 * @returns AbortController linked to the token, or undefined if no token provided
 */
export function createAbortControllerFromToken(
    token: vscode.CancellationToken | undefined
): AbortController | undefined {
    if (!token) {
        return undefined;
    }

    const controller = new AbortController();

    if (token.isCancellationRequested) {
        controller.abort();
        return controller;
    }

    const disposable = token.onCancellationRequested(() => {
        controller.abort();
        disposable.dispose();
    });

    return controller;
}
