import { describe, expect, it } from 'vitest';
import { extractReviewFromMalformedToolCall } from '../utils/reviewExtractionUtils';

describe('extractReviewFromMalformedToolCall', () => {
    describe('JSON code block extraction', () => {
        it('should extract review from json code block', () => {
            const content = `Calling submit_review with the final review.

\`\`\`json
{
  "review_content": "## Summary\\n> **TL;DR**: This PR improves performance and fixes critical bugs in the authentication flow."
}
\`\`\``;

            const result = extractReviewFromMalformedToolCall(content);

            expect(result).toBe(
                '## Summary\n> **TL;DR**: This PR improves performance and fixes critical bugs in the authentication flow.'
            );
        });

        it('should extract from code block without json tag', () => {
            const content = `Here is my review:

\`\`\`
{"review_content": "## Summary\\n\\nThe code looks good with no **Critical** issues found in this implementation."}
\`\`\``;

            const result = extractReviewFromMalformedToolCall(content);

            expect(result).toBe(
                '## Summary\n\nThe code looks good with no **Critical** issues found in this implementation.'
            );
        });
    });

    describe('raw JSON extraction', () => {
        it('should extract from inline JSON object', () => {
            const content =
                'I will call submit_review: {"review_content": "## Summary\\n\\n**TL;DR**: Great PR with solid implementation!"}';

            const result = extractReviewFromMalformedToolCall(content);

            expect(result).toBe(
                '## Summary\n\n**TL;DR**: Great PR with solid implementation!'
            );
        });

        it('should handle JSON with whitespace', () => {
            const content = `{
                "review_content": "## Findings\\n\\nMultiline review content here with detailed analysis."
            }`;

            const result = extractReviewFromMalformedToolCall(content);

            expect(result).toBe(
                '## Findings\n\nMultiline review content here with detailed analysis.'
            );
        });
    });

    describe('escape sequence handling', () => {
        it('should unescape newlines', () => {
            const content =
                '{"review_content": "## Summary\\nLine 1\\nLine 2\\nLine 3\\n\\nWith detailed **Critical** findings."}';

            const result = extractReviewFromMalformedToolCall(content);

            expect(result).toBe(
                '## Summary\nLine 1\nLine 2\nLine 3\n\nWith detailed **Critical** findings.'
            );
        });

        it('should unescape tabs', () => {
            const content =
                '{"review_content": "## Summary\\n\\nCol1\\tCol2\\tCol3 with detailed analysis and **findings**."}';

            const result = extractReviewFromMalformedToolCall(content);

            expect(result).toBe(
                '## Summary\n\nCol1\tCol2\tCol3 with detailed analysis and **findings**.'
            );
        });

        it('should unescape quotes', () => {
            const content =
                '{"review_content": "## Summary\\n\\nHe said \\"hello\\" to them. This is a detailed analysis with **Issues**."}';

            const result = extractReviewFromMalformedToolCall(content);

            expect(result).toBe(
                '## Summary\n\nHe said "hello" to them. This is a detailed analysis with **Issues**.'
            );
        });

        it('should unescape backslashes', () => {
            const content =
                '{"review_content": "## Summary\\n\\nPath: C:\\\\Users\\\\file has some **Critical** issues to address."}';

            const result = extractReviewFromMalformedToolCall(content);

            expect(result).toBe(
                '## Summary\n\nPath: C:\\Users\\file has some **Critical** issues to address.'
            );
        });

        it('should handle mixed escape sequences', () => {
            const content =
                '{"review_content": "## Summary\\n> Quote: \\"Nice\\"\\n\\nDone with detailed findings and **recommendations**."}';

            const result = extractReviewFromMalformedToolCall(content);

            expect(result).toBe(
                '## Summary\n> Quote: "Nice"\n\nDone with detailed findings and **recommendations**.'
            );
        });
    });

    describe('malformed JSON recovery', () => {
        it('should recover from truncated JSON', () => {
            const content =
                'Calling submit_review {"review_content": "This is a partial review that got cut';

            const result = extractReviewFromMalformedToolCall(content);

            expect(result).toBeUndefined();
        });

        it('should recover from valid content in malformed wrapper', () => {
            const content = `Some text before
{"review_content": "## Summary\\n\\nExtracted content with detailed **Issues** found in the analysis."}
Some text after that breaks JSON`;

            const result = extractReviewFromMalformedToolCall(content);

            expect(result).toBe(
                '## Summary\n\nExtracted content with detailed **Issues** found in the analysis.'
            );
        });
    });

    describe('no match cases', () => {
        it('should return undefined for null content', () => {
            expect(extractReviewFromMalformedToolCall(null)).toBeUndefined();
        });

        it('should return undefined for undefined content', () => {
            expect(
                extractReviewFromMalformedToolCall(undefined)
            ).toBeUndefined();
        });

        it('should return undefined for empty string', () => {
            expect(extractReviewFromMalformedToolCall('')).toBeUndefined();
        });

        it('should return undefined for content without review_content pattern', () => {
            const content =
                '### Summary\nThis is a regular markdown response without JSON.';

            const result = extractReviewFromMalformedToolCall(content);

            expect(result).toBeUndefined();
        });

        it('should return undefined for unrelated JSON', () => {
            const content = '{"name": "test", "value": 123}';

            const result = extractReviewFromMalformedToolCall(content);

            expect(result).toBeUndefined();
        });
    });

    describe('content validation', () => {
        it('should reject content that is too short', () => {
            const content = '{"review_content": "Too short"}';

            const result = extractReviewFromMalformedToolCall(content);

            expect(result).toBeUndefined();
        });

        it('should reject content without review-like patterns', () => {
            const content =
                '{"review_content": "This is just random text without any headings or review patterns that would indicate a real review document."}';

            const result = extractReviewFromMalformedToolCall(content);

            expect(result).toBeUndefined();
        });

        it('should accept content with markdown headings', () => {
            const content =
                '{"review_content": "## Analysis\\n\\nThis section contains detailed findings about the code under review."}';

            const result = extractReviewFromMalformedToolCall(content);

            expect(result).toContain('## Analysis');
        });

        it('should accept content with TL;DR pattern', () => {
            const content =
                '{"review_content": "> TL;DR: This PR improves the architecture significantly with clean abstractions."}';

            const result = extractReviewFromMalformedToolCall(content);

            expect(result).toContain('TL;DR');
        });

        it('should accept content with severity indicators', () => {
            const content =
                '{"review_content": "Found 2 Critical issues and 3 Medium issues in the authentication module."}';

            const result = extractReviewFromMalformedToolCall(content);

            expect(result).toContain('Critical');
        });

        it('should accept content with bold markdown', () => {
            const content =
                '{"review_content": "The changes are **solid** and follow best practices with detailed implementation."}';

            const result = extractReviewFromMalformedToolCall(content);

            expect(result).toContain('**solid**');
        });
    });

    describe('real-world patterns from logs', () => {
        it('should extract from actual LLM failure pattern', () => {
            const content = `Calling submit_review with the final review.

\`\`\`json
{
  "review_content": "## Summary\\n> **TL;DR**: This PR makes the tool-calling analysis concurrency-safe by creating per-analysis instances.\\n\\n### Key Changes\\n- Added SubagentSessionManager\\n- Fixed race conditions"
}
\`\`\``;

            const result = extractReviewFromMalformedToolCall(content);

            expect(result).toContain('## Summary');
            expect(result).toContain('**TL;DR**');
            expect(result).toContain('SubagentSessionManager');
        });
    });
});
