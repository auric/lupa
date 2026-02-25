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

const TERMINAL_STATUSES: ReadonlySet<AgentStatus> = new Set([
    'completed',
    'failed',
    'cancelled',
]);

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
 * Budget model: Independent per-agent allocation following the RLM paper.
 * Each child gets DEFAULT_CHILD_BUDGET as its OWN iteration budget,
 * independent of the parent (not deducted from parent's budget).
 * Total compute is bounded by maxSubagentsPerSession and maxRecursionDepth settings.
 */
export const RecursionConstants = {
    /** Below this budget a new agent is not worth spawning */
    MIN_VIABLE_BUDGET: 3,
    /** Independent iteration budget allocated to each child agent */
    DEFAULT_CHILD_BUDGET: 30,
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

    constructor(private readonly maxDepth: number) {}

    /**
     * Register a new agent in the tree and return its unique ID.
     */
    registerAgent(
        parentId: string | undefined,
        task: string,
        budget: number
    ): string {
        if (!parentId && this.tree.has('root')) {
            throw new Error(
                'Root agent already registered. Each RecursiveStateManager supports a single root.'
            );
        }

        if (parentId && !this.tree.has(parentId)) {
            Log.warn(
                `registerAgent: parent "${parentId}" not found in tree — child will be orphaned`
            );
        }

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
        if (!node) {
            Log.warn(`completeAgent called with unknown agentId: "${agentId}"`);
            return;
        }
        if (TERMINAL_STATUSES.has(node.status)) {
            Log.warn(
                `completeAgent: agent "${agentId}" already in terminal state "${node.status}", ignoring`
            );
            return;
        }
        node.status = 'completed';
        node.findings = findings;
        node.filesExamined = filesExamined;
        node.endTime = Date.now();
    }

    failAgent(agentId: string, _error: string): void {
        const node = this.getNode(agentId);
        if (!node) {
            Log.warn(`failAgent called with unknown agentId: "${agentId}"`);
            return;
        }
        if (TERMINAL_STATUSES.has(node.status)) {
            Log.warn(
                `failAgent: agent "${agentId}" already in terminal state "${node.status}", ignoring`
            );
            return;
        }
        node.status = 'failed';
        node.endTime = Date.now();
    }

    cancelAgent(agentId: string): void {
        const node = this.getNode(agentId);
        if (!node) {
            Log.warn(`cancelAgent called with unknown agentId: "${agentId}"`);
            return;
        }
        if (TERMINAL_STATUSES.has(node.status)) {
            Log.warn(
                `cancelAgent: agent "${agentId}" already in terminal state "${node.status}", ignoring`
            );
            return;
        }
        node.status = 'cancelled';
        node.endTime = Date.now();
    }

    /**
     * Check whether a child agent can be spawned from the given parent.
     */
    canSpawnChild(parentId: string): SpawnGuardResult {
        const parentNode = this.tree.get(parentId);
        if (!parentNode) {
            return { allowed: false, reason: `Parent "${parentId}" not found` };
        }

        if (parentNode.status !== 'running') {
            return {
                allowed: false,
                reason: `Parent agent "${parentId}" is ${parentNode.status}, only running agents can spawn children`,
            };
        }

        const childDepth = parentNode.depth + 1;
        if (childDepth > this.maxDepth) {
            return {
                allowed: false,
                reason: `Maximum recursion depth (${this.maxDepth}) reached`,
            };
        }

        const budget = this.calculateChildBudget(parentId);
        // Future-proofing: currently always returns DEFAULT_CHILD_BUDGET (30),
        // but this guard activates if the budget model evolves (e.g., dynamic allocation).
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
     * Check if a file was successfully analyzed by a completed agent.
     * Only completed agents count — failed/cancelled agents may not have
     * actually examined their assigned files.
     */
    isFileAlreadyCovered(file: string): boolean {
        for (const node of this.tree.values()) {
            if (
                node.filesExamined.includes(file) &&
                node.status === 'completed'
            ) {
                return true;
            }
        }
        return false;
    }

    getCoveredFiles(): Set<string> {
        const files = new Set<string>();
        for (const node of this.tree.values()) {
            if (node.status === 'completed') {
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

        const sortedNodes = [...this.tree.values()].sort((a, b) => {
            if (a.depth !== b.depth) {
                return a.depth - b.depth;
            }
            return a.agentId.localeCompare(b.agentId);
        });

        const lines: string[] = [];
        for (const node of sortedNodes) {
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
     * RLM paper model: each child gets an independent budget, not deducted from parent.
     * Total compute is controlled by maxSubagentsPerSession and maxRecursionDepth.
     */
    calculateChildBudget(parentId: string): number {
        const parent = this.tree.get(parentId);
        if (!parent) {
            return 0;
        }
        return RecursionConstants.DEFAULT_CHILD_BUDGET;
    }

    /**
     * Allocate iteration budget for a single child.
     * RLM paper model: independent budget per agent — no deduction from parent.
     */
    allocateChildBudget(parentId: string): number {
        return this.calculateChildBudget(parentId);
    }

    /**
     * Get approximate total remaining iterations across all active agents.
     * Informational only — with independent per-agent budgets, this sums
     * individual budgets of running/pending agents for progress reporting.
     */
    getRemainingBudget(): number {
        let remaining = 0;
        for (const node of this.tree.values()) {
            if (node.status === 'running' || node.status === 'pending') {
                remaining += node.iterationBudget;
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
