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
    iterationsUsed: number;
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
 */
export const RecursionConstants = {
    /** Below this budget a new agent is not worth spawning */
    MIN_VIABLE_BUDGET: 5,
    /** Fraction of budget the parent keeps for orchestration */
    ROOT_BUDGET_RATIO: 0.4,
    /** Fraction of parent's remaining budget given to children */
    CHILD_BUDGET_RATIO: 0.6,
    /** If root hasn't spawned subagents after this many iterations, fall back to linear */
    FALLBACK_ITERATION_THRESHOLD: 5,
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
            iterationsUsed: 0,
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

        const budget = this.allocateChildBudget(parentId, 1);
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
     * Calculate the iteration budget for a single child of the given parent.
     *
     * @param parentId The parent agent
     * @param numChildren How many children the parent intends to spawn in this batch
     */
    allocateChildBudget(parentId: string, numChildren: number): number {
        const parent = this.tree.get(parentId);
        if (!parent || numChildren <= 0) {
            return 0;
        }

        const ratio =
            parent.depth === 0
                ? RecursionConstants.CHILD_BUDGET_RATIO
                : RecursionConstants.CHILD_BUDGET_RATIO;

        const childPool = Math.floor(parent.iterationBudget * ratio);
        return Math.max(1, Math.floor(childPool / numChildren));
    }

    /**
     * Get the remaining iteration budget across the whole analysis.
     * (Sum of budgets minus iterations used for all running/pending agents.)
     */
    getRemainingBudget(): number {
        let remaining = 0;
        for (const node of this.tree.values()) {
            if (node.status === 'running' || node.status === 'pending') {
                remaining += node.iterationBudget - node.iterationsUsed;
            }
        }
        return remaining;
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
