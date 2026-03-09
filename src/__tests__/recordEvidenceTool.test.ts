import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RecordEvidenceTool } from '../tools/recordEvidenceTool';
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

describe('RecordEvidenceTool', () => {
    let tool: RecordEvidenceTool;

    beforeEach(() => {
        vi.clearAllMocks();
        tool = new RecordEvidenceTool();
    });

    it('should have correct name', () => {
        expect(tool.name).toBe('record_evidence');
    });

    it('records evidence to ledger and returns success', async () => {
        const ledger = new EvidenceLedger();
        const ctx = createMockExecutionContext({
            evidenceLedger: ledger,
            currentAgentId: 'agent-1',
        });

        const result = await tool.execute(
            {
                category: 'type_constraint',
                file: 'src/handler.ts',
                symbol: 'processRequest',
                line: 15,
                claim: 'Function accepts Request | undefined',
                raw_snippet:
                    'function processRequest(req: Request | undefined)',
                confidence: 'high',
                source: 'tool_result',
            },
            ctx
        );

        expect(result.success).toBe(true);
        expect(result.data).toContain('Evidence recorded');
        expect(result.data).toContain('type_constraint');
        expect(result.data).toContain('Function accepts Request | undefined');
        expect(ledger.size).toBe(1);
    });

    it('returns error when no evidenceLedger in context', async () => {
        const ctx = createMockExecutionContext({
            evidenceLedger: undefined,
        });

        const result = await tool.execute(
            {
                category: 'behavior_observation',
                file: 'src/foo.ts',
                claim: 'Something observed',
                confidence: 'medium',
                source: 'observation',
            },
            ctx
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('Evidence ledger not available');
    });

    it('passes correct arguments to ledger', async () => {
        const ledger = new EvidenceLedger();
        const recordSpy = vi.spyOn(ledger, 'record');
        const ctx = createMockExecutionContext({
            evidenceLedger: ledger,
            currentAgentId: 'child-1',
        });

        await tool.execute(
            {
                category: 'caller_pattern',
                file: 'src/service.ts',
                symbol: 'init',
                line: 42,
                claim: 'Called from 3 places',
                raw_snippet: 'init()',
                confidence: 'high',
                source: 'lsp_query',
            },
            ctx
        );

        expect(recordSpy).toHaveBeenCalledWith({
            agentId: 'child-1',
            category: 'caller_pattern',
            file: 'src/service.ts',
            symbol: 'init',
            line: 42,
            claim: 'Called from 3 places',
            rawSnippet: 'init()',
            confidence: 'high',
            source: 'lsp_query',
        });
    });

    it('uses "unknown" agentId when currentAgentId is not set', async () => {
        const ledger = new EvidenceLedger();
        const recordSpy = vi.spyOn(ledger, 'record');
        const ctx = createMockExecutionContext({
            evidenceLedger: ledger,
        });

        await tool.execute(
            {
                category: 'api_contract',
                file: 'src/api.ts',
                claim: 'Returns 404 on missing',
                confidence: 'low',
                source: 'observation',
            },
            ctx
        );

        expect(recordSpy).toHaveBeenCalledWith(
            expect.objectContaining({ agentId: 'unknown' })
        );
    });

    it('handles optional fields as undefined', async () => {
        const ledger = new EvidenceLedger();
        const recordSpy = vi.spyOn(ledger, 'record');
        const ctx = createMockExecutionContext({
            evidenceLedger: ledger,
            currentAgentId: 'root',
        });

        await tool.execute(
            {
                category: 'design_intent',
                file: 'src/core.ts',
                claim: 'Module is intentionally stateless',
                confidence: 'medium',
                source: 'observation',
            },
            ctx
        );

        expect(recordSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                symbol: undefined,
                line: undefined,
                rawSnippet: undefined,
            })
        );
    });
});
