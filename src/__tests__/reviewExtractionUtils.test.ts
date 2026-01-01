import { describe, expect, it } from 'vitest';
import { extractReviewFromMalformedToolCall } from '../utils/reviewExtractionUtils';

describe('extractReviewFromMalformedToolCall', () => {
    describe('JSON code block extraction', () => {
        it('should extract review from json code block', () => {
            const content = `Calling submit_review with the final review.

\`\`\`json
{
  "review_content": "## Summary\\n> **TL;DR**: This PR improves performance."
}
\`\`\``;

            const result = extractReviewFromMalformedToolCall(content);

            expect(result).toBe(
                '## Summary\n> **TL;DR**: This PR improves performance.'
            );
        });

        it('should extract from code block without json tag', () => {
            const content = `Here is my review:

\`\`\`
{"review_content": "The code looks good."}
\`\`\``;

            const result = extractReviewFromMalformedToolCall(content);

            expect(result).toBe('The code looks good.');
        });
    });

    describe('raw JSON extraction', () => {
        it('should extract from inline JSON object', () => {
            const content =
                'I will call submit_review: {"review_content": "Great PR!"}';

            const result = extractReviewFromMalformedToolCall(content);

            expect(result).toBe('Great PR!');
        });

        it('should handle JSON with whitespace', () => {
            const content = `{
                "review_content": "Multiline review content here."
            }`;

            const result = extractReviewFromMalformedToolCall(content);

            expect(result).toBe('Multiline review content here.');
        });
    });

    describe('escape sequence handling', () => {
        it('should unescape newlines', () => {
            const content = '{"review_content": "Line 1\\nLine 2\\nLine 3"}';

            const result = extractReviewFromMalformedToolCall(content);

            expect(result).toBe('Line 1\nLine 2\nLine 3');
        });

        it('should unescape tabs', () => {
            const content = '{"review_content": "Col1\\tCol2\\tCol3"}';

            const result = extractReviewFromMalformedToolCall(content);

            expect(result).toBe('Col1\tCol2\tCol3');
        });

        it('should unescape quotes', () => {
            const content =
                '{"review_content": "He said \\"hello\\" to them."}';

            const result = extractReviewFromMalformedToolCall(content);

            expect(result).toBe('He said "hello" to them.');
        });

        it('should unescape backslashes', () => {
            const content = '{"review_content": "Path: C:\\\\Users\\\\file"}';

            const result = extractReviewFromMalformedToolCall(content);

            expect(result).toBe('Path: C:\\Users\\file');
        });

        it('should handle mixed escape sequences', () => {
            const content =
                '{"review_content": "## Summary\\n> Quote: \\"Nice\\"\\n\\nDone."}';

            const result = extractReviewFromMalformedToolCall(content);

            expect(result).toBe('## Summary\n> Quote: "Nice"\n\nDone.');
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
{"review_content": "Extracted content"}
Some text after that breaks JSON`;

            const result = extractReviewFromMalformedToolCall(content);

            expect(result).toBe('Extracted content');
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
