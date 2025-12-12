// filepath: d:\dev\copilot-review\src\services\gitService.ts
import * as vscode from 'vscode';
import * as child_process from 'child_process';
import type {
    API,
    GitExtension,
    Repository
} from '../types/vscodeGitExtension';
import { RefType } from '../types/vscodeGitExtension';
import { Log } from './loggingService';

/**
 * Represents a Git commit
 */
export interface GitCommit {
    hash: string;
    message: string;
    author: string;
    date: number;
}

/**
 * Represents Git branch information
 */
export interface GitBranch {
    name: string;
    isDefault: boolean;
    isCurrent: boolean;
}

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
}

/**
 * Repository option for selection UI
 */
interface RepositoryQuickPickItem extends vscode.QuickPickItem {
    repository: Repository;
}

/**
 * GitService handles Git operations for the PR Analyzer
 */
export class GitService {
    private gitApi: API | null = null;
    private repository: Repository | null = null;
    private static instance: GitService | null = null;
    private defaultBranchCache: string | null = null;

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
    private constructor() { }

    /**
     * Initialize the Git service
     * @returns True if Git API is available and repository is found
     */
    public async initialize(): Promise<boolean> {
        try {
            const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git')?.exports;
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

            // If multiple repositories are available, let the user select one
            if (this.gitApi.repositories.length > 1) {
                const selectedRepo = await this.selectRepository();
                if (!selectedRepo) {
                    // User canceled repository selection
                    return false;
                }
                this.repository = selectedRepo;
            } else {
                // Just use the only repository
                this.repository = this.gitApi.repositories[0];
            }

            return true;
        } catch (error) {
            Log.error('Failed to initialize Git service:', error);
            return false;
        }
    }

    /**
     * Allow user to select a repository when multiple are available
     * @returns The selected repository or undefined if selection was canceled
     */
    private async selectRepository(): Promise<Repository | undefined> {
        // Get list of repositories
        const repositories = this.gitApi!.repositories;

        // Create QuickPick items for each repository
        const items: RepositoryQuickPickItem[] = repositories.map((repo: Repository) => {
            // Get the repository root path
            const rootPath = repo.rootUri.fsPath;
            // Get repository name (last segment of path)
            const name = rootPath.split(/[/\\]/).pop() || rootPath;

            return {
                label: name,
                description: rootPath,
                repository: repo
            };
        });

        // Show QuickPick for repository selection
        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select Git repository to use for PR analysis',
            title: 'Multiple Git repositories detected'
        });

        // Return the selected repository or undefined if canceled
        return selected ? selected.repository : undefined;
    }

    /**
     * Try to detect and open a Git repository from a parent directory
     * of the current workspace
     */
    private async detectParentGitRepository(): Promise<void> {
        if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
            return; // No workspace open
        }

        try {
            // For each workspace folder
            for (const workspaceFolder of vscode.workspace.workspaceFolders) {
                // Try to detect Git repository in parent folders
                const folderPath = workspaceFolder.uri.fsPath;

                // Check if VS Code Git extension has any repositories in parent folders
                // that it can detect but hasn't opened yet
                await vscode.commands.executeCommand('git.openRepository', folderPath);

                // After execution of the command, check again if new repositories are available
                if (this.gitApi && this.gitApi.repositories.length > 0) {
                    Log.info(`Detected and opened Git repository for workspace folder: ${folderPath}`);
                    break; // Successfully found a repository
                }
            }
        } catch (error) {
            Log.error('Error detecting Git repository in parent directories:', error);
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
     */
    public async getDefaultBranch(): Promise<string | undefined> {
        if (this.defaultBranchCache) {
            return this.defaultBranchCache;
        }

        try {
            if (!this.repository) {
                throw new Error('Git repository not initialized');
            }

            // Try to get the default branch from upstream remote
            const remotes = await this.repository.getConfigs();
            const originHead = remotes.find(config => config.key === 'remote.origin.head');

            if (originHead) {
                // Extract branch name from value like 'refs/heads/main'
                const match = originHead.value.match(/refs\/heads\/(.+)/);
                if (match) {
                    this.defaultBranchCache = match[1];
                    return match[1];
                }
            }

            // Try to get the default branch from origin remote via git command
            const remote = this.repository.state.remotes.find(r => r.name === 'origin');
            if (remote) {
                // Execute git command to get the default branch info
                const result = await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: 'Fetching default branch information' },
                    async () => {
                        const gitOutput = await this.executeGitCommand(['remote', 'show', remote.name]);
                        const match = gitOutput.match(/HEAD branch: (.+)/);
                        return match ? match[1] : undefined;
                    }
                );

                if (result) {
                    this.defaultBranchCache = result;
                    return result;
                }
            }

            // Fallback to common default branch names
            const commonDefaults = ['develop', 'main', 'master', 'dev'];
            const branchRefs = await this.repository.getRefs({
                pattern: commonDefaults,
                count: 1
            });

            if (branchRefs.length > 0) {
                const defaultBranch = branchRefs[0].name;
                if (defaultBranch) {
                    this.defaultBranchCache = defaultBranch;
                    return defaultBranch;
                }
            }

            // If none found, use current HEAD if it's a branch
            return this.repository.state.HEAD?.name;
        } catch (error) {
            Log.error('Error getting default branch:', error);
            return undefined;
        }
    }

    /**
     * Get all branches in the repository
     */
    public async getBranches(): Promise<GitBranch[]> {
        try {
            if (!this.isInitialized() || !this.repository) {
                throw new Error('Git service not initialized');
            }

            const defaultBranch = await this.getDefaultBranch();
            const currentBranch = this.repository.state.HEAD?.name;

            // Get local branches from the repository
            const branchRefs = await this.repository.getRefs({
                pattern: '*',
                includeCommitDetails: false
            });

            // Filter to only include local branches (type = HEAD)
            const branches: GitBranch[] = branchRefs
                .filter(ref => ref.type === RefType.Head)
                .map(ref => ({
                    name: ref.name || '',
                    isDefault: ref.name === defaultBranch,
                    isCurrent: ref.name === currentBranch
                }));

            return branches;
        } catch (error) {
            Log.error('Error getting branches:', error);
            return [];
        }
    }

    /**
     * Get recent commits from the repository
     * @param limit Maximum number of commits to return
     */
    public async getRecentCommits(limit: number = 30): Promise<GitCommit[]> {
        try {
            if (!this.isInitialized() || !this.repository) {
                throw new Error('Git service not initialized');
            }

            // Use the VS Code Git API to get commits
            const commits = await this.repository.log({
                maxEntries: limit
            });

            // Convert to our GitCommit format
            return commits.map(commit => ({
                hash: commit.hash,
                message: commit.message,
                author: commit.authorName || 'Unknown',
                date: commit.authorDate ? commit.authorDate.getTime() : Date.now()
            }));
        } catch (error) {
            Log.error('Error getting recent commits:', error);
            return [];
        }
    }

    /**
     * Get a specific commit by hash
     * @param hash The commit hash to lookup
     */
    public async getCommit(hash: string): Promise<GitCommit | undefined> {
        try {
            if (!this.isInitialized() || !this.repository) {
                throw new Error('Git service not initialized');
            }

            // Use repository API to get commit details
            const commit = await this.repository.getCommit(hash);

            return {
                hash: commit.hash,
                message: commit.message,
                author: commit.authorName || 'Unknown',
                date: commit.authorDate ? commit.authorDate.getTime() : Date.now()
            };
        } catch (error) {
            Log.error(`Error getting commit ${hash}:`, error);
            return undefined;
        }
    }

    /**
     * Compare two branches or refs and get the diff
     * @param options The compare options
     */
    public async compareBranches(options: GitCompareOptions): Promise<GitDiffResult> {
        try {
            if (!this.isInitialized() || !this.repository) {
                throw new Error('Git service not initialized');
            }

            const base = options.base || await this.getDefaultBranch();
            const compare = options.compare || this.repository.state.HEAD?.name;

            if (!base) {
                return {
                    diffText: '',
                    refName: compare || 'unknown',
                    error: 'Could not determine base branch for comparison'
                };
            }

            if (!compare) {
                return {
                    diffText: '',
                    refName: 'unknown',
                    error: 'Could not determine comparison branch'
                };
            }

            // Use Git command directly for three-dot diff format
            const diffText = await this.executeGitCommand(['diff', `${base}...${compare}`]);

            return {
                diffText,
                refName: compare
            };
        } catch (error) {
            Log.error('Error comparing branches:', error);
            return {
                diffText: '',
                refName: options.compare || 'unknown',
                error: `Failed to compare branches: ${error instanceof Error ? error.message : String(error)}`
            };
        }
    }

    /**
     * Get the diff for a specific commit
     * @param hash The commit hash
     */
    public async getCommitDiff(hash: string): Promise<GitDiffResult> {
        try {
            if (!this.isInitialized() || !this.repository) {
                throw new Error('Git service not initialized');
            }

            const commit = await this.getCommit(hash);

            // Use Git command to show the commit with diff
            const diffText = await this.executeGitCommand(['show', hash]);

            return {
                diffText,
                refName: `commit ${hash.substring(0, 7)}${commit ? ` (${commit.message})` : ''}`
            };
        } catch (error) {
            Log.error(`Error getting diff for commit ${hash}:`, error);
            return {
                diffText: '',
                refName: `commit ${hash.substring(0, 7)}`,
                error: `Failed to get commit diff: ${error instanceof Error ? error.message : String(error)}`
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
                    error: 'No uncommitted changes found'
                };
            }

            // Get staged changes using VS Code API
            const stagedDiff = await this.repository.diff(true);

            // Get unstaged changes using VS Code API
            const unstagedDiff = await this.repository.diff(false);

            // Combine them
            const diffText = `${stagedDiff ? `Staged changes:\n${stagedDiff}\n\n` : ''}${unstagedDiff ? `Unstaged changes:\n${unstagedDiff}` : ''}`.trim();

            return {
                diffText,
                refName: 'uncommitted changes'
            };
        } catch (error) {
            Log.error('Error getting uncommitted changes:', error);
            return {
                diffText: '',
                refName: 'uncommitted changes',
                error: `Failed to get uncommitted changes: ${error instanceof Error ? error.message : String(error)}`
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