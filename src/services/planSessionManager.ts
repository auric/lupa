/**
 * Manages the review plan state across analysis sessions.
 * Uses session IDs to isolate plans between parallel analyses (e.g., webview + chat).
 */
export class PlanSessionManager {
    /** Plans keyed by session ID. Default session ID is 'default'. */
    private plans = new Map<string, string>();

    /** Current active session ID */
    private activeSessionId = 'default';

    /**
     * Set the active session ID for subsequent operations.
     * Call this at the start of each analysis to isolate plans.
     */
    setActiveSession(sessionId: string): void {
        this.activeSessionId = sessionId;
    }

    /**
     * Get the active session ID.
     */
    getActiveSession(): string {
        return this.activeSessionId;
    }

    /**
     * Update the plan for the active session.
     * @param plan Markdown-formatted plan string
     */
    updatePlan(plan: string): void {
        this.plans.set(this.activeSessionId, plan);
    }

    /**
     * Get the plan for the active session, if any.
     */
    getPlan(): string | undefined {
        return this.plans.get(this.activeSessionId);
    }

    /**
     * Check if a plan exists for the active session.
     */
    hasPlan(): boolean {
        return this.plans.has(this.activeSessionId);
    }

    /**
     * Reset the plan for the active session.
     * Call this at the start of a new analysis.
     */
    reset(): void {
        this.plans.delete(this.activeSessionId);
    }

    /**
     * Reset all sessions. Use when extension deactivates.
     */
    resetAll(): void {
        this.plans.clear();
        this.activeSessionId = 'default';
    }
}
