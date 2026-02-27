import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    RecursiveStateManager,
    RecursionConstants,
} from '../sessions/recursiveStateManager';
import { Log } from '../services/loggingService';

vi.mock('../services/loggingService', () => ({
    Log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}));

describe('RecursiveStateManager', () => {
    let manager: RecursiveStateManager;

    beforeEach(() => {
        // maxDepth=2
        manager = new RecursiveStateManager(2);
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

        it('should throw when registering a duplicate root agent', () => {
            manager.registerAgent(undefined, 'Root', 25);

            expect(() =>
                manager.registerAgent(undefined, 'Second root', 25)
            ).toThrow('Root agent already registered');
        });

        it('should warn and create orphaned child when parentId is unknown', () => {
            manager.registerAgent(undefined, 'Root', 25);

            // Should not throw, but child is orphaned (no parent link)
            const childId = manager.registerAgent(
                'nonexistent',
                'Orphaned child',
                10
            );

            // Child exists in tree
            const childNode = manager.getNode(childId);
            expect(childNode).toBeDefined();
            expect(childNode!.parentId).toBe('nonexistent');

            // But the root's childIds does NOT contain it (parent was not found)
            const rootNode = manager.getNode('root')!;
            expect(rootNode.childIds).not.toContain(childId);
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
            expect(manager.getNode('root')!.error).toBe('LLM error');
        });

        it('should handle cancellation state', () => {
            manager.startAgent('root');
            manager.cancelAgent('root');

            expect(manager.getNode('root')!.status).toBe('cancelled');
        });

        it('should ignore completeAgent on already-completed agent', () => {
            manager.startAgent('root');
            manager.completeAgent(
                'root',
                [
                    {
                        severity: 'high',
                        category: 'bug',
                        file: 'a.ts',
                        line: 1,
                        title: 'First',
                        description: '',
                        confidence: 'verified',
                        agentId: 'root',
                    },
                ],
                ['a.ts']
            );

            // Second complete should be ignored — findings stay from first call
            manager.completeAgent('root', [], ['b.ts']);
            expect(manager.getNode('root')!.status).toBe('completed');
            expect(manager.getNode('root')!.findings).toHaveLength(1);
            expect(manager.getNode('root')!.filesExamined).toEqual(['a.ts']);
        });

        it('should ignore failAgent on already-completed agent', () => {
            manager.startAgent('root');
            manager.completeAgent('root', [], []);

            manager.failAgent('root', 'late error');
            expect(manager.getNode('root')!.status).toBe('completed');
        });

        it('should ignore cancelAgent on already-failed agent', () => {
            manager.startAgent('root');
            manager.failAgent('root', 'error');

            manager.cancelAgent('root');
            expect(manager.getNode('root')!.status).toBe('failed');
        });

        it('should ignore completeAgent on already-cancelled agent', () => {
            manager.startAgent('root');
            manager.cancelAgent('root');

            manager.completeAgent('root', [], ['file.ts']);
            expect(manager.getNode('root')!.status).toBe('cancelled');
            expect(manager.getNode('root')!.filesExamined).toEqual([]);
        });

        it('should warn and ignore startAgent for unknown agentId', () => {
            manager.startAgent('nonexistent');
            expect(Log.warn).toHaveBeenCalledWith(
                expect.stringContaining('unknown agentId')
            );
        });

        it('should warn and ignore completeAgent for unknown agentId', () => {
            manager.completeAgent('nonexistent', [], ['file.ts']);
            expect(Log.warn).toHaveBeenCalledWith(
                expect.stringContaining('unknown agentId')
            );
        });

        it('should warn and ignore failAgent for unknown agentId', () => {
            manager.failAgent('nonexistent', 'some error');
            expect(Log.warn).toHaveBeenCalledWith(
                expect.stringContaining('unknown agentId')
            );
        });

        it('should warn and ignore cancelAgent for unknown agentId', () => {
            manager.cancelAgent('nonexistent');
            expect(Log.warn).toHaveBeenCalledWith(
                expect.stringContaining('unknown agentId')
            );
        });

        it('should ignore startAgent on already-completed agent', () => {
            manager.startAgent('root');
            manager.completeAgent('root', [], []);

            manager.startAgent('root');
            expect(manager.getNode('root')!.status).toBe('completed');
            expect(Log.warn).toHaveBeenCalledWith(
                expect.stringContaining('terminal state')
            );
        });

        it('should ignore startAgent on already-failed agent', () => {
            manager.startAgent('root');
            manager.failAgent('root', 'error');

            manager.startAgent('root');
            expect(manager.getNode('root')!.status).toBe('failed');
        });

        it('should ignore startAgent on already-cancelled agent', () => {
            manager.startAgent('root');
            manager.cancelAgent('root');

            manager.startAgent('root');
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
            const child1Id = manager.registerAgent('root', 'Child', 10);
            manager.startAgent(child1Id);
            const grandchildId = manager.registerAgent(
                'child-1',
                'Grandchild',
                5
            );
            manager.startAgent(grandchildId);

            // Depth 2 grandchild trying to spawn depth 3 → rejected
            const result = manager.canSpawnChild('child-1.1');
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('depth');
        });

        it('should allow spawning regardless of parent budget (independent model)', () => {
            // Independent budget model: parent's low budget doesn't prevent child spawn
            const lowBudgetManager = new RecursiveStateManager(2);
            lowBudgetManager.registerAgent(undefined, 'Root', 5);
            lowBudgetManager.startAgent('root');

            const result = lowBudgetManager.canSpawnChild('root');
            expect(result.allowed).toBe(true);
        });

        it('should reject for unknown parent', () => {
            const result = manager.canSpawnChild('nonexistent');
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('not found');
        });

        it('should reject spawning from non-running parent', () => {
            manager.completeAgent('root', [], []);
            const result = manager.canSpawnChild('root');
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('completed');
        });

        it('should reject spawning from failed parent', () => {
            manager.failAgent('root', 'some error');
            const result = manager.canSpawnChild('root');
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('failed');
        });

        it('should reject spawning from cancelled parent', () => {
            manager.cancelAgent('root');
            const result = manager.canSpawnChild('root');
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('cancelled');
        });

        it('should reject spawning from pending parent', () => {
            // Create a manager and register without starting
            const pendingManager = new RecursiveStateManager(2);
            pendingManager.registerAgent(undefined, 'Root', 25);
            // Don't call startAgent — parent stays 'pending'
            const result = pendingManager.canSpawnChild('root');
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('pending');
        });

        it('should reject when budget is below MIN_VIABLE_BUDGET', () => {
            // Spy on calculateChildBudget to return below-minimum budget
            const spy = vi
                .spyOn(manager, 'calculateChildBudget')
                .mockReturnValue(RecursionConstants.MIN_VIABLE_BUDGET - 1);

            const result = manager.canSpawnChild('root');
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('Insufficient budget');

            spy.mockRestore();
        });

        it('should allow spawning when budget equals MIN_VIABLE_BUDGET', () => {
            const spy = vi
                .spyOn(manager, 'calculateChildBudget')
                .mockReturnValue(RecursionConstants.MIN_VIABLE_BUDGET);

            const result = manager.canSpawnChild('root');
            expect(result.allowed).toBe(true);

            spy.mockRestore();
        });
    });

    describe('budget allocation', () => {
        it('should allocate up to DEFAULT_CHILD_BUDGET per child', () => {
            const bigManager = new RecursiveStateManager(2);
            bigManager.registerAgent(undefined, 'Root', 100);

            const budget = bigManager.allocateChildBudget('root');
            expect(budget).toBe(RecursionConstants.DEFAULT_CHILD_BUDGET);
        });

        it('should return DEFAULT_CHILD_BUDGET regardless of parent budget', () => {
            // Independent budget model: parent budget doesn't limit child budget
            const limitedManager = new RecursiveStateManager(2);
            limitedManager.registerAgent(undefined, 'Root', 15);

            const budget = limitedManager.allocateChildBudget('root');
            expect(budget).toBe(RecursionConstants.DEFAULT_CHILD_BUDGET);
        });

        it('should return 0 for unknown parent', () => {
            const budget = manager.allocateChildBudget('nonexistent');
            expect(budget).toBe(0);
        });

        it('should return DEFAULT_CHILD_BUDGET even when parent budget is low', () => {
            // Independent budget model: child gets its own budget
            const lowManager = new RecursiveStateManager(2);
            lowManager.registerAgent(undefined, 'Root', 5);

            const budget = lowManager.allocateChildBudget('root');
            expect(budget).toBe(RecursionConstants.DEFAULT_CHILD_BUDGET);
        });

        it('should NOT deduct allocated budget from parent (independent model)', () => {
            const bigManager = new RecursiveStateManager(2);
            bigManager.registerAgent(undefined, 'Root', 100);

            const budget = bigManager.allocateChildBudget('root');
            expect(budget).toBe(RecursionConstants.DEFAULT_CHILD_BUDGET);

            // Parent budget unchanged — independent budget model
            const rootNode = bigManager.getNode('root')!;
            expect(rootNode.iterationBudget).toBe(100);
        });

        it('should yield consistent budgets on repeated allocations (independent model)', () => {
            const bigManager = new RecursiveStateManager(2);
            bigManager.registerAgent(undefined, 'Root', 100);

            // Independent model: every allocation returns DEFAULT_CHILD_BUDGET
            const first = bigManager.allocateChildBudget('root');
            expect(first).toBe(RecursionConstants.DEFAULT_CHILD_BUDGET);

            const second = bigManager.allocateChildBudget('root');
            expect(second).toBe(RecursionConstants.DEFAULT_CHILD_BUDGET);

            const third = bigManager.allocateChildBudget('root');
            expect(third).toBe(RecursionConstants.DEFAULT_CHILD_BUDGET);

            // Parent budget unchanged
            const rootNode = bigManager.getNode('root')!;
            expect(rootNode.iterationBudget).toBe(100);
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

        it('should not include files from failed agents', () => {
            manager.registerAgent(undefined, 'Root', 25);
            manager.startAgent('root');
            manager.completeAgent('root', [], ['file1.ts']);

            const childId = manager.registerAgent('root', 'Child', 10);
            manager.startAgent(childId);
            // Child fails — its files should NOT be marked as covered
            manager.failAgent(childId, 'error');

            // Root's file is covered (completed), but child has no files since failAgent doesn't set them
            expect(manager.isFileAlreadyCovered('file1.ts')).toBe(true);

            const covered = manager.getCoveredFiles();
            expect(covered).toEqual(new Set(['file1.ts']));
        });

        it('should not include files from cancelled agents', () => {
            manager.registerAgent(undefined, 'Root', 25);
            manager.startAgent('root');
            manager.completeAgent('root', [], ['a.ts']);

            const childId = manager.registerAgent('root', 'Child', 10);
            manager.startAgent(childId);
            manager.cancelAgent(childId);

            // Only completed agent's files counted
            const covered = manager.getCoveredFiles();
            expect(covered).toEqual(new Set(['a.ts']));
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
            const emptyManager = new RecursiveStateManager(2);
            expect(emptyManager.getTreeSummary()).toBe('No agents registered.');
        });

        it('should order nodes by depth then agentId', () => {
            const deepManager = new RecursiveStateManager(3);
            deepManager.registerAgent(undefined, 'Root', 100);
            deepManager.startAgent('root');

            // Register children in reverse alphabetical order
            deepManager.registerAgent('root', 'Child B', 30);
            deepManager.startAgent('child-2');
            deepManager.registerAgent('root', 'Child A', 30);
            deepManager.startAgent('child-1');

            // Register grandchild under child-2
            deepManager.registerAgent('child-2', 'Grandchild', 10);
            deepManager.startAgent('child-2.1');

            const summary = deepManager.getTreeSummary();
            const lines = summary.split('\n');

            // Depth 0 first, then depth 1 (sorted by id), then depth 2
            expect(lines[0]).toContain('root');
            expect(lines[1]).toContain('child-1');
            expect(lines[2]).toContain('child-2');
            expect(lines[3]).toContain('child-2.1');
        });

        it('should include error reason for failed agents', () => {
            manager.startAgent('root');
            manager.registerAgent('root', 'Child task', 10);
            manager.startAgent('child-1');
            manager.failAgent('child-1', 'Rate limit exceeded');

            const summary = manager.getTreeSummary();
            expect(summary).toContain('[failed]');
            expect(summary).toContain('error: Rate limit exceeded');
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

        it('should return actual sum without totalBudget cap (independent model)', () => {
            // Independent budget model: no global budget cap
            const tightManager = new RecursiveStateManager(2);
            tightManager.registerAgent(undefined, 'Root', 30);
            tightManager.startAgent('root');

            // Remaining is 30 — no cap applied with independent budgets
            expect(tightManager.getRemainingBudget()).toBe(30);
        });
    });

    describe('RecursionConstants', () => {
        it('should have sensible defaults', () => {
            expect(RecursionConstants.MIN_VIABLE_BUDGET).toBeGreaterThan(0);
            expect(RecursionConstants.DEFAULT_CHILD_BUDGET).toBeGreaterThan(
                RecursionConstants.MIN_VIABLE_BUDGET
            );
        });
    });
});
