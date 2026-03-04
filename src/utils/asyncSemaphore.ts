import * as vscode from 'vscode';

interface QueueEntry {
    resolve: () => void;
    reject: (error: Error) => void;
    settled: boolean;
    disposeListener: (() => void) | undefined;
}

/**
 * Async semaphore for limiting concurrent access to a shared resource.
 * Used to throttle parallel LLM requests across all agents to avoid API rate limits.
 */
export class AsyncSemaphore {
    private current = 0;
    private readonly queue: QueueEntry[] = [];

    constructor(private readonly maxConcurrency: number) {
        if (maxConcurrency < 1) {
            throw new Error(
                `maxConcurrency must be >= 1, got ${maxConcurrency}`
            );
        }
    }

    /** Number of slots currently in use. */
    get activeCount(): number {
        return this.current;
    }

    /** Number of callers waiting for a slot. */
    get waitingCount(): number {
        return this.queue.length;
    }

    /**
     * Acquire a semaphore slot. Resolves immediately if a slot is available,
     * otherwise queues until one opens up.
     *
     * When the CancellationToken fires while queued, the waiter is removed from
     * the queue and the returned promise rejects with CancellationError.
     * No slot is consumed in this case.
     */
    async acquire(token: vscode.CancellationToken): Promise<void> {
        if (token.isCancellationRequested) {
            throw new vscode.CancellationError();
        }

        if (this.current < this.maxConcurrency) {
            this.current++;
            return;
        }

        return new Promise<void>((resolve, reject) => {
            const entry: QueueEntry = {
                resolve: () => {
                    this.current++;
                    resolve();
                },
                reject,
                settled: false,
                disposeListener: undefined,
            };
            this.queue.push(entry);

            const listener = token.onCancellationRequested(() => {
                if (entry.settled) {
                    return;
                }
                entry.settled = true;
                entry.disposeListener = undefined;
                listener.dispose();
                const idx = this.queue.indexOf(entry);
                if (idx !== -1) {
                    this.queue.splice(idx, 1);
                }
                reject(new vscode.CancellationError());
            });
            entry.disposeListener = () => listener.dispose();
        });
    }

    /**
     * Release a semaphore slot, allowing the next queued caller to proceed.
     */
    release(): void {
        if (this.current <= 0) {
            throw new Error(
                'AsyncSemaphore.release() called without a matching acquire()'
            );
        }
        this.current--;
        const next = this.queue.shift();
        if (next) {
            next.settled = true;
            next.disposeListener?.();
            next.disposeListener = undefined;
            next.resolve();
        }
    }

    /**
     * Run an async function with semaphore-controlled concurrency.
     * Acquires a slot before execution and releases it when done (even on error).
     *
     * @param fn - The async function to execute with concurrency control
     * @param token - Cancellation token; if fired while queued, rejects with CancellationError
     *               without consuming a slot
     */
    async run<T>(
        fn: () => Promise<T>,
        token: vscode.CancellationToken
    ): Promise<T> {
        await this.acquire(token);
        try {
            return await fn();
        } finally {
            this.release();
        }
    }
}
