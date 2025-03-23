import * as vscode from 'vscode';
import { GitService } from './gitService';

/**
 * Interface for git diff result
 */
export interface DiffResult {
    diffText: string;
    refName: string;
    error?: string;
}

/**
 * Interface for branch comparison options
 */
export interface BranchCompareOptions {
    base: string;
    compare: string;
}

/**
 * GitOperationsManager encapsulates all Git-related operations
 */
export class GitOperationsManager implements vscode.Disposable {
    private gitService: GitService;

    /**
     * Create a new GitOperationsManager
     */
    constructor() {
        this.gitService = GitService.getInstance();
    }

    /**
     * Initialize Git service
     * @returns true if Git is available, false otherwise
     */
    public async initialize(): Promise<boolean> {
        return await this.gitService.initialize();
    }

    /**
     * Get diff based on user selection
     * @param selection The user's selected analysis type
     */
    public async getDiffFromSelection(selection: string): Promise<DiffResult | undefined> {
        switch (selection) {
            case 'Current Branch vs Default Branch': {
                const repository = this.gitService.getRepository();
                if (!repository) {
                    vscode.window.showErrorMessage('No Git repository found in workspace.');
                    return undefined;
                }

                const currentBranch = repository.state.HEAD?.name;
                if (!currentBranch) {
                    vscode.window.showErrorMessage('Not currently on a branch.');
                    return undefined;
                }

                const defaultBranch = await this.gitService.getDefaultBranch();
                if (!defaultBranch) {
                    vscode.window.showErrorMessage('Could not determine default branch.');
                    return undefined;
                }

                return await this.gitService.compareBranches({ base: defaultBranch, compare: currentBranch });
            }

            case 'Select Branch': {
                // Fetch available branches
                const defaultBranch = await this.gitService.getDefaultBranch();
                if (!defaultBranch) {
                    vscode.window.showErrorMessage('Could not determine default branch.');
                    return undefined;
                }

                const branches = await this.gitService.getBranches();
                const branchItems = branches.map(branch => ({
                    label: branch.name,
                    description: branch.isDefault ? '(default branch)' : '',
                    picked: branch.isCurrent
                }));

                const selectedBranch = await vscode.window.showQuickPick(branchItems, {
                    placeHolder: 'Select a branch to analyze',
                });

                if (!selectedBranch) {
                    return undefined;
                }

                return await this.gitService.compareBranches({ base: defaultBranch, compare: selectedBranch.label });
            }

            case 'Select Commit': {
                // Get recent commits
                const commits = await this.gitService.getRecentCommits();

                if (commits.length === 0) {
                    vscode.window.showErrorMessage('No commits found in the repository.');
                    return undefined;
                }

                const commitItems = commits.map(commit => ({
                    label: commit.hash.substring(0, 7),
                    description: `${commit.message} (${new Date(commit.date).toLocaleDateString()})`,
                    detail: commit.author
                }));

                const selectedCommit = await vscode.window.showQuickPick(commitItems, {
                    placeHolder: 'Select a commit to analyze',
                });

                if (!selectedCommit) {
                    return undefined;
                }

                const fullCommitHash = commits.find(c => c.hash.startsWith(selectedCommit.label))?.hash;
                if (!fullCommitHash) {
                    vscode.window.showErrorMessage('Could not find the selected commit.');
                    return undefined;
                }

                // Get the diff for a single commit
                return await this.gitService.getCommitDiff(fullCommitHash);
            }

            case 'Current Changes': {
                // Get uncommitted changes
                return await this.gitService.getUncommittedChanges();
            }

            default:
                return undefined;
        }
    }

    /**
     * Get the repository instance
     */
    public getRepository() {
        return this.gitService.getRepository();
    }

    /**
     * Dispose resources
     */
    public dispose(): void {
        // GitService is a singleton, no need to dispose
    }
}