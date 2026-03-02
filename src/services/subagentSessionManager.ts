import * as vscode from 'vscode';
import { WorkspaceSettingsService } from './workspaceSettingsService';

/**
 * Tracks subagent usage per analysis session.
 * Prevents excessive subagent spawning that could exhaust resources.
 *
 * Session slots are intentionally never freed on cancellation or timeout —
 * a cancelled subagent still consumed model resources, so the budget should
 * reflect actual usage. `rollbackSpawn` reclaims a slot when post-spawn
 * registration fails or when a subagent fails to produce useful work
 * (LLM errors, service errors, unexpected exceptions).
 */
export class SubagentSessionManager {
    private count = 0;
    private nextId = 0;
    private parentCancellationToken: vscode.CancellationToken | undefined;

    constructor(private readonly workspaceSettings: WorkspaceSettingsService) {}

    private get maxPerSession(): number {
        return this.workspaceSettings.getMaxSubagentsPerSession();
    }

    canSpawn(): boolean {
        return this.count < this.maxPerSession;
    }

    /**
     * Record that a subagent was spawned and return its ID.
     * IDs are monotonically increasing and never reused, even after rollback.
     */
    recordSpawn(): number {
        this.count++;
        this.nextId++;
        return this.nextId;
    }

    /**
     * Roll back a spawn when post-spawn registration fails.
     * Decrements the count so the budget slot isn't permanently consumed.
     */
    rollbackSpawn(): void {
        if (this.count > 0) {
            this.count--;
        }
    }

    getCount(): number {
        return this.count;
    }

    getRemainingBudget(): number {
        return Math.max(0, this.maxPerSession - this.count);
    }

    /**
     * Link a parent cancellation token (main analysis) so subagents cancel promptly.
     */
    setParentCancellationToken(
        token: vscode.CancellationToken | undefined
    ): void {
        this.parentCancellationToken = token;
    }

    /**
     * Register a subagent cancellation source so it mirrors the parent cancellation token.
     */
    registerSubagentCancellation(
        source: vscode.CancellationTokenSource
    ): vscode.Disposable | undefined {
        if (!this.parentCancellationToken) {
            return undefined;
        }

        return this.parentCancellationToken.onCancellationRequested(() => {
            source.cancel();
        });
    }

    reset(): void {
        this.count = 0;
        this.nextId = 0;
        this.parentCancellationToken = undefined;
    }
}
