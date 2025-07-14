import * as vscode from 'vscode';
import { AnalysisProvider } from '../services/analysisProvider';
import { GitOperationsManager } from '../services/gitOperationsManager';
import { UIManager } from '../services/uiManager';
import { StatusBarService } from '../services/statusBarService';
import { IServiceRegistry } from '../services/serviceManager';

/**
 * AnalysisOrchestrator handles the core PR analysis workflow
 * Orchestrates the interaction between UI, Git, and analysis services
 */
export class AnalysisOrchestrator implements vscode.Disposable {
    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly services: IServiceRegistry
    ) {}

    /**
     * Orchestrate the complete PR analysis workflow
     */
    public async analyzePR(): Promise<void> {
        const statusId = 'pr-analysis';
        
        try {
            this.services.statusBar.showProgress(statusId, 'Analyzing PR', 'PR analysis in progress');

            // Initialize Git service
            const isGitAvailable = await this.services.gitOperations.initialize();
            if (!isGitAvailable) {
                vscode.window.showErrorMessage('Git extension not available or no Git repository found in workspace.');
                return;
            }

            const repository = this.services.gitOperations.getRepository();
            if (!repository) {
                vscode.window.showErrorMessage('No active Git repository could be determined.');
                return;
            }
            const gitRootPath = repository.rootUri.fsPath;

            // Get analysis options from user
            const analysisOptions = await this.getUserAnalysisOptions();
            if (!analysisOptions) {
                return;
            }

            const { diffResult, analysisMode } = analysisOptions;
            const { diffText, refName, error } = diffResult;

            if (error) {
                vscode.window.showErrorMessage(error);
                return;
            }

            if (!diffText || diffText.trim() === '') {
                vscode.window.showInformationMessage('No changes found to analyze.');
                return;
            }

            // Perform the analysis with progress reporting
            await this.services.uiManager.showAnalysisProgress('PR Analyzer', async (progress, token) => {
                // Initial setup - 5%
                progress.report({ message: 'Initializing analysis...', increment: 5 });

                // Step 1: Run the analysis with detailed progress reporting - 85% total
                const { analysis, context } = await this.services.analysisProvider.analyzePullRequest(
                    diffText,
                    gitRootPath,
                    analysisMode,
                    (message, increment) => {
                        // Only update the message if no increment is specified
                        if (increment) {
                            // Use a very conservative scaling factor to ensure progress
                            // never gets ahead of actual completion
                            const scaledIncrement = Math.min(increment * 0.2, 1);
                            progress.report({ message, increment: scaledIncrement });
                        } else {
                            progress.report({ message });
                        }
                    },
                    token
                );

                // Step 2: Display the results - 10% remaining
                progress.report({ message: 'Preparing analysis results...', increment: 5 });

                // Create a title based on the reference
                const title = `PR Analysis: ${refName}`;

                // Display the results in a webview
                this.services.uiManager.displayAnalysisResults(title, diffText, context, analysis);
                progress.report({ message: 'Analysis displayed', increment: 5 });
            });

            this.services.statusBar.showTemporaryMessage('Analysis complete', 3000, 'check');
        } catch (error) {
            if (error instanceof Error && error.message.includes('cancelled')) {
                this.services.statusBar.showTemporaryMessage('Analysis cancelled', 3000, 'warning');
                vscode.window.showInformationMessage('Analysis cancelled');
            } else {
                const errorMessage = error instanceof Error ? error.message : String(error);
                this.services.statusBar.showTemporaryMessage('Analysis failed', 3000, 'error');
                vscode.window.showErrorMessage(`Failed to analyze PR: ${errorMessage}`);
            }
        } finally {
            this.services.statusBar.hideProgress(statusId);
        }
    }

    /**
     * Get analysis options from user
     */
    private async getUserAnalysisOptions() {
        // Offer options for analysis type
        const selectedOption = await this.services.uiManager.showAnalysisTypeOptions();
        if (!selectedOption) {
            return null;
        }

        // Get diff based on selected option
        const diffResult = await this.services.gitOperations.getDiffFromSelection(selectedOption);
        if (!diffResult) {
            return null;
        }

        // Select analysis mode
        const analysisMode = await this.services.uiManager.selectAnalysisMode();
        if (!analysisMode) {
            return null;
        }

        return {
            diffResult,
            analysisMode
        };
    }

    /**
     * Dispose of resources
     */
    public dispose(): void {
        // AnalysisOrchestrator doesn't own services, just coordinates them
        // Services are disposed by ServiceManager
    }
}