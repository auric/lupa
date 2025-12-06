import { WorkspaceSettingsService } from './workspaceSettingsService';

/**
 * Tracks subagent usage per analysis session.
 * Prevents excessive subagent spawning that could exhaust resources.
 */
export class SubagentSessionManager {
    private count = 0;

    constructor(private readonly workspaceSettings: WorkspaceSettingsService) { }

    private get maxPerSession(): number {
        return this.workspaceSettings.getMaxSubagentsPerSession();
    }

    canSpawn(): boolean {
        return this.count < this.maxPerSession;
    }

    /**
     * Record that a subagent was spawned and return its ID.
     */
    recordSpawn(): number {
        this.count++;
        return this.count;
    }

    getCount(): number {
        return this.count;
    }

    getRemainingBudget(): number {
        return Math.max(0, this.maxPerSession - this.count);
    }

    reset(): void {
        this.count = 0;
    }
}
