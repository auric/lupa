import * as vscode from 'vscode';
import { PlanSessionManager } from '../services/planSessionManager';
import { SubagentSessionManager } from '../services/subagentSessionManager';
import { SubagentExecutor } from '../services/subagentExecutor';
import { RecursiveStateManager } from '../sessions/recursiveStateManager';
import type { SubagentBatchManager } from '../sessions/subagentBatchManager';
import type { DiffHunk } from './contextTypes';

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
     *
     * Required: All entry points must provide a token. For tests, use
     * `createMockExecutionContext()` from `src/__tests__/testUtils/mockFactories.ts` which
     * provides a non-cancelled token by default.
     */
    cancellationToken: vscode.CancellationToken;

    /**
     * Recursive state manager for the current analysis.
     * Tracks the agent tree, enforces depth/budget limits, and tracks file coverage.
     * Present when recursive review mode is enabled (maxRecursionDepth >= 1).
     */
    recursiveState?: RecursiveStateManager;

    /**
     * Current recursion depth of this agent.
     * 0 = root agent, 1 = first-level child, 2 = grandchild, etc.
     */
    currentDepth?: number;

    /**
     * Hierarchical identifier for this agent in the recursive tree.
     * Examples: "root", "child-1", "child-1.1"
     */
    currentAgentId?: string;

    /**
     * Parsed diff data for on-demand access via diff tools.
     * The get_file_diff tool reads from this to return diffs on demand.
     * Present only during analysis mode (not exploration mode).
     */
    parsedDiff?: DiffHunk[];

    /**
     * Batch manager for accumulating subagent calls across iterations.
     * When present, RunSubagentTool enqueues tasks instead of executing immediately.
     * ConversationRunner flushes the batch when the model stops emitting run_subagent calls.
     * Created per-analysis when subagent batching is enabled.
     */
    subagentBatchManager?: SubagentBatchManager;
}
