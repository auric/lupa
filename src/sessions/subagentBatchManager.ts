import { Log } from '../services/loggingService';

/**
 * A queued subagent task waiting for batched execution.
 * Captures all state needed to execute the subagent later.
 */
export interface QueuedSubagent {
    /** The investigation task description */
    task: string;
    /** Optional context from the parent agent */
    taskContext: string | undefined;
    /** Unique identifier assigned by SubagentSessionManager.recordSpawn() */
    subagentId: number;
    /** Child agent ID in the recursive state tree (if recursive mode) */
    childAgentId: string | undefined;
    /** Allocated iteration budget for recursive mode */
    childBudget: number | undefined;
    /** The parent agent's recursion depth at enqueue time */
    currentDepth: number;
}

/**
 * Accumulates run_subagent calls across conversation iterations for batched parallel execution.
 *
 * Problem: Some models (e.g., GPT-5-mini) emit only one run_subagent call per iteration
 * instead of spawning multiple in parallel. This causes sequential execution:
 *   IT1: run_subagent(A) → 30s → IT2: run_subagent(B) → 30s → IT3: run_subagent(C) → 30s
 *
 * Solution: Instead of executing immediately, RunSubagentTool enqueues tasks here.
 * After each iteration, ConversationRunner checks: if the queue has pending tasks
 * and the model's latest response contained no run_subagent calls (indicating it
 * has finished delegating), all queued tasks execute in parallel:
 *   IT1: queue(A) → IT2: queue(B) → IT3: queue(C) → IT4: no subagent → flush(A,B,C) parallel
 *
 * For models that already parallelize, the overhead is minimal (1 extra iteration
 * before the flush fires).
 */
export class SubagentBatchManager {
    private queue: QueuedSubagent[] = [];

    /**
     * Add a subagent task to the batch queue.
     * Called by RunSubagentTool.execute() when batching is enabled.
     */
    enqueue(entry: QueuedSubagent): void {
        this.queue.push(entry);
        Log.info(
            `SubagentBatchManager: Queued subagent #${entry.subagentId} (${this.queue.length} pending)`
        );
    }

    /** Whether there are tasks waiting to be executed. */
    hasPending(): boolean {
        return this.queue.length > 0;
    }

    /** Number of tasks currently queued. */
    getPendingCount(): number {
        return this.queue.length;
    }

    /**
     * Remove and return all queued tasks.
     * The caller is responsible for executing them.
     */
    drain(): QueuedSubagent[] {
        const items = this.queue;
        this.queue = [];
        Log.info(
            `SubagentBatchManager: Drained ${items.length} queued subagent(s)`
        );
        return items;
    }

    /** Discard all queued tasks without executing them. */
    clear(): void {
        if (this.queue.length > 0) {
            Log.info(
                `SubagentBatchManager: Cleared ${this.queue.length} queued subagent(s)`
            );
        }
        this.queue = [];
    }
}
