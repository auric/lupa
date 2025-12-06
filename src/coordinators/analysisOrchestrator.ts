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

            // Check if legacy embedding LSP algorithm is enabled
            const useEmbeddingLspAlgorithm = this.services.workspaceSettings.isEmbeddingLspAlgorithmEnabled();

            // Perform the analysis with progress reporting
            await this.services.uiManager.showAnalysisProgress('PR Analyzer', async (progress, token) => {
                // Initial setup
                progress.report({ message: 'Initializing analysis...', increment: 1 });

                let analysis: string;
                let context: string;
                let toolCallsData: ToolCallsData | undefined;

                if (useEmbeddingLspAlgorithm) {
                    // Use legacy embedding-based LSP algorithm
                    progress.report({ message: 'Using legacy embedding-based analysis...', increment: 1 });

                    const result = await this.services.analysisProvider.analyzePullRequest(
                        diffText,
                        gitRootPath,
                        analysisMode,
                        (message, increment) => {
                            if (increment) {
                                const scaledIncrement = Math.min(increment * 0.2, 1);
                                progress.report({ message, increment: scaledIncrement });
                            } else {
                                progress.report({ message });
                            }
                        },
                        token
                    );

                    analysis = result.analysis;
                    context = result.context;
                } else {
                    // Use new tool-calling approach with detailed progress reporting
                    progress.report({ message: 'Starting tool-calling analysis...', increment: 1 });

                    const progressCallback: AnalysisProgressCallback = (message, incrementPercent) => {
                        if (incrementPercent !== undefined) {
                            progress.report({ message, increment: incrementPercent });
                        } else {
                            progress.report({ message });
                        }
                    };

                    const result = await this.services.toolCallingAnalysisProvider.analyze(
                        diffText,
                        token,
                        progressCallback
                    );
                    analysis = result.analysis;
                    toolCallsData = result.toolCalls;
                    context = '';
                }

                // Display the results
                progress.report({ message: 'Preparing analysis results...', increment: 2 });

                const title = `PR Analysis: ${refName}`;
                this.services.uiManager.displayAnalysisResults(title, diffText, context, analysis, toolCallsData);
                progress.report({ message: 'Analysis displayed', increment: 2 });
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
            this.isAnalysisRunning = false;
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