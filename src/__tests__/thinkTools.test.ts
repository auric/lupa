import { describe, it, expect, beforeEach } from 'vitest';
import { ThinkAboutCompletionTool } from '../tools/thinkAboutCompletionTool';
import { createMockExecutionContext } from './testUtils/mockFactories';

describe('ThinkAboutCompletionTool', () => {
    let tool: ThinkAboutCompletionTool;

    beforeEach(() => {
        tool = new ThinkAboutCompletionTool();
    });

    describe('Tool Configuration', () => {
        it('should have correct name', () => {
            expect(tool.name).toBe('think_about_completion');
        });

        it('should have meaningful description', () => {
            expect(tool.description).toContain('checkpoint');
            expect(tool.description).toContain('submit_review');
        });

        it('should generate valid VS Code tool configuration', () => {
            const vscodeTool = tool.getVSCodeTool();
            expect(vscodeTool.name).toBe('think_about_completion');
            expect(vscodeTool.description).toBeDefined();
        });
    });

    describe('Schema Validation', () => {
        it('should accept valid input with all required fields', () => {
            const parsed = tool.schema.safeParse({
                summary_draft:
                    'This PR adds authentication support with OAuth2 integration.',
                issues_count: 1,
                files_analyzed: ['src/auth.ts', 'src/oauth.ts'],
                files_in_diff: 3,
                recommendation: 'approve_with_suggestions',
            });
            expect(parsed.success).toBe(true);
        });

        it('should reject summary_draft shorter than 20 characters', () => {
            const parsed = tool.schema.safeParse({
                summary_draft: 'Too short',
                issues_count: 0,
                files_analyzed: ['src/file.ts'],
                files_in_diff: 1,
                recommendation: 'approve',
            });
            expect(parsed.success).toBe(false);
        });

        it('should reject empty files_analyzed array', () => {
            const parsed = tool.schema.safeParse({
                summary_draft: 'This is a valid summary that is long enough.',
                issues_count: 0,
                files_analyzed: [],
                files_in_diff: 1,
                recommendation: 'approve',
            });
            expect(parsed.success).toBe(false);
        });

        it('should reject files_in_diff less than 1', () => {
            const parsed = tool.schema.safeParse({
                summary_draft: 'This is a valid summary that is long enough.',
                issues_count: 0,
                files_analyzed: ['src/file.ts'],
                files_in_diff: 0,
                recommendation: 'approve',
            });
            expect(parsed.success).toBe(false);
        });

        it('should reject negative issue counts', () => {
            const parsed = tool.schema.safeParse({
                summary_draft: 'This is a valid summary that is long enough.',
                issues_count: -1,
                files_analyzed: ['src/file.ts'],
                files_in_diff: 1,
                recommendation: 'approve',
            });
            expect(parsed.success).toBe(false);
        });

        it('should accept all valid recommendation values', () => {
            const recommendations = [
                'approve',
                'approve_with_suggestions',
                'request_changes',
                'block_merge',
            ];
            for (const recommendation of recommendations) {
                const parsed = tool.schema.safeParse({
                    summary_draft:
                        'This is a valid summary that is long enough.',
                    issues_count: 0,
                    files_analyzed: ['src/file.ts'],
                    files_in_diff: 1,
                    recommendation,
                });
                expect(parsed.success).toBe(true);
            }
        });

        it('should reject missing required fields', () => {
            const parsed = tool.schema.safeParse({});
            expect(parsed.success).toBe(false);
        });

        it('should reject unexpected parameters in strict mode', () => {
            const parsed = tool.schema.safeParse({
                summary_draft: 'This is a valid summary that is long enough.',
                issues_count: 0,
                files_analyzed: ['src/file.ts'],
                files_in_diff: 1,
                recommendation: 'approve',
                extra: 'not allowed',
            });
            expect(parsed.success).toBe(false);
        });
    });

    describe('Execution', () => {
        it('should return guidance reflecting summary draft', async () => {
            const result = await tool.execute(
                {
                    summary_draft:
                        'This PR refactors the authentication module for better security.',
                    issues_count: 0,
                    files_analyzed: ['src/auth.ts'],
                    files_in_diff: 1,
                    recommendation: 'approve',
                },
                createMockExecutionContext()
            );

            expect(result.success).toBe(true);
            expect(result.data).toContain('Reflection recorded');
            expect(result.data).toContain('0 issue(s)');
        });

        it('should show issue count', async () => {
            const result = await tool.execute(
                {
                    summary_draft:
                        'This PR has some issues that need to be addressed.',
                    issues_count: 5,
                    files_analyzed: ['src/auth.ts', 'src/api.ts'],
                    files_in_diff: 2,
                    recommendation: 'request_changes',
                },
                createMockExecutionContext()
            );

            expect(result.success).toBe(true);
            expect(result.data).toContain('5 issue(s)');
        });

        it('should calculate and show coverage percentage', async () => {
            const result = await tool.execute(
                {
                    summary_draft:
                        'Partial review of the authentication changes.',
                    issues_count: 0,
                    files_analyzed: ['src/auth.ts', 'src/oauth.ts'],
                    files_in_diff: 4,
                    recommendation: 'approve_with_suggestions',
                },
                createMockExecutionContext()
            );

            expect(result.success).toBe(true);
            expect(result.data).toContain('2/4 files (50%)');
            expect(result.data).toContain('uncovered');
        });

        it('should suggest covering remaining files when coverage < 100%', async () => {
            const result = await tool.execute(
                {
                    summary_draft:
                        'Need to analyze more files before completing review.',
                    issues_count: 0,
                    files_analyzed: ['src/auth.ts'],
                    files_in_diff: 3,
                    recommendation: 'approve',
                },
                createMockExecutionContext()
            );

            expect(result.success).toBe(true);
            expect(result.data).toContain('2 file(s)');
            expect(result.data).toContain('submit_review');
        });

        it('should show recommendation in output', async () => {
            const result = await tool.execute(
                {
                    summary_draft:
                        'This PR makes good improvements but has suggestions.',
                    issues_count: 1,
                    files_analyzed: ['src/auth.ts'],
                    files_in_diff: 1,
                    recommendation: 'approve_with_suggestions',
                },
                createMockExecutionContext()
            );

            expect(result.success).toBe(true);
            expect(result.data).toContain(
                'recommendation: approve_with_suggestions'
            );
        });
    });
});
