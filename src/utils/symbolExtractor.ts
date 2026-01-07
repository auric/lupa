import * as path from 'path';
import * as vscode from 'vscode';
import ignore from 'ignore';
import { GitOperationsManager } from '../services/gitOperationsManager';
import { readGitignore } from '../utils/gitUtils';
import { CodeFileUtils } from './codeFileUtils';
import { withCancellableTimeout, isTimeoutError } from './asyncUtils';
import { Log } from '../services/loggingService';

/** Timeout for extracting symbols from a single file */
const FILE_SYMBOL_TIMEOUT = 5_000; // 5 seconds per file

/** Maximum time for entire directory symbol extraction */
const DIRECTORY_SYMBOL_TIMEOUT = 60_000; // 60 seconds total

/**
 * Options for directory symbol extraction
 */
export interface DirectorySymbolOptions {
    maxDepth?: number;
    includeHidden?: boolean;
    filePattern?: RegExp;
    /** Maximum time in milliseconds for entire directory scan. Defaults to DIRECTORY_SYMBOL_TIMEOUT. */
    timeoutMs?: number;
    /** Cancellation token to abort the operation early */
    token?: vscode.CancellationToken;
}

/**
 * Result structure for file symbols
 */
export interface FileSymbolResult {
    filePath: string;
    symbols: vscode.DocumentSymbol[] | vscode.SymbolInformation[];
}

/**
 * Utility class for extracting symbols from files and directories using VS Code LSP.
 * Handles Git repository context, .gitignore patterns, and recursive directory traversal.
 */
export class SymbolExtractor {
    constructor(private readonly gitOperationsManager: GitOperationsManager) {}

    /**
     * Extract symbols from a single file using VS Code LSP API with timeout protection.
     * @param fileUri - VS Code URI of the file
     * @param token - Optional cancellation token
     * @returns Array of DocumentSymbols or SymbolInformation, or empty array if extraction fails/times out
     */
    async getFileSymbols(
        fileUri: vscode.Uri,
        token?: vscode.CancellationToken
    ): Promise<vscode.DocumentSymbol[] | vscode.SymbolInformation[]> {
        try {
            const symbolsPromise = vscode.commands.executeCommand<
                vscode.DocumentSymbol[] | vscode.SymbolInformation[]
            >('vscode.executeDocumentSymbolProvider', fileUri);

            const symbols = await withCancellableTimeout(
                Promise.resolve(symbolsPromise),
                FILE_SYMBOL_TIMEOUT,
                `Symbol extraction for ${path.basename(fileUri.fsPath)}`,
                token
            );

            return symbols || [];
        } catch (error) {
            // Log timeout specifically for debugging slow language servers
            if (isTimeoutError(error)) {
                Log.debug(
                    `Symbol extraction timed out for ${fileUri.fsPath} - language server may be slow`
                );
            }
            // Return empty array if no symbols, timeout, or provider not available
            return [];
        }
    }

    /**
     * Extract symbols from all files in a directory, respecting .gitignore.
     * Has built-in timeout protection and returns partial results if stopped early.
     *
     * @param targetPath - Absolute path to the directory
     * @param relativePath - Relative path for context
     * @param options - Directory extraction options (including timeoutMs and token)
     * @returns Array of file symbol results (may be partial if timeout/cancelled)
     */
    async getDirectorySymbols(
        targetPath: string,
        relativePath: string,
        options: DirectorySymbolOptions = {}
    ): Promise<FileSymbolResult[]> {
        const results: FileSymbolResult[] = [];
        const startTime = Date.now();
        const timeoutMs = options.timeoutMs ?? DIRECTORY_SYMBOL_TIMEOUT;
        const token = options.token;

        // Check cancellation before starting
        if (token?.isCancellationRequested) {
            return results;
        }

        // Read .gitignore patterns
        const repository = this.gitOperationsManager.getRepository();
        const gitignoreContent = await readGitignore(repository);
        const ig = ignore().add(gitignoreContent);

        // Debug: Log gitignore patterns loaded
        if (gitignoreContent.trim()) {
            console.log(
                `[SymbolExtractor] Loaded gitignore patterns:`,
                gitignoreContent
                    .split('\n')
                    .filter((line) => line.trim() && !line.startsWith('#'))
            );
        } else {
            console.log(`[SymbolExtractor] No gitignore patterns found`);
        }

        // Get all files in directory recursively
        const files = await this.getAllFiles(
            targetPath,
            relativePath,
            ig,
            options
        );

        // Get symbols for each file with timeout protection
        for (const filePath of files) {
            // Check overall directory timeout
            const elapsed = Date.now() - startTime;
            if (elapsed > timeoutMs) {
                Log.warn(
                    `Directory symbol extraction stopped after ${elapsed}ms (limit: ${timeoutMs}ms) - processed ${results.length} files with symbols`
                );
                break;
            }

            // Check cancellation between files
            if (token?.isCancellationRequested) {
                Log.debug(
                    `Directory symbol extraction cancelled after processing ${results.length} files`
                );
                break;
            }

            const gitRootDirectory =
                this.gitOperationsManager.getRepository()?.rootUri.fsPath || '';
            const fullPath = path.join(gitRootDirectory, filePath);
            const fileUri = vscode.Uri.file(fullPath);

            try {
                // getFileSymbols now has its own per-file timeout
                const symbols = await this.getFileSymbols(fileUri, token);
                if (symbols.length > 0) {
                    results.push({ filePath, symbols });
                }
            } catch {
                // Skip files that can't be processed (cancelled, etc.)
                continue;
            }
        }

        return results;
    }

    /**
     * Recursively get all code files in a directory, respecting .gitignore
     * @param targetPath - Absolute path to search
     * @param relativePath - Relative path for context
     * @param ignorePatterns - Ignore patterns from .gitignore
     * @param options - Directory traversal options
     * @param currentDepth - Current recursion depth
     * @returns Array of relative file paths
     */
    async getAllFiles(
        targetPath: string,
        relativePath: string,
        ignorePatterns: ReturnType<typeof ignore>,
        options: DirectorySymbolOptions = {},
        currentDepth: number = 0
    ): Promise<string[]> {
        const { maxDepth = 10, includeHidden = false, filePattern } = options;
        const files: string[] = [];

        // Prevent infinite recursion by limiting depth
        if (currentDepth > maxDepth) {
            return files;
        }

        try {
            const targetUri = vscode.Uri.file(targetPath);
            const entries = await vscode.workspace.fs.readDirectory(targetUri);

            for (const [name, type] of entries) {
                // Skip hidden files/directories unless explicitly included
                if (!includeHidden && name.startsWith('.')) {
                    continue;
                }

                // Build full path relative to git root for gitignore checking
                const fullPath =
                    relativePath === '.'
                        ? name
                        : path.posix.join(relativePath, name);

                // Validate path format before checking gitignore patterns
                if (ignore.isPathValid(fullPath)) {
                    try {
                        // Check if this entry should be ignored by .gitignore using full path
                        // Use ignores() method with full path instead of checkIgnore() with just name
                        if (ignorePatterns.ignores(fullPath)) {
                            continue;
                        }
                    } catch (error) {
                        // Log gitignore check failures for debugging but continue processing
                        console.warn(
                            `Failed to check gitignore for path "${fullPath}":`,
                            error
                        );
                    }
                } else {
                    // Log invalid paths for debugging
                    console.warn(
                        `Invalid path format for gitignore check: "${fullPath}"`
                    );
                }

                if (type === vscode.FileType.File) {
                    // Check if it's a code file
                    let shouldInclude = CodeFileUtils.isCodeFile(name);

                    // Apply additional file pattern filter if provided
                    if (shouldInclude && filePattern) {
                        shouldInclude = filePattern.test(name);
                    }

                    if (shouldInclude) {
                        files.push(fullPath);
                    }
                } else if (type === vscode.FileType.Directory) {
                    // Recursively process subdirectories with depth tracking
                    const subPath = path.join(targetPath, name);
                    const subFiles = await this.getAllFiles(
                        subPath,
                        fullPath,
                        ignorePatterns,
                        options,
                        currentDepth + 1
                    );
                    files.push(...subFiles);
                }
            }
        } catch {
            // Skip directories that can't be read
        }

        return files;
    }

    /**
     * Get the git repository root path
     * @returns Git root path or undefined if no repository
     */
    getGitRootPath(): string | undefined {
        return this.gitOperationsManager.getRepository()?.rootUri.fsPath;
    }

    /**
     * Convert absolute path to git-relative path
     * @param absolutePath - Absolute file path
     * @returns Path relative to git repository root
     */
    getGitRelativePath(absolutePath: string): string {
        const gitRoot = this.getGitRootPath();
        if (!gitRoot) {
            return path.basename(absolutePath);
        }

        if (absolutePath.startsWith(gitRoot)) {
            return path
                .relative(gitRoot, absolutePath)
                .replaceAll(path.sep, path.posix.sep);
        }

        return path.basename(absolutePath);
    }

    /**
     * Convert VS Code URI to git-relative path
     * @param uri - VS Code URI
     * @returns Path relative to git repository root
     */
    getGitRelativePathFromUri(uri: vscode.Uri): string {
        return this.getGitRelativePath(uri.fsPath);
    }

    /**
     * Check if a path exists and get its file type
     * @param targetPath - Path to check
     * @returns FileStat if path exists, undefined otherwise
     */
    async getPathStat(
        targetPath: string
    ): Promise<vscode.FileStat | undefined> {
        try {
            const targetUri = vscode.Uri.file(targetPath);
            return await vscode.workspace.fs.stat(targetUri);
        } catch {
            return undefined;
        }
    }

    /**
     * Get text document for a file URI (opens if not already open)
     * @param fileUri - VS Code URI of the file
     * @returns TextDocument or undefined if file cannot be opened
     */
    async getTextDocument(
        fileUri: vscode.Uri
    ): Promise<vscode.TextDocument | undefined> {
        try {
            return await vscode.workspace.openTextDocument(fileUri);
        } catch {
            return undefined;
        }
    }

    /**
     * Extract symbols with full context (document + git-relative paths)
     * @param fileUri - VS Code URI of the file
     * @returns Symbol extraction result with context
     */
    async extractSymbolsWithContext(fileUri: vscode.Uri): Promise<{
        symbols: vscode.DocumentSymbol[] | vscode.SymbolInformation[];
        document?: vscode.TextDocument;
        relativePath: string;
    }> {
        const symbols = await this.getFileSymbols(fileUri);
        const document = await this.getTextDocument(fileUri);
        const relativePath = this.getGitRelativePathFromUri(fileUri);

        return {
            symbols,
            document,
            relativePath,
        };
    }
}
