import * as vscode from 'vscode';
import * as path from 'path';
import { Repository } from '../types/vscodeGitExtension';

/**
 * Reads a file's content, returning empty string if it doesn't exist.
 */
async function readFileContent(uri: vscode.Uri): Promise<string> {
    try {
        const content = await vscode.workspace.fs.readFile(uri);
        return content.toString();
    } catch {
        return '';
    }
}

/**
 * Reads gitignore patterns from the git repository.
 * Combines patterns from:
 * - .gitignore (root-level gitignore file)
 * - .git/info/exclude (local per-repo excludes, not version controlled)
 *
 * Used by multiple tools to respect gitignore patterns.
 *
 * @param repository The git repository instance (can be null)
 * @returns Combined gitignore patterns as a string, or empty string if not found
 */
export async function readGitignore(
    repository: Repository | null
): Promise<string> {
    if (!repository) {
        return '';
    }

    const repoRoot = repository.rootUri.fsPath;

    const gitignoreUri = vscode.Uri.file(path.join(repoRoot, '.gitignore'));
    const gitignoreContent = await readFileContent(gitignoreUri);

    const excludeUri = vscode.Uri.file(
        path.join(repoRoot, '.git', 'info', 'exclude')
    );
    const excludeContent = await readFileContent(excludeUri);

    const combined = [gitignoreContent, excludeContent]
        .filter((content) => content.length > 0)
        .join('\n');

    return combined;
}
