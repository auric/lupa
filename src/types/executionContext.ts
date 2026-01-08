import * as vscode from 'vscode';
import { PlanSessionManager } from '../services/planSessionManager';
import { SubagentSessionManager } from '../services/subagentSessionManager';
import { SubagentExecutor } from '../services/subagentExecutor';

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

    /**
     * Subagent session manager for the current analysis.
     * Tracks spawn counts, budget, and parent cancellation token.
     * Created per-analysis for concurrency safety.
     */
    subagentSessionManager?: SubagentSessionManager;

    /**
     * Subagent executor for the current analysis.
     * Handles subagent task execution with isolated conversation context.
     * Created per-analysis with bound progress callback.
     */
    subagentExecutor?: SubagentExecutor;

    /**
     * Cancellation token for the current analysis.
     * Tools should pass this to long-running operations (symbol extraction, LSP calls)
     * to enable responsive cancellation when user stops the analysis.
     */
    cancellationToken: vscode.CancellationToken;
}
