import * as z from 'zod';
import * as path from 'path';
import * as vscode from 'vscode';
import ignore from 'ignore';
import { BaseTool } from './baseTool';
import { GitOperationsManager } from '../services/gitOperationsManager';
import { PathSanitizer } from '../utils/pathSanitizer';
import { rethrowIfCancellationOrTimeout } from '../utils/asyncUtils';
import { readGitignore } from '../utils/gitUtils';
import { ToolResult, toolSuccess } from '../types/toolResultTypes';
import { ExecutionContext } from '../types/executionContext';

/**
 * Tool that lists the contents of a directory, with optional recursion.
 * Respects .gitignore and other ignore files, prevents directory traversal attacks.
 */
export class ListDirTool extends BaseTool {
    name = 'list_directory';
    description =
        'List files and directories within a specified path, with optional recursion. Respects .gitignore files.';

    schema = z.object({
        relative_path: z
            .string()
            .min(1, 'Relative path cannot be empty')
            .describe(
                'The relative path to the directory to list (e.g., "src", "src/components", "." for root)'
            ),
        recursive: z
            .boolean()
            .describe('Whether to scan subdirectories recursively'),
    });

    constructor(private readonly gitOperationsManager: GitOperationsManager) {
        super();
    }

    async execute(
        args: z.infer<typeof this.schema>,
        context?: ExecutionContext
    ): Promise<ToolResult> {
        const { relative_path, recursive } = args;

        const sanitizedPath = PathSanitizer.sanitizePath(relative_path);

        // List directory contents with ignore pattern support
        // No timeout wrapper needed - vscode.workspace.fs.readDirectory is inherently fast
        // and callListDir checks cancellation token during iteration
        const result = await this.callListDir(
            sanitizedPath,
            recursive,
            context?.cancellationToken
        );

        const output = this.formatOutput(result);

        // Empty directory is a valid state (success)
        return toolSuccess(output || '(empty directory)');
    }

    /**
     * Lists directory contents respecting .gitignore and other ignore files
     */
    private async callListDir(
        relativePath: string,
        recursive: boolean,
        token?: vscode.CancellationToken
    ): Promise<{ dirs: string[]; files: string[] }> {
        try {
            if (token?.isCancellationRequested) {
                throw new vscode.CancellationError();
            }

            const ig = ignore().add(
                await readGitignore(this.gitOperationsManager.getRepository())
            );

            const gitRootDirectory =
                this.gitOperationsManager.getRepository()?.rootUri.fsPath || '';
            const targetPath = path.join(gitRootDirectory, relativePath);
            const targetUri = vscode.Uri.file(targetPath);

            const entries = await vscode.workspace.fs.readDirectory(targetUri);
            const dirs: string[] = [];
            const files: string[] = [];

            for (const [name, type] of entries) {
                if (token?.isCancellationRequested) {
                    throw new vscode.CancellationError();
                }

                if (ig.checkIgnore(name).ignored) {
                    continue;
                }

                const fullPath =
                    relativePath === '.'
                        ? name
                        : path.posix.join(relativePath, name);

                if (type === vscode.FileType.Directory) {
                    dirs.push(fullPath);

                    if (recursive) {
                        try {
                            const subResult = await this.callListDir(
                                fullPath,
                                recursive,
                                token
                            );
                            dirs.push(...subResult.dirs);
                            files.push(...subResult.files);
                        } catch (error) {
                            rethrowIfCancellationOrTimeout(error);
                            // Skip directories that can't be read for other errors
                        }
                    }
                } else if (type === vscode.FileType.File) {
                    files.push(fullPath);
                }
            }

            return { dirs, files };
        } catch (error) {
            rethrowIfCancellationOrTimeout(error);

            throw new Error(
                `Failed to read directory '${relativePath}': ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    /**
     * Formats the output as a single string with directories and files
     */
    private formatOutput(result: { dirs: string[]; files: string[] }): string {
        const output: string[] = [];

        const sortedDirs = result.dirs.sort();
        for (const dir of sortedDirs) {
            output.push(`${dir}/`);
        }

        const sortedFiles = result.files.sort();
        for (const file of sortedFiles) {
            output.push(file);
        }

        return output.join('\n');
    }
}
