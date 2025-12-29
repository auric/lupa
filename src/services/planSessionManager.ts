/**
 * Manages the review plan state for a single analysis session.
 *
 * Create a new instance for each analysis run to ensure isolation
 * between parallel analyses. The instance is passed to ToolExecutor
 * for the duration of the analysis.
 */
export class PlanSessionManager {
    private plan: string | undefined;

    /**
     * Update the current plan.
     * @param plan Markdown-formatted plan string
     */
    updatePlan(plan: string): void {
        this.plan = plan;
    }

    /**
     * Get the current plan, if any.
     */
    getPlan(): string | undefined {
        return this.plan;
    }

    /**
     * Check if a plan exists.
     */
    hasPlan(): boolean {
        return this.plan !== undefined;
    }

    /**
     * Reset the plan.
     */
    reset(): void {
        this.plan = undefined;
    }
}
