/**
 * Manages the review plan state across a single analysis session.
 * The plan is a markdown-formatted checklist that the LLM creates and updates.
 */
export class PlanSessionManager {
    private currentPlan: string | undefined;

    /**
     * Update the plan with new content.
     * @param plan Markdown-formatted plan string
     */
    updatePlan(plan: string): void {
        this.currentPlan = plan;
    }

    /**
     * Get the current plan, if any.
     */
    getPlan(): string | undefined {
        return this.currentPlan;
    }

    /**
     * Check if a plan has been created.
     */
    hasPlan(): boolean {
        return this.currentPlan !== undefined;
    }

    /**
     * Reset the plan state for a new analysis session.
     */
    reset(): void {
        this.currentPlan = undefined;
    }
}
