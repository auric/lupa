import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { IndexingService, FileToProcess, IndexingServiceOptions } from './indexingService';
import { StatusBarService, StatusBarMessageType, StatusBarState } from './statusBarService';
import { ResourceDetectionService } from './resourceDetectionService';
import { ModelSelectionService, EmbeddingModel } from './modelSelectionService';
import { WorkspaceSettingsService } from './workspaceSettingsService';

/**
 * PRAnalyzer handles the main functionality of analyzing pull requests
 */
export class PRAnalyzer implements vscode.Disposable {
    private indexingService: IndexingService | null = null;
    private resourceDetectionService: ResourceDetectionService;
    private modelSelectionService: ModelSelectionService;
    private workspaceSettingsService: WorkspaceSettingsService;
    private statusBarService: StatusBarService;
    private selectedModel: string | null = null;

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
        this.initializeIndexingService();

        // Get the status bar service
        this.statusBarService = StatusBarService.getInstance();

        // Set the initial status
        this.statusBarService.setState(StatusBarState.Ready);

        // Register analyze PR command
        this.context.subscriptions.push(
            vscode.commands.registerCommand('codelens-pr-analyzer.analyzePR', () => this.analyzePR())
        );

        // Register model selection command
        this.context.subscriptions.push(
            vscode.commands.registerCommand('codelens-pr-analyzer.selectEmbeddingModel', () => this.showModelSelectionOptions())
        );

        // Register model info command
        this.context.subscriptions.push(
            vscode.commands.registerCommand('codelens-pr-analyzer.showModelsInfo', () => this.modelSelectionService.showModelsInfo())
        );
    }

    /**
     * Initialize or reinitialize the indexing service with the appropriate model
     */
    private initializeIndexingService(): void {
        // Dispose existing service if it exists
        if (this.indexingService) {
            this.indexingService.dispose();
            this.indexingService = null;
        }

        // Get the selected model from settings or use optimal model selection
        const savedModel = this.workspaceSettingsService.getSelectedEmbeddingModel();
        let modelName: string;
        let contextLength: number | undefined;

        if (savedModel) {
            // User has explicitly selected a model
            modelName = savedModel;

            // Set context length based on known model properties
            if (savedModel === EmbeddingModel.JinaEmbeddings) {
                contextLength = 8192; // Jina has larger context
            } else {
                contextLength = 256; // MiniLM has smaller context
            }
        } else {
            // Use automatic model selection
            const { model, modelInfo } = this.modelSelectionService.selectOptimalModel();
            modelName = model;
            contextLength = modelInfo?.contextLength;
        }

        this.selectedModel = modelName;

        // Calculate optimal worker count
        const workerCount = this.calculateOptimalWorkerCount(modelName === EmbeddingModel.JinaEmbeddings);

        // Create options for indexing service
        const options: IndexingServiceOptions = {
            modelName,
            maxWorkers: workerCount,
            contextLength
        };

        // Create the indexing service
        this.indexingService = new IndexingService(
            this.context,
            this.workspaceSettingsService,
            options
        );

        console.log(`Initialized IndexingService with model: ${modelName}, workers: ${workerCount}`);
    }

    /**
     * Calculate the optimal number of worker threads based on system resources
     */
    private calculateOptimalWorkerCount(isHighMemoryModel: boolean): number {
        return this.resourceDetectionService.calculateOptimalWorkerCount(
            isHighMemoryModel,
            Math.max(1, Math.floor(os.availableParallelism ? os.availableParallelism() : (os.cpus().length + 1) / 2))
        );
    }

    /**
     * Show options for selecting embedding model
     */
    private async showModelSelectionOptions(): Promise<void> {
        // Show model info first
        this.modelSelectionService.showModelsInfo();

        // Show options
        const options = [
            'Use optimal model (automatic selection)',
            'Force high-memory model (Jina Embeddings)',
            'Force low-memory model (MiniLM)'
        ];

        const selected = await vscode.window.showQuickPick(options, {
            placeHolder: 'Select embedding model preference'
        });

        if (!selected) {
            return;
        }
        let modelChanged = false;

        // Update settings based on selection
        switch (selected) {
            case options[0]: // Automatic
                const currentModel = this.workspaceSettingsService.getSelectedEmbeddingModel();
                modelChanged = currentModel !== undefined;
                this.workspaceSettingsService.setSelectedEmbeddingModel(undefined);
                break;

            case options[1]: // Force high-memory
                const hiMemModel = EmbeddingModel.JinaEmbeddings;
                modelChanged = this.selectedModel !== hiMemModel;
                this.workspaceSettingsService.setSelectedEmbeddingModel(hiMemModel);
                break;

            case options[2]: // Force low-memory
                const lowMemModel = EmbeddingModel.MiniLM;
                modelChanged = this.selectedModel !== lowMemModel;
                this.workspaceSettingsService.setSelectedEmbeddingModel(lowMemModel);
                break;
        }

        // Reinitialize indexing service if model changed
        if (modelChanged) {
            vscode.window.showInformationMessage('Reinitializing with new model selection...');
            this.initializeIndexingService();
        }
    }

    /**
     * Analyze a pull request or the currently open file
     */
    private async analyzePR(): Promise<void> {
        // Ensure indexing service is initialized
        if (!this.indexingService) {
            this.initializeIndexingService();
        }

        try {
            // Set status to analyzing
            this.statusBarService.setState(StatusBarState.Analyzing);

            // For now, just analyze current file
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage('No active editor found. Open a file to analyze.');
                this.statusBarService.setState(StatusBarState.Ready);
                return;
            }

            // Get current file
            const document = editor.document;
            const filePath = document.uri.fsPath;
            const fileContent = document.getText();

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
                    const results = await this.indexingService!.processFiles([fileToProcess], token, (processed, total) => {
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
                    this.statusBarService.showTemporaryMessage(
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

                    // Reset status to ready
                    this.statusBarService.setState(StatusBarState.Ready);
                } catch (error) {
                    if (error instanceof Error && error.message === 'Operation cancelled') {
                        vscode.window.showInformationMessage('Analysis cancelled');
                        this.statusBarService.showTemporaryMessage(
                            'Analysis cancelled',
                            3000,
                            StatusBarMessageType.Warning
                        );
                        this.statusBarService.setState(StatusBarState.Ready);
                    } else {
                        const errorMessage = error instanceof Error ? error.message : String(error);
                        vscode.window.showErrorMessage(`Failed to analyze PR: ${errorMessage}`);
                        this.statusBarService.showTemporaryMessage(
                            'Analysis failed',
                            5000,
                            StatusBarMessageType.Error
                        );
                        this.statusBarService.setState(StatusBarState.Error, errorMessage);
                    }
                }
            });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`PR analysis failed: ${errorMessage}`);
            this.statusBarService.showTemporaryMessage('Analysis failed', 5000, StatusBarMessageType.Error);
            this.statusBarService.setState(StatusBarState.Error, errorMessage);
        }
    }

    /**
     * Dispose of resources
     */
    public dispose(): void {
        // Dispose of all services in reverse order of creation
        if (this.indexingService) {
            this.indexingService.dispose();
            this.indexingService = null;
        }
        this.workspaceSettingsService.dispose();
        this.modelSelectionService.dispose();
    }
}