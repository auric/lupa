import * as vscode from 'vscode';
import { GitService } from './gitService';
import type { WorkspaceSettingsService } from './workspaceSettingsService';
import type { AnalysisTargetType } from '../types/analysisTypes';

/**
 * Interface for git diff result
 */
export interface DiffResult {
    diffText: string;
    refName: string;
    error?: string;
}

/**
 * GitOperationsManager encapsulates all Git-related operations for PR analysis.
 *
 * Only supports analysis targets that maintain consistency between the diff
 * and the repository state accessible via LLM tools.
 */
export class GitOperationsManager implements vscode.Disposable {
    private gitService: GitService;
    private workspaceSettings: WorkspaceSettingsService | undefined;

    constructor(workspaceSettings?: WorkspaceSettingsService) {
        this.gitService = GitService.getInstance();
        this.workspaceSettings = workspaceSettings;
    }

    /**
     * Initialize Git service
     * @returns true if Git is available, false otherwise
     */
    public async initialize(): Promise<boolean> {
        return await this.gitService.initialize(this.workspaceSettings);
    }

    /**
     * Allow user to manually select a different repository
     * @returns True if a repository was selected, false if canceled
     */
    public async selectRepositoryManually(): Promise<boolean> {
        return await this.gitService.selectRepositoryManually(this.workspaceSettings);
    }

    /**
     * Get diff based on user-selected analysis target.
     * @param target The analysis target type (strongly typed)
     */
    public async getDiffFromSelection(target: AnalysisTargetType): Promise<DiffResult | undefined> {
        switch (target) {
            case 'current-branch-vs-default': {
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

            case 'uncommitted-changes': {
                return await this.gitService.getUncommittedChanges();
            }
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