import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withTimeout, TimeoutError, isTimeoutError } from '../utils/asyncUtils';

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

            // Advance past the timeout
            await vi.advanceTimersByTimeAsync(150);

            await expect(resultPromise).rejects.toThrow(
                'slow operation timed out after 100ms'
            );
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

            await vi.advanceTimersByTimeAsync(1);

            await expect(resultPromise).rejects.toThrow('timed out after 0ms');
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

            await vi.advanceTimersByTimeAsync(150);

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
    });
});
