/**
 * Safely stringify a value for embedding in an HTML inline script.
 *
 * JSON.stringify output can contain sequences that break HTML parsing:
 * - `</script>` or `</` can prematurely close the script tag
 * - `<!--` can start an HTML comment
 * - `-->` can end an HTML comment
 *
 * This function escapes these sequences using unicode escapes.
 *
 * @param value - The value to stringify
 * @returns A JSON string safe for embedding in HTML script tags
 */
export function safeJsonStringify(value: unknown): string {
    const json = JSON.stringify(value);

    // Escape sequences that can break HTML script parsing
    // Order matters: escape < before checking for specific patterns
    return json
        .replace(/</g, '\\u003C')
        .replace(/>/g, '\\u003E')
        .replace(/\u2028/g, '\\u2028') // Line separator
        .replace(/\u2029/g, '\\u2029'); // Paragraph separator
}
