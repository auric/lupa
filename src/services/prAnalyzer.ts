import * as vscode from 'vscode';
import * as path from 'path';
import { IndexingService, FileToProcess } from './indexingService';
import { StatusBarService, StatusBarMessageType } from './statusBarService';
import { ResourceDetectionService } from './resourceDetectionService';
import { ModelSelectionService } from './modelSelectionService';
import { WorkspaceSettingsService } from './workspaceSettingsService';

/**
 * PRAnalyzer handles the main functionality of analyzing pull requests
 */
export class PRAnalyzer implements vscode.Disposable {
    private indexingService: IndexingService;
    private resourceDetectionService: ResourceDetectionService;
    private modelSelectionService: ModelSelectionService;
    private workspaceSettingsService: WorkspaceSettingsService;

    /**
     * Create a new PR Analyzer
     * @param context VS Code extension context
     */
    constructor(
        private readonly context: vscode.ExtensionContext
    ) {
        // Initialize the required services
        this.resourceDetectionService = new ResourceDetectionService({
            memoryReserveGB: 4 // 4GB reserve for other processes
        });

        this.modelSelectionService = new ModelSelectionService(
            path.join(context.extensionPath, 'models')
        );

        this.workspaceSettingsService = new WorkspaceSettingsService(context);

        // Initialize the indexing service with our dependencies
        this.indexingService = new IndexingService(
            context,
            this.resourceDetectionService,
            this.modelSelectionService,
            this.workspaceSettingsService
        );

        // Set up the main status bar for PR Analyzer using the StatusBarService
        const statusBarService = StatusBarService.getInstance();

        // Set the main status bar text - this single status bar will be used for the whole extension
        statusBarService.setMainStatusBarText("PR Analyzer", "PR Analyzer - Ready");

        // Configure the main status bar to trigger analysis when clicked
        const mainStatusBar = statusBarService.getOrCreateItem(StatusBarService.MAIN_STATUS_BAR_ID);
        mainStatusBar.command = "codelens-pr-analyzer.analyzePR";

        // Register analyze PR command
        this.context.subscriptions.push(
            vscode.commands.registerCommand('codelens-pr-analyzer.analyzePR', () => this.analyzePR())
        );
    }

    /**
     * Analyze a pull request or the currently open file
     */
    private async analyzePR(): Promise<void> {
        try {
            // Get status bar service
            const statusBarService = StatusBarService.getInstance();

            // For now, just analyze current file
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage('No active editor found. Open a file to analyze.');
                return;
            }

            // Get current file
            const document = editor.document;
            const filePath = document.uri.fsPath;
            const fileContent = document.getText();

            // Show temporary status message
            statusBarService.setMainStatusBarText(
                `Analyzing ${path.basename(filePath)}`,
                `Analyzing file: ${path.basename(filePath)}`,
                StatusBarMessageType.Working
            );

            // Create file to process
            const fileToProcess: FileToProcess = {
                id: filePath,
                path: filePath,
                content: fileContent,
                priority: 10
            };

            // Show progress notification
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'PR Analyzer',
                cancellable: true
            }, async (progress, token) => {
                progress.report({ message: 'Generating embeddings...' });

                try {
                    // Process the file
                    const results = await this.indexingService.processFiles([fileToProcess], token, (processed, total) => {
                        const percentage = Math.round((processed / total) * 100);
                        progress.report({
                            message: `${processed}/${total} files (${percentage}%)`,
                            increment: (1 / total) * 100
                        });
                    });

                    // Get the result for our file
                    const result = results.get(filePath);
                    if (!result) {
                        throw new Error('No results returned for file');
                    }

                    if (!result.success) {
                        throw new Error(result.error || 'Failed to generate embeddings');
                    }

                    // Success! Show the results
                    progress.report({ message: 'Embeddings generated successfully', increment: 100 });

                    // Update status bar with success message
                    statusBarService.showTemporaryMessage(
                        `Generated ${result.embeddings.length} embeddings`,
                        5000,
                        StatusBarMessageType.Info
                    );

                    // Show summary in notification
                    vscode.window.showInformationMessage(
                        `Generated ${result.embeddings.length} embeddings for ${path.basename(filePath)}`
                    );

                    // For demonstration, show first embedding vector (truncated)
                    if (result.embeddings.length > 0) {
                        const firstVector = result.embeddings[0];
                        const truncated = Array.from(firstVector.slice(0, 5)).map(v => v.toFixed(6)).join(', ');

                        vscode.window.showInformationMessage(
                            `First embedding vector (truncated): [${truncated}, ...]`
                        );
                    }
                } catch (error) {
                    if (error instanceof Error && error.message === 'Operation cancelled') {
                        vscode.window.showInformationMessage('Analysis cancelled');
                        statusBarService.showTemporaryMessage(
                            'Analysis cancelled',
                            3000,
                            StatusBarMessageType.Warning
                        );
                    } else {
                        const errorMessage = error instanceof Error ? error.message : String(error);
                        vscode.window.showErrorMessage(`Failed to analyze PR: ${errorMessage}`);
                        statusBarService.showTemporaryMessage(
                            'Analysis failed',
                            5000,
                            StatusBarMessageType.Error
                        );
                    }
                }
            });
        } catch (error) {
            const statusBarService = StatusBarService.getInstance();
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`PR analysis failed: ${errorMessage}`);
            statusBarService.showTemporaryMessage('Analysis failed', 5000, StatusBarMessageType.Error);
        }
    }

    /**
     * Dispose of resources
     */
    public dispose(): void {
        // Dispose of all services in reverse order of creation
        this.indexingService.dispose();
        this.workspaceSettingsService.dispose();
        this.modelSelectionService.dispose();
    }
}