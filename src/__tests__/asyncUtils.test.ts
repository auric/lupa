import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import {
    withTimeout,
    withCancellableTimeout,
    isTimeoutError,
    isCancellationError,
    rethrowIfCancellationOrTimeout,
} from '../utils/asyncUtils';
import { TimeoutError } from '../types/errorTypes';

describe('asyncUtils', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('withTimeout', () => {
        it('should resolve when promise completes before timeout', async () => {
            const promise = Promise.resolve('success');
            const result = await withTimeout(promise, 1000, 'test operation');
            expect(result).toBe('success');
        });

        it('should throw TimeoutError when promise exceeds timeout', async () => {
            const slowPromise = new Promise((resolve) => {
                setTimeout(() => resolve('too late'), 5000);
            });

            const timeoutPromise = withTimeout(
                slowPromise,
                1000,
                'test operation'
            );
            vi.advanceTimersByTime(1001);

            await expect(timeoutPromise).rejects.toThrow(TimeoutError);
        });

        it('should include operation name in TimeoutError', async () => {
            const slowPromise = new Promise((resolve) => {
                setTimeout(() => resolve('too late'), 5000);
            });

            const timeoutPromise = withTimeout(
                slowPromise,
                1000,
                'MyOperation'
            );
            vi.advanceTimersByTime(1001);

            await expect(timeoutPromise).rejects.toMatchObject({
                operation: 'MyOperation',
                timeoutMs: 1000,
            });
        });

        it('should not cause unhandled rejection when underlying promise rejects after timeout', async () => {
            // Track unhandled rejections
            const unhandledRejections: unknown[] = [];
            const originalListener = process.listeners('unhandledRejection');
            process.removeAllListeners('unhandledRejection');
            process.on('unhandledRejection', (reason) => {
                unhandledRejections.push(reason);
            });

            try {
                // Create a promise that rejects AFTER the timeout
                const slowRejectingPromise = new Promise((_, reject) => {
                    setTimeout(() => reject(new Error('late rejection')), 2000);
                });

                const timeoutPromise = withTimeout(
                    slowRejectingPromise,
                    1000,
                    'test operation'
                );

                // Trigger timeout
                vi.advanceTimersByTime(1001);
                await expect(timeoutPromise).rejects.toThrow(TimeoutError);

                // Trigger the late rejection
                vi.advanceTimersByTime(1000);

                // Allow microtasks to process
                await vi.runAllTimersAsync();

                // No unhandled rejections should have occurred
                expect(unhandledRejections).toHaveLength(0);
            } finally {
                // Restore original listeners
                process.removeAllListeners('unhandledRejection');
                for (const listener of originalListener) {
                    process.on('unhandledRejection', listener);
                }
            }
        });

        it('should clean up timer when promise resolves', async () => {
            const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');

            const promise = Promise.resolve('success');
            await withTimeout(promise, 1000, 'test operation');

            expect(clearTimeoutSpy).toHaveBeenCalled();
        });
    });

    describe('withCancellableTimeout', () => {
        it('should resolve when promise completes before timeout or cancellation', async () => {
            const promise = Promise.resolve('success');
            const result = await withCancellableTimeout(
                promise,
                1000,
                'test operation'
            );
            expect(result).toBe('success');
        });

        it('should throw CancellationError when token is already cancelled', async () => {
            const token = {
                isCancellationRequested: true,
                onCancellationRequested: vi.fn(),
            } as unknown as vscode.CancellationToken;

            const promise = Promise.resolve('success');

            await expect(
                withCancellableTimeout(promise, 1000, 'test operation', token)
            ).rejects.toThrow(vscode.CancellationError);
        });

        it('should throw CancellationError when token is cancelled during operation', async () => {
            let cancelCallback: () => void = () => {};

            const token = {
                isCancellationRequested: false,
                onCancellationRequested: vi.fn((callback: () => void) => {
                    cancelCallback = callback;
                    return { dispose: vi.fn() };
                }),
            } as unknown as vscode.CancellationToken;

            const slowPromise = new Promise((resolve) => {
                setTimeout(() => resolve('too late'), 5000);
            });

            const operationPromise = withCancellableTimeout(
                slowPromise,
                10000,
                'test operation',
                token
            );

            // Simulate user cancellation after 500ms
            vi.advanceTimersByTime(500);
            cancelCallback();

            await expect(operationPromise).rejects.toThrow(
                vscode.CancellationError
            );
        });

        it('should throw TimeoutError when timeout occurs before cancellation', async () => {
            const token = {
                isCancellationRequested: false,
                onCancellationRequested: vi.fn(() => ({ dispose: vi.fn() })),
            } as unknown as vscode.CancellationToken;

            const slowPromise = new Promise((resolve) => {
                setTimeout(() => resolve('too late'), 5000);
            });

            const operationPromise = withCancellableTimeout(
                slowPromise,
                1000,
                'test operation',
                token
            );

            vi.advanceTimersByTime(1001);

            await expect(operationPromise).rejects.toThrow(TimeoutError);
        });

        it('should dispose cancellation listener on success', async () => {
            const disposeMock = vi.fn();
            const token = {
                isCancellationRequested: false,
                onCancellationRequested: vi.fn(() => ({
                    dispose: disposeMock,
                })),
            } as unknown as vscode.CancellationToken;

            const promise = Promise.resolve('success');
            await withCancellableTimeout(
                promise,
                1000,
                'test operation',
                token
            );

            expect(disposeMock).toHaveBeenCalled();
        });

        it('should dispose cancellation listener on timeout', async () => {
            const disposeMock = vi.fn();
            const token = {
                isCancellationRequested: false,
                onCancellationRequested: vi.fn(() => ({
                    dispose: disposeMock,
                })),
            } as unknown as vscode.CancellationToken;

            const slowPromise = new Promise((resolve) => {
                setTimeout(() => resolve('too late'), 5000);
            });

            const operationPromise = withCancellableTimeout(
                slowPromise,
                1000,
                'test operation',
                token
            );

            vi.advanceTimersByTime(1001);
            await expect(operationPromise).rejects.toThrow(TimeoutError);

            expect(disposeMock).toHaveBeenCalled();
        });

        it('should not cause unhandled rejection when underlying promise rejects after cancellation', async () => {
            const unhandledRejections: unknown[] = [];
            const originalListener = process.listeners('unhandledRejection');
            process.removeAllListeners('unhandledRejection');
            process.on('unhandledRejection', (reason) => {
                unhandledRejections.push(reason);
            });

            try {
                let cancelCallback: () => void = () => {};
                const token = {
                    isCancellationRequested: false,
                    onCancellationRequested: vi.fn((callback: () => void) => {
                        cancelCallback = callback;
                        return { dispose: vi.fn() };
                    }),
                } as unknown as vscode.CancellationToken;

                // Promise that rejects after cancellation
                const slowRejectingPromise = new Promise((_, reject) => {
                    setTimeout(() => reject(new Error('late rejection')), 2000);
                });

                const operationPromise = withCancellableTimeout(
                    slowRejectingPromise,
                    10000,
                    'test operation',
                    token
                );

                // Cancel before timeout
                vi.advanceTimersByTime(500);
                cancelCallback();
                await expect(operationPromise).rejects.toThrow(
                    vscode.CancellationError
                );

                // Trigger the late rejection
                vi.advanceTimersByTime(2000);
                await vi.runAllTimersAsync();

                expect(unhandledRejections).toHaveLength(0);
            } finally {
                process.removeAllListeners('unhandledRejection');
                for (const listener of originalListener) {
                    process.on('unhandledRejection', listener);
                }
            }
        });
    });

    describe('isTimeoutError', () => {
        it('should return true for TimeoutError instances', () => {
            const error = TimeoutError.create('test', 1000);
            expect(isTimeoutError(error)).toBe(true);
        });

        it('should return false for regular Error instances', () => {
            const error = new Error('test');
            expect(isTimeoutError(error)).toBe(false);
        });

        it('should return false for null/undefined', () => {
            expect(isTimeoutError(null)).toBe(false);
            expect(isTimeoutError(undefined)).toBe(false);
        });
    });

    describe('isCancellationError', () => {
        it('should return true for CancellationError instances', () => {
            const error = new vscode.CancellationError();
            expect(isCancellationError(error)).toBe(true);
        });

        it('should return false for regular Error instances', () => {
            const error = new Error('test');
            expect(isCancellationError(error)).toBe(false);
        });

        it('should return false for TimeoutError instances', () => {
            const error = TimeoutError.create('test', 1000);
            expect(isCancellationError(error)).toBe(false);
        });
    });

    describe('rethrowIfCancellationOrTimeout', () => {
        it('should rethrow CancellationError', () => {
            const error = new vscode.CancellationError();
            expect(() => rethrowIfCancellationOrTimeout(error)).toThrow(
                vscode.CancellationError
            );
        });

        it('should rethrow TimeoutError', () => {
            const error = TimeoutError.create('test', 1000);
            expect(() => rethrowIfCancellationOrTimeout(error)).toThrow(
                TimeoutError
            );
        });

        it('should not throw for regular Error instances', () => {
            const error = new Error('test');
            expect(() => rethrowIfCancellationOrTimeout(error)).not.toThrow();
        });

        it('should not throw for null/undefined', () => {
            expect(() => rethrowIfCancellationOrTimeout(null)).not.toThrow();
            expect(() =>
                rethrowIfCancellationOrTimeout(undefined)
            ).not.toThrow();
        });

        it('should not throw for string errors', () => {
            expect(() =>
                rethrowIfCancellationOrTimeout('some error')
            ).not.toThrow();
        });
    });
});
