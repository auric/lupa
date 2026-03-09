import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { SubmitReviewTool } from '../tools/submitReviewTool';
import {
    createMockExecutionContext,
    createCancelledExecutionContext,
} from './testUtils/mockFactories';
import { FindingStore } from '../sessions/findingStore';

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
        });

        it('should have description mentioning final step', () => {
            expect(tool.description).toContain('final');
            expect(tool.description).toContain('FINAL step');
        });

        it('should expose schema for LLM', () => {
            const schema = tool.schema;
            expect(schema).toBeDefined();
        });
    });

    describe('execute', () => {
        it('should return review content as-is', async () => {
            const reviewContent = `## Summary
> **TL;DR**: This PR adds authentication middleware.

**Risk Level:** Medium
**Recommendation:** Request Changes

## Critical Issues
- Issue 1 in auth.ts
- Issue 2 in handler.ts`;

            const result = await tool.execute(
                {
                    review_content: reviewContent,
                },
                createMockExecutionContext()
            );

            expect(result.success).toBe(true);
            expect(result.data).toBe(reviewContent);
        });

        it('should include metadata with isCompletion flag', async () => {
            const reviewContent =
                'Test review content that meets minimum length requirements for validation. This needs to be at least 100 characters long.';

            const result = await tool.execute(
                {
                    review_content: reviewContent,
                },
                createMockExecutionContext()
            );

            expect(result.success).toBe(true);
            expect(result.metadata).toEqual({ isCompletion: true });
        });

        it('should preserve markdown formatting', async () => {
            const reviewContent = `## Summary
> **TL;DR**: Adds new feature.

### Findings
| File | Issue |
|------|-------|
| src/auth.ts | Missing validation |

\`\`\`typescript
// Code example
const x = 1;
\`\`\``;

            const result = await tool.execute(
                {
                    review_content: reviewContent,
                },
                createMockExecutionContext()
            );

            expect(result.success).toBe(true);
            expect(result.data).toContain('## Summary');
            expect(result.data).toContain('| File | Issue |');
            expect(result.data).toContain('```typescript');
        });
    });

    describe('schema validation', () => {
        it('should require review_content', () => {
            const schema = tool.schema;

            const missing = schema.safeParse({});
            expect(missing.success).toBe(false);
        });

        it('should reject review_content shorter than 20 characters', () => {
            const schema = tool.schema;

            const tooShort = schema.safeParse({
                review_content: 'Too short',
            });
            expect(tooShort.success).toBe(false);
        });

        it('should accept concise reviews of at least 20 characters', () => {
            const schema = tool.schema;

            // 25 chars - acceptable concise review
            const conciseReview = schema.safeParse({
                review_content: 'LGTM. No issues found.',
            });
            expect(conciseReview.success).toBe(true);

            // Longer review also works
            const detailedReview = schema.safeParse({
                review_content:
                    'Test review content that meets minimum length requirements. This is a detailed analysis.',
            });
            expect(detailedReview.success).toBe(true);
        });

        it('should reject extra properties (strict schema)', () => {
            const schema = tool.schema;

            const withExtras = schema.safeParse({
                review_content:
                    'Test review content that meets minimum length requirements.',
                extra_property: 'not allowed',
            });
            expect(withExtras.success).toBe(false);
        });
    });

    describe('FindingStore appendix', () => {
        it('returns review content as-is when no findings in store', async () => {
            const store = new FindingStore();
            const ctx = createMockExecutionContext({ findingStore: store });
            const content = 'Review with no findings detected.';

            const result = await tool.execute({ review_content: content }, ctx);

            expect(result.data).toBe(content);
        });

        it('appends finding appendix when FindingStore has findings', async () => {
            const store = new FindingStore();
            store.record({
                agentId: 'root',
                severity: 'HIGH',
                category: 'security',
                title: 'SQL injection risk',
                file: 'src/db.ts',
                lineRange: [5, 10],
                description: 'Unsanitized input in query.',
                supportingToolCalls: ['read_file'],
                disproof: {
                    attempted: true,
                    method: 'checked sanitization',
                    result: 'none found',
                },
                verifiableClaims: [],
            });
            const ctx = createMockExecutionContext({ findingStore: store });

            const result = await tool.execute(
                { review_content: 'Base review content here.' },
                ctx
            );

            expect(result.data).toContain('Base review content here.');
            expect(result.data).toContain('Structured Findings');
            expect(result.data).toContain('SQL injection risk');
            expect(result.data).toContain('src/db.ts:5-10');
        });

        it('groups findings by severity in correct order', async () => {
            const store = new FindingStore();
            // Record in non-order to verify sorting
            store.record({
                agentId: 'root',
                severity: 'LOW',
                category: 'style',
                title: 'Naming convention',
                file: 'src/a.ts',
                lineRange: [1, 1],
                description: 'Low severity item.',
                supportingToolCalls: [],
                disproof: {
                    attempted: false,
                    method: '',
                    result: '',
                },
                verifiableClaims: [],
            });
            store.record({
                agentId: 'root',
                severity: 'CRITICAL',
                category: 'security',
                title: 'RCE vulnerability',
                file: 'src/b.ts',
                lineRange: [2, 3],
                description: 'Critical severity item.',
                supportingToolCalls: [],
                disproof: {
                    attempted: true,
                    method: 'test',
                    result: 'confirmed',
                },
                verifiableClaims: [],
            });
            const ctx = createMockExecutionContext({ findingStore: store });

            const result = await tool.execute(
                { review_content: 'Review content here.' },
                ctx
            );

            // Severity order in appendix should be critical before low
            const criticalIdx = result.data!.indexOf('RCE vulnerability');
            const lowIdx = result.data!.indexOf('Naming convention');
            expect(criticalIdx).toBeLessThan(lowIdx);
        });

        it('appends LSP verification tags', async () => {
            const store = new FindingStore();
            const f1 = store.record({
                agentId: 'root',
                severity: 'HIGH',
                category: 'type-safety',
                title: 'Verified finding',
                file: 'src/v.ts',
                lineRange: [1, 5],
                description: 'This was verified by LSP.',
                supportingToolCalls: ['validate_claim'],
                disproof: {
                    attempted: true,
                    method: 'lsp',
                    result: 'confirmed',
                },
                verifiableClaims: [],
            });
            store.updateLspValidation(f1.id, {
                status: 'verified',
                details: 'LSP confirmed',
                claimResults: [],
            });

            const f2 = store.record({
                agentId: 'root',
                severity: 'MEDIUM',
                category: 'type-safety',
                title: 'Refuted finding',
                file: 'src/r.ts',
                lineRange: [10, 15],
                description: 'This was refuted by LSP.',
                supportingToolCalls: ['validate_claim'],
                disproof: {
                    attempted: true,
                    method: 'lsp',
                    result: 'refuted',
                },
                verifiableClaims: [],
            });
            store.updateLspValidation(f2.id, {
                status: 'refuted',
                details: 'LSP refuted',
                claimResults: [],
            });

            const ctx = createMockExecutionContext({ findingStore: store });

            const result = await tool.execute(
                { review_content: 'Review with LSP findings.' },
                ctx
            );

            expect(result.data).toContain('✅ LSP-verified');
            expect(result.data).toContain('❌ LSP-refuted');
        });

        it('returns success with isCompletion metadata', async () => {
            const result = await tool.execute(
                {
                    review_content:
                        'Complete review content for metadata test.',
                },
                createMockExecutionContext()
            );

            expect(result.success).toBe(true);
            expect(result.metadata).toEqual({ isCompletion: true });
        });
    });

    describe('cancellation', () => {
        it('throws CancellationError when cancelled', async () => {
            const ctx = createCancelledExecutionContext();

            await expect(
                tool.execute(
                    { review_content: 'Will not complete this review.' },
                    ctx
                )
            ).rejects.toThrow(vscode.CancellationError);
        });
    });
});
