import * as vscode from 'vscode';

/**
 * Extracts text content from VS Code hover results.
 * Handles MarkdownString, plain strings, and legacy { language, value } objects.
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
            // Legacy MarkedString: { language: string; value: string }
            const legacy = c as { language?: string; value?: string };
            return legacy.value ? String(legacy.value) : '';
        })
        .filter(Boolean)
        .join('\n');
}
