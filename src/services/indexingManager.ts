import * as vscode from 'vscode';
import * as os from 'os';
import { IndexingService, FileToProcess, IndexingServiceOptions } from './indexingService';
import { VectorDatabaseService } from './vectorDatabaseService';
import { EmbeddingDatabaseAdapter } from './embeddingDatabaseAdapter';
import { StatusBarService, StatusBarMessageType, StatusBarState } from './statusBarService';
import { WorkspaceSettingsService } from './workspaceSettingsService';
import { ResourceDetectionService } from './resourceDetectionService';
import { EmbeddingModelSelectionService, EmbeddingModel } from './embeddingModelSelectionService';
import { getSupportedFilesGlob, getExcludePattern } from '../types/types';

/**
 * IndexingManager handles all indexing operations with consistent reporting
 * for both continuous indexing and full reindexing
 */
export class IndexingManager implements vscode.Disposable {
    private indexingService: IndexingService | null = null;
    private continuousIndexingInProgress: boolean = false;
    private continuousIndexingCancellationToken: vscode.CancellationTokenSource | null = null;
    private selectedModel: string | null = null;
    private statusBarService: StatusBarService;
    private embeddingDatabaseAdapter: EmbeddingDatabaseAdapter | null = null;

    /**
     * Create a new IndexingManager
     * @param context VS Code extension context
     * @param workspaceSettingsService Service for workspace settings
     * @param resourceDetectionService Service for resource detection
     * @param modelSelectionService Service for embedding model selection
     * @param vectorDatabaseService Service for vector database operations
     * @param embeddingDatabaseAdapter Adapter for embedding database operations (can be null initially)
     */
    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly workspaceSettingsService: WorkspaceSettingsService,
        private readonly resourceDetectionService: ResourceDetectionService,
        private readonly modelSelectionService: EmbeddingModelSelectionService,
        private readonly vectorDatabaseService: VectorDatabaseService,
        embeddingDatabaseAdapter: EmbeddingDatabaseAdapter | null
    ) {
        this.statusBarService = StatusBarService.getInstance();
        this.embeddingDatabaseAdapter = embeddingDatabaseAdapter;

        // Initialize the indexing service
        this.initializeIndexingService();
    }

    /**
     * Set the embedding database adapter (used to break circular dependency)
     * @param embeddingDatabaseAdapter The adapter to set
     */
    public setEmbeddingDatabaseAdapter(embeddingDatabaseAdapter: EmbeddingDatabaseAdapter): void {
        this.embeddingDatabaseAdapter = embeddingDatabaseAdapter;
    }

    /**
     * Initialize or reinitialize the indexing service with the appropriate model
     * @returns The initialized indexing service
     */
    public initializeIndexingService(): IndexingService {
        // Dispose existing service if it exists
        if (this.indexingService) {
            this.indexingService.dispose();
        }

        // Get the selected model from EmbeddingModelSelectionService
        const { model, modelInfo } = this.modelSelectionService.selectOptimalModel();

        this.selectedModel = model;

        // Calculate optimal worker count
        const isHighMemoryModel = model === EmbeddingModel.JinaEmbeddings;
        const workerCount = this.resourceDetectionService.calculateOptimalWorkerCount(
            isHighMemoryModel,
            Math.max(1, Math.floor(os.availableParallelism ? os.availableParallelism() : (os.cpus().length + 1) / 2))
        );

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

        return this.indexingService;
    }

    /**
     * Get the current indexing service
     */
    public getIndexingService(): IndexingService | null {
        return this.indexingService;
    }

    /**
     * Get the selected model
     */
    public getSelectedModel(): string | null {
        return this.selectedModel;
    }

    /**
     * Find source files in workspace for indexing
     */
    private async findSourceFiles(rootPath: string): Promise<string[]> {
        // Use VS Code API to find files
        const include = getSupportedFilesGlob();
        const excludePattern = getExcludePattern();

        const files = await vscode.workspace.findFiles(include, excludePattern);
        return files.map(file => file.fsPath);
    }

    /**
     * Perform full reindexing with database cleanup
     */
    public async performFullReindexing(): Promise<void> {
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
                // Delete all embeddings for current model (database cleanup)
                progress.report({ message: 'Deleting old embeddings...' });
                this.vectorDatabaseService.deleteEmbeddingsByModel(this.selectedModel || '');

                // Find files and process them using the common indexing method
                await this.processFilesWithIndexing(progress, token, true);

                vscode.window.showInformationMessage('Database rebuild completed successfully');
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
     * Start continuous indexing of workspace files
     */
    public async startContinuousIndexing(): Promise<void> {
        // Don't start if already in progress
        if (this.continuousIndexingInProgress) {
            vscode.window.showInformationMessage('Continuous indexing is already in progress');
            return;
        }

        // Ensure indexing service is initialized
        if (!this.indexingService) {
            this.initializeIndexingService();
        }

        // Create a cancellation token source
        this.continuousIndexingCancellationToken = new vscode.CancellationTokenSource();

        // Set flag to indicate indexing is in progress
        this.continuousIndexingInProgress = true;

        // Update status bar
        this.statusBarService.setState(StatusBarState.Indexing, 'continuous');

        try {
            // Show progress notification
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Continuous Indexing',
                cancellable: true
            }, async (progress, token) => {
                // Link our cancellation token with the progress token
                token.onCancellationRequested(() => {
                    if (this.continuousIndexingCancellationToken) {
                        this.continuousIndexingCancellationToken.cancel();
                    }
                });

                // Create a merged cancellation token
                const mergedToken = this.continuousIndexingCancellationToken!.token;

                // Process files using the common indexing method
                await this.processFilesWithIndexing(progress, mergedToken, false);
            });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Continuous indexing error: ${errorMessage}`);
        } finally {
            // Reset state
            this.continuousIndexingInProgress = false;
            this.continuousIndexingCancellationToken = null;

            // Update status bar
            this.statusBarService.setState(StatusBarState.Ready);
        }
    }

    /**
     * Common method to process files with indexing
     * Used by both continuous indexing and full reindexing
     */
    private async processFilesWithIndexing(
        progress: vscode.Progress<{ message?: string; increment?: number }>,
        token: vscode.CancellationToken,
        isFullReindexing: boolean
    ): Promise<void> {
        if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
            vscode.window.showErrorMessage('No workspace folder open');
            return;
        }

        const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;

        // Find source files in workspace
        progress.report({ message: 'Finding files to index...' });
        const sourceFiles = await this.findSourceFiles(workspaceRoot);

        if (sourceFiles.length === 0) {
            vscode.window.showInformationMessage('No files found to index');
            return;
        }

        progress.report({ message: `Found ${sourceFiles.length} files, analyzing...` });

        // Process files in batches to keep memory usage under control
        const batchSize = 20;
        let totalFilesProcessed = 0;
        let totalFilesChecked = 0;
        let totalFilesNeededIndexing = 0;

        // Process all files in batches
        for (let i = 0; i < sourceFiles.length; i += batchSize) {
            // Check if operation was cancelled
            if (token.isCancellationRequested) {
                vscode.window.showInformationMessage('Indexing operation cancelled');
                break;
            }

            // Get batch of files
            const fileBatch = sourceFiles.slice(i, i + batchSize);

            // Process this batch of files
            const filesToProcess: FileToProcess[] = [];

            for (const filePath of fileBatch) {
                try {
                    // Check if operation was cancelled
                    if (token.isCancellationRequested) {
                        break;
                    }

                    // Read file content
                    const content = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
                    const fileContent = Buffer.from(content).toString('utf8');

                    // For full reindexing, we process all files.
                    // For continuous indexing, we only process files that need reindexing.
                    const needsIndexing = isFullReindexing ||
                        await this.embeddingDatabaseAdapter!.needsReindexing(filePath, fileContent);

                    // Increment total checked files counter
                    totalFilesChecked++;

                    // Update progress based on total files checked
                    const checkingProgressPercent = Math.round((totalFilesChecked / sourceFiles.length) * 100);
                    progress.report({
                        message: `Checked ${totalFilesChecked} of ${sourceFiles.length} files (${totalFilesNeededIndexing} need indexing)`,
                        increment: 100 / sourceFiles.length // Increment by percentage of one file
                    });

                    if (needsIndexing) {
                        // Add file to batch for processing
                        filesToProcess.push({
                            id: filePath,
                            path: filePath,
                            content: fileContent
                        });
                        totalFilesNeededIndexing++;
                    }
                } catch (error) {
                    console.error(`Error processing file ${filePath}:`, error);
                    totalFilesChecked++; // Still count as checked even if there was an error
                }
            }

            // If there are files to index in this batch, process them
            if (filesToProcess.length > 0 && !token.isCancellationRequested) {
                // Process files and get embeddings
                const results = await this.indexingService!.processFiles(
                    filesToProcess,
                    token,
                    (processed, total) => {
                        // Update progress message for current batch
                        progress.report({
                            message: `Checked ${totalFilesChecked} of ${sourceFiles.length} files. ` +
                                `Indexing ${processed}/${total} files in current batch...`
                        });
                    }
                );

                // Store embeddings in database
                await this.embeddingDatabaseAdapter!.storeEmbeddingResults(filesToProcess, results);

                // Update counters
                totalFilesProcessed += filesToProcess.length;

                // Show overall progress based on files checked and indexed
                progress.report({
                    message: `Checked ${totalFilesChecked}/${sourceFiles.length} files. ` +
                        `Indexed ${totalFilesProcessed}/${totalFilesNeededIndexing} files that needed indexing.`
                });
            }
        }

        // Finalize with report
        if (!token.isCancellationRequested) {
            const message = `Indexing completed. ` +
                `Checked ${totalFilesChecked}/${sourceFiles.length} files. ` +
                `Indexed ${totalFilesProcessed}/${totalFilesNeededIndexing} files.`;

            progress.report({ message });
            console.log(message);
        }
    }

    /**
     * Stop continuous indexing if it's currently running
     */
    public stopContinuousIndexing(): void {
        if (this.continuousIndexingInProgress && this.continuousIndexingCancellationToken) {
            this.continuousIndexingCancellationToken.cancel();
            vscode.window.showInformationMessage('Stopping continuous indexing...');
        } else {
            vscode.window.showInformationMessage('No continuous indexing is currently running');
        }
    }

    /**
     * Dispose of resources
     */
    public dispose(): void {
        if (this.indexingService) {
            this.indexingService.dispose();
        }

        if (this.continuousIndexingCancellationToken) {
            this.continuousIndexingCancellationToken.cancel();
        }
    }
}