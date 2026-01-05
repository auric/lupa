import * as crypto from 'crypto';
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
     * Unique trace ID for this analysis session.
     * Used for correlating logs across tool calls and subagents.
     * Format: 8-character hex string (e.g., "a1b2c3d4")
     */
    traceId: string;

    /**
     * Label for the current execution context.
     * For main analysis: "Main"
     * For subagents: "Sub#1", "Sub#2", etc.
     * For chat: "Chat", "Exploration"
     */
    contextLabel: string;

    /**
     * Current iteration number in the conversation loop.
     * Starts at 1, updated by ConversationRunner at the start of each iteration.
     */
    currentIteration: number;

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
}

/**
 * Generate a short trace ID for logging correlation.
 * Uses crypto.randomUUID for better uniqueness and collision resistance.
 * @returns 8-character hex string
 */
export function generateTraceId(): string {
    // Use first 8 chars of UUID (removing hyphens)
    return crypto.randomUUID().replace(/-/g, '').substring(0, 8);
}
