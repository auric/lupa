import { describe, it, expect, beforeEach } from 'vitest';
import {
    RecursiveStateManager,
    RecursionConstants,
} from '../sessions/recursiveStateManager';

describe('RecursiveStateManager', () => {
    let manager: RecursiveStateManager;

    beforeEach(() => {
        // maxDepth=2, maxTotalAgents=12, totalBudget=25
        manager = new RecursiveStateManager(2, 12, 25);
    });

    describe('registerAgent', () => {
        it('should register root agent with depth 0', () => {
            const id = manager.registerAgent(undefined, 'Root task', 25);
            expect(id).toBe('root');

            const node = manager.getNode('root');
            expect(node).toBeDefined();
            expect(node!.depth).toBe(0);
            expect(node!.parentId).toBeUndefined();
            expect(node!.status).toBe('pending');
            expect(node!.iterationBudget).toBe(25);
        });

        it('should register child agents with incremental IDs', () => {
            manager.registerAgent(undefined, 'Root', 25);
            const child1 = manager.registerAgent('root', 'Child 1', 10);
            const child2 = manager.registerAgent('root', 'Child 2', 10);

            expect(child1).toBe('child-1');
            expect(child2).toBe('child-2');

            expect(manager.getNode('child-1')!.depth).toBe(1);
            expect(manager.getNode('child-2')!.depth).toBe(1);
        });

        it('should register grandchild agents with hierarchical IDs', () => {
            manager.registerAgent(undefined, 'Root', 25);
            manager.registerAgent('root', 'Child 1', 10);
            const grandchild = manager.registerAgent(
                'child-1',
                'Grandchild',
                5
            );

            expect(grandchild).toBe('child-1.1');
            expect(manager.getNode('child-1.1')!.depth).toBe(2);
            expect(manager.getNode('child-1.1')!.parentId).toBe('child-1');
        });

        it('should track parent-child relationships', () => {
            manager.registerAgent(undefined, 'Root', 25);
            manager.registerAgent('root', 'Child 1', 10);
            manager.registerAgent('root', 'Child 2', 10);

            const root = manager.getNode('root')!;
            expect(root.childIds).toEqual(['child-1', 'child-2']);
        });
    });

    describe('agent lifecycle', () => {
        beforeEach(() => {
            manager.registerAgent(undefined, 'Root', 25);
        });

        it('should transition through pending → running → completed', () => {
            expect(manager.getNode('root')!.status).toBe('pending');

            manager.startAgent('root');
            expect(manager.getNode('root')!.status).toBe('running');

            manager.completeAgent('root', [], []);
            expect(manager.getNode('root')!.status).toBe('completed');
            expect(manager.getNode('root')!.endTime).toBeDefined();
        });

        it('should record findings on completion', () => {
            manager.startAgent('root');
            const findings = [
                {
                    severity: 'high' as const,
                    category: 'security',
                    file: 'auth.ts',
                    line: 42,
                    title: 'Missing validation',
                    description: 'Input not sanitized',
                    confidence: 'verified' as const,
                    agentId: 'root',
                },
            ];
            manager.completeAgent('root', findings, ['auth.ts']);

            const node = manager.getNode('root')!;
            expect(node.findings).toHaveLength(1);
            expect(node.filesExamined).toEqual(['auth.ts']);
        });

        it('should handle failure state', () => {
            manager.startAgent('root');
            manager.failAgent('root', 'LLM error');

            expect(manager.getNode('root')!.status).toBe('failed');
            expect(manager.getNode('root')!.endTime).toBeDefined();
        });

        it('should handle cancellation state', () => {
            manager.startAgent('root');
            manager.cancelAgent('root');

            expect(manager.getNode('root')!.status).toBe('cancelled');
        });
    });

    describe('canSpawnChild', () => {
        beforeEach(() => {
            manager.registerAgent(undefined, 'Root', 25);
            manager.startAgent('root');
        });

        it('should allow spawning within depth limit', () => {
            const result = manager.canSpawnChild('root');
            expect(result.allowed).toBe(true);
        });

        it('should reject spawning beyond max depth', () => {
            manager.registerAgent('root', 'Child', 10);
            manager.registerAgent('child-1', 'Grandchild', 5);

            // Depth 2 grandchild trying to spawn depth 3 → rejected
            const result = manager.canSpawnChild('child-1.1');
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('depth');
        });

        it('should reject spawning beyond max total agents', () => {
            // Create a manager with very low max agents
            const tightManager = new RecursiveStateManager(2, 3, 25);
            tightManager.registerAgent(undefined, 'Root', 25);
            tightManager.startAgent('root');
            tightManager.registerAgent('root', 'C1', 10);
            tightManager.registerAgent('root', 'C2', 10);

            // 3 agents total → max reached
            const result = tightManager.canSpawnChild('root');
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('total agents');
        });

        it('should reject when budget is insufficient', () => {
            // Create a manager with low budget
            const lowBudgetManager = new RecursiveStateManager(2, 12, 3);
            lowBudgetManager.registerAgent(undefined, 'Root', 3);
            lowBudgetManager.startAgent('root');

            // 3 * 0.6 = 1.8 → floor = 1 < MIN_VIABLE_BUDGET(5) → rejected
            const result = lowBudgetManager.canSpawnChild('root');
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('budget');
        });

        it('should reject for unknown parent', () => {
            const result = manager.canSpawnChild('nonexistent');
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('not found');
        });
    });

    describe('budget allocation', () => {
        it('should allocate child budget using CHILD_BUDGET_RATIO', () => {
            manager.registerAgent(undefined, 'Root', 25);

            // 25 * 0.6 = 15, divided by 3 children = 5 each
            const budget = manager.allocateChildBudget('root', 3);
            expect(budget).toBe(5);
        });

        it('should allocate for single child', () => {
            manager.registerAgent(undefined, 'Root', 25);

            // 25 * 0.6 = 15
            const budget = manager.allocateChildBudget('root', 1);
            expect(budget).toBe(15);
        });

        it('should return 0 for unknown parent', () => {
            const budget = manager.allocateChildBudget('nonexistent', 1);
            expect(budget).toBe(0);
        });

        it('should return 0 for zero children', () => {
            manager.registerAgent(undefined, 'Root', 25);
            const budget = manager.allocateChildBudget('root', 0);
            expect(budget).toBe(0);
        });

        it('should deduct allocated budget from parent', () => {
            manager.registerAgent(undefined, 'Root', 25);

            const budget = manager.allocateChildBudget('root', 1);
            expect(budget).toBe(15);

            // Parent's remaining iterationBudget should be reduced
            const rootNode = manager.getNode('root')!;
            expect(rootNode.iterationBudget).toBe(10); // 25 - 15 = 10
        });

        it('should yield progressively smaller budgets on repeated allocations', () => {
            manager.registerAgent(undefined, 'Root', 100);

            const first = manager.allocateChildBudget('root', 1);
            expect(first).toBe(60); // 100 * 0.6 = 60

            const second = manager.allocateChildBudget('root', 1);
            expect(second).toBe(24); // 40 * 0.6 = 24

            const third = manager.allocateChildBudget('root', 1);
            expect(third).toBe(9); // 16 * 0.6 = 9.6 → 9
        });

        it('canSpawnChild should not deduct budget (read-only check)', () => {
            manager.registerAgent(undefined, 'Root', 25);
            manager.startAgent('root');

            const result = manager.canSpawnChild('root');
            expect(result.allowed).toBe(true);

            // Budget should be unchanged after canSpawnChild
            const rootNode = manager.getNode('root')!;
            expect(rootNode.iterationBudget).toBe(25);
        });
    });

    describe('deduplication', () => {
        it('should track files examined by running agents', () => {
            manager.registerAgent(undefined, 'Root', 25);
            manager.startAgent('root');
            manager.completeAgent('root', [], ['file1.ts', 'file2.ts']);

            expect(manager.isFileAlreadyCovered('file1.ts')).toBe(true);
            expect(manager.isFileAlreadyCovered('file3.ts')).toBe(false);
        });

        it('should return all covered files', () => {
            manager.registerAgent(undefined, 'Root', 25);
            manager.startAgent('root');
            manager.completeAgent('root', [], ['a.ts', 'b.ts']);

            manager.registerAgent('root', 'Child', 10);
            manager.startAgent('child-1');
            manager.completeAgent('child-1', [], ['c.ts']);

            const covered = manager.getCoveredFiles();
            expect(covered).toEqual(new Set(['a.ts', 'b.ts', 'c.ts']));
        });

        it('should not include files from pending agents', () => {
            manager.registerAgent(undefined, 'Root', 25);
            // Root is still pending, not running/completed

            expect(manager.isFileAlreadyCovered('file1.ts')).toBe(false);
        });
    });

    describe('aggregation', () => {
        it('should collect findings from all agents', () => {
            manager.registerAgent(undefined, 'Root', 25);
            manager.startAgent('root');

            const rootFindings = [
                {
                    severity: 'high' as const,
                    category: 'security',
                    file: 'auth.ts',
                    line: 10,
                    title: 'Root finding',
                    description: 'Found by root',
                    confidence: 'verified' as const,
                    agentId: 'root',
                },
            ];
            manager.completeAgent('root', rootFindings, ['auth.ts']);

            manager.registerAgent('root', 'Child', 10);
            manager.startAgent('child-1');
            const childFindings = [
                {
                    severity: 'medium' as const,
                    category: 'logic',
                    file: 'service.ts',
                    line: 20,
                    title: 'Child finding',
                    description: 'Found by child',
                    confidence: 'likely' as const,
                    agentId: 'child-1',
                },
            ];
            manager.completeAgent('child-1', childFindings, ['service.ts']);

            const all = manager.getAllFindings();
            expect(all).toHaveLength(2);
            expect(all[0]!.agentId).toBe('root');
            expect(all[1]!.agentId).toBe('child-1');
        });

        it('should produce a readable tree summary', () => {
            manager.registerAgent(undefined, 'Root', 25);
            manager.startAgent('root');

            manager.registerAgent('root', 'Child 1', 10);
            manager.startAgent('child-1');
            manager.completeAgent('child-1', [], []);

            const summary = manager.getTreeSummary();
            expect(summary).toContain('root');
            expect(summary).toContain('child-1');
            expect(summary).toContain('[completed]');
        });

        it('should return message for empty tree', () => {
            const emptyManager = new RecursiveStateManager(2, 12, 25);
            expect(emptyManager.getTreeSummary()).toBe('No agents registered.');
        });
    });

    describe('getTotalAgentCount', () => {
        it('should track total agents across all depths', () => {
            expect(manager.getTotalAgentCount()).toBe(0);

            manager.registerAgent(undefined, 'Root', 25);
            expect(manager.getTotalAgentCount()).toBe(1);

            manager.registerAgent('root', 'Child 1', 10);
            manager.registerAgent('root', 'Child 2', 10);
            expect(manager.getTotalAgentCount()).toBe(3);
        });
    });

    describe('getDepthOf', () => {
        it('should return correct depth for each agent', () => {
            manager.registerAgent(undefined, 'Root', 25);
            manager.registerAgent('root', 'Child', 10);
            manager.registerAgent('child-1', 'Grandchild', 5);

            expect(manager.getDepthOf('root')).toBe(0);
            expect(manager.getDepthOf('child-1')).toBe(1);
            expect(manager.getDepthOf('child-1.1')).toBe(2);
        });

        it('should return 0 for unknown agent', () => {
            expect(manager.getDepthOf('nonexistent')).toBe(0);
        });
    });

    describe('getRemainingBudget', () => {
        it('should sum remaining budget of active agents', () => {
            manager.registerAgent(undefined, 'Root', 25);
            manager.startAgent('root');

            // Root has 25 budget, 0 used
            expect(manager.getRemainingBudget()).toBe(25);
        });

        it('should exclude completed agents', () => {
            manager.registerAgent(undefined, 'Root', 25);
            manager.startAgent('root');
            manager.completeAgent('root', [], []);

            expect(manager.getRemainingBudget()).toBe(0);
        });

        it('should cap at totalBudget', () => {
            // totalBudget=25 but register agents with more
            const tightManager = new RecursiveStateManager(2, 12, 25);
            tightManager.registerAgent(undefined, 'Root', 30);
            tightManager.startAgent('root');

            // Remaining would be 30 but capped at totalBudget=25
            expect(tightManager.getRemainingBudget()).toBe(25);
        });
    });

    describe('RecursionConstants', () => {
        it('should have sensible defaults', () => {
            expect(RecursionConstants.MIN_VIABLE_BUDGET).toBeGreaterThan(0);
            expect(RecursionConstants.ROOT_BUDGET_RATIO).toBeGreaterThan(0);
            expect(RecursionConstants.ROOT_BUDGET_RATIO).toBeLessThan(1);
            expect(RecursionConstants.CHILD_BUDGET_RATIO).toBeGreaterThan(0);
            expect(RecursionConstants.CHILD_BUDGET_RATIO).toBeLessThan(1);
        });
    });
});
