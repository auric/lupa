import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { IndexingService, FileToProcess, IndexingServiceOptions } from './indexingService';
import { StatusBarService, StatusBarMessageType, StatusBarState } from './statusBarService';
import { ResourceDetectionService } from './resourceDetectionService';
import { ModelSelectionService, EmbeddingModel } from './modelSelectionService';
import { WorkspaceSettingsService } from './workspaceSettingsService';
import { VectorDatabaseService } from './vectorDatabaseService';
import { EmbeddingDatabaseAdapter } from './embeddingDatabaseAdapter';
import { ContextProvider } from './contextProvider';

/**
 * PRAnalyzer handles the main functionality of analyzing pull requests
 */
export class PRAnalyzer implements vscode.Disposable {
    private indexingService: IndexingService | null = null;
    private vectorDatabaseService: VectorDatabaseService;
    private embeddingDatabaseAdapter: EmbeddingDatabaseAdapter;
    private contextProvider: ContextProvider;
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
        this.workspaceSettingsService = new WorkspaceSettingsService(context);

        // Initialize the required services
        this.resourceDetectionService = new ResourceDetectionService({
            memoryReserveGB: 4 // 4GB reserve for other processes
        });

        this.modelSelectionService = new ModelSelectionService(
            path.join(context.extensionPath, 'models'),
            this.workspaceSettingsService
        );

        // Initialize the vector database service
        this.vectorDatabaseService = VectorDatabaseService.getInstance(context);

        // Initialize the indexing service first so we can pass it to the adapter
        this.initializeIndexingService();

        // Initialize the embedding database adapter with the indexing service
        this.embeddingDatabaseAdapter = EmbeddingDatabaseAdapter.getInstance(
            context,
            this.vectorDatabaseService,
            this.workspaceSettingsService,
            this.indexingService!
        );

        // Initialize the context provider
        this.contextProvider = ContextProvider.getInstance(this.embeddingDatabaseAdapter);

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

        // Register database management command
        this.context.subscriptions.push(
            vscode.commands.registerCommand('codelens-pr-analyzer.manageDatabase', () => this.showDatabaseManagementOptions())
        );
    }

    /**
     * Initialize or reinitialize the indexing service with the appropriate model
     */
    private initializeIndexingService(): void {
        // Dispose existing service if it exists
        if (this.indexingService) {
            this.indexingService.dispose();
        }

        // Get the selected model from ModelSelectionService
        // It will check workspace settings internally and handle model selection
        const { model, modelInfo } = this.modelSelectionService.selectOptimalModel();

        this.selectedModel = model;

        // Calculate optimal worker count
        const isHighMemoryModel = model === EmbeddingModel.JinaEmbeddings;
        const workerCount = this.calculateOptimalWorkerCount(isHighMemoryModel);

        // Create options for indexing service
        const options: IndexingServiceOptions = {
            modelBasePath: this.modelSelectionService.getBasePath(),
            modelName: model,
            maxWorkers: workerCount,
            contextLength: modelInfo.contextLength
        };

        // Create the indexing service
        this.indexingService = new IndexingService(
            this.context,
            this.workspaceSettingsService,
            options
        );

        console.log(`Initialized IndexingService with model: ${model}, workers: ${workerCount}, context length: ${modelInfo?.contextLength || 'unknown'}`);

        // If we already have an embeddingDatabaseAdapter, update it with the new IndexingService
        if (this.embeddingDatabaseAdapter) {
            // Update the reference to the indexing service by recreating the singleton instance
            this.embeddingDatabaseAdapter = EmbeddingDatabaseAdapter.getInstance(
                this.context,
                this.vectorDatabaseService,
                this.workspaceSettingsService,
                this.indexingService
            );

            // Recreate the context provider with the updated adapter
            this.contextProvider = ContextProvider.getInstance(this.embeddingDatabaseAdapter);
        }
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

            // Ask if user wants to rebuild database with new model
            const rebuild = await vscode.window.showQuickPick(['Yes', 'No'], {
                placeHolder: 'Rebuild embedding database with new model?'
            });

            if (rebuild === 'Yes') {
                // Delete existing embeddings for old model
                await this.rebuildDatabase();
            }
        }
    }

    /**
     * Show database management options
     */
    private async showDatabaseManagementOptions(): Promise<void> {
        // Show database stats first
        const stats = this.embeddingDatabaseAdapter.getStorageStats();
        vscode.window.showInformationMessage(stats, { modal: true });

        // Show management options
        const options = [
            'Optimize database',
            'Rebuild entire database',
            'Show database statistics'
        ];

        const selected = await vscode.window.showQuickPick(options, {
            placeHolder: 'Select database management action'
        });

        if (!selected) {
            return;
        }

        switch (selected) {
            case options[0]: // Optimize
                await this.optimizeDatabase();
                break;

            case options[1]: // Rebuild
                await this.rebuildDatabase();
                break;

            case options[2]: // Stats
                const detailedStats = this.embeddingDatabaseAdapter.getStorageStats();
                vscode.window.showInformationMessage(detailedStats, { modal: true });
                break;
        }
    }

    /**
     * Optimize the vector database
     */
    private async optimizeDatabase(): Promise<void> {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Optimizing database',
            cancellable: false
        }, async (progress) => {
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
     * Rebuild the database by clearing old embeddings and re-indexing
     */
    private async rebuildDatabase(): Promise<void> {
        const confirm = await vscode.window.showWarningMessage(
            'This will delete all embeddings and rebuild the database. Continue?',
            { modal: true },
            'Yes', 'No'
        );

        if (confirm !== 'Yes') {
            return;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Rebuilding database',
            cancellable: true
        }, async (progress, token) => {
            try {
                // Delete all embeddings for current model
                progress.report({ message: 'Deleting old embeddings...' });
                this.vectorDatabaseService.deleteEmbeddingsByModel(this.selectedModel || '');

                // Find files to reindex
                if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
                    vscode.window.showErrorMessage('No workspace folder open');
                    return;
                }

                const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;

                // Find files to process
                progress.report({ message: 'Finding files to index...' });
                const sourceFiles = await this.findSourceFiles(workspaceRoot);

                if (sourceFiles.length === 0) {
                    vscode.window.showInformationMessage('No files found to index');
                    return;
                }

                // Create file objects for indexing
                progress.report({ message: `Found ${sourceFiles.length} files to index` });
                const filesToProcess: FileToProcess[] = [];

                for (let i = 0; i < sourceFiles.length; i++) {
                    if (token.isCancellationRequested) {
                        vscode.window.showInformationMessage('Operation cancelled');
                        return;
                    }

                    try {
                        const filePath = sourceFiles[i];
                        const content = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
                        const fileContent = Buffer.from(content).toString('utf8');

                        filesToProcess.push({
                            id: filePath,
                            path: filePath,
                            content: fileContent
                        });

                        if (i % 10 === 0) {
                            progress.report({
                                message: `Prepared ${i + 1}/${sourceFiles.length} files`,
                                increment: (1 / sourceFiles.length) * 10
                            });
                        }
                    } catch (error) {
                        console.error(`Error reading file ${sourceFiles[i]}:`, error);
                    }
                }

                // Process files in batches to avoid OOM
                const batchSize = 20;
                for (let i = 0; i < filesToProcess.length; i += batchSize) {
                    if (token.isCancellationRequested) {
                        vscode.window.showInformationMessage('Operation cancelled');
                        return;
                    }

                    const batch = filesToProcess.slice(i, i + batchSize);
                    progress.report({
                        message: `Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(filesToProcess.length / batchSize)}`
                    });

                    // Process the batch
                    const results = await this.indexingService!.processFiles(batch, token);

                    // Store results in database
                    await this.embeddingDatabaseAdapter.storeEmbeddingResults(batch, results);

                    progress.report({
                        increment: (batch.length / filesToProcess.length) * 100,
                        message: `Completed ${Math.min(i + batchSize, filesToProcess.length)}/${filesToProcess.length} files`
                    });
                }

                vscode.window.showInformationMessage(`Database rebuilt with ${filesToProcess.length} files`);
            } catch (error) {
                if (token.isCancellationRequested) {
                    vscode.window.showInformationMessage('Operation cancelled');
                } else {
                    vscode.window.showErrorMessage(`Failed to rebuild database: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
        });
    }

    /**
     * Find source files in workspace for indexing
     */
    private async findSourceFiles(rootPath: string): Promise<string[]> {
        // Use VS Code API to find files
        const include = '**/*.{js,jsx,ts,tsx,py,java,c,cpp,cs,go,rb,php}';
        const excludePattern = '**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/.vscode/**';

        const files = await vscode.workspace.findFiles(include, excludePattern);
        return files.map(file => file.fsPath);
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

            // Check if file needs indexing
            const needsIndexing = await this.embeddingDatabaseAdapter.needsReindexing(filePath, fileContent);

            // Show progress notification
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'PR Analyzer',
                cancellable: true
            }, async (progress, token) => {
                // Step 1: Index the file if needed
                if (needsIndexing) {
                    progress.report({ message: 'Generating embeddings...' });

                    // Create file to process
                    const fileToProcess: FileToProcess = {
                        id: filePath,
                        path: filePath,
                        content: fileContent,
                        priority: 10
                    };

                    try {
                    // Process the file
                        const results = await this.indexingService!.processFiles([fileToProcess], token);

                        // Store the embeddings in the database
                        await this.embeddingDatabaseAdapter.storeEmbeddingResults([fileToProcess], results);

                        progress.report({ message: 'Embeddings generated and stored', increment: 40 });
                    } catch (error) {
                        if (token.isCancellationRequested) {
                            throw new Error('Operation cancelled');
                        }
                        throw new Error(`Failed to generate embeddings: ${error instanceof Error ? error.message : String(error)}`);
                    }
                } else {
                    progress.report({ message: 'Using existing embeddings', increment: 40 });
                }

                // Step 2: Find relevant code context
                progress.report({ message: 'Finding relevant code context...', increment: 10 });

                try {
                    // Find related code
                    const context = await this.contextProvider.getContextForDiff(fileContent);

                    progress.report({ message: 'Context found', increment: 25 });

                    // Display the context
                    const panel = vscode.window.createWebviewPanel(
                        'prAnalyzerContext',
                        'PR Analysis Context',
                        vscode.ViewColumn.Beside,
                        { enableScripts: true }
                    );

                    panel.webview.html = this.generateContextHtml(filePath, context);

                    progress.report({ message: 'Analysis complete', increment: 25 });

                    // Update status bar
                    this.statusBarService.showTemporaryMessage(
                        'Analysis complete',
                        5000,
                        StatusBarMessageType.Info
                    );
                } catch (error) {
                    throw new Error(`Failed to analyze context: ${error instanceof Error ? error.message : String(error)}`);
                }

                // Reset status to ready
                this.statusBarService.setState(StatusBarState.Ready);
            });
        } catch (error) {
            if (error instanceof Error && error.message.includes('cancelled')) {
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
    }

    /**
     * Generate HTML to display analysis context
     */
    private generateContextHtml(filePath: string, context: string): string {
        return `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>PR Analysis Context</title>
            <style>
                body {
                    font-family: var(--vscode-font-family);
                    font-size: var(--vscode-font-size);
                    color: var(--vscode-editor-foreground);
                    background-color: var(--vscode-editor-background);
                    padding: 20px;
                    line-height: 1.5;
                }
                h1 {
                    color: var(--vscode-titleBar-activeForeground);
                    font-size: 1.5em;
                    border-bottom: 1px solid var(--vscode-panel-border);
                    padding-bottom: 10px;
                }
                h2 {
                    color: var(--vscode-editor-foreground);
                    font-size: 1.3em;
                    margin-top: 20px;
                }
                h3 {
                    color: var(--vscode-textLink-foreground);
                    font-size: 1.1em;
                    margin-top: 15px;
                }
                pre {
                    background-color: var(--vscode-textCodeBlock-background);
                    padding: 10px;
                    border-radius: 5px;
                    overflow: auto;
                    font-family: var(--vscode-editor-font-family);
                }
                code {
                    font-family: var(--vscode-editor-font-family);
                }
                .relevance {
                    color: var(--vscode-charts-green);
                    font-size: 0.9em;
                }
            </style>
        </head>
        <body>
            <h1>Analysis Context for: ${path.basename(filePath)}</h1>
            <div class="context-content">
                ${this.markdownToHtml(context)}
            </div>
        </body>
        </html>
        `;
    }

    /**
     * Convert markdown to HTML (basic implementation)
     */
    private markdownToHtml(markdown: string): string {
        return markdown
            // Headings
            .replace(/^### (.*$)/gm, '<h3>$1</h3>')
            .replace(/^## (.*$)/gm, '<h2>$1</h2>')
            .replace(/^# (.*$)/gm, '<h1>$1</h1>')
            // Code blocks
            .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
            // Inline code
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            // Line breaks
            .replace(/\n/g, '<br>')
            // File paths with relevance scores
            .replace(/### File: `([^`]+)` \(Relevance: ([0-9.]+)%\)/g,
                '<h3>File: <code>$1</code> <span class="relevance">(Relevance: $2%)</span></h3>');
    }

    /**
     * Dispose of resources
     */
    public dispose(): void {
        if (this.indexingService) {
            this.indexingService.dispose();
        }

        this.contextProvider.dispose();
        this.embeddingDatabaseAdapter.dispose();
        this.vectorDatabaseService.dispose();
        this.workspaceSettingsService.dispose();
        this.modelSelectionService.dispose();
    }
}