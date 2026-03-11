import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RecordFindingTool } from '../tools/recordFindingTool';
import { createMockExecutionContext } from './testUtils/mockFactories';
import { FindingStore } from '../sessions/findingStore';

vi.mock('../services/loggingService', () => ({
    Log: {
        info: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
    },
}));

const BASE_FINDING_ARGS = {
    severity: 'HIGH' as const,
    category: 'error_handling_gap' as const,
    title: 'Missing error handler',
    file: 'src/api.ts',
    line: 15,
    description: 'The catch block is empty and swallows errors silently.',
    verification_evidence:
        'search_for_pattern(catch, src/api.ts) showed empty catch block at line 15 with no logging or rethrow',
    disproof_note:
        'Checked if error is logged elsewhere — no other error handling found',
};

describe('RecordFindingTool', () => {
    let tool: RecordFindingTool;

    beforeEach(() => {
        vi.clearAllMocks();
        tool = new RecordFindingTool();
    });

    it('should have correct name', () => {
        expect(tool.name).toBe('record_finding');
    });

    it('records finding to store and returns success with finding id', async () => {
        const store = new FindingStore();
        const ctx = createMockExecutionContext({
            findingStore: store,
            currentAgentId: 'root',
        });

        const result = await tool.execute(BASE_FINDING_ARGS, ctx);

        expect(result.success).toBe(true);
        expect(result.data).toContain('Finding recorded');
        expect(result.data).toContain('finding-');
        expect(result.data).toContain('HIGH');
        expect(result.data).toContain('Missing error handler');
        expect(store.size).toBe(1);
    });

    it('returns error when no findingStore in context', async () => {
        const ctx = createMockExecutionContext({
            findingStore: undefined,
        });

        const result = await tool.execute(BASE_FINDING_ARGS, ctx);

        expect(result.success).toBe(false);
        expect(result.error).toContain('Finding store not available');
    });

    it('passes correct arguments to store with defaults', async () => {
        const store = new FindingStore();
        const recordSpy = vi.spyOn(store, 'record');
        const ctx = createMockExecutionContext({
            findingStore: store,
            currentAgentId: 'child-1',
        });

        await tool.execute(BASE_FINDING_ARGS, ctx);

        expect(recordSpy).toHaveBeenCalledWith({
            agentId: 'child-1',
            severity: 'HIGH',
            category: 'error_handling_gap',
            title: 'Missing error handler',
            file: 'src/api.ts',
            lineRange: [15, 15],
            description:
                'The catch block is empty and swallows errors silently.',
            supportingToolCalls: [],
            disproof: {
                attempted: true,
                method: 'Checked if error is logged elsewhere — no other error handling found',
                result: 'Checked if error is logged elsewhere — no other error handling found',
            },
            verifiableClaims: [],
        });
    });

    it('always sets disproof.attempted=true since disproof_note is required', async () => {
        const store = new FindingStore();
        const recordSpy = vi.spyOn(store, 'record');
        const ctx = createMockExecutionContext({
            findingStore: store,
            currentAgentId: 'root',
        });

        await tool.execute(BASE_FINDING_ARGS, ctx);

        expect(recordSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                disproof: expect.objectContaining({ attempted: true }),
            })
        );
    });

    it('uses "unknown" agentId when currentAgentId is not set', async () => {
        const store = new FindingStore();
        const recordSpy = vi.spyOn(store, 'record');
        const ctx = createMockExecutionContext({ findingStore: store });

        await tool.execute(BASE_FINDING_ARGS, ctx);

        expect(recordSpy).toHaveBeenCalledWith(
            expect.objectContaining({ agentId: 'unknown' })
        );
    });
});
