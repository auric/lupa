import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { fdir } from 'fdir';
import picomatch, { PicomatchOptions } from 'picomatch';
import ignore from 'ignore';
import { PathSanitizer } from './pathSanitizer';
import { readGitignore } from './gitUtils';
import { Repository } from '../types/vscodeGitExtension';
import { Log } from '../services/loggingService';
import { isCancellationError } from './asyncUtils';

export interface FileDiscoveryOptions {
    /**
     * Directory to search within, relative to project root
     */
    searchPath?: string;

    // Glob pattern to include files (e.g., "*.ts", "**/*.js")
    includePattern: string;

    /**
     * Glob pattern to exclude files (takes precedence over includePattern)
     */
    excludePattern?: string;

    /**
     * Whether to respect .gitignore rules
     */
    respectGitignore?: boolean;

    /**
     * Maximum number of files to return (prevents excessive memory usage)
     */
    maxResults?: number;

    /**
     * Timeout in milliseconds for file discovery
     */
    timeoutMs?: number;

    /**
     * VS Code CancellationToken for user-initiated cancellation.
     * Internally converted to AbortSignal for fdir compatibility.
     */
    cancellationToken?: vscode.CancellationToken;
}

export interface FileDiscoveryResult {
    /**
     * Array of file paths relative to git root
     */
    files: string[];

    /**
     * Whether the search was truncated due to limits
     */
    truncated: boolean;

    /**
     * Total number of files found before truncation
     */
    totalFound: number;
}

/**
 * Utility for discovering files in a project with glob patterns and gitignore support.
 * Extracted from findFilesByPatternTool.ts to enable reuse across multiple tools.
 */
export class FileDiscoverer {
    private static readonly DEFAULT_MAX_RESULTS = 1000;
    private static readonly DEFAULT_TIMEOUT = 15000; // 15 seconds

    /**
     * Discover files matching the specified criteria.
     * Uses AbortController for proper cancellation of fdir crawl on timeout.
     * Supports external abort signal for user-initiated cancellation.
     */
    static async discoverFiles(
        gitRepo: Repository,
        options: FileDiscoveryOptions
    ): Promise<FileDiscoveryResult> {
        const {
            searchPath = '.',
            includePattern,
            excludePattern,
            respectGitignore = true,
            maxResults = this.DEFAULT_MAX_RESULTS,
            timeoutMs = this.DEFAULT_TIMEOUT,
            cancellationToken,
        } = options;

        if (!gitRepo) {
            throw new Error('Git repository not found');
        }

        if (cancellationToken?.isCancellationRequested) {
            throw new vscode.CancellationError();
        }

        // Sanitize and resolve search path
        const sanitizedPath = PathSanitizer.sanitizePath(searchPath);
        const gitRootDirectory = gitRepo.rootUri.fsPath;
        const targetPath = path.join(gitRootDirectory, sanitizedPath);

        // Create AbortController for timeout
        const timeoutController = new AbortController();
        const timeoutId = setTimeout(() => {
            Log.warn(`[Timeout] File discovery aborted after ${timeoutMs}ms`);
            timeoutController.abort();
        }, timeoutMs);

        // Convert CancellationToken to AbortController for fdir compatibility
        let cancellationController: AbortController | undefined;
        let cancellationDisposable: vscode.Disposable | undefined;
        if (cancellationToken) {
            cancellationController = new AbortController();
            cancellationDisposable = cancellationToken.onCancellationRequested(
                () => {
                    cancellationController!.abort();
                }
            );
        }

        // Combine timeout and cancellation signals
        const combinedSignal = cancellationController
            ? AbortSignal.any([
                  timeoutController.signal,
                  cancellationController.signal,
              ])
            : timeoutController.signal;

        try {
            const result = await this.performFileDiscovery(gitRepo, {
                gitRootDirectory,
                targetPath,
                includePattern,
                excludePattern,
                respectGitignore,
                maxResults,
                abortSignal: combinedSignal,
            });

            // fdir resolves with partial results when aborted (does not reject).
            // Return partial results with truncated flag instead of throwing,
            // so LLM gets useful data even when timeout/cancellation occurs.
            if (cancellationToken?.isCancellationRequested) {
                // User cancellation still throws to stop the analysis
                throw new vscode.CancellationError();
            }
            if (timeoutController.signal.aborted) {
                // Timeout: return partial results with truncated=true
                Log.info(
                    `File discovery timed out, returning ${result.files.length} partial results`
                );
                return {
                    files: result.files,
                    truncated: true,
                    totalFound: result.totalFound,
                };
            }

            return result;
        } catch (error) {
            // Rethrow CancellationError directly - user cancelled the operation
            if (isCancellationError(error)) {
                throw error;
            }
            // Note: fdir never throws on abort - it resolves with partial results.
            // This catch block handles errors from other operations (readGitignore, etc.)
            throw new Error(
                `File discovery failed: ${error instanceof Error ? error.message : String(error)}`
            );
        } finally {
            clearTimeout(timeoutId);
            cancellationDisposable?.dispose();
        }
    }

    /**
     * Perform the actual file discovery using fdir and filtering.
     * Uses AbortSignal for proper cancellation and filters during crawl for efficiency.
     */
    private static async performFileDiscovery(
        gitRepo: Repository,
        options: {
            gitRootDirectory: string;
            targetPath: string;
            includePattern: string;
            excludePattern?: string;
            respectGitignore: boolean;
            maxResults: number;
            abortSignal: AbortSignal;
        }
    ): Promise<FileDiscoveryResult> {
        const {
            gitRootDirectory,
            targetPath,
            includePattern,
            excludePattern,
            respectGitignore,
            maxResults,
            abortSignal,
        } = options;

        let ig: ReturnType<typeof ignore> | undefined;
        if (respectGitignore) {
            const gitignorePatterns = await readGitignore(gitRepo);
            ig = ignore().add(gitignorePatterns);
        }

        // Setup picomatch options for cross-platform compatibility
        const picomatchOptions: PicomatchOptions = {
            windows: os.platform() === 'win32',
            // matchBase allows patterns without slashes to match against basename
            // e.g., "*.ts" matches "src/components/Button.ts" by matching "Button.ts"
            matchBase: true,
        };

        // Build fdir crawler, add withGlobFunction to bundle it correctly
        let crawler = new fdir()
            .withGlobFunction(picomatch)
            .withAbortSignal(abortSignal)
            .withFullPaths()
            .globWithOptions([includePattern], picomatchOptions);

        const excludeMatcher = excludePattern
            ? picomatch(excludePattern, picomatchOptions)
            : undefined;

        crawler = crawler.filter((filePath) => {
            const relativePath = path
                .relative(gitRootDirectory, filePath)
                .replaceAll(path.sep, path.posix.sep);

            if (ig && ig.ignores(relativePath)) {
                return false;
            }

            if (excludeMatcher && excludeMatcher(relativePath)) {
                return false;
            }

            return true;
        });

        crawler = crawler.exclude((_dirName, dirPath) => {
            const relativePath = path.relative(gitRootDirectory, dirPath);
            const posixPath = relativePath.replaceAll(path.sep, path.posix.sep);

            // Use normalized POSIX path for gitignore checks (consistent with file filter)
            if (ig && ig.ignores(posixPath)) {
                return true;
            }

            if (
                posixPath === '.git' ||
                posixPath.startsWith('.git/') ||
                posixPath.includes('/.git/')
            ) {
                return true;
            }

            return false;
        });

        // Discover all files (async to avoid blocking the event loop)
        const allFiles = await crawler.crawl(targetPath).withPromise();

        // Convert to relative paths from git root (filtering already done during crawl)
        const relativeFiles = allFiles
            .map((file) =>
                path
                    .relative(gitRootDirectory, file)
                    .replaceAll(path.sep, path.posix.sep)
            )
            .sort();

        const totalFound = relativeFiles.length;
        const truncated = relativeFiles.length > maxResults;
        const files = relativeFiles.slice(0, maxResults);

        return {
            files,
            truncated,
            totalFound,
        };
    }
}
