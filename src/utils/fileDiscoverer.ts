import * as path from 'path';
import * as os from 'os';
import { fdir } from 'fdir';
import picomatch, { PicomatchOptions } from 'picomatch';
import ignore from 'ignore';
import { PathSanitizer } from './pathSanitizer';
import { readGitignore } from './gitUtils';
import { Repository } from '../types/vscodeGitExtension';
import { TimeoutError } from '../types/errorTypes';
import { Log } from '../services/loggingService';

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
        } = options;

        if (!gitRepo) {
            throw new Error('Git repository not found');
        }

        // Sanitize and resolve search path
        const sanitizedPath = PathSanitizer.sanitizePath(searchPath);
        const gitRootDirectory = gitRepo.rootUri.fsPath;
        const targetPath = path.join(gitRootDirectory, sanitizedPath);

        const abortController = new AbortController();
        const timeoutId = setTimeout(() => {
            Log.warn(`[Timeout] File discovery aborted after ${timeoutMs}ms`);
            abortController.abort();
        }, timeoutMs);

        try {
            const result = await this.performFileDiscovery(gitRepo, {
                gitRootDirectory,
                targetPath,
                includePattern,
                excludePattern,
                respectGitignore,
                maxResults,
                abortSignal: abortController.signal,
            });
            return result;
        } catch (error) {
            if (abortController.signal.aborted) {
                throw TimeoutError.create('File discovery', timeoutMs);
            }
            throw new Error(
                `File discovery failed: ${error instanceof Error ? error.message : String(error)}`
            );
        } finally {
            clearTimeout(timeoutId);
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

            if (ig && ig.ignores(relativePath)) {
                return true;
            }

            const posixPath = relativePath.replaceAll(path.sep, path.posix.sep);
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
