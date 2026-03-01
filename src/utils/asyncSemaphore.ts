/**
 * Async semaphore for limiting concurrent access to a shared resource.
 * Used to throttle parallel LLM requests across all agents to avoid API rate limits.
 */
export class AsyncSemaphore {
    private current = 0;
    private readonly queue: Array<() => void> = [];

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
     */
    async acquire(): Promise<void> {
        if (this.current < this.maxConcurrency) {
            this.current++;
            return;
        }

        return new Promise<void>((resolve) => {
            this.queue.push(() => {
                this.current++;
                resolve();
            });
        });
    }

    /**
     * Release a semaphore slot, allowing the next queued caller to proceed.
     */
    release(): void {
        this.current--;
        const next = this.queue.shift();
        if (next) {
            next();
        }
    }

    /**
     * Run an async function with semaphore-controlled concurrency.
     * Acquires a slot before execution and releases it when done (even on error).
     */
    async run<T>(fn: () => Promise<T>): Promise<T> {
        await this.acquire();
        try {
            return await fn();
        } finally {
            this.release();
        }
    }
}
