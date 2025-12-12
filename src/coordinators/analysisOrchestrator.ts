import * as vscode from 'vscode';
import { AnalysisMode } from '../types/modelTypes';
import type { ToolCallsData, AnalysisProgressCallback } from '../types/toolCallTypes';
import { IServiceRegistry } from '../services/serviceManager';

/**
 * AnalysisOrchestrator handles the core PR analysis workflow
 * Orchestrates the interaction between UI, Git, and analysis services
 */
export class AnalysisOrchestrator implements vscode.Disposable {
    private isAnalysisRunning = false;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly services: IServiceRegistry
    ) { }

    /**
     * Check if an analysis is currently running
     */
    public isRunning(): boolean {
        return this.isAnalysisRunning;
    }

    /**
     * Orchestrate the complete PR analysis workflow
     */
    public async analyzePR(): Promise<void> {
        if (this.isAnalysisRunning) {
            vscode.window.showInformationMessage(
                'Analysis is already in progress. Please wait for it to complete or cancel it.'
            );
            return;
        }

        this.isAnalysisRunning = true;

        try {
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

            // Run the analysis with a progress notification
            await this.runAnalysisWithProgress(diffText, refName, gitRootPath, analysisMode);

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
            this.isAnalysisRunning = false;
        }
    }

    /**
     * Run analysis with VS Code progress notification
     * The notification appears automatically and can be minimized by user.
     * When minimized, it moves to the status bar area near the bell icon.
     * Clicking the status bar or bell icon reopens the notification.
     */
    private async runAnalysisWithProgress(
        diffText: string,
        refName: string,
        gitRootPath: string,
        analysisMode: AnalysisMode
    ): Promise<void> {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Analyzing PR (Esc to hide)',
                cancellable: true
            },
            async (progress, token) => {
                const cancellationTokenSource = new vscode.CancellationTokenSource();

                // Link the VS Code cancellation token to our source
                token.onCancellationRequested(() => {
                    cancellationTokenSource.cancel();
                });

                try {
                    const useEmbeddingLspAlgorithm = this.services.workspaceSettings.isEmbeddingLspAlgorithmEnabled();

                    let analysis: string;
                    let context: string;
                    let toolCallsData: ToolCallsData | undefined;

                    const updateProgress = (message: string) => {
                        progress.report({ message });
                    };

                    updateProgress('Starting analysis...');

                    if (useEmbeddingLspAlgorithm) {
                        const result = await this.services.analysisProvider.analyzePullRequest(
                            diffText,
                            gitRootPath,
                            analysisMode,
                            updateProgress,
                            cancellationTokenSource.token
                        );

                        analysis = result.analysis;
                        context = result.context;
                    } else {
                        const progressCallback: AnalysisProgressCallback = updateProgress;

                        const result = await this.services.toolCallingAnalysisProvider.analyze(
                            diffText,
                            cancellationTokenSource.token,
                            progressCallback
                        );
                        analysis = result.analysis;
                        toolCallsData = result.toolCalls;
                        context = '';
                    }

                    // Display results in webview
                    const title = `PR Analysis: ${refName}`;
                    this.services.uiManager.displayAnalysisResults(title, diffText, context, analysis, toolCallsData);

                    this.services.statusBar.showTemporaryMessage('Analysis complete', 3000, 'check');
                } finally {
                    cancellationTokenSource.dispose();
                }
            }
        );
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
        const analysisMode = AnalysisMode.Comprehensive;

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