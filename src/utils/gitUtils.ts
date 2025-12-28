import * as vscode from 'vscode';
import * as path from 'path';
import { Repository } from '../types/vscodeGitExtension';

/**
 * Reads the .gitignore file content from the git repository root.
 * Used by multiple tools to respect gitignore patterns.
 *
 * @param repository The git repository instance (can be null)
 * @returns The .gitignore file content as a string, or empty string if not found
 */
export async function readGitignore(
    repository: Repository | null
): Promise<string> {
    try {
        if (!repository) {
            return '';
        }
        const gitignoreUri = vscode.Uri.file(
            path.join(repository.rootUri.fsPath, '.gitignore')
        );
        const gitignoreContent =
            await vscode.workspace.fs.readFile(gitignoreUri);
        return gitignoreContent.toString();
    } catch {
        return '';
    }
}
