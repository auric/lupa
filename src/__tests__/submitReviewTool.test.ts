import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { SubmitReviewTool } from '../tools/submitReviewTool';
import {
    createMockExecutionContext,
    createCancelledExecutionContext,
} from './testUtils/mockFactories';
import { FindingStore } from '../sessions/findingStore';
import type { RecordedFinding } from '../types/findingTypes';

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

    /** Creates a context where think_about_completion was already called */
    const ctxWithReflection = (
        overrides: Partial<
            Parameters<typeof createMockExecutionContext>[0]
        > = {}
    ) =>
        createMockExecutionContext({
            toolCallCounts: new Map([['think_about_completion', 1]]),
            ...overrides,
        });

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
                ctxWithReflection()
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
                ctxWithReflection()
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
                ctxWithReflection()
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

    describe('review content', () => {
        it('returns review content as-is', async () => {
            const ctx = ctxWithReflection();
            const content = 'Review with no findings detected.';

            const result = await tool.execute({ review_content: content }, ctx);

            expect(result.data).toBe(content);
        });

        it('returns success with isCompletion metadata', async () => {
            const result = await tool.execute(
                {
                    review_content:
                        'Complete review content for metadata test.',
                },
                ctxWithReflection()
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

    describe('FindingStore gate', () => {
        function createFindingStore(
            ...partials: Partial<
                Omit<RecordedFinding, 'id' | 'timestamp' | 'lspValidation'>
            >[]
        ): FindingStore {
            const store = new FindingStore();
            for (const p of partials) {
                store.record({
                    agentId: p.agentId ?? 'agent-1',
                    severity: p.severity ?? 'HIGH',
                    category: p.category ?? 'logic_error',
                    title: p.title ?? 'Null dereference in handler',
                    file: p.file ?? 'src/handler.ts',
                    lineRange: p.lineRange ?? [10, 15],
                    description: p.description ?? 'desc',
                    affectedComponent: p.affectedComponent ?? 'Handler',
                    failureMechanism:
                        p.failureMechanism ?? 'wrong_return_value',
                    supportingToolCalls: p.supportingToolCalls ?? ['read_file'],
                    disproof: p.disproof ?? {
                        attempted: true,
                        method: 'test',
                        result: 'confirmed',
                    },
                    verifiableClaims: p.verifiableClaims ?? [],
                });
            }
            return store;
        }

        it('rejects review that omits a recorded finding', async () => {
            const store = createFindingStore({
                title: 'Null dereference in handler',
                file: 'src/handler.ts',
            });
            const ctx = ctxWithReflection({ findingStore: store });

            const result = await tool.execute(
                {
                    review_content:
                        'This PR looks good. No issues found. Approved with no concerns whatsoever.',
                },
                ctx
            );

            expect(result.success).toBe(false);
            expect(result.error).toContain('Review rejected');
            expect(result.error).toContain('Null dereference in handler');
        });

        it('accepts review that mentions finding title', async () => {
            const store = createFindingStore({
                title: 'Null dereference in handler',
                file: 'src/handler.ts',
            });
            const ctx = ctxWithReflection({ findingStore: store });

            const result = await tool.execute(
                {
                    review_content:
                        'Found a null dereference issue in the codebase. Recommend fixing before merge.',
                },
                ctx
            );

            expect(result.success).toBe(true);
        });

        it('accepts review that mentions finding file', async () => {
            const store = createFindingStore({
                title: 'Null dereference in handler',
                file: 'src/handler.ts',
            });
            const ctx = ctxWithReflection({ findingStore: store });

            const result = await tool.execute(
                {
                    review_content:
                        'Issues were found in src/handler.ts that require attention before merging.',
                },
                ctx
            );

            expect(result.success).toBe(true);
        });

        it('rejects when one of multiple findings is missing', async () => {
            const store = createFindingStore(
                { title: 'SQL injection risk', file: 'src/db.ts' },
                { title: 'Unrelated obscure bug', file: 'src/obscure.ts' }
            );
            const ctx = ctxWithReflection({ findingStore: store });

            const result = await tool.execute(
                {
                    review_content:
                        'Found a SQL injection risk in src/db.ts. This needs to be fixed urgently.',
                },
                ctx
            );

            expect(result.success).toBe(false);
            expect(result.error).toContain('1 are missing');
            expect(result.error).toContain('Unrelated obscure bug');
        });

        it('succeeds with no findingStore in context', async () => {
            const ctx = ctxWithReflection({ findingStore: undefined });

            const result = await tool.execute(
                { review_content: 'Clean review with no findings at all.' },
                ctx
            );

            expect(result.success).toBe(true);
        });
    });

    describe('Hypothesis enforcement gate', () => {
        it('rejects review when confirmed hypotheses exist but zero findings recorded', async () => {
            const { ReasoningChain } =
                await import('../sessions/reasoningChain');
            const chain = new ReasoningChain();
            chain.addCheckpoint('auth review', ['timing attack on login']);
            chain.markConfirmed(1, 'found via find_usages');

            const store = new FindingStore();
            const ctx = ctxWithReflection({
                reasoningChain: chain,
                findingStore: store,
            });

            const result = await tool.execute(
                {
                    review_content:
                        'This PR looks good. No significant issues found in the auth module.',
                },
                ctx
            );

            expect(result.success).toBe(false);
            expect(result.error).toContain('CONFIRMED');
            expect(result.error).toContain('timing attack on login');
            expect(result.error).toContain('record_finding');
        });

        it('allows review when confirmed hypotheses have corresponding findings', async () => {
            const { ReasoningChain } =
                await import('../sessions/reasoningChain');
            const chain = new ReasoningChain();
            chain.addCheckpoint('auth review', ['timing attack on login']);
            chain.markConfirmed(1, 'found it');

            const store = new FindingStore();
            store.record({
                agentId: 'root',
                severity: 'HIGH',
                category: 'security_vulnerability',
                title: 'Timing attack on login',
                file: 'src/auth.ts',
                lineRange: [10, 15],
                description: 'Password comparison using ===',
                affectedComponent: 'login()',
                failureMechanism: 'wrong_return_value',
                supportingToolCalls: ['find_usages'],
                disproof: {
                    attempted: true,
                    method: 'checked callers',
                    result: 'confirmed',
                },
                verifiableClaims: [],
            });

            const ctx = ctxWithReflection({
                reasoningChain: chain,
                findingStore: store,
            });

            const result = await tool.execute(
                {
                    review_content:
                        'Found a timing attack vulnerability in the login auth module at src/auth.ts.',
                },
                ctx
            );

            expect(result.success).toBe(true);
        });

        it('allows review when no hypotheses were confirmed', async () => {
            const { ReasoningChain } =
                await import('../sessions/reasoningChain');
            const chain = new ReasoningChain();
            chain.addCheckpoint('auth review', ['timing attack']);
            chain.markDismissed(1, 'all callers handle it');

            const store = new FindingStore();
            const ctx = ctxWithReflection({
                reasoningChain: chain,
                findingStore: store,
            });

            const result = await tool.execute(
                {
                    review_content:
                        'This PR looks good. All hypotheses were investigated and dismissed.',
                },
                ctx
            );

            expect(result.success).toBe(true);
        });

        it('allows review when no reasoning chain present', async () => {
            const ctx = ctxWithReflection();

            const result = await tool.execute(
                {
                    review_content:
                        'Simple review without reasoning chain tracking.',
                },
                ctx
            );

            expect(result.success).toBe(true);
        });
    });
});
