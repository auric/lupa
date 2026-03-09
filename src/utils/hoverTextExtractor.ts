import * as vscode from 'vscode';

/**
 * Extracts text content from VS Code hover results.
 * Handles all hover content types: plain strings, MarkdownString, and objects with `value`.
 */
export function extractHoverText(hovers: vscode.Hover[]): string {
    return hovers
        .flatMap((h) => h.contents)
        .map((c) => {
            if (typeof c === 'string') {
                return c;
            }
            if (c instanceof vscode.MarkdownString) {
                return c.value;
            }
            if (typeof c === 'object' && 'value' in c) {
                return String(c.value);
            }
            return '';
        })
        .filter(Boolean)
        .join('\n');
}
