/**
 * Utility for extracting review content from malformed tool call attempts.
 *
 * When an LLM fails to make a proper tool call and instead outputs JSON
 * in its text response, this utility extracts the intended content.
 */

import { Log } from '../services/loggingService';

/**
 * Minimum length for extracted review content to be considered valid.
 *
 * Higher than SubmitReviewTool's 20-char minimum because extraction is
 * "suspicious" - the model didn't call the tool properly. We need:
 * - Stricter validation to avoid false positives from arbitrary JSON
 * - Additional pattern matching (headings, review keywords) as secondary check
 *
 * When the model explicitly calls submit_review, we trust its intent more.
 */
const MIN_REVIEW_LENGTH = 50;

/**
 * Validates that extracted content looks like a legitimate review.
 * Prevents accepting arbitrary JSON that happened to have a review_content field.
 */
function isValidReviewContent(content: string): boolean {
    if (content.length < MIN_REVIEW_LENGTH) {
        return false;
    }
    const hasReviewPattern =
        /\*\*|##|###|TL;DR|Summary|Critical|High|Medium|Low|Issues?|Findings?|Recommendations?/i.test(
            content
        );
    return hasReviewPattern;
}

/**
 * Extracts JSON object content from a fenced code block.
 * Returns the raw string between the opening fence and closing fence.
 */
function extractCodeBlockContent(content: string): string | undefined {
    const fenceStart = content.match(/```(?:json)?\s*\n/);
    if (!fenceStart) {
        return undefined;
    }

    const startIdx = fenceStart.index! + fenceStart[0].length;
    const endIdx = content.indexOf('```', startIdx);

    if (endIdx === -1) {
        // Unclosed code block - take everything after the fence
        return content.substring(startIdx).trim();
    }

    return content.substring(startIdx, endIdx).trim();
}

/**
 * Extracts a balanced JSON object starting from the given index.
 * Properly handles nested braces inside string literals.
 */
function extractBalancedJsonObject(
    content: string,
    startIdx: number
): string | undefined {
    if (content[startIdx] !== '{') {
        return undefined;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = startIdx; i < content.length; i++) {
        const char = content[i]!;

        if (escaped) {
            escaped = false;
            continue;
        }

        if (char === '\\' && inString) {
            escaped = true;
            continue;
        }

        if (char === '"') {
            inString = !inString;
            continue;
        }

        if (!inString) {
            if (char === '{') {
                depth++;
            } else if (char === '}') {
                depth--;
                if (depth === 0) {
                    return content.substring(startIdx, i + 1);
                }
            }
        }
    }

    return undefined;
}

/**
 * Attempts to extract review content from a model response that contains
 * an embedded (but not properly invoked) submit_review tool call.
 *
 * Handles patterns like:
 * - JSON code block: ```json\n{"review_content": "..."}\n```
 * - Unclosed code block: ```json\n{"review_content": "..."} (no closing ```)
 * - Raw JSON: {"review_content": "..."}
 * - Partial pattern: "review_content": "..."
 *
 * @returns The extracted review content, or undefined if no pattern matched
 *          or content fails validation
 */
export function extractReviewFromMalformedToolCall(
    content: string | null | undefined
): string | undefined {
    if (!content) {
        return undefined;
    }

    // Strategy 1: Extract code block content and parse as JSON
    const codeBlockContent = extractCodeBlockContent(content);
    if (codeBlockContent) {
        const extracted = tryParseJsonReviewContent(codeBlockContent);
        if (extracted && isValidReviewContent(extracted)) {
            Log.info('Extracted review from JSON code block');
            return extracted;
        }
        Log.debug('Code block found but JSON parsing/validation failed');
    }

    // Strategy 2: Find JSON object with brace-depth scanning
    const reviewContentIdx = content.indexOf('"review_content"');
    if (reviewContentIdx !== -1) {
        // Find the opening brace before "review_content"
        const braceIdx = content.lastIndexOf('{', reviewContentIdx);
        if (braceIdx !== -1) {
            const jsonObject = extractBalancedJsonObject(content, braceIdx);
            if (jsonObject) {
                const extracted = tryParseJsonReviewContent(jsonObject);
                if (extracted && isValidReviewContent(extracted)) {
                    Log.info('Extracted review from balanced JSON object');
                    return extracted;
                }
                Log.debug('Balanced JSON extraction failed parsing/validation');
            }
        }
    }

    // Strategy 3: Recovery from malformed JSON
    const recovered = tryRecoverMalformedJson(content);
    if (recovered && isValidReviewContent(recovered)) {
        Log.info('Recovered review from malformed JSON');
        return recovered;
    }

    if (content.includes('review_content')) {
        Log.warn(
            'Content contains "review_content" but extraction failed',
            `Content length: ${content.length}, ending: ...${content.slice(-100)}`
        );
    }

    return undefined;
}

/**
 * Attempts to parse a JSON string and extract the review_content field.
 */
function tryParseJsonReviewContent(jsonString: string): string | undefined {
    try {
        const parsed = JSON.parse(jsonString) as unknown;
        if (
            typeof parsed === 'object' &&
            parsed !== null &&
            'review_content' in parsed
        ) {
            const reviewContent = (parsed as { review_content: unknown })
                .review_content;
            if (typeof reviewContent === 'string') {
                return reviewContent;
            }
        }
    } catch {
        // JSON parsing failed, try recovery strategies
        return tryRecoverMalformedJson(jsonString);
    }
    return undefined;
}

/**
 * Attempts to recover review content from malformed JSON.
 * Handles common issues like truncated strings or unescaped newlines.
 */
function tryRecoverMalformedJson(jsonString: string): string | undefined {
    // Look for the review_content value even in malformed JSON
    const match = jsonString.match(/"review_content"\s*:\s*"([\s\S]*)/);
    if (match) {
        let content = match[1]!;
        // Find the end of the string value (unescaped quote)
        let endIndex = 0;
        let escaped = false;
        for (let i = 0; i < content.length; i++) {
            const char = content[i];
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === '"') {
                endIndex = i;
                break;
            }
        }
        if (endIndex > 0) {
            return unescapeJsonString(content.substring(0, endIndex));
        }
    }
    return undefined;
}

/**
 * Unescapes a JSON string value, handling common escape sequences.
 */
function unescapeJsonString(str: string): string {
    return str
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
}
