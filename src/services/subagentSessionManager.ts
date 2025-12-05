import { SubagentLimits } from '../models/toolConstants';

/**
 * Tracks subagent usage per analysis session.
 * Prevents excessive subagent spawning that could exhaust resources.
 */
export class SubagentSessionManager {
    private count = 0;

    /**
     * Check if another subagent can be spawned.
     */
    canSpawn(): boolean {
        return this.count < SubagentLimits.MAX_PER_SESSION;
    }

    /**
     * Record that a subagent was spawned.
     */
    recordSpawn(): void {
        this.count++;
    }

    /**
     * Get current subagent count.
     */
    getCount(): number {
        return this.count;
    }

    /**
     * Get remaining subagent budget.
     */
    getRemainingBudget(): number {
        return Math.max(0, SubagentLimits.MAX_PER_SESSION - this.count);
    }

    /**
     * Reset counter for a new analysis session.
     */
    reset(): void {
        this.count = 0;
    }
}
