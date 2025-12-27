import * as vscode from 'vscode';
import type { DiffHunk } from '../types/contextTypes';

/**
 * Transforms parsed diff hunks into a hierarchical file tree structure
 * suitable for display via vscode.ChatResponseStream.filetree().
 *
 * Creates a nested folder structure from flat file paths for intuitive visualization.
 * @param parsedDiff Array of diff hunks containing file paths
 * @returns Hierarchical tree structure for vscode chat filetree rendering
 */
export function buildFileTree(parsedDiff: DiffHunk[]): vscode.ChatResponseFileTree[] {
    if (!parsedDiff || parsedDiff.length === 0) {
        return [];
    }

    // Extract unique file paths and sort them for consistent ordering
    const filePaths = [...new Set(parsedDiff.map(hunk => hunk.filePath))].sort();

    // Build hierarchical tree structure
    const root: Map<string, TreeNode> = new Map();

    for (const filePath of filePaths) {
        const parts = filePath.split('/');
        let currentLevel = root;

        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            if (!part) continue;
            const isFile = i === parts.length - 1;

            if (!currentLevel.has(part)) {
                currentLevel.set(part, {
                    name: part,
                    children: isFile ? undefined : new Map()
                });
            }

            const node = currentLevel.get(part)!;
            if (!isFile && node.children) {
                currentLevel = node.children;
            }
        }
    }

    return convertToFileTree(root);
}

interface TreeNode {
    name: string;
    children: Map<string, TreeNode> | undefined;
}

function convertToFileTree(nodes: Map<string, TreeNode>): vscode.ChatResponseFileTree[] {
    const result: vscode.ChatResponseFileTree[] = [];

    // Sort: folders first, then files, alphabetically within each group
    const sortedEntries = [...nodes.entries()].sort((a, b) => {
        const aIsFolder = a[1].children !== undefined;
        const bIsFolder = b[1].children !== undefined;

        if (aIsFolder !== bIsFolder) {
            return aIsFolder ? -1 : 1;
        }
        return a[0].localeCompare(b[0]);
    });

    for (const [, node] of sortedEntries) {
        const treeItem: vscode.ChatResponseFileTree = {
            name: node.name
        };

        if (node.children && node.children.size > 0) {
            treeItem.children = convertToFileTree(node.children);
        }

        result.push(treeItem);
    }

    return result;
}
