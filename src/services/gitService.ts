// filepath: d:\dev\copilot-review\src\services\gitService.ts
import * as vscode from 'vscode';
import * as child_process from 'child_process';
import type {
    API,
    GitExtension,
    Repository,
} from '../types/vscodeGitExtension';
import { Log } from './loggingService';
import type { WorkspaceSettingsService } from './workspaceSettingsService';

/**
 * Options for comparing branches
 */
export interface GitCompareOptions {
    base?: string;
    compare?: string;
}

/**
 * Result of a Git diff operation
 */
export interface GitDiffResult {
    diffText: string;
    refName: string;
    error?: string;
    /** Binary files that were excluded from the diff */
    binaryFiles?: string[];
}

/**
 * Repository option for selection UI
 */
interface RepositoryQuickPickItem extends vscode.QuickPickItem {
    repository: Repository;
    isSubmodule: boolean;
}

/**
 * Patterns that identify binary file diffs in git diff output
 */
const BINARY_DIFF_PATTERNS = [
    // "Binary files a/path and b/path differ" (default git diff output)
    /^Binary files .+ and .+ differ$/m,
    // "GIT binary patch" header (used with --binary flag)
    /^GIT binary patch$/m,
];

/**
 * Split a unified diff into individual file diffs
 */
function splitDiffByFile(diffText: string): string[] {
    if (!diffText || !diffText.trim()) {
        return [];
    }

    // Split at each "diff --git" boundary, keeping the delimiter
    const parts = diffText.split(/(?=^diff --git )/m);
    return parts.filter((part) => part.startsWith('diff --git'));
}

/**
 * Check if a single file diff entry is a binary diff
 */
function isBinaryFileDiff(fileDiff: string): boolean {
    return BINARY_DIFF_PATTERNS.some((pattern) => pattern.test(fileDiff));
}

/**
 * Extract the file path from a diff --git line
 */
function extractFilePath(fileDiff: string): string | null {
    // Match "diff --git a/path b/path" and extract the b/ path
    const match = /^diff --git a\/.+ b\/(.+)$/m.exec(fileDiff);
    return match?.[1] ?? null;
}

/**
 * Filter out binary file diffs from a unified diff string.
 * Binary files are wasteful to send to LLMs and may cause confusion.
 */
function filterBinaryDiffs(diffText: string): {
    filteredDiff: string;
    binaryFiles: string[];
} {
    const fileDiffs = splitDiffByFile(diffText);
    const textDiffs: string[] = [];
    const binaryFiles: string[] = [];

    for (const fileDiff of fileDiffs) {
        if (isBinaryFileDiff(fileDiff)) {
            const path = extractFilePath(fileDiff);
            if (path) {
                binaryFiles.push(path);
            }
        } else {
            textDiffs.push(fileDiff);
        }
    }

    return {
        filteredDiff: textDiffs.join(''),
        binaryFiles,
    };
}

/**
 * GitService handles Git operations for the PR Analyzer
 */
export class GitService {
    /** Common default branch names in priority order */
    private static readonly DEFAULT_BRANCH_CANDIDATES = [
        'main',
        'master',
        'develop',
        'dev',
    ] as const;

    private gitApi: API | null = null;
    private repository: Repository | null = null;
    private static instance: GitService | null = null;
    private defaultBranchCache: string | null = null;
    private workspaceSettings: WorkspaceSettingsService | null = null;

    /**
     * Get the singleton instance of GitService
     */
    public static getInstance(): GitService {
        if (!this.instance) {
            this.instance = new GitService();
        }
        return this.instance;
    }

    /**
     * Private constructor (use getInstance)
     */
    private constructor() {}

    /**
     * Initialize the Git service with smart repository selection
     * @param workspaceSettings Optional settings service for persistence
     * @returns True if Git API is available and repository is found
     */
    public async initialize(
        workspaceSettings?: WorkspaceSettingsService
    ): Promise<boolean> {
        try {
            if (workspaceSettings) {
                this.workspaceSettings = workspaceSettings;
            }

            const gitExtension =
                vscode.extensions.getExtension<GitExtension>(
                    'vscode.git'
                )?.exports;
            if (!gitExtension) {
                Log.info('Git extension not available');
                return false;
            }

            if (!gitExtension.enabled) {
                Log.info('Git extension is disabled');
                return false;
            }

            this.gitApi = gitExtension.getAPI(1);
            if (!this.gitApi) {
                Log.info('Git API not available');
                return false;
            }

            // Check all available repositories
            if (this.gitApi.repositories.length === 0) {
                Log.info('No Git repositories found');

                // If no repositories are available yet, try to detect Git repositories
                // in parent folders of the current workspace
                await this.detectParentGitRepository();

                // Recheck if we have repositories now
                if (this.gitApi.repositories.length === 0) {
                    return false;
                }
            }

            const savedRepo = this.findSavedRepository();
            if (savedRepo) {
                Log.info(`Using saved repository: ${savedRepo.rootUri.fsPath}`);
                this.repository = savedRepo;
                return true;
            }

            // Try to auto-select a main (non-submodule) repository
            const autoSelected = this.autoSelectMainRepository();
            if (autoSelected) {
                Log.info(
                    `Auto-selected main repository: ${autoSelected.rootUri.fsPath}`
                );
                this.repository = autoSelected;
                this.saveRepositorySelection(autoSelected);
                return true;
            }

            // Multiple main repositories or only submodules - prompt user
            const selectedRepo = await this.showRepositoryPicker();
            if (!selectedRepo) {
                // User canceled repository selection
                return false;
            }
            this.repository = selectedRepo;
            this.saveRepositorySelection(selectedRepo);

            return true;
        } catch (error) {
            Log.error('Failed to initialize Git service:', error);
            return false;
        }
    }

    /**
     * Collect all submodule paths from all repositories
     */
    private getSubmodulePaths(): Set<string> {
        const submodulePaths = new Set<string>();
        if (!this.gitApi) {
            return submodulePaths;
        }

        for (const repo of this.gitApi.repositories) {
            for (const submodule of repo.state.submodules) {
                // Submodule path is relative to the parent repo
                const absolutePath = vscode.Uri.joinPath(
                    repo.rootUri,
                    submodule.path
                ).fsPath;
                submodulePaths.add(this.normalizePath(absolutePath));
            }
        }
        return submodulePaths;
    }

    /**
     * Normalize path for comparison (lowercase on Windows, consistent separators)
     */
    private normalizePath(p: string): string {
        const normalized = p.replace(/\\/g, '/');
        return process.platform === 'win32'
            ? normalized.toLowerCase()
            : normalized;
    }

    /**
     * Check if a repository is a submodule
     */
    private isSubmodule(repo: Repository): boolean {
        const submodulePaths = this.getSubmodulePaths();
        return submodulePaths.has(this.normalizePath(repo.rootUri.fsPath));
    }

    /**
     * Get all non-submodule (main) repositories
     */
    private getMainRepositories(): Repository[] {
        if (!this.gitApi) {
            return [];
        }
        const submodulePaths = this.getSubmodulePaths();
        return this.gitApi.repositories.filter(
            (repo) =>
                !submodulePaths.has(this.normalizePath(repo.rootUri.fsPath))
        );
    }

    /**
     * Find the saved repository if it still exists
     */
    private findSavedRepository(): Repository | undefined {
        if (!this.workspaceSettings || !this.gitApi) {
            return undefined;
        }

        const savedPath = this.workspaceSettings.getSelectedRepositoryPath();
        if (!savedPath) {
            return undefined;
        }

        const normalizedSaved = this.normalizePath(savedPath);
        return this.gitApi.repositories.find(
            (repo) =>
                this.normalizePath(repo.rootUri.fsPath) === normalizedSaved
        );
    }

    /**
     * Try to auto-select a main repository
     * Returns undefined if there are multiple main repos or none
     */
    private autoSelectMainRepository(): Repository | undefined {
        const mainRepos = this.getMainRepositories();

        // Only auto-select if there's exactly one main repository
        if (mainRepos.length === 1) {
            return mainRepos[0];
        }

        // If all repos are submodules and there's only one, use it
        if (
            mainRepos.length === 0 &&
            this.gitApi &&
            this.gitApi.repositories.length === 1
        ) {
            return this.gitApi.repositories[0];
        }

        return undefined;
    }

    /**
     * Save the repository selection to workspace settings
     */
    private saveRepositorySelection(repo: Repository): void {
        if (this.workspaceSettings) {
            this.workspaceSettings.setSelectedRepositoryPath(
                repo.rootUri.fsPath
            );
        }
    }

    /**
     * Show repository picker with submodule indicators
     * @returns The selected repository or undefined if canceled
     */
    private async showRepositoryPicker(): Promise<Repository | undefined> {
        if (!this.gitApi) {
            return undefined;
        }

        const submodulePaths = this.getSubmodulePaths();
        const repositories = this.gitApi.repositories;

        // Create QuickPick items with submodule indicators, sorted main repos first
        const items: RepositoryQuickPickItem[] = repositories
            .map((repo: Repository) => {
                const rootPath = repo.rootUri.fsPath;
                const name = rootPath.split(/[/\\]/).pop() || rootPath;
                const isSubmodule = submodulePaths.has(
                    this.normalizePath(rootPath)
                );

                return {
                    label: isSubmodule
                        ? `$(git-submodule) ${name}`
                        : `$(repo) ${name}`,
                    description: rootPath,
                    detail: isSubmodule ? 'Submodule' : undefined,
                    repository: repo,
                    isSubmodule,
                };
            })
            .sort((a, b) => {
                // Main repos first, then submodules
                if (a.isSubmodule !== b.isSubmodule) {
                    return a.isSubmodule ? 1 : -1;
                }
                // Within same type, sort alphabetically
                return a.label.localeCompare(b.label);
            });

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select Git repository to use for PR analysis',
            title: 'Select Repository',
        });

        return selected?.repository;
    }

    /**
     * Allow user to manually select a different repository
     * Called by the lupa.selectRepository command
     * @param workspaceSettings Settings service for persistence
     * @returns True if a repository was selected, false if canceled
     */
    public async selectRepositoryManually(
        workspaceSettings?: WorkspaceSettingsService
    ): Promise<boolean> {
        if (workspaceSettings) {
            this.workspaceSettings = workspaceSettings;
        }

        // Ensure Git API is available
        if (!this.gitApi) {
            const gitExtension =
                vscode.extensions.getExtension<GitExtension>(
                    'vscode.git'
                )?.exports;
            if (!gitExtension?.enabled) {
                vscode.window.showErrorMessage(
                    'Git extension is not available'
                );
                return false;
            }
            this.gitApi = gitExtension.getAPI(1);
        }

        if (!this.gitApi || this.gitApi.repositories.length === 0) {
            vscode.window.showErrorMessage(
                'No Git repositories found in workspace'
            );
            return false;
        }

        const selectedRepo = await this.showRepositoryPicker();
        if (!selectedRepo) {
            return false;
        }

        this.repository = selectedRepo;
        this.saveRepositorySelection(selectedRepo);
        this.defaultBranchCache = null; // Clear cache when switching repos

        vscode.window.showInformationMessage(
            `Selected repository: ${selectedRepo.rootUri.fsPath.split(/[/\\]/).pop()}`
        );

        return true;
    }

    /**
     * Try to detect and open a Git repository from a parent directory
     * of the current workspace
     */
    private async detectParentGitRepository(): Promise<void> {
        if (
            !vscode.workspace.workspaceFolders ||
            vscode.workspace.workspaceFolders.length === 0
        ) {
            return; // No workspace open
        }

        try {
            // For each workspace folder
            for (const workspaceFolder of vscode.workspace.workspaceFolders) {
                // Try to detect Git repository in parent folders
                const folderPath = workspaceFolder.uri.fsPath;

                // Check if VS Code Git extension has any repositories in parent folders
                // that it can detect but hasn't opened yet
                await vscode.commands.executeCommand(
                    'git.openRepository',
                    folderPath
                );

                // After execution of the command, check again if new repositories are available
                if (this.gitApi && this.gitApi.repositories.length > 0) {
                    Log.info(
                        `Detected and opened Git repository for workspace folder: ${folderPath}`
                    );
                    break; // Successfully found a repository
                }
            }
        } catch (error) {
            Log.error(
                'Error detecting Git repository in parent directories:',
                error
            );
        }
    }

    /**
     * Check if Git service is initialized
     */
    public isInitialized(): boolean {
        return !!this.repository;
    }

    /**
     * Get the current repository
     */
    public getRepository(): Repository | null {
        return this.repository;
    }

    /**
     * Get the default branch of the repository
     * Uses local-only methods first, falling back to network calls only as a last resort
     */
    public async getDefaultBranch(): Promise<string | undefined> {
        if (this.defaultBranchCache) {
            return this.defaultBranchCache;
        }

        try {
            if (!this.repository) {
                throw new Error('Git repository not initialized');
            }

            // Method 1: Try to get from git config (local, no network)
            const remotes = await this.repository.getConfigs();
            const originHead = remotes.find(
                (config) => config.key === 'remote.origin.head'
            );

            if (originHead) {
                // Extract branch name from value like 'refs/heads/main'
                const match = originHead.value.match(/refs\/heads\/(.+)/);
                if (match && match[1]) {
                    this.defaultBranchCache = match[1];
                    Log.info(`Default branch from config: ${match[1]}`);
                    return match[1];
                }
            }

            // Method 2: Try symbolic-ref for origin/HEAD (local, no network)
            // This reference is set when cloning and persists locally
            try {
                const symbolicRef = await this.executeGitCommand([
                    'symbolic-ref',
                    '--short',
                    'refs/remotes/origin/HEAD',
                ]);
                if (symbolicRef) {
                    // Result is like "origin/main", extract just the branch name
                    const branchName = symbolicRef
                        .replace(/^origin\//, '')
                        .trim();
                    if (branchName) {
                        this.defaultBranchCache = branchName;
                        Log.info(
                            `Default branch from symbolic-ref: ${branchName}`
                        );
                        return branchName;
                    }
                }
            } catch {
                // symbolic-ref fails if refs/remotes/origin/HEAD doesn't exist, continue
            }

            // Method 3: Check for remote tracking branches locally
            // These exist after clone/fetch without requiring network access
            for (const branch of GitService.DEFAULT_BRANCH_CANDIDATES) {
                try {
                    await this.executeGitCommand([
                        'rev-parse',
                        '--verify',
                        '--quiet',
                        `refs/remotes/origin/${branch}`,
                    ]);
                    // If we get here, the remote tracking branch exists
                    this.defaultBranchCache = branch;
                    Log.info(
                        `Default branch from remote tracking ref: ${branch}`
                    );
                    return branch;
                } catch {
                    // Branch doesn't exist, try next
                }
            }

            // Method 4: Check for local branches with common names
            // Use explicit loop to maintain consistent priority order
            for (const branch of GitService.DEFAULT_BRANCH_CANDIDATES) {
                try {
                    await this.executeGitCommand([
                        'rev-parse',
                        '--verify',
                        '--quiet',
                        `refs/heads/${branch}`,
                    ]);
                    // If we get here, the local branch exists
                    this.defaultBranchCache = branch;
                    Log.info(`Default branch from local branch: ${branch}`);
                    return branch;
                } catch {
                    // Branch doesn't exist, try next
                }
            }

            // Method 5: Try network call as LAST RESORT
            // This may fail if user doesn't have remote access (SSH keys, permissions, etc.)
            const remote = this.repository.state.remotes.find(
                (r) => r.name === 'origin'
            );
            if (remote) {
                try {
                    const gitOutput = await this.executeGitCommand([
                        'remote',
                        'show',
                        remote.name,
                    ]);
                    const match = gitOutput.match(/HEAD branch: (.+)/);
                    if (match && match[1]) {
                        this.defaultBranchCache = match[1];
                        Log.info(`Default branch from remote: ${match[1]}`);
                        return match[1];
                    }
                } catch (networkError) {
                    // Network/permission error - expected in offline or restricted environments
                    Log.info(
                        'Could not fetch default branch from remote (requires network/SSH access), falling back to current HEAD',
                        networkError
                    );
                }
            }

            // Method 6: Final fallback - use current HEAD if it's a branch
            const headBranch = this.repository.state.HEAD?.name;
            if (headBranch) {
                Log.info(
                    `Using current HEAD as default branch fallback: ${headBranch}`
                );
            }
            return headBranch;
        } catch (error) {
            Log.error('Error getting default branch:', error);
            return undefined;
        }
    }

    /**
     * Compare two branches or refs and get the diff
     * @param options The compare options
     */
    public async compareBranches(
        options: GitCompareOptions
    ): Promise<GitDiffResult> {
        try {
            if (!this.isInitialized() || !this.repository) {
                throw new Error('Git service not initialized');
            }

            const base = options.base || (await this.getDefaultBranch());
            const compare = options.compare || this.repository.state.HEAD?.name;

            if (!base) {
                return {
                    diffText: '',
                    refName: compare || 'unknown',
                    error: 'Could not determine base branch for comparison',
                };
            }

            if (!compare) {
                return {
                    diffText: '',
                    refName: 'unknown',
                    error: 'Could not determine comparison branch',
                };
            }

            // Use Git command directly for three-dot diff format
            const rawDiff = await this.executeGitCommand([
                'diff',
                `${base}...${compare}`,
            ]);

            // Filter out binary file diffs (wasteful to send to LLM)
            const { filteredDiff, binaryFiles } = filterBinaryDiffs(rawDiff);

            if (binaryFiles.length > 0) {
                Log.info(
                    `Filtered ${binaryFiles.length} binary file(s) from diff: ${binaryFiles.join(', ')}`
                );
            }

            return {
                diffText: filteredDiff,
                refName: compare,
                binaryFiles: binaryFiles.length > 0 ? binaryFiles : undefined,
            };
        } catch (error) {
            Log.error('Error comparing branches:', error);
            return {
                diffText: '',
                refName: options.compare || 'unknown',
                error: `Failed to compare branches: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
    }

    /**
     * Get uncommitted changes
     */
    public async getUncommittedChanges(): Promise<GitDiffResult> {
        try {
            if (!this.isInitialized() || !this.repository) {
                throw new Error('Git service not initialized');
            }

            // Check if there are any changes using repository state
            const hasChanges =
                this.repository.state.workingTreeChanges.length > 0 ||
                this.repository.state.indexChanges.length > 0;

            if (!hasChanges) {
                return {
                    diffText: '',
                    refName: 'uncommitted changes',
                    error: 'No uncommitted changes found',
                };
            }

            // Get staged changes using VS Code API
            const stagedDiff = await this.repository.diff(true);

            // Get unstaged changes using VS Code API
            const unstagedDiff = await this.repository.diff(false);

            // Combine them
            const rawDiff =
                `${stagedDiff ? `Staged changes:\n${stagedDiff}\n\n` : ''}${unstagedDiff ? `Unstaged changes:\n${unstagedDiff}` : ''}`.trim();

            // Filter out binary file diffs (wasteful to send to LLM)
            const { filteredDiff, binaryFiles } = filterBinaryDiffs(rawDiff);

            if (binaryFiles.length > 0) {
                Log.info(
                    `Filtered ${binaryFiles.length} binary file(s) from uncommitted changes: ${binaryFiles.join(', ')}`
                );
            }

            return {
                diffText: filteredDiff,
                refName: 'uncommitted changes',
                binaryFiles: binaryFiles.length > 0 ? binaryFiles : undefined,
            };
        } catch (error) {
            Log.error('Error getting uncommitted changes:', error);
            return {
                diffText: '',
                refName: 'uncommitted changes',
                error: `Failed to get uncommitted changes: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
    }

    /**
     * Execute a Git command
     * @param args Arguments to pass to the git command
     */
    private async executeGitCommand(args: string[]): Promise<string> {
        if (!this.isInitialized() || !this.repository) {
            throw new Error('Git service not initialized');
        }

        return new Promise<string>((resolve, reject) => {
            const cwd = this.repository!.rootUri.fsPath;

            const gitProcess = child_process.spawn('git', args, { cwd });

            let stdout = '';
            let stderr = '';

            gitProcess.stdout.on('data', (data: Buffer) => {
                stdout += data.toString();
            });

            gitProcess.stderr.on('data', (data: Buffer) => {
                stderr += data.toString();
            });

            gitProcess.on('close', (code: number) => {
                if (code === 0) {
                    resolve(stdout.trim());
                } else {
                    reject(new Error(`Git command failed: ${stderr}`));
                }
            });

            gitProcess.on('error', (err: Error) => {
                reject(err);
            });
        });
    }
}
