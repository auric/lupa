import * as vscode from 'vscode';
import * as path from 'path';
import { parseMarkdownFileLinks } from '../lib/pathUtils';

/**
 * Streams markdown content to a ChatResponseStream, converting file links
 * to proper VS Code anchors for clickable navigation.
 *
 * This solves the issue where markdown links like [file.ts:42](file.ts:42)
 * don't render as clickable links in VS Code Chat. By parsing the markdown
 * and using stream.anchor() for file links, we get proper file navigation.
 *
 * @param stream The VS Code chat response stream
 * @param markdown The markdown content to stream
 * @param workspaceRoot Optional workspace root for resolving relative paths
 */
export function streamMarkdownWithAnchors(
    stream: vscode.ChatResponseStream,
    markdown: string,
    workspaceRoot: vscode.Uri | undefined
): void {
    const segments = parseMarkdownFileLinks(markdown);

    for (const segment of segments) {
        if (segment.type === 'text') {
            stream.markdown(segment.content);
        } else if (segment.type === 'fileLink' && segment.filePath) {
            // Resolve the file path to a proper URI
            const fileUri = resolveFileUri(segment.filePath, workspaceRoot);

            // Use title or fall back to file path
            const displayText = segment.title || segment.filePath;

            // Can't resolve - emit as plain text (preserves content without broken anchor)
            if (!fileUri) {
                stream.markdown(displayText);
                continue;
            }

            if (segment.line !== undefined) {
                // Create a Location with line or range (convert 1-based to 0-based)
                const startLine = segment.line - 1;
                const endLine =
                    segment.endLine !== undefined
                        ? segment.endLine - 1
                        : startLine;

                // Determine column positions based on format:
                // - line:column (e.g., file.ts:42:10) → cursor at specific position (zero-width)
                // - line-endLine (e.g., file.ts:10-20) → select entire line range
                // - line only (e.g., file.ts:42) → cursor at start of line (zero-width)
                const startColumn =
                    segment.column !== undefined ? segment.column - 1 : 0;
                const endColumn =
                    segment.endLine !== undefined
                        ? Number.MAX_SAFE_INTEGER // Line range: select to end of last line
                        : startColumn; // Single position: zero-width selection

                const range = new vscode.Range(
                    new vscode.Position(startLine, startColumn),
                    new vscode.Position(endLine, endColumn)
                );
                const location = new vscode.Location(fileUri, range);
                stream.anchor(location, segment.title);
            } else {
                // Just a file reference without line number
                stream.anchor(fileUri, segment.title);
            }
        }
    }
}

/**
 * Resolve a file path to a VS Code URI.
 * Returns undefined for relative paths without workspace root (can't resolve).
 */
function resolveFileUri(
    filePath: string,
    workspaceRoot: vscode.Uri | undefined
): vscode.Uri | undefined {
    // Absolute paths resolve directly
    if (path.isAbsolute(filePath)) {
        return vscode.Uri.file(filePath);
    }

    // Relative paths need workspace root
    if (workspaceRoot) {
        return vscode.Uri.joinPath(workspaceRoot, filePath);
    }

    // Can't resolve relative path without workspace - caller should handle
    return undefined;
}
