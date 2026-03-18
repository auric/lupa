import { describe, it, expect, beforeEach } from 'vitest';
import { ListFindingsTool } from '../tools/listFindingsTool';
import { FindingStore } from '../sessions/findingStore';
import { createMockExecutionContext } from './testUtils/mockFactories';
import type { ExecutionContext } from '../types/executionContext';

describe('ListFindingsTool', () => {
    let tool: ListFindingsTool;
    let store: FindingStore;
    let context: ExecutionContext;

    beforeEach(() => {
        tool = new ListFindingsTool();
        store = new FindingStore();
        context = {
            ...createMockExecutionContext(),
            findingStore: store,
        };
    });

    it('has correct name and description', () => {
        expect(tool.name).toBe('list_findings');
        expect(tool.description).toContain('List findings');
    });

    it('returns empty message when no findings exist', async () => {
        const result = await tool.execute({}, context);
        expect(result.data).toContain('No findings recorded yet');
        expect(result.data).toContain('investigate your assigned files');
    });

    it('returns empty message with file filter', async () => {
        const result = await tool.execute({ file: 'src/foo.ts' }, context);
        expect(result.data).toContain('No findings recorded yet');
        expect(result.data).toContain('src/foo.ts');
    });

    it('lists all findings when no filter', async () => {
        store.record({
            agentId: 'agent-1',
            severity: 'HIGH',
            category: 'logic_error',
            title: 'Wrong return value in parseConfig',
            file: 'src/config.ts',
            lineRange: [10, 15],
            description: 'parseConfig returns undefined instead of default',
            affectedComponent: 'parseConfig',
            failureMechanism: 'wrong_return_value',
            supportingToolCalls: ['find_symbol'],
            disproof: {
                attempted: true,
                method: 'checked callers',
                result: 'confirmed',
            },
            verifiableClaims: [],
        });
        store.record({
            agentId: 'agent-2',
            severity: 'MEDIUM',
            category: 'error_handling_gap',
            title: 'Unhandled rejection in fetchData',
            file: 'src/api.ts',
            lineRange: [42, 42],
            description: 'fetchData does not catch network errors',
            affectedComponent: 'fetchData',
            failureMechanism: 'runtime_exception',
            supportingToolCalls: ['find_usages'],
            disproof: {
                attempted: true,
                method: 'traced callers',
                result: 'no outer catch',
            },
            verifiableClaims: [],
        });

        const result = await tool.execute({}, context);
        expect(result.data).toContain('2 finding(s)');
        expect(result.data).toContain('Wrong return value in parseConfig');
        expect(result.data).toContain('Unhandled rejection in fetchData');
        expect(result.data).toContain('src/config.ts');
        expect(result.data).toContain('src/api.ts');
        expect(result.data).toContain('agent-1');
        expect(result.data).toContain('agent-2');
    });

    it('filters findings by file', async () => {
        store.record({
            agentId: 'agent-1',
            severity: 'HIGH',
            category: 'logic_error',
            title: 'Bug in config',
            file: 'src/config.ts',
            lineRange: [10, 15],
            description: 'desc',
            affectedComponent: 'parseConfig',
            failureMechanism: 'wrong_return_value',
            supportingToolCalls: [],
            disproof: { attempted: false, method: '', result: '' },
            verifiableClaims: [],
        });
        store.record({
            agentId: 'agent-2',
            severity: 'MEDIUM',
            category: 'error_handling_gap',
            title: 'Bug in api',
            file: 'src/api.ts',
            lineRange: [42, 42],
            description: 'desc',
            affectedComponent: 'fetchData',
            failureMechanism: 'runtime_exception',
            supportingToolCalls: [],
            disproof: { attempted: false, method: '', result: '' },
            verifiableClaims: [],
        });

        const result = await tool.execute({ file: 'src/config.ts' }, context);
        expect(result.data).toContain('1 finding(s)');
        expect(result.data).toContain('Bug in config');
        expect(result.data).not.toContain('Bug in api');
    });

    it('filters findings by severity', async () => {
        store.record({
            agentId: 'agent-1',
            severity: 'HIGH',
            category: 'logic_error',
            title: 'High bug',
            file: 'src/config.ts',
            lineRange: [10, 15],
            description: 'desc',
            affectedComponent: 'comp',
            failureMechanism: 'wrong_return_value',
            supportingToolCalls: [],
            disproof: { attempted: false, method: '', result: '' },
            verifiableClaims: [],
        });
        store.record({
            agentId: 'agent-2',
            severity: 'LOW',
            category: 'logic_error',
            title: 'Low bug',
            file: 'src/api.ts',
            lineRange: [42, 42],
            description: 'desc',
            affectedComponent: 'comp',
            failureMechanism: 'wrong_return_value',
            supportingToolCalls: [],
            disproof: { attempted: false, method: '', result: '' },
            verifiableClaims: [],
        });

        const result = await tool.execute({ severity: 'HIGH' }, context);
        expect(result.data).toContain('1 finding(s)');
        expect(result.data).toContain('High bug');
        expect(result.data).not.toContain('Low bug');
    });

    it('returns error when finding store not available', async () => {
        const noStoreContext = {
            ...createMockExecutionContext(),
            findingStore: undefined,
        } as unknown as ExecutionContext;

        const result = await tool.execute({}, noStoreContext);
        expect(result.success).toBe(false);
        expect(result.error).toContain('Finding store not available');
    });

    it('includes compact summary with key fields', async () => {
        store.record({
            agentId: 'subagent-3',
            severity: 'CRITICAL',
            category: 'security_vulnerability',
            title: 'SQL injection in query builder',
            file: 'src/db.ts',
            lineRange: [100, 110],
            description: 'Unparameterized query',
            affectedComponent: 'buildQuery',
            failureMechanism: 'security_bypass',
            supportingToolCalls: ['search_for_pattern'],
            disproof: {
                attempted: true,
                method: 'checked inputs',
                result: 'user input reaches query',
            },
            verifiableClaims: [],
        });

        const result = await tool.execute({}, context);
        expect(result.data).toContain('CRITICAL');
        expect(result.data).toContain('SQL injection in query builder');
        expect(result.data).toContain('src/db.ts:100');
        expect(result.data).toContain('security_vulnerability');
        expect(result.data).toContain('buildQuery');
        expect(result.data).toContain('subagent-3');
    });
});
