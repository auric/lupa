/**
 * Utility for extracting review content from malformed tool call attempts.
 *
 * When an LLM fails to make a proper tool call and instead outputs JSON
 * in its text response, this utility extracts the intended content.
 */

/**
 * Attempts to extract review content from a model response that contains
 * an embedded (but not properly invoked) submit_review tool call.
 *
 * Handles patterns like:
 * - JSON code block: ```json\n{"review_content": "..."}\n```
 * - Raw JSON: {"review_content": "..."}
 * - Partial pattern: "review_content": "..."
 *
 * @returns The extracted review content, or undefined if no pattern matched
 */
export function extractReviewFromMalformedToolCall(
    content: string | null | undefined
): string | undefined {
    if (!content) {
        return undefined;
    }

    // Try JSON code block first (most explicit pattern)
    const codeBlockMatch = content.match(
        /```(?:json)?\s*\n?\s*\{[\s\S]*?"review_content"\s*:\s*"([\s\S]*?)"\s*\}[\s\S]*?```/
    );
    if (codeBlockMatch) {
        return unescapeJsonString(codeBlockMatch[1]!);
    }

    // Try raw JSON object with review_content
    const jsonMatch = content.match(
        /\{\s*"review_content"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/
    );
    if (jsonMatch) {
        return unescapeJsonString(jsonMatch[1]!);
    }

    // Try to find and parse a complete JSON object containing review_content
    const jsonObjectMatch = content.match(
        /\{[\s\S]*?"review_content"[\s\S]*?\}/
    );
    if (jsonObjectMatch) {
        const extracted = tryParseJsonReviewContent(jsonObjectMatch[0]);
        if (extracted) {
            return extracted;
        }
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
