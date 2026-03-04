import { describe, it, expect } from 'vitest';
import * as vscode from 'vscode';
import { AsyncSemaphore } from '../utils/asyncSemaphore';

function createToken() {
    const cts = new vscode.CancellationTokenSource();
    return { cts, token: cts.token };
}

describe('AsyncSemaphore', () => {
    it('should reject maxConcurrency < 1', () => {
        expect(() => new AsyncSemaphore(0)).toThrow('maxConcurrency must be');
    });

    it('should allow up to maxConcurrency parallel tasks', async () => {
        const sem = new AsyncSemaphore(3);
        const { token } = createToken();
        let running = 0;
        let maxRunning = 0;

        const task = () =>
            sem.run(async () => {
                running++;
                maxRunning = Math.max(maxRunning, running);
                // Yield to let other tasks attempt to start
                await new Promise((r) => setTimeout(r, 10));
                running--;
            }, token);

        await Promise.all([task(), task(), task(), task(), task()]);

        expect(maxRunning).toBe(3);
    });

    it('should queue tasks beyond concurrency limit', async () => {
        const sem = new AsyncSemaphore(1);
        const { token } = createToken();
        const order: number[] = [];

        const task = (id: number) =>
            sem.run(async () => {
                order.push(id);
                await new Promise((r) => setTimeout(r, 5));
            }, token);

        await Promise.all([task(1), task(2), task(3)]);

        // Sequential execution means FIFO order
        expect(order).toEqual([1, 2, 3]);
    });

    it('should release slot on error', async () => {
        const sem = new AsyncSemaphore(1);
        const { token } = createToken();

        // Task that throws
        await expect(
            sem.run(async () => {
                throw new Error('boom');
            }, token)
        ).rejects.toThrow('boom');

        // Slot should be available again
        expect(sem.activeCount).toBe(0);
        expect(sem.waitingCount).toBe(0);

        // Next task should proceed
        const result = await sem.run(async () => 'ok', token);
        expect(result).toBe('ok');
    });

    it('should report activeCount and waitingCount', async () => {
        const sem = new AsyncSemaphore(2);
        const { token } = createToken();
        const resolvers: Array<() => void> = [];

        // Start 3 tasks with manual resolvers
        const tasks = [0, 1, 2].map(() =>
            sem.run(
                () =>
                    new Promise<void>((resolve) => {
                        resolvers.push(resolve);
                    }),
                token
            )
        );

        // Allow microtasks to settle
        await new Promise((r) => setTimeout(r, 0));

        expect(sem.activeCount).toBe(2);
        expect(sem.waitingCount).toBe(1);

        // Release one slot
        resolvers[0]!();
        await new Promise((r) => setTimeout(r, 0));

        expect(sem.activeCount).toBe(2);
        expect(sem.waitingCount).toBe(0);

        // Release remaining
        resolvers[1]!();
        resolvers[2]!();
        await Promise.all(tasks);

        expect(sem.activeCount).toBe(0);
        expect(sem.waitingCount).toBe(0);
    });

    it('should acquire/release manually', async () => {
        const sem = new AsyncSemaphore(1);
        const { token } = createToken();

        await sem.acquire(token);
        expect(sem.activeCount).toBe(1);

        sem.release();
        expect(sem.activeCount).toBe(0);
    });

    it('should throw on release without matching acquire', () => {
        const sem = new AsyncSemaphore(1);
        expect(() => sem.release()).toThrow(
            'release() called without a matching acquire()'
        );
    });

    it('should throw on double release', async () => {
        const sem = new AsyncSemaphore(1);
        const { token } = createToken();
        await sem.acquire(token);
        sem.release();
        expect(() => sem.release()).toThrow(
            'release() called without a matching acquire()'
        );
    });
});

describe('AsyncSemaphore cancellation', () => {
    it('should reject immediately when token is already cancelled', async () => {
        const sem = new AsyncSemaphore(1);
        const { cts, token } = createToken();
        cts.cancel();

        await expect(sem.acquire(token)).rejects.toThrow('Canceled');
        expect(sem.activeCount).toBe(0);
    });

    it('should reject queued acquire when token fires while waiting', async () => {
        const sem = new AsyncSemaphore(1);
        const { token: holderToken } = createToken();
        const { cts: waiterCts, token: waiterToken } = createToken();

        // Fill the single slot
        await sem.acquire(holderToken);
        expect(sem.activeCount).toBe(1);

        // Queue a second acquire
        const acquirePromise = sem.acquire(waiterToken);
        expect(sem.waitingCount).toBe(1);

        // Cancel the waiting acquire
        waiterCts.cancel();

        await expect(acquirePromise).rejects.toThrow('Canceled');
        expect(sem.waitingCount).toBe(0);
        // Slot still held by the holder
        expect(sem.activeCount).toBe(1);

        sem.release();
    });

    it('should not consume a slot when cancelled while queued', async () => {
        const sem = new AsyncSemaphore(1);
        const { token: holderToken } = createToken();
        const { cts: waiterCts, token: waiterToken } = createToken();

        await sem.acquire(holderToken);

        const acquirePromise = sem.acquire(waiterToken);
        waiterCts.cancel();
        await expect(acquirePromise).rejects.toThrow('Canceled');

        // Release the holder — activeCount should go to 0, not stay at 1
        sem.release();
        expect(sem.activeCount).toBe(0);
    });

    it('should cancel run() with CancellationError when token fires while queued', async () => {
        const sem = new AsyncSemaphore(1);
        const { token: holderToken } = createToken();
        const { cts: waiterCts, token: waiterToken } = createToken();

        // Hold the slot with a long-running task
        let resolveHolder: () => void;
        const holderTask = sem.run(
            () =>
                new Promise<void>((r) => {
                    resolveHolder = r;
                }),
            holderToken
        );

        await new Promise((r) => setTimeout(r, 0));
        expect(sem.activeCount).toBe(1);

        // Queue a run() that will be cancelled
        let taskExecuted = false;
        const waitingTask = sem.run(async () => {
            taskExecuted = true;
        }, waiterToken);

        await new Promise((r) => setTimeout(r, 0));
        expect(sem.waitingCount).toBe(1);

        waiterCts.cancel();
        await expect(waitingTask).rejects.toThrow('Canceled');
        expect(taskExecuted).toBe(false);

        // Slot still available for others after holder finishes
        resolveHolder!();
        await holderTask;
        expect(sem.activeCount).toBe(0);
    });

    it('should process next waiter normally after a cancelled waiter', async () => {
        const sem = new AsyncSemaphore(1);
        const { token: holderToken } = createToken();
        const { cts: cancelledCts, token: cancelledToken } = createToken();
        const { token: normalToken } = createToken();

        // Fill slot
        let resolveHolder: () => void;
        const holderTask = sem.run(
            () =>
                new Promise<void>((r) => {
                    resolveHolder = r;
                }),
            holderToken
        );
        await new Promise((r) => setTimeout(r, 0));

        // Queue two waiters
        const cancelledTask = sem.run(
            async () => 'cancelled-result',
            cancelledToken
        );
        const normalTask = sem.run(async () => 'normal-result', normalToken);
        await new Promise((r) => setTimeout(r, 0));
        expect(sem.waitingCount).toBe(2);

        // Cancel the first waiter
        cancelledCts.cancel();
        await expect(cancelledTask).rejects.toThrow('Canceled');
        expect(sem.waitingCount).toBe(1);

        // Release holder — normal waiter should proceed
        resolveHolder!();
        await holderTask;
        const result = await normalTask;
        expect(result).toBe('normal-result');
    });

    it('should not leak listener when slot is acquired normally', async () => {
        const sem = new AsyncSemaphore(1);
        const { token: holderToken } = createToken();
        const { token: waiterToken } = createToken();

        // Fill and hold the slot
        await sem.acquire(holderToken);

        // Queue a waiter
        const acquirePromise = sem.acquire(waiterToken);
        expect(sem.waitingCount).toBe(1);

        // Release holder — waiter gets the slot normally
        sem.release();
        await acquirePromise;

        // The listener dispose should have been called during release()
        // Verify by checking that the onCancellationRequested mock's disposable was called
        expect(waiterToken.onCancellationRequested).toHaveBeenCalledTimes(1);
        const disposable = (
            waiterToken.onCancellationRequested as ReturnType<
                typeof import('vitest').vi.fn
            >
        ).mock.results[0]!.value;
        expect(disposable.dispose).toHaveBeenCalled();

        sem.release();
        expect(sem.activeCount).toBe(0);
    });
});
