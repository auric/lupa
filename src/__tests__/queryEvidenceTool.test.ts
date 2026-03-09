import { describe, it, expect, beforeEach, vi } from 'vitest';
import { QueryEvidenceTool } from '../tools/queryEvidenceTool';
import { createMockExecutionContext } from './testUtils/mockFactories';
import { EvidenceLedger } from '../sessions/evidenceLedger';

vi.mock('../services/loggingService', () => ({
    Log: {
        info: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
    },
}));

describe('QueryEvidenceTool', () => {
    let tool: QueryEvidenceTool;

    beforeEach(() => {
        vi.clearAllMocks();
        tool = new QueryEvidenceTool();
    });

    it('should have correct name', () => {
        expect(tool.name).toBe('query_evidence');
    });

    it('returns matching evidence from ledger', async () => {
        const ledger = new EvidenceLedger();
        ledger.record({
            agentId: 'agent-1',
            category: 'type_constraint',
            file: 'src/handler.ts',
            symbol: 'process',
            line: 10,
            claim: 'Param is nullable',
            rawSnippet: 'param: string | null',
            confidence: 'high',
            source: 'lsp_query',
        });
        ledger.record({
            agentId: 'agent-2',
            category: 'error_handling',
            file: 'src/other.ts',
            symbol: undefined,
            line: undefined,
            claim: 'No error handling',
            rawSnippet: undefined,
            confidence: 'medium',
            source: 'observation',
        });

        const ctx = createMockExecutionContext({ evidenceLedger: ledger });

        const result = await tool.execute({ file: 'src/handler.ts' }, ctx);

        expect(result.success).toBe(true);
        expect(result.data).toContain('Found 1 evidence entries');
        expect(result.data).toContain('Param is nullable');
        expect(result.data).not.toContain('No error handling');
    });

    it('returns "no evidence" message when none found', async () => {
        const ledger = new EvidenceLedger();
        const ctx = createMockExecutionContext({ evidenceLedger: ledger });

        const result = await tool.execute({ file: 'src/nonexistent.ts' }, ctx);

        expect(result.success).toBe(true);
        expect(result.data).toContain('No evidence entries match');
    });

    it('returns error when no evidenceLedger in context', async () => {
        const ctx = createMockExecutionContext({
            evidenceLedger: undefined,
        });

        const result = await tool.execute({}, ctx);

        expect(result.success).toBe(false);
        expect(result.error).toContain('Evidence ledger not available');
    });

    it('passes correct query to ledger', async () => {
        const ledger = new EvidenceLedger();
        const querySpy = vi.spyOn(ledger, 'query');
        const ctx = createMockExecutionContext({ evidenceLedger: ledger });

        await tool.execute(
            {
                file: 'src/a.ts',
                symbol: 'myFn',
                category: 'caller_pattern',
                text: 'search term',
            },
            ctx
        );

        expect(querySpy).toHaveBeenCalledWith({
            file: 'src/a.ts',
            symbol: 'myFn',
            category: 'caller_pattern',
            agentId: undefined,
            text: 'search term',
        });
    });

    it('formats evidence entries with snippets', async () => {
        const ledger = new EvidenceLedger();
        ledger.record({
            agentId: 'root',
            category: 'api_contract',
            file: 'src/api.ts',
            symbol: 'getUser',
            line: 25,
            claim: 'Returns User | null',
            rawSnippet: 'async function getUser(): Promise<User | null>',
            confidence: 'high',
            source: 'tool_result',
        });
        const ctx = createMockExecutionContext({ evidenceLedger: ledger });

        const result = await tool.execute({}, ctx);

        expect(result.data).toContain('(root)');
        expect(result.data).toContain('api_contract');
        expect(result.data).toContain('src/api.ts');
        expect(result.data).toContain(':getUser');
        expect(result.data).toContain(':L25');
        expect(result.data).toContain('Returns User | null');
        expect(result.data).toContain(
            'async function getUser(): Promise<User | null>'
        );
    });

    it('formats entries without optional fields', async () => {
        const ledger = new EvidenceLedger();
        ledger.record({
            agentId: 'agent-1',
            category: 'design_intent',
            file: 'src/core.ts',
            symbol: undefined,
            line: undefined,
            claim: 'Module is stateless',
            rawSnippet: undefined,
            confidence: 'medium',
            source: 'observation',
        });
        const ctx = createMockExecutionContext({ evidenceLedger: ledger });

        const result = await tool.execute({}, ctx);

        expect(result.data).toContain('Module is stateless');
        expect(result.data).not.toContain(':undefined');
        expect(result.data).not.toContain('```');
    });
});
