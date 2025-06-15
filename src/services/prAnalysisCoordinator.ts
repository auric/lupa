import * as vscode from 'vscode';
import * as path from 'path';
import { IndexingManager } from './indexingManager';
import { GitOperationsManager } from './gitOperationsManager';
import { UIManager } from './uiManager';
import { AnalysisProvider } from './analysisProvider';
import { StatusBarService, StatusBarMessageType, StatusBarState } from './statusBarService';
import { WorkspaceSettingsService } from './workspaceSettingsService';
import { EmbeddingModelSelectionService, EmbeddingModel } from './embeddingModelSelectionService';
import { VectorDatabaseService } from './vectorDatabaseService';
import { EmbeddingDatabaseAdapter } from './embeddingDatabaseAdapter';
import { ContextProvider } from './contextProvider';
import { CopilotModelManager } from '../models/copilotModelManager';
import { IndexingService } from './indexingService';
import { ResourceDetectionService } from './resourceDetectionService';
import { CodeAnalysisServiceInitializer } from './codeAnalysisService';

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
    private modelSelectionService: EmbeddingModelSelectionService;
    private workspaceSettingsService: WorkspaceSettingsService;
    private modelManager: CopilotModelManager;
    private indexingService: IndexingService;
    private resourceDetectionService: ResourceDetectionService;

    /**
     * Create a new PRAnalysisCoordinator
     * @param context VS Code extension context
     */
    constructor(
        private readonly context: vscode.ExtensionContext
    ) {
        CodeAnalysisServiceInitializer.initialize(this.context.extensionPath);

        // Initialize support services
        this.workspaceSettingsService = new WorkspaceSettingsService(context);
        this.resourceDetectionService = new ResourceDetectionService({
            memoryReserveGB: 4 // 4GB reserve for other processes
        });

        // Initialize model selection service
        this.modelSelectionService = new EmbeddingModelSelectionService(
            path.join(context.extensionPath, 'dist', 'models'),
            this.workspaceSettingsService,
            this.resourceDetectionService
        );

        // Initialize the language model manager
        this.modelManager = new CopilotModelManager(this.workspaceSettingsService);

        // Initialize the vector database service
        this.vectorDatabaseService = VectorDatabaseService.getInstance(context);

        // Set initial model dimension for VectorDatabaseService
        const initialModelInfo = this.modelSelectionService.selectOptimalModel().modelInfo;
        if (initialModelInfo && initialModelInfo.dimensions) {
            this.vectorDatabaseService.setCurrentModelDimension(initialModelInfo.dimensions);
        } else {
            console.warn('PRAnalysisCoordinator: Could not determine initial model dimension for VectorDatabaseService.');
        }

        this.indexingManager = new IndexingManager(
            context,
            this.workspaceSettingsService,
            this.modelSelectionService,
            this.vectorDatabaseService,
            this.resourceDetectionService,
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

        this.context.subscriptions.push(
            vscode.commands.registerCommand(
                'codelens-pr-analyzer.manageIndexing',
                () => this.indexingService.showIndexingManagementOptions()
            )
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

            const repository = this.gitOperationsManager.getRepository();
            if (!repository) {
                vscode.window.showErrorMessage('No active Git repository could be determined.');
                this.uiManager.updateStatusBar(StatusBarState.Ready);
                return;
            }
            const gitRootPath = repository.rootUri.fsPath;

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
                    // Initial setup - 5%
                    progress.report({ message: 'Initializing analysis...', increment: 5 });

                    // Step 1: Run the analysis with detailed progress reporting - 85% total
                    // We allocate most of the progress to the actual analysis
                    const { analysis, context } = await this.analysisProvider.analyzePullRequest(
                        diffText,
                        gitRootPath, // Pass gitRootPath here
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
                    this.uiManager.displayAnalysisResults(title, diffText, context, analysis);
                    progress.report({ message: 'Analysis displayed', increment: 5 });

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
        const previousModel = this.indexingManager.getSelectedModel();

        // Show options and get selection
        const selectedOption = await this.uiManager.showModelSelectionOptions();

        if (!selectedOption) {
            return;
        }

        let newSelectedModelEnumValue: EmbeddingModel | undefined;

        // Update settings based on selection
        switch (selectedOption) {
            case 'Use optimal model (automatic selection)':
                newSelectedModelEnumValue = undefined; // Let the service pick
                this.workspaceSettingsService.setSelectedEmbeddingModel(undefined);
                break;
            case 'Force high-memory model (Jina Embeddings)':
                newSelectedModelEnumValue = EmbeddingModel.JinaEmbeddings;
                this.workspaceSettingsService.setSelectedEmbeddingModel(newSelectedModelEnumValue);
                break;
            case 'Force low-memory model (MiniLM)':
                newSelectedModelEnumValue = EmbeddingModel.MiniLM;
                this.workspaceSettingsService.setSelectedEmbeddingModel(newSelectedModelEnumValue);
                break;
            default:
                return; // Should not happen
        }

        // Determine the actual model that will be used after selection
        // This considers the case where 'undefined' means optimal selection
        // selectOptimalModel will use the value just set in workspaceSettingsService
        const actualNewModelInfo = this.modelSelectionService.selectOptimalModel();
        const actualNewModelName = actualNewModelInfo.modelInfo.name;

        // Check if the model has actually changed
        const modelChanged = previousModel !== actualNewModelName;

        if (modelChanged) {
            vscode.window.showInformationMessage(
                `Embedding model changed from "${previousModel || 'auto'}" to "${actualNewModelName}". The existing embedding database is incompatible and must be rebuilt.`
            );

            // Set the new model dimension in VectorDatabaseService BEFORE re-initializing IndexingManager
            // or performing a full reindex, as deleteAllEmbeddingsAndChunks might be called.
            const newDimension = actualNewModelInfo.modelInfo.dimensions;
            if (newDimension) {
                this.vectorDatabaseService.setCurrentModelDimension(newDimension);
            } else {
                console.warn('PRAnalysisCoordinator: Could not determine new model dimension for VectorDatabaseService during model change.');
            }

            // Reinitialize IndexingManager and dependent services with the new model
            await this.indexingManager.initializeIndexingService(actualNewModelInfo.modelInfo);

            // Update the EmbeddingDatabaseAdapter with the new IndexingService instance
            this.embeddingDatabaseAdapter = EmbeddingDatabaseAdapter.getInstance(
                this.context,
                this.vectorDatabaseService,
                this.workspaceSettingsService,
                this.indexingManager.getIndexingService()!
            );
            this.indexingManager.setEmbeddingDatabaseAdapter(this.embeddingDatabaseAdapter);

            // Ask if user wants to rebuild database with new model
            const rebuildChoice = await vscode.window.showQuickPick(['Yes, rebuild now', 'No, I will do it later'], {
                placeHolder: `Rebuild embedding database for the new model "${actualNewModelName}"? This is required for context retrieval to work correctly.`,
                ignoreFocusOut: true
            });

            if (rebuildChoice === 'Yes, rebuild now') {
                this.statusBarService.showTemporaryMessage(
                    `Rebuilding database for model: ${actualNewModelName}...`,
                    undefined, // Indefinite until indexing finishes
                    StatusBarMessageType.Working
                );
                // performFullReindexing should now call vectorDb.deleteAllEmbeddingsAndChunks()
                await this.indexingManager.performFullReindexing();
                this.statusBarService.showTemporaryMessage(
                    `Database rebuild for ${actualNewModelName} complete.`,
                    5000,
                    StatusBarMessageType.Info
                );
            } else {
                vscode.window.showWarningMessage(
                    `Database not rebuilt. Context retrieval may not work correctly until the database is rebuilt for model "${actualNewModelName}".`
                );
            }
        } else {
            vscode.window.showInformationMessage(`Embedding model selection confirmed: "${actualNewModelName}". No change detected.`);
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
        // const stats = await this.embeddingDatabaseAdapter.getStorageStats();
        // vscode.window.showInformationMessage(stats, { modal: true });

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