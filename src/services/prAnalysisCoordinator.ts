import * as vscode from 'vscode';
import * as path from 'path';
import { IndexingManager } from './indexingManager';
import { GitOperationsManager } from './gitOperationsManager';
import { UIManager } from './uiManager';
import { AnalysisProvider } from './analysisProvider';
import { StatusBarService, StatusBarMessageType, StatusBarState } from './statusBarService';
import { WorkspaceSettingsService } from './workspaceSettingsService';
import { ResourceDetectionService } from './resourceDetectionService';
import { EmbeddingModelSelectionService, EmbeddingModel } from './embeddingModelSelectionService';
import { VectorDatabaseService } from './vectorDatabaseService';
import { EmbeddingDatabaseAdapter } from './embeddingDatabaseAdapter';
import { ContextProvider } from './contextProvider';
import { CopilotModelManager } from '../models/copilotModelManager';
import { TokenManagerService } from './tokenManagerService';
import { DiffResult } from './gitOperationsManager';
import { IndexingService } from './indexingService';

/**
 * PRAnalysisCoordinator orchestrates the PR analysis workflow
 */
export class PRAnalysisCoordinator implements vscode.Disposable {
    // Core services
    private indexingManager: IndexingManager;
    private gitOperationsManager: GitOperationsManager;
    private uiManager: UIManager;
    private analysisProvider: AnalysisProvider;
    private statusBarService: StatusBarService;

    // Support services
    private vectorDatabaseService: VectorDatabaseService;
    private embeddingDatabaseAdapter: EmbeddingDatabaseAdapter;
    private contextProvider: ContextProvider;
    private resourceDetectionService: ResourceDetectionService;
    private modelSelectionService: EmbeddingModelSelectionService;
    private workspaceSettingsService: WorkspaceSettingsService;
    private modelManager: CopilotModelManager;
    private indexingService: IndexingService;

    /**
     * Create a new PRAnalysisCoordinator
     * @param context VS Code extension context
     */
    constructor(
        private readonly context: vscode.ExtensionContext
    ) {
        // Initialize support services
        this.workspaceSettingsService = new WorkspaceSettingsService(context);

        this.resourceDetectionService = new ResourceDetectionService({
            memoryReserveGB: 4 // 4GB reserve for other processes
        });

        this.modelSelectionService = new EmbeddingModelSelectionService(
            path.join(context.extensionPath, 'dist', 'models'),
            this.workspaceSettingsService
        );

        // Initialize the language model manager
        this.modelManager = new CopilotModelManager(this.workspaceSettingsService);

        // Initialize the vector database service
        this.vectorDatabaseService = VectorDatabaseService.getInstance(context);

        // Initialize the indexing manager first without the embedding database adapter
        // to break the circular dependency
        this.indexingManager = new IndexingManager(
            context,
            this.workspaceSettingsService,
            this.resourceDetectionService,
            this.modelSelectionService,
            this.vectorDatabaseService,
            null // Initially pass null for embeddingDatabaseAdapter
        );

        // Get the indexing service from the manager
        this.indexingService = this.indexingManager.getIndexingService()!;

        // Now initialize the embedding database adapter with the indexing service
        this.embeddingDatabaseAdapter = EmbeddingDatabaseAdapter.getInstance(
            context,
            this.vectorDatabaseService,
            this.workspaceSettingsService,
            this.indexingService
        );

        // Update the indexing manager with the now-created embedding database adapter
        this.indexingManager.setEmbeddingDatabaseAdapter(this.embeddingDatabaseAdapter);

        // Initialize the context provider
        this.contextProvider = ContextProvider.createSingleton(
            this.context, this.embeddingDatabaseAdapter, this.modelManager
        );

        // Initialize the UI manager
        this.uiManager = new UIManager();

        // Initialize the Git operations manager
        this.gitOperationsManager = new GitOperationsManager();

        // Initialize the analysis provider
        this.analysisProvider = new AnalysisProvider(
            this.contextProvider,
            this.modelManager
        );

        // Get the status bar service
        this.statusBarService = StatusBarService.getInstance();

        // Set the initial status
        this.uiManager.updateStatusBar(StatusBarState.Ready);

        // Register commands
        this.registerCommands();
    }

    /**
     * Register extension commands
     */
    private registerCommands(): void {
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

        // Register language model info command
        this.context.subscriptions.push(
            vscode.commands.registerCommand('codelens-pr-analyzer.showLanguageModelsInfo', () => this.modelManager.showModelsInfo())
        );

        // Register language model selection command
        this.context.subscriptions.push(
            vscode.commands.registerCommand('codelens-pr-analyzer.selectLanguageModel', () => this.showLanguageModelSelectionOptions())
        );

        // Register database management command
        this.context.subscriptions.push(
            vscode.commands.registerCommand('codelens-pr-analyzer.manageDatabase', () => this.showDatabaseManagementOptions())
        );

        // Register continuous indexing command
        this.context.subscriptions.push(
            vscode.commands.registerCommand('codelens-pr-analyzer.startContinuousIndexing', () => this.indexingManager.startContinuousIndexing())
        );

        // Register stop continuous indexing command
        this.context.subscriptions.push(
            vscode.commands.registerCommand('codelens-pr-analyzer.stopContinuousIndexing', () => this.indexingManager.stopContinuousIndexing())
        );
    }

    /**
     * Analyze a pull request
     */
    public async analyzePR(): Promise<void> {
        try {
            // Set status to analyzing
            this.uiManager.updateStatusBar(StatusBarState.Analyzing);

            // Initialize Git service
            const isGitAvailable = await this.gitOperationsManager.initialize();
            if (!isGitAvailable) {
                vscode.window.showErrorMessage('Git extension not available or no Git repository found in workspace.');
                this.uiManager.updateStatusBar(StatusBarState.Ready);
                return;
            }

            // Offer options for analysis type
            const selectedOption = await this.uiManager.showAnalysisTypeOptions();

            if (!selectedOption) {
                this.uiManager.updateStatusBar(StatusBarState.Ready);
                return;
            }

            // Get diff based on selected option
            const diffResult = await this.gitOperationsManager.getDiffFromSelection(selectedOption);

            if (!diffResult) {
                this.uiManager.updateStatusBar(StatusBarState.Ready);
                return;
            }

            const { diffText, refName, error } = diffResult;

            if (error) {
                vscode.window.showErrorMessage(error);
                this.uiManager.updateStatusBar(StatusBarState.Ready);
                return;
            }

            if (!diffText || diffText.trim() === '') {
                vscode.window.showInformationMessage('No changes found to analyze.');
                this.uiManager.updateStatusBar(StatusBarState.Ready);
                return;
            }

            // Select analysis mode
            const analysisMode = await this.uiManager.selectAnalysisMode();

            if (!analysisMode) {
                this.uiManager.updateStatusBar(StatusBarState.Ready);
                return;
            }

            // Perform the analysis with progress reporting
            await this.uiManager.showAnalysisProgress('PR Analyzer', async (progress, token) => {
                try {
                    // Step 1: Generate embeddings for the diff
                    progress.report({ message: 'Analyzing changes...', increment: 10 });

                    // Step 2: Run the analysis
                    const { analysis, context } = await this.analysisProvider.analyzePullRequest(diffText, analysisMode);
                    progress.report({ message: 'Analysis complete', increment: 75 });

                    // Create a title based on the reference
                    const title = `PR Analysis: ${refName}`;

                    // Display the results in a webview
                    this.uiManager.displayAnalysisResults(title, diffText, context, analysis);
                    progress.report({ message: 'Analysis displayed', increment: 15 });

                    // Update status bar
                    this.uiManager.showTemporaryStatusMessage(
                        'Analysis complete',
                        5000,
                        StatusBarMessageType.Info
                    );
                } catch (error) {
                    if (token.isCancellationRequested) {
                        throw new Error('Operation cancelled');
                    }
                    throw new Error(`Failed to analyze PR: ${error instanceof Error ? error.message : String(error)}`);
                }

                // Reset status to ready
                this.uiManager.updateStatusBar(StatusBarState.Ready);
            });
        } catch (error) {
            if (error instanceof Error && error.message.includes('cancelled')) {
                vscode.window.showInformationMessage('Analysis cancelled');
                this.uiManager.showTemporaryStatusMessage(
                    'Analysis cancelled',
                    3000,
                    StatusBarMessageType.Warning
                );
            } else {
                const errorMessage = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Failed to analyze PR: ${errorMessage}`);
                this.uiManager.showTemporaryStatusMessage(
                    'Analysis failed',
                    5000,
                    StatusBarMessageType.Error
                );
                this.uiManager.updateStatusBar(StatusBarState.Error, errorMessage);
            }
            this.uiManager.updateStatusBar(StatusBarState.Ready);
        }
    }

    /**
     * Show options for selecting embedding model
     */
    private async showModelSelectionOptions(): Promise<void> {
        // Show model info first
        this.modelSelectionService.showModelsInfo();

        // Show options and get selection
        const selected = await this.uiManager.showModelSelectionOptions();

        if (!selected) {
            return;
        }

        let modelChanged = false;

        // Update settings based on selection
        switch (selected) {
            case 'Use optimal model (automatic selection)':
                const currentModel = this.workspaceSettingsService.getSelectedEmbeddingModel();
                modelChanged = currentModel !== undefined;
                this.workspaceSettingsService.setSelectedEmbeddingModel(undefined);
                break;

            case 'Force high-memory model (Jina Embeddings)':
                const hiMemModel = EmbeddingModel.JinaEmbeddings;
                modelChanged = this.indexingManager.getSelectedModel() !== hiMemModel;
                this.workspaceSettingsService.setSelectedEmbeddingModel(hiMemModel);
                break;

            case 'Force low-memory model (MiniLM)':
                const lowMemModel = EmbeddingModel.MiniLM;
                modelChanged = this.indexingManager.getSelectedModel() !== lowMemModel;
                this.workspaceSettingsService.setSelectedEmbeddingModel(lowMemModel);
                break;
        }

        // Reinitialize indexing service if model changed
        if (modelChanged) {
            vscode.window.showInformationMessage('Reinitializing with new model selection...');
            this.indexingManager.initializeIndexingService();

            // Ask if user wants to rebuild database with new model
            const rebuild = await vscode.window.showQuickPick(['Yes', 'No'], {
                placeHolder: 'Rebuild embedding database with new model?'
            });

            if (rebuild === 'Yes') {
                // Delete existing embeddings for old model and rebuild
                await this.indexingManager.performFullReindexing();
            }
        }
    }

    /**
     * Show options for selecting language model
     */
    private async showLanguageModelSelectionOptions(): Promise<void> {
        try {
            // First show available models
            await this.modelManager.showModelsInfo();

            // Get available model families
            const models = await this.modelManager.listAvailableModels();
            const families = Array.from(new Set(models.map(m => m.family)));

            if (families.length === 0) {
                vscode.window.showInformationMessage('No language models available. Please ensure GitHub Copilot is installed and authorized.');
                return;
            }

            // Create quickpick options for model families
            const options = [
                ...models.map(model => ({
                    label: `${model.name}`,
                    description: model.version
                }))
            ];

            // Ask user to select model family
            const selectedModelOption = await vscode.window.showQuickPick(options, {
                placeHolder: 'Select language model',
                matchOnDescription: true
            });

            if (!selectedModelOption) {
                return;
            }

            const selectedModel = models.find(m => {
                return m.name === selectedModelOption.label;
            })!;

            // Save selected model preferences
            this.workspaceSettingsService.setPreferredModelFamily(selectedModel.family);
            this.workspaceSettingsService.setPreferredModelVersion(selectedModel.version);
            vscode.window.showInformationMessage(`Language model set to ${selectedModel.name} (version: ${selectedModel.version})`);

            // Try to select the model to verify it's available
            await this.modelManager.selectModel({
                family: selectedModel.family,
                version: selectedModel.version
            });

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Error selecting language model: ${errorMessage}`);
        }
    }

    /**
     * Show database management options
     */
    private async showDatabaseManagementOptions(): Promise<void> {
        // Show database stats first
        const stats = await this.embeddingDatabaseAdapter.getStorageStats();
        vscode.window.showInformationMessage(stats, { modal: true });

        // Show management options
        const selected = await this.uiManager.showDatabaseManagementOptions();

        if (!selected) {
            return;
        }

        switch (selected) {
            case 'Optimize database':
                await this.optimizeDatabase();
                break;

            case 'Rebuild entire database':
                await this.indexingManager.performFullReindexing();
                break;

            case 'Show database statistics':
                const detailedStats = await this.embeddingDatabaseAdapter.getStorageStats();
                vscode.window.showInformationMessage(detailedStats, { modal: true });
                break;
        }
    }

    /**
     * Optimize the vector database
     */
    private async optimizeDatabase(): Promise<void> {
        await this.uiManager.showAnalysisProgress('Optimizing database', async (progress) => {
            progress.report({ message: 'Running optimization...' });

            try {
                this.embeddingDatabaseAdapter.optimizeStorage();
                vscode.window.showInformationMessage('Database optimization complete');
            } catch (error) {
                vscode.window.showErrorMessage(`Database optimization failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        });
    }

    /**
     * Dispose of resources
     */
    public dispose(): void {
        this.indexingManager.dispose();
        this.analysisProvider.dispose();
        this.contextProvider.dispose();
        this.embeddingDatabaseAdapter.dispose();
        this.vectorDatabaseService.dispose();
        this.workspaceSettingsService.dispose();
        this.modelSelectionService.dispose();
        this.gitOperationsManager.dispose();
    }
}