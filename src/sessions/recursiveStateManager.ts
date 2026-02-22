import { Log } from '../services/loggingService';

/**
 * Severity levels for review findings, ordered by impact.
 */
export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low';

/**
 * Confidence that the finding is a real issue, not a false positive.
 */
export type FindingConfidence = 'verified' | 'likely' | 'uncertain';

/**
 * Agent lifecycle states.
 */
export type AgentStatus =
    | 'pending'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled';

/**
 * A single finding reported by a recursive review agent.
 */
export interface RecursiveReviewFinding {
    severity: FindingSeverity;
    category: string;
    file: string;
    line: number | undefined;
    title: string;
    description: string;
    confidence: FindingConfidence;
    agentId: string;
}

/**
 * A node in the recursive agent tree, tracking one agent's lifecycle.
 */
export interface RecursiveStateNode {
    agentId: string;
    depth: number;
    parentId: string | undefined;
    task: string;
    status: AgentStatus;
    findings: RecursiveReviewFinding[];
    filesExamined: string[];
    iterationBudget: number;
    childIds: string[];
    startTime: number;
    endTime: number | undefined;
}

/**
 * Result of a spawn guard check.
 */
export interface SpawnGuardResult {
    allowed: boolean;
    reason?: string;
}

/**
 * Constants controlling recursive agent behavior.
 * These are internal / non-user-configurable.
 *
 * Budget model: Flat per-child allocation instead of exponential decay.
 * Each child gets up to DEFAULT_CHILD_BUDGET iterations, deducted from parent.
 * Parent always retains at least MIN_VIABLE_BUDGET for its own orchestration.
 */
export const RecursionConstants = {
    /** Below this budget a new agent is not worth spawning */
    MIN_VIABLE_BUDGET: 3,
    /** Default iteration budget allocated to each child agent */
    DEFAULT_CHILD_BUDGET: 20,
    /** If root hasn't spawned subagents after this many iterations, fall back to linear */
    FALLBACK_ITERATION_THRESHOLD: 5,
    /** Timeout per allocated iteration (ms) — used to compute subagent execution timeout */
    TIMEOUT_PER_ITERATION_MS: 30_000,
    /** Minimum subagent execution timeout (ms) regardless of budget */
    MIN_SUBAGENT_TIMEOUT_MS: 120_000,
} as const;

/**
 * Tracks the tree of recursive review agents, enforces depth/budget limits,
 * aggregates findings, and prevents duplicate file analysis.
 *
 * Created per-analysis for concurrency safety.
 */
export class RecursiveStateManager {
    private readonly tree = new Map<string, RecursiveStateNode>();
    private nextChildIndex = new Map<string, number>();

    constructor(
        private readonly maxDepth: number,
        private readonly maxTotalAgents: number,
        private readonly totalBudget: number
    ) {}

    /**
     * Register a new agent in the tree and return its unique ID.
     */
    registerAgent(
        parentId: string | undefined,
        task: string,
        budget: number
    ): string {
        const agentId = this.generateAgentId(parentId);
        const depth = parentId ? this.getDepthOf(parentId) + 1 : 0;

        const node: RecursiveStateNode = {
            agentId,
            depth,
            parentId,
            task,
            status: 'pending',
            findings: [],
            filesExamined: [],
            iterationBudget: budget,
            childIds: [],
            startTime: Date.now(),
            endTime: undefined,
        };

        this.tree.set(agentId, node);

        if (parentId) {
            const parent = this.tree.get(parentId);
            if (parent) {
                parent.childIds.push(agentId);
            }
        }

        Log.debug(
            `RecursiveState: Registered agent "${agentId}" (depth=${depth}, budget=${budget})`
        );
        return agentId;
    }

    startAgent(agentId: string): void {
        const node = this.getNode(agentId);
        if (node) {
            node.status = 'running';
        }
    }

    completeAgent(
        agentId: string,
        findings: RecursiveReviewFinding[] = [],
        filesExamined: string[] = []
    ): void {
        const node = this.getNode(agentId);
        if (node) {
            node.status = 'completed';
            node.findings = findings;
            node.filesExamined = filesExamined;
            node.endTime = Date.now();
        }
    }

    failAgent(agentId: string, _error: string): void {
        const node = this.getNode(agentId);
        if (node) {
            node.status = 'failed';
            node.endTime = Date.now();
        }
    }

    cancelAgent(agentId: string): void {
        const node = this.getNode(agentId);
        if (node) {
            node.status = 'cancelled';
            node.endTime = Date.now();
        }
    }

    /**
     * Check whether a child agent can be spawned from the given parent.
     */
    canSpawnChild(parentId: string): SpawnGuardResult {
        const parentNode = this.tree.get(parentId);
        if (!parentNode) {
            return { allowed: false, reason: `Parent "${parentId}" not found` };
        }

        const childDepth = parentNode.depth + 1;
        if (childDepth > this.maxDepth) {
            return {
                allowed: false,
                reason: `Maximum recursion depth (${this.maxDepth}) reached`,
            };
        }

        if (this.getTotalAgentCount() >= this.maxTotalAgents) {
            return {
                allowed: false,
                reason: `Maximum total agents (${this.maxTotalAgents}) reached`,
            };
        }

        const budget = this.calculateChildBudget(parentId);
        if (budget < RecursionConstants.MIN_VIABLE_BUDGET) {
            return {
                allowed: false,
                reason: `Insufficient budget (${budget} < ${RecursionConstants.MIN_VIABLE_BUDGET})`,
            };
        }

        return { allowed: true };
    }

    getDepthOf(agentId: string): number {
        return this.tree.get(agentId)?.depth ?? 0;
    }

    getTotalAgentCount(): number {
        return this.tree.size;
    }

    getMaxDepth(): number {
        return this.maxDepth;
    }

    /**
     * Check if a file is already being analyzed by another agent.
     */
    isFileAlreadyCovered(file: string): boolean {
        for (const node of this.tree.values()) {
            if (
                node.filesExamined.includes(file) &&
                (node.status === 'running' || node.status === 'completed')
            ) {
                return true;
            }
        }
        return false;
    }

    getCoveredFiles(): Set<string> {
        const files = new Set<string>();
        for (const node of this.tree.values()) {
            if (node.status === 'running' || node.status === 'completed') {
                for (const file of node.filesExamined) {
                    files.add(file);
                }
            }
        }
        return files;
    }

    /**
     * Collect all findings from every agent in the tree.
     */
    getAllFindings(): RecursiveReviewFinding[] {
        const findings: RecursiveReviewFinding[] = [];
        for (const node of this.tree.values()) {
            findings.push(...node.findings);
        }
        return findings;
    }

    /**
     * Produce a human-readable summary of the agent tree for logging/prompts.
     */
    getTreeSummary(): string {
        if (this.tree.size === 0) {
            return 'No agents registered.';
        }

        const lines: string[] = [];
        for (const node of this.tree.values()) {
            const indent = '  '.repeat(node.depth);
            const duration = node.endTime
                ? `${node.endTime - node.startTime}ms`
                : 'running';
            lines.push(
                `${indent}${node.agentId} [${node.status}] (${duration}) — ${node.findings.length} findings`
            );
        }
        return lines.join('\n');
    }

    getNode(agentId: string): RecursiveStateNode | undefined {
        return this.tree.get(agentId);
    }

    /**
     * Calculate the iteration budget for a single child without mutating state.
     * Uses flat allocation: each child gets up to DEFAULT_CHILD_BUDGET,
     * bounded by what the parent can afford (must retain MIN_VIABLE_BUDGET).
     */
    calculateChildBudget(parentId: string): number {
        const parent = this.tree.get(parentId);
        if (!parent) {
            return 0;
        }

        const available =
            parent.iterationBudget - RecursionConstants.MIN_VIABLE_BUDGET;
        if (available < RecursionConstants.MIN_VIABLE_BUDGET) {
            return 0;
        }

        return Math.min(RecursionConstants.DEFAULT_CHILD_BUDGET, available);
    }

    /**
     * Allocate iteration budget for a single child and deduct from parent.
     */
    allocateChildBudget(parentId: string): number {
        const budget = this.calculateChildBudget(parentId);
        const parent = this.tree.get(parentId);
        if (parent && budget >= RecursionConstants.MIN_VIABLE_BUDGET) {
            parent.iterationBudget = Math.max(
                0,
                parent.iterationBudget - budget
            );
        }
        return budget;
    }

    /**
     * Get the remaining iteration budget across the whole analysis.
     * (Sum of budgets minus iterations used for all running/pending agents.)
     */
    getRemainingBudget(): number {
        let remaining = 0;
        for (const node of this.tree.values()) {
            if (node.status === 'running' || node.status === 'pending') {
                remaining += node.iterationBudget;
            }
        }
        return Math.min(remaining, this.totalBudget);
    }

    /**
     * Generate a hierarchical agent ID.
     * root → child-1 → child-1.1 → child-1.1.1
     */
    private generateAgentId(parentId: string | undefined): string {
        if (!parentId) {
            return 'root';
        }

        const idx = (this.nextChildIndex.get(parentId) ?? 0) + 1;
        this.nextChildIndex.set(parentId, idx);

        if (parentId === 'root') {
            return `child-${idx}`;
        }
        return `${parentId}.${idx}`;
    }
}
