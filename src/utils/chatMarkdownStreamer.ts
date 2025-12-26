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

            if (segment.line !== undefined) {
                // Create a Location with line (0-based in VS Code)
                const position = new vscode.Position(
                    segment.line - 1,
                    segment.column !== undefined ? segment.column - 1 : 0
                );
                const location = new vscode.Location(fileUri, position);
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
 * Handles both absolute and relative paths.
 */
function resolveFileUri(filePath: string, workspaceRoot: vscode.Uri | undefined): vscode.Uri {
    // Check if it's an absolute path
    if (path.isAbsolute(filePath)) {
        return vscode.Uri.file(filePath);
    }

    // Resolve relative to workspace root if available
    if (workspaceRoot) {
        return vscode.Uri.joinPath(workspaceRoot, filePath);
    }

    // Fall back to file URI (may not resolve correctly without workspace)
    return vscode.Uri.file(filePath);
}
