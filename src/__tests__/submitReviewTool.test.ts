import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SubmitReviewTool } from '../tools/submitReviewTool';
import { createMockExecutionContext } from './testUtils/mockFactories';

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
});
