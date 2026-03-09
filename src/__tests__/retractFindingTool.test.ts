import { describe, it, expect, beforeEach } from 'vitest';
import { RetractFindingTool } from '../tools/retractFindingTool';
import { FindingStore } from '../sessions/findingStore';
import { createMockExecutionContext } from './testUtils/mockFactories';
import type { ExecutionContext } from '../types/executionContext';

describe('RetractFindingTool', () => {
    let tool: RetractFindingTool;
    let store: FindingStore;
    let context: ExecutionContext;

    beforeEach(() => {
        tool = new RetractFindingTool();
        store = new FindingStore();
        context = {
            ...createMockExecutionContext(),
            findingStore: store,
        };
    });

    it('has correct name and description', () => {
        expect(tool.name).toBe('retract_finding');
        expect(tool.description).toContain(
            'Remove a previously recorded finding'
        );
    });

    it('retracts an existing finding', async () => {
        const recorded = store.record({
            agentId: 'root',
            severity: 'HIGH',
            category: 'error-handling',
            title: 'Missing error handler',
            file: 'src/foo.ts',
            lineRange: [10, 20],
            description: 'No error handling',
            supportingToolCalls: ['read_file'],
            disproof: {
                attempted: true,
                method: 'checked',
                result: 'still valid',
            },
            verifiableClaims: [],
        });

        expect(store.size).toBe(1);

        const result = await tool.execute(
            {
                finding_id: recorded.id,
                reason: 'False positive after reading broader context',
            },
            context
        );

        expect(result.success).toBe(true);
        expect(result.data).toContain('Retracted');
        expect(result.data).toContain(recorded.id);
        expect(result.data).toContain('Missing error handler');
        expect(store.size).toBe(0);
    });

    it('returns error for non-existent finding', async () => {
        const result = await tool.execute(
            { finding_id: 'finding-999', reason: 'wrong' },
            context
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('not found');
    });

    it('returns error when finding store is not available', async () => {
        const noStoreContext = createMockExecutionContext();

        const result = await tool.execute(
            { finding_id: 'finding-1', reason: 'wrong' },
            noStoreContext
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('not available');
    });

    it('only removes the targeted finding', async () => {
        store.record({
            agentId: 'root',
            severity: 'HIGH',
            category: 'security',
            title: 'SQL injection',
            file: 'src/db.ts',
            lineRange: [1, 5],
            description: 'Possible SQL injection',
            supportingToolCalls: ['read_file'],
            disproof: { attempted: true, method: 'checked', result: 'valid' },
            verifiableClaims: [],
        });

        const toRetract = store.record({
            agentId: 'root',
            severity: 'LOW',
            category: 'style',
            title: 'Naming convention',
            file: 'src/utils.ts',
            lineRange: [10, 12],
            description: 'Bad name',
            supportingToolCalls: [],
            disproof: { attempted: false, method: '', result: '' },
            verifiableClaims: [],
        });

        await tool.execute(
            { finding_id: toRetract.id, reason: 'Not actually a problem' },
            context
        );

        expect(store.size).toBe(1);
        expect(store.getAll()[0]!.title).toBe('SQL injection');
    });
});
