import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { ThinkAboutCompletionTool } from '../tools/thinkAboutCompletionTool';
import {
    createMockExecutionContext,
    createCancelledExecutionContext,
} from './testUtils/mockFactories';
import { FindingStore } from '../sessions/findingStore';
import { ReasoningChain } from '../sessions/reasoningChain';

vi.mock('../services/loggingService', () => ({
    Log: {
        info: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
    },
}));

describe('ThinkAboutCompletionTool', () => {
    let tool: ThinkAboutCompletionTool;

    beforeEach(() => {
        vi.clearAllMocks();
        tool = new ThinkAboutCompletionTool();
    });

    describe('metadata', () => {
        it('should have correct tool name', () => {
            expect(tool.name).toBe('think_about_completion');
        });

        it('should have schema', () => {
            expect(tool.schema).toBeDefined();
        });
    });

    describe('execute', () => {
        it('should return success with coverage stats', async () => {
            const result = await tool.execute(
                {
                    summary_draft:
                        'This PR adds authentication middleware for API routes.',
                    issues_count: 2,
                    files_analyzed: ['src/auth.ts', 'src/handler.ts'],
                    files_in_diff: 2,
                    recommendation: 'request_changes',
                },
                createMockExecutionContext()
            );

            expect(result.success).toBe(true);
            expect(result.data).toContain('2/2 files (100%)');
            expect(result.data).toContain('2 issue(s)');
            expect(result.data).toContain('request_changes');
        });

        it('should warn about uncovered files', async () => {
            const result = await tool.execute(
                {
                    summary_draft:
                        'This PR adds new feature with multiple files changed.',
                    issues_count: 0,
                    files_analyzed: ['src/auth.ts'],
                    files_in_diff: 3,
                    recommendation: 'approve',
                },
                createMockExecutionContext()
            );

            expect(result.success).toBe(true);
            expect(result.data).toContain('2 file(s) uncovered');
        });

        it('should throw CancellationError when cancelled', async () => {
            await expect(
                tool.execute(
                    {
                        summary_draft: 'Draft summary for cancellation test.',
                        issues_count: 0,
                        files_analyzed: ['src/test.ts'],
                        files_in_diff: 1,
                        recommendation: 'approve',
                    },
                    createCancelledExecutionContext()
                )
            ).rejects.toThrow(vscode.CancellationError);
        });
    });

    describe('investigation cross-reference', () => {
        it('should detect files claimed but never investigated', async () => {
            const ctx = createMockExecutionContext({
                investigatedFiles: new Set(['src/auth.ts']),
            });

            const result = await tool.execute(
                {
                    summary_draft: 'Reviewed all files in this PR.',
                    issues_count: 0,
                    files_analyzed: [
                        'src/auth.ts',
                        'src/handler.ts',
                        'src/utils.ts',
                    ],
                    files_in_diff: 3,
                    recommendation: 'approve',
                },
                ctx
            );

            expect(result.success).toBe(true);
            expect(result.data).toContain('INVESTIGATION GAP');
            expect(result.data).toContain('src/handler.ts');
            expect(result.data).toContain('src/utils.ts');
        });

        it('should not warn when all claimed files were investigated', async () => {
            const ctx = createMockExecutionContext({
                investigatedFiles: new Set(['src/auth.ts', 'src/handler.ts']),
            });

            const result = await tool.execute(
                {
                    summary_draft: 'Reviewed both changed files.',
                    issues_count: 1,
                    files_analyzed: ['src/auth.ts', 'src/handler.ts'],
                    files_in_diff: 2,
                    recommendation: 'request_changes',
                },
                ctx
            );

            expect(result.success).toBe(true);
            expect(result.data).not.toContain('INVESTIGATION GAP');
        });

        it('should handle path suffix matching', async () => {
            const ctx = createMockExecutionContext({
                investigatedFiles: new Set(['project/src/auth.ts']),
            });

            const result = await tool.execute(
                {
                    summary_draft: 'Reviewed auth file.',
                    issues_count: 0,
                    files_analyzed: ['src/auth.ts'],
                    files_in_diff: 1,
                    recommendation: 'approve',
                },
                ctx
            );

            expect(result.success).toBe(true);
            expect(result.data).not.toContain('INVESTIGATION GAP');
        });

        it('should skip cross-reference when investigatedFiles is empty', async () => {
            const ctx = createMockExecutionContext({
                investigatedFiles: new Set(),
            });

            const result = await tool.execute(
                {
                    summary_draft: 'Reviewed the file.',
                    issues_count: 0,
                    files_analyzed: ['src/auth.ts'],
                    files_in_diff: 1,
                    recommendation: 'approve',
                },
                ctx
            );

            expect(result.success).toBe(true);
            expect(result.data).not.toContain('INVESTIGATION GAP');
        });
    });

    describe('FindingStore integration', () => {
        it('should include Chain-of-Verification when findings exist', async () => {
            const store = new FindingStore();
            store.record({
                agentId: 'child-1',
                severity: 'HIGH',
                category: 'logic_error',
                title: 'Null dereference in auth handler',
                file: 'src/auth.ts',
                lineRange: [42, 42],
                description:
                    'The auth handler dereferences user without null check after DB query.',
                supportingToolCalls: [],
                disproof: {
                    attempted: true,
                    method: 'Checked callers with find_usages',
                    result: 'All callers pass potentially null value',
                },
                verifiableClaims: [],
            });

            const ctx = createMockExecutionContext({ findingStore: store });

            const result = await tool.execute(
                {
                    summary_draft: 'Found null dereference issue.',
                    issues_count: 1,
                    files_analyzed: ['src/auth.ts'],
                    files_in_diff: 1,
                    recommendation: 'request_changes',
                },
                ctx
            );

            expect(result.success).toBe(true);
            expect(result.data).toContain('CHAIN-OF-VERIFICATION');
            expect(result.data).toContain('Null dereference in auth handler');
            expect(result.data).toContain('KEEP or RETRACT');
        });

        it('should not include Chain-of-Verification when no findings', async () => {
            const store = new FindingStore();
            const ctx = createMockExecutionContext({ findingStore: store });

            const result = await tool.execute(
                {
                    summary_draft: 'No issues found.',
                    issues_count: 0,
                    files_analyzed: ['src/auth.ts'],
                    files_in_diff: 1,
                    recommendation: 'approve',
                },
                ctx
            );

            expect(result.success).toBe(true);
            expect(result.data).not.toContain('CHAIN-OF-VERIFICATION');
        });
    });

    describe('hypothesis trail integration', () => {
        it('includes hypothesis trail when reasoningChain has hypotheses', async () => {
            const chain = new ReasoningChain();
            chain.addCheckpoint('auth review', [
                'timing attack in login',
                'missing null check',
            ]);
            chain.recordToolCall('read_file');
            chain.markConfirmed(1, 'found issue');
            chain.markDismissed(2, 'all callers handle it');

            const ctx = createMockExecutionContext({ reasoningChain: chain });

            const result = await tool.execute(
                {
                    summary_draft: 'Found timing attack issue in login flow.',
                    issues_count: 1,
                    files_analyzed: ['src/auth.ts'],
                    files_in_diff: 1,
                    recommendation: 'request_changes',
                },
                ctx
            );

            expect(result.success).toBe(true);
            expect(result.data).toContain('Hypothesis Trail');
            expect(result.data).toContain('1 confirmed');
            expect(result.data).toContain('1 dismissed');
        });
    });
});
