import { describe, it, expect } from 'vitest';
import { AsyncSemaphore } from '../utils/asyncSemaphore';

describe('AsyncSemaphore', () => {
    it('should reject maxConcurrency < 1', () => {
        expect(() => new AsyncSemaphore(0)).toThrow('maxConcurrency must be');
    });

    it('should allow up to maxConcurrency parallel tasks', async () => {
        const sem = new AsyncSemaphore(3);
        let running = 0;
        let maxRunning = 0;

        const task = () =>
            sem.run(async () => {
                running++;
                maxRunning = Math.max(maxRunning, running);
                // Yield to let other tasks attempt to start
                await new Promise((r) => setTimeout(r, 10));
                running--;
            });

        await Promise.all([task(), task(), task(), task(), task()]);

        expect(maxRunning).toBe(3);
    });

    it('should queue tasks beyond concurrency limit', async () => {
        const sem = new AsyncSemaphore(1);
        const order: number[] = [];

        const task = (id: number) =>
            sem.run(async () => {
                order.push(id);
                await new Promise((r) => setTimeout(r, 5));
            });

        await Promise.all([task(1), task(2), task(3)]);

        // Sequential execution means FIFO order
        expect(order).toEqual([1, 2, 3]);
    });

    it('should release slot on error', async () => {
        const sem = new AsyncSemaphore(1);

        // Task that throws
        await expect(
            sem.run(async () => {
                throw new Error('boom');
            })
        ).rejects.toThrow('boom');

        // Slot should be available again
        expect(sem.activeCount).toBe(0);
        expect(sem.waitingCount).toBe(0);

        // Next task should proceed
        const result = await sem.run(async () => 'ok');
        expect(result).toBe('ok');
    });

    it('should report activeCount and waitingCount', async () => {
        const sem = new AsyncSemaphore(2);
        const resolvers: Array<() => void> = [];

        // Start 3 tasks with manual resolvers
        const tasks = [0, 1, 2].map(() =>
            sem.run(
                () =>
                    new Promise<void>((resolve) => {
                        resolvers.push(resolve);
                    })
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

        await sem.acquire();
        expect(sem.activeCount).toBe(1);

        sem.release();
        expect(sem.activeCount).toBe(0);
    });
});
