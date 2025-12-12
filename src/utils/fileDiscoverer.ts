import * as path from 'path';
import * as os from 'os';
import { fdir } from 'fdir';
import picomatch, { PicomatchOptions } from 'picomatch';
import ignore from 'ignore';
import { PathSanitizer } from './pathSanitizer';
import { readGitignore } from './gitUtils';
import { Repository } from '../types/vscodeGitExtension';

export interface FileDiscoveryOptions {
  /**
   * Directory to search within, relative to project root
   */
  searchPath?: string;

  // Glob pattern to include files (e.g., "*.ts", "**/*.js")
  includePattern?: string;

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
   * Discover files matching the specified criteria
   */
  static async discoverFiles(
    gitRepo: Repository,
    options: FileDiscoveryOptions = {}
  ): Promise<FileDiscoveryResult> {
    const {
      searchPath = '.',
      includePattern,
      excludePattern,
      respectGitignore = true,
      maxResults = this.DEFAULT_MAX_RESULTS,
      timeoutMs = this.DEFAULT_TIMEOUT
    } = options;

    if (!gitRepo) {
      throw new Error('Git repository not found');
    }

    // Sanitize and resolve search path
    const sanitizedPath = PathSanitizer.sanitizePath(searchPath);
    const gitRootDirectory = gitRepo.rootUri.fsPath;
    const targetPath = path.join(gitRootDirectory, sanitizedPath);

    // Setup timeout protection
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('File discovery timeout - search too expensive')), timeoutMs)
    );

    try {
      const discoveryPromise = this.performFileDiscovery(gitRepo, {
        gitRootDirectory,
        targetPath,
        includePattern,
        excludePattern,
        respectGitignore,
        maxResults
      });

      const result = await Promise.race([discoveryPromise, timeoutPromise]);
      return result;
    } catch (error) {
      throw new Error(`File discovery failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Perform the actual file discovery using fdir and filtering
   */
  private static async performFileDiscovery(
    gitRepo: Repository,
    options: {
      gitRootDirectory: string;
      targetPath: string;
      includePattern?: string;
      excludePattern?: string;
      respectGitignore: boolean;
      maxResults: number;
    }
  ): Promise<FileDiscoveryResult> {
    const { gitRootDirectory, targetPath, includePattern, excludePattern, respectGitignore, maxResults } = options;

    // Read gitignore patterns if requested
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

    // Build fdir crawler
    let crawler = new fdir().withFullPaths();

    // Add include pattern if provided
    if (includePattern) {
      crawler = crawler.globWithOptions([includePattern], picomatchOptions);
    }

    crawler = crawler.exclude((_dirName, dirPath) => {
      const relativePath = path.relative(gitRootDirectory, dirPath);

      if (ig && ig.ignores(relativePath)) {
        return true;
      }

      const posixPath = relativePath.replaceAll(path.sep, path.posix.sep);
      if (posixPath === '.git' || posixPath.startsWith('.git/') || posixPath.includes('/.git/')) {
        return true;
      }

      return false;
    });

    // Discover all files
    const allFiles = crawler.crawl(targetPath).sync();

    // Convert to relative paths from git root
    let relativeFiles = allFiles.map(file =>
      path.relative(gitRootDirectory, file).replaceAll(path.sep, path.posix.sep)
    );

    if (ig) {
      relativeFiles = ig.filter(relativeFiles);
    }

    // Apply exclude pattern if provided (takes precedence over include)
    if (excludePattern) {
      const excludeMatcher = picomatch(excludePattern, picomatchOptions);
      relativeFiles = relativeFiles.filter(file => !excludeMatcher(file));
    }

    // Sort files for consistent results
    relativeFiles.sort();

    // Apply result limits
    const totalFound = relativeFiles.length;
    const truncated = relativeFiles.length > maxResults;
    const files = relativeFiles.slice(0, maxResults);

    return {
      files,
      truncated,
      totalFound
    };
  }
}
