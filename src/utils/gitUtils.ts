import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { Repository } from '../types/vscodeGitExtension';
import { Log } from '../services/loggingService';

function isFileNotFoundError(error: unknown): boolean {
    if (error instanceof vscode.FileSystemError) {
        return error.code === 'FileNotFound';
    }
    if (error instanceof Error) {
        return (
            error.message.includes('ENOENT') ||
            error.message.includes('File not found')
        );
    }
    return false;
}

async function readFileContent(uri: vscode.Uri): Promise<string> {
    try {
        const content = await vscode.workspace.fs.readFile(uri);
        return Buffer.from(content).toString('utf8');
    } catch (error) {
        if (isFileNotFoundError(error)) {
            return '';
        }
        Log.warn(`Failed to read ${uri.fsPath}: ${error}`);
        return '';
    }
}

function expandHomeDir(filePath: string): string {
    if (filePath.startsWith('~')) {
        return path.join(os.homedir(), filePath.slice(1));
    }
    return filePath;
}

/**
 * Reads gitignore patterns from the git repository.
 * Combines patterns from global gitignore, .gitignore, and .git/info/exclude.
 *
 * Note: Nested .gitignore files in subdirectories are not supported.
 * Use ripgrep-based tools for full nested gitignore support.
 */
export async function readGitignore(
    repository: Repository | null
): Promise<string> {
    if (!repository) {
        return '';
    }

    const repoRoot = repository.rootUri.fsPath;
    const patterns: string[] = [];

    try {
        const globalExcludesPath =
            await repository.getGlobalConfig('core.excludesFile');
        if (globalExcludesPath) {
            const expandedPath = expandHomeDir(globalExcludesPath.trim());
            const globalUri = vscode.Uri.file(expandedPath);
            const globalContent = await readFileContent(globalUri);
            if (globalContent) {
                patterns.push(globalContent);
            }
        }
    } catch (error) {
        Log.debug(`Failed to read global gitignore config: ${error}`);
    }

    const gitignoreUri = vscode.Uri.file(path.join(repoRoot, '.gitignore'));
    const gitignoreContent = await readFileContent(gitignoreUri);
    if (gitignoreContent) {
        patterns.push(gitignoreContent);
    }

    const excludeUri = vscode.Uri.file(
        path.join(repoRoot, '.git', 'info', 'exclude')
    );
    const excludeContent = await readFileContent(excludeUri);
    if (excludeContent) {
        patterns.push(excludeContent);
    }

    return patterns.join('\n');
}
