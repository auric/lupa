import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SubmitReviewTool } from '../tools/submitReviewTool';

// Mock the logging service
vi.mock('../services/loggingService', () => ({
    Log: {
        info: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
    },
}));

describe('SubmitReviewTool', () => {
    let tool: SubmitReviewTool;

    beforeEach(() => {
        vi.clearAllMocks();
        tool = new SubmitReviewTool();
    });

    describe('metadata', () => {
        it('should have correct tool name', () => {
            expect(tool.name).toBe('submit_review');
            expect(SubmitReviewTool.TOOL_NAME).toBe('submit_review');
        });

        it('should have description', () => {
            expect(tool.description).toContain('final');
            expect(tool.description).toContain('complete');
        });

        it('should expose schema for LLM', () => {
            const schema = tool.schema;
            expect(schema).toBeDefined();
        });
    });

    describe('execute', () => {
        it('should format review with all sections', async () => {
            const args = {
                summary: 'This PR adds authentication middleware.',
                risk_level: 'medium' as const,
                recommendation: 'request_changes' as const,
                review_content:
                    '## Findings\n\n- Issue 1 in auth.ts\n- Issue 2 in handler.ts',
            };

            const result = await tool.execute(args);

            expect(result.success).toBe(true);
            expect(result.data).toContain('## Summary');
            expect(result.data).toContain(
                'This PR adds authentication middleware.'
            );
            expect(result.data).toContain('**Risk Level:** 🟡 Medium');
            expect(result.data).toContain(
                '**Recommendation:** Request Changes'
            );
            expect(result.data).toContain('## Findings');
            expect(result.data).toContain('Issue 1 in auth.ts');
        });

        it('should use correct emoji for each risk level', async () => {
            const riskLevels: Array<{
                level: 'low' | 'medium' | 'high' | 'critical';
                emoji: string;
            }> = [
                { level: 'low', emoji: '🟢' },
                { level: 'medium', emoji: '🟡' },
                { level: 'high', emoji: '🟠' },
                { level: 'critical', emoji: '🔴' },
            ];

            for (const { level, emoji } of riskLevels) {
                const args = {
                    summary: 'Test summary with enough length for validation.',
                    risk_level: level,
                    recommendation: 'approve' as const,
                    review_content:
                        'Test review content that meets minimum length requirements for validation.',
                };

                const result = await tool.execute(args);

                expect(result.success).toBe(true);
                expect(result.data).toContain(emoji);
            }
        });

        it('should format recommendation correctly', async () => {
            const recommendations: Array<{
                value:
                    | 'approve'
                    | 'approve_with_suggestions'
                    | 'request_changes'
                    | 'block_merge';
                label: string;
            }> = [
                { value: 'approve', label: 'Approve' },
                {
                    value: 'approve_with_suggestions',
                    label: 'Approve with Suggestions',
                },
                { value: 'request_changes', label: 'Request Changes' },
                { value: 'block_merge', label: 'Block Merge' },
            ];

            for (const { value, label } of recommendations) {
                const args = {
                    summary: 'Test summary with enough length for validation.',
                    risk_level: 'low' as const,
                    recommendation: value,
                    review_content:
                        'Test review content that meets minimum length requirements for validation.',
                };

                const result = await tool.execute(args);

                expect(result.success).toBe(true);
                expect(result.data).toContain(`**Recommendation:** ${label}`);
            }
        });

        it('should include metadata with isCompletion flag', async () => {
            const args = {
                summary: 'Test summary with enough length for validation.',
                risk_level: 'low' as const,
                recommendation: 'approve' as const,
                review_content:
                    'Test review content that meets minimum length requirements for validation.',
            };

            const result = await tool.execute(args);

            expect(result.success).toBe(true);
            expect(result.metadata).toEqual({
                isCompletion: true,
                riskLevel: 'low',
                recommendation: 'approve',
            });
        });
    });

    describe('schema validation', () => {
        it('should require summary with minimum length', () => {
            const schema = tool.schema;

            const tooShort = schema.safeParse({
                summary: 'Short',
                risk_level: 'low',
                recommendation: 'approve',
                review_content:
                    'Test review content that meets minimum length requirements. This needs to be at least 100 characters long.',
            });
            expect(tooShort.success).toBe(false);

            const valid = schema.safeParse({
                summary: 'This is a summary with enough characters.',
                risk_level: 'low',
                recommendation: 'approve',
                review_content:
                    'Test review content that meets minimum length requirements. This needs to be at least 100 characters long.',
            });
            expect(valid.success).toBe(true);
        });

        it('should require review_content with minimum length', () => {
            const schema = tool.schema;

            const tooShort = schema.safeParse({
                summary: 'This is a summary with enough characters.',
                risk_level: 'low',
                recommendation: 'approve',
                review_content: 'Too short',
            });
            expect(tooShort.success).toBe(false);
        });

        it('should validate risk_level enum', () => {
            const schema = tool.schema;

            const invalid = schema.safeParse({
                summary: 'This is a summary with enough characters.',
                risk_level: 'invalid',
                recommendation: 'approve',
                review_content:
                    'Test review content that meets minimum length requirements. This needs to be at least 100 characters long.',
            });
            expect(invalid.success).toBe(false);
        });

        it('should validate recommendation enum', () => {
            const schema = tool.schema;

            const invalid = schema.safeParse({
                summary: 'This is a summary with enough characters.',
                risk_level: 'low',
                recommendation: 'invalid',
                review_content:
                    'Test review content that meets minimum length requirements. This needs to be at least 100 characters long.',
            });
            expect(invalid.success).toBe(false);
        });
    });
});
