import * as path from 'path';
import * as vscode from 'vscode';
import ignore from 'ignore';
import { GitOperationsManager } from '../services/gitOperationsManager';
import { readGitignore } from '../utils/gitUtils';
import { CodeFileUtils } from './codeFileUtils';
import {
    withCancellableTimeout,
    isTimeoutError,
    isCancellationError,
    rethrowIfCancellationOrTimeout,
} from './asyncUtils';
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
 * Result structure for directory symbol extraction with truncation metadata
 */
export interface DirectorySymbolsResult {
    /** Array of file symbol results */
    results: FileSymbolResult[];
    /** True if extraction was stopped early due to timeout or cancellation */
    truncated: boolean;
    /** Number of files that timed out during symbol extraction */
    timedOutFiles: number;
}

/**
 * Result from file discovery with explicit truncation tracking
 */
interface FileDiscoveryResult {
    /** Array of relative file paths found */
    files: string[];
    /** True if discovery was stopped early due to timeout */
    truncated: boolean;
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
     * @returns Array of DocumentSymbols or SymbolInformation
     * @throws CancellationError if cancelled
     * @throws TimeoutError if extraction times out
     * @returns Empty array for other LSP errors (non-fatal)
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
            if (isCancellationError(error)) {
                throw error;
            }
            if (isTimeoutError(error)) {
                Log.debug(
                    `Symbol extraction timed out for ${fileUri.fsPath} - language server may be slow`
                );
                throw error;
            }
            // Other errors (LSP failures, etc.) return empty - don't abort entire directory scan
            const message =
                error instanceof Error ? error.message : String(error);
            Log.warn(
                `Symbol extraction failed for ${fileUri.fsPath}: ${message}`
            );
            return [];
        }
    }

    /**
     * Extract symbols from all files in a directory, respecting .gitignore.
     * Has built-in timeout protection for the overall operation.
     *
     * Behavior:
     * - **Timeout**: Returns partial results with `truncated: true`
     * - **Cancellation**: Throws CancellationError (pre-cancellation or mid-loop)
     * - **Per-file timeout**: Increments `timedOutFiles` counter and continues
     *
     * @param targetPath - Absolute path to the directory
     * @param relativePath - Relative path for context
     * @param options - Directory extraction options (including timeoutMs and token)
     * @returns Directory symbol results with truncation metadata
     * @throws CancellationError if token is cancelled before or during extraction
     */
    async getDirectorySymbols(
        targetPath: string,
        relativePath: string,
        options: DirectorySymbolOptions = {}
    ): Promise<DirectorySymbolsResult> {
        const results: FileSymbolResult[] = [];
        const startTime = Date.now();
        const timeoutMs = options.timeoutMs ?? DIRECTORY_SYMBOL_TIMEOUT;
        const token = options.token;
        let timedOutFiles = 0;

        if (token?.isCancellationRequested) {
            throw new vscode.CancellationError();
        }

        const repository = this.gitOperationsManager.getRepository();
        const gitignoreContent = await readGitignore(repository);
        const ig = ignore().add(gitignoreContent);

        if (gitignoreContent.trim()) {
            Log.debug(
                `Loaded gitignore patterns: ${gitignoreContent
                    .split('\n')
                    .filter((line) => line.trim() && !line.startsWith('#'))
                    .join(', ')}`
            );
        } else {
            Log.debug(`No gitignore patterns found`);
        }

        const discoveryResult = await this.getAllFiles(
            targetPath,
            relativePath,
            ig,
            options,
            0,
            startTime,
            timeoutMs
        );

        const { files, truncated: discoveryTruncated } = discoveryResult;
        let truncated = discoveryTruncated;
        if (truncated) {
            Log.debug(
                `File discovery hit timeout - processing ${files.length} files found so far`
            );
        }

        for (const filePath of files) {
            const elapsed = Date.now() - startTime;
            if (elapsed > timeoutMs) {
                Log.warn(
                    `Directory symbol extraction stopped after ${elapsed}ms (limit: ${timeoutMs}ms) - processed ${results.length} files with symbols`
                );
                truncated = true;
                break;
            }

            if (token?.isCancellationRequested) {
                Log.debug(
                    `Directory symbol extraction cancelled after processing ${results.length} files`
                );
                throw new vscode.CancellationError();
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
            } catch (error) {
                if (isCancellationError(error)) {
                    Log.debug(`Symbol extraction cancelled for ${filePath}`);
                    throw error;
                }

                if (isTimeoutError(error)) {
                    timedOutFiles++;
                }

                const message =
                    error instanceof Error ? error.message : String(error);
                Log.debug(`Skipping file ${filePath}: ${message}`);
                continue;
            }
        }

        // If any files timed out, results are incomplete - set truncated flag
        // This centralizes "results incomplete" semantics and reduces duplication in callers
        if (timedOutFiles > 0) {
            truncated = true;
        }

        return { results, truncated, timedOutFiles };
    }

    /**
     * Recursively get all code files in a directory, respecting .gitignore
     * @param targetPath - Absolute path to search
     * @param relativePath - Relative path for context
     * @param ignorePatterns - Ignore patterns from .gitignore
     * @param options - Directory traversal options
     * @param currentDepth - Current recursion depth
     * @param startTime - Start time for timeout tracking (passed from getDirectorySymbols)
     * @param timeoutMs - Timeout in milliseconds for entire traversal
     * @returns File discovery result with explicit truncation flag
     * @throws CancellationError if cancelled
     */
    async getAllFiles(
        targetPath: string,
        relativePath: string,
        ignorePatterns: ReturnType<typeof ignore>,
        options: DirectorySymbolOptions = {},
        currentDepth: number = 0,
        startTime: number = Date.now(),
        timeoutMs: number = DIRECTORY_SYMBOL_TIMEOUT
    ): Promise<FileDiscoveryResult> {
        const {
            maxDepth = 10,
            includeHidden = false,
            filePattern,
            token,
        } = options;
        const files: string[] = [];

        if (Date.now() - startTime > timeoutMs) {
            Log.warn(
                `File discovery stopped after timeout - found ${files.length} files so far`
            );
            return { files, truncated: true };
        }

        if (token?.isCancellationRequested) {
            throw new vscode.CancellationError();
        }

        if (currentDepth > maxDepth) {
            return { files, truncated: false };
        }

        try {
            const targetUri = vscode.Uri.file(targetPath);
            const entries = await vscode.workspace.fs.readDirectory(targetUri);

            for (const [name, type] of entries) {
                if (Date.now() - startTime > timeoutMs) {
                    Log.warn(
                        `File discovery stopped after timeout - found ${files.length} files so far`
                    );
                    return { files, truncated: true };
                }

                if (token?.isCancellationRequested) {
                    throw new vscode.CancellationError();
                }
                if (!includeHidden && name.startsWith('.')) {
                    continue;
                }

                const fullPath =
                    relativePath === '.'
                        ? name
                        : path.posix.join(relativePath, name);

                if (ignore.isPathValid(fullPath)) {
                    try {
                        // Check if this entry should be ignored by .gitignore using full path
                        // Use ignores() method with full path instead of checkIgnore() with just name
                        if (ignorePatterns.ignores(fullPath)) {
                            continue;
                        }
                    } catch (error) {
                        const message =
                            error instanceof Error
                                ? error.message
                                : String(error);
                        Log.warn(
                            `Failed to check gitignore for path "${fullPath}": ${message}`
                        );
                    }
                } else {
                    Log.warn(
                        `Invalid path format for gitignore check: "${fullPath}"`
                    );
                }

                if (type === vscode.FileType.File) {
                    let shouldInclude = CodeFileUtils.isCodeFile(name);

                    if (shouldInclude && filePattern) {
                        shouldInclude = filePattern.test(name);
                    }

                    if (shouldInclude) {
                        files.push(fullPath);
                    }
                } else if (type === vscode.FileType.Directory) {
                    const subPath = path.join(targetPath, name);
                    const subResult = await this.getAllFiles(
                        subPath,
                        fullPath,
                        ignorePatterns,
                        options,
                        currentDepth + 1,
                        startTime,
                        timeoutMs
                    );
                    files.push(...subResult.files);
                    if (subResult.truncated) {
                        return { files, truncated: true };
                    }
                }
            }
        } catch (error) {
            rethrowIfCancellationOrTimeout(error);

            const message =
                error instanceof Error ? error.message : String(error);
            Log.debug(`Cannot read directory ${targetPath}: ${message}`);
        }

        return { files, truncated: false };
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
     * @param token - Cancellation token for aborting the operation
     * @returns Symbol extraction result with context
     */
    async extractSymbolsWithContext(
        fileUri: vscode.Uri,
        token: vscode.CancellationToken
    ): Promise<{
        symbols: vscode.DocumentSymbol[] | vscode.SymbolInformation[];
        document?: vscode.TextDocument;
        relativePath: string;
    }> {
        const symbols = await this.getFileSymbols(fileUri, token);
        const document = await this.getTextDocument(fileUri);
        const relativePath = this.getGitRelativePathFromUri(fileUri);

        return {
            symbols,
            document,
            relativePath,
        };
    }
}
