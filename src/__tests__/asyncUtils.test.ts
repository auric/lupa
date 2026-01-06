import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withTimeout, TimeoutError, isTimeoutError } from '../utils/asyncUtils';
import { Log } from '../services/loggingService';

vi.mock('../services/loggingService', () => ({
    Log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}));

describe('asyncUtils', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.clearAllMocks();
    });

    describe('withTimeout', () => {
        it('should resolve when promise completes before timeout', async () => {
            const promise = Promise.resolve('success');

            const result = await withTimeout(promise, 1000, 'test operation');

            expect(result).toBe('success');
        });

        it('should reject when promise takes longer than timeout', async () => {
            const slowPromise = new Promise<string>((resolve) => {
                setTimeout(() => resolve('too late'), 2000);
            });

            const resultPromise = withTimeout(
                slowPromise,
                100,
                'slow operation'
            );

            // Start awaiting rejection before advancing time to avoid unhandled rejection
            const rejectPromise = expect(resultPromise).rejects.toThrow(
                'slow operation timed out after 100ms'
            );

            // Advance past the timeout
            await vi.advanceTimersByTimeAsync(150);

            await rejectPromise;
        });

        it('should clear timeout timer when promise resolves before timeout', async () => {
            const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');

            const promise = Promise.resolve('quick');
            await withTimeout(promise, 5000, 'quick operation');

            expect(clearTimeoutSpy).toHaveBeenCalled();
            clearTimeoutSpy.mockRestore();
        });

        it('should clear timeout timer when promise rejects before timeout', async () => {
            const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');

            const promise = Promise.reject(new Error('failed'));

            await expect(
                withTimeout(promise, 5000, 'failing operation')
            ).rejects.toThrow('failed');

            expect(clearTimeoutSpy).toHaveBeenCalled();
            clearTimeoutSpy.mockRestore();
        });

        it('should propagate original error when promise rejects', async () => {
            const originalError = new Error('original error message');
            const promise = Promise.reject(originalError);

            await expect(
                withTimeout(promise, 1000, 'test operation')
            ).rejects.toThrow('original error message');
        });

        it('should handle zero timeout', async () => {
            const promise = new Promise<string>((resolve) => {
                setTimeout(() => resolve('result'), 10);
            });

            const resultPromise = withTimeout(
                promise,
                0,
                'zero timeout operation'
            );

            // Start awaiting rejection before advancing time
            const rejectPromise = expect(resultPromise).rejects.toThrow(
                'timed out after 0ms'
            );

            await vi.advanceTimersByTimeAsync(1);

            await rejectPromise;
        });

        it('should work with different return types', async () => {
            const numberPromise = Promise.resolve(42);
            const objectPromise = Promise.resolve({ key: 'value' });
            const arrayPromise = Promise.resolve([1, 2, 3]);

            expect(await withTimeout(numberPromise, 1000, 'number')).toBe(42);
            expect(await withTimeout(objectPromise, 1000, 'object')).toEqual({
                key: 'value',
            });
            expect(await withTimeout(arrayPromise, 1000, 'array')).toEqual([
                1, 2, 3,
            ]);
        });

        it('should throw TimeoutError instance when timeout occurs', async () => {
            const slowPromise = new Promise<string>((resolve) => {
                setTimeout(() => resolve('too late'), 2000);
            });

            const resultPromise = withTimeout(
                slowPromise,
                100,
                'slow operation'
            );

            // Start awaiting before advancing time to avoid unhandled rejection
            const awaitPromise = (async () => {
                try {
                    await resultPromise;
                    expect.fail('Should have thrown');
                } catch (error) {
                    expect(error).toBeInstanceOf(TimeoutError);
                    expect(isTimeoutError(error)).toBe(true);
                    if (error instanceof TimeoutError) {
                        expect(error.operation).toBe('slow operation');
                        expect(error.timeoutMs).toBe(100);
                        expect(error.isTimeout).toBe(true);
                    }
                }
            })();

            await vi.advanceTimersByTimeAsync(150);
            await awaitPromise;
        });

        it('should log abandoned operation when promise resolves after timeout', async () => {
            const slowPromise = new Promise<string>((resolve) => {
                setTimeout(() => resolve('completed after timeout'), 500);
            });

            const resultPromise = withTimeout(
                slowPromise,
                100,
                'abandoned operation'
            );

            // Start awaiting before advancing time to avoid unhandled rejection
            const awaitPromise = (async () => {
                try {
                    await resultPromise;
                    expect.fail('Should have thrown TimeoutError');
                } catch (error) {
                    expect(error).toBeInstanceOf(TimeoutError);
                }
            })();

            // Advance past the timeout (100ms)
            await vi.advanceTimersByTimeAsync(150);
            await awaitPromise;

            // Clear mock before checking for abandoned log
            vi.mocked(Log.debug).mockClear();

            // Now advance time so the underlying promise resolves (at 500ms)
            await vi.advanceTimersByTimeAsync(400);

            // Verify the abandoned operation was logged
            expect(Log.debug).toHaveBeenCalledWith(
                expect.stringContaining('[Abandoned]')
            );
            expect(Log.debug).toHaveBeenCalledWith(
                expect.stringContaining('abandoned operation')
            );
        });

        it('should log abandoned operation when promise rejects after timeout', async () => {
            // Create a promise that rejects after 500ms, add no-op catch to prevent
            // unhandled rejection warnings (asyncUtils handles it internally)
            const slowPromise = new Promise<string>((_, reject) => {
                setTimeout(() => reject(new Error('late error')), 500);
            });
            slowPromise.catch(() => {});

            const resultPromise = withTimeout(
                slowPromise,
                100,
                'abandoned failing operation'
            );

            // Start awaiting before advancing time to avoid unhandled rejection
            const awaitPromise = (async () => {
                try {
                    await resultPromise;
                    expect.fail('Should have thrown TimeoutError');
                } catch (error) {
                    expect(error).toBeInstanceOf(TimeoutError);
                }
            })();

            // Advance past the timeout
            await vi.advanceTimersByTimeAsync(150);
            await awaitPromise;

            // Clear mock before checking for abandoned log
            vi.mocked(Log.debug).mockClear();

            // Advance so underlying promise rejects
            await vi.advanceTimersByTimeAsync(400);

            // Verify the abandoned operation failure was logged
            expect(Log.debug).toHaveBeenCalledWith(
                expect.stringContaining('[Abandoned]')
            );
            expect(Log.debug).toHaveBeenCalledWith(
                expect.stringContaining('failed after')
            );
        });
    });

    describe('isTimeoutError', () => {
        it('should return true for TimeoutError instances', () => {
            const error = new TimeoutError('test op', 5000);
            expect(isTimeoutError(error)).toBe(true);
        });

        it('should return false for regular Error instances', () => {
            const error = new Error('regular error');
            expect(isTimeoutError(error)).toBe(false);
        });

        it('should return false for non-Error objects', () => {
            expect(isTimeoutError({ message: 'not an error' })).toBe(false);
            expect(isTimeoutError('string error')).toBe(false);
            expect(isTimeoutError(null)).toBe(false);
            expect(isTimeoutError(undefined)).toBe(false);
        });

        it('should return false for Error with "timed out" in message but not TimeoutError', () => {
            const error = new Error('Operation timed out');
            expect(isTimeoutError(error)).toBe(false);
        });

        it('should return true for plain object with isTimeout property', () => {
            // Handles cross-module boundary cases where instanceof may fail
            const errorLikeObject = {
                isTimeout: true,
                message: 'Simulated timeout',
                timeoutMs: 5000,
                operation: 'cross-module operation',
            };
            expect(isTimeoutError(errorLikeObject)).toBe(true);
        });

        it('should return false for object with isTimeout set to false', () => {
            const errorLikeObject = {
                isTimeout: false,
                message: 'Not a timeout',
            };
            expect(isTimeoutError(errorLikeObject)).toBe(false);
        });
    });
});
