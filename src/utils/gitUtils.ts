import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import ignore, { Ignore } from 'ignore';
import { Repository } from '../types/vscodeGitExtension';
import { Log } from '../services/loggingService';
import { getErrorMessage } from './errorUtils';

function isFileNotFoundError(error: unknown): boolean {
    if (error instanceof vscode.FileSystemError) {
        return error.code === 'FileNotFound';
    }
    if (error && typeof error === 'object') {
        // Check error.code first (Node.js fs errors have this property)
        const code = (error as { code?: string }).code;
        // ENOTDIR: path component is not a directory (e.g., /file.txt/subpath)
        if (
            code === 'ENOENT' ||
            code === 'ENOTDIR' ||
            code === 'FileNotFound'
        ) {
            return true;
        }
    }
    if (error instanceof Error) {
        return (
            error.message.includes('ENOENT') ||
            error.message.includes('ENOTDIR') ||
            error.message.includes('File not found')
        );
    }
    return false;
}

function isPermissionError(error: unknown): boolean {
    if (error instanceof vscode.FileSystemError) {
        return error.code === 'NoPermissions';
    }
    if (error && typeof error === 'object') {
        const code = (error as { code?: string }).code;
        if (code === 'EACCES' || code === 'EPERM' || code === 'NoPermissions') {
            return true;
        }
    }
    if (error instanceof Error) {
        return (
            error.message.includes('EACCES') ||
            error.message.includes('permission denied') ||
            error.message.includes('Permission denied')
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
        if (isPermissionError(error)) {
            Log.warn(
                `Permission denied reading gitignore file (${uri.fsPath}): ${getErrorMessage(error)}`
            );
            return '';
        }
        Log.warn(
            `Failed to read gitignore file (${uri.fsPath}): ${getErrorMessage(error)}`
        );
        return '';
    }
}

/**
 * Expands ~ to the current user's home directory.
 *
 * Supported forms:
 * - `~` → home directory
 * - `~/path` or `~\path` → home directory + path
 *
 * Unsupported forms (passed through unchanged):
 * - `~user/path` → tilde expansion for other users is not supported
 *
 * Note: Paths outside the home directory (e.g., ~/../../etc/foo) are allowed
 * since git's core.excludesFile can legitimately point to any location.
 */
function expandHomeDir(filePath: string): string {
    if (!filePath.startsWith('~')) {
        return filePath;
    }
    // Only expand ~ for current user, not ~user/ form
    if (filePath.length > 1 && filePath[1] !== '/' && filePath[1] !== '\\') {
        // This is ~user/path form which we don't support
        return filePath;
    }
    if (filePath === '~') {
        return os.homedir();
    }
    // Remove ~ and any following path separator to avoid path.join discarding homedir
    const remainder = filePath.slice(1).replace(/^[/\\]/, '');
    // Use path.resolve to normalize the path (handles .. segments cleanly)
    return path.resolve(os.homedir(), remainder);
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
        const trimmedPath = globalExcludesPath?.trim();
        if (trimmedPath) {
            const expandedPath = expandHomeDir(trimmedPath);
            const globalUri = vscode.Uri.file(expandedPath);
            const globalContent = await readFileContent(globalUri);
            if (globalContent) {
                patterns.push(globalContent);
            }
        }
    } catch (error) {
        Log.debug(
            `Failed to read global gitignore config: ${getErrorMessage(error)}`
        );
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

/**
 * Creates a gitignore filter instance for the given repository.
 * Combines patterns from global gitignore, .gitignore, and .git/info/exclude.
 *
 * This is a convenience function that wraps readGitignore() and returns
 * an Ignore instance ready for use with isPathValid() and ignores().
 *
 * @param repository The git repository instance (can be null)
 * @returns An Ignore instance with all patterns loaded
 */
export async function createGitignoreFilter(
    repository: Repository | null
): Promise<Ignore> {
    const patterns = await readGitignore(repository);
    return ignore().add(patterns);
}
