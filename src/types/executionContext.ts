import { PlanSessionManager } from '../services/planSessionManager';

/**
 * Context passed to tools during execution.
 *
 * This provides per-analysis state that tools can access without
 * relying on shared mutable state in singleton services.
 *
 * Key design principle: Each analysis creates its own ExecutionContext,
 * ensuring complete isolation between parallel analyses.
 */
export interface ExecutionContext {
    /**
     * Plan manager for the current analysis session.
     * Used by UpdatePlanTool to track review progress.
     * Undefined for subagent executions (they don't have plans).
     */
    planManager?: PlanSessionManager;
}
