import * as vscode from 'vscode';
import { IndexingService, IndexingServiceOptions } from './indexingService';
import { FileToProcess } from '../workers/asyncIndexingProcessor';
import { VectorDatabaseService } from './vectorDatabaseService';
import { EmbeddingDatabaseAdapter } from './embeddingDatabaseAdapter';
import { StatusBarService, StatusBarState } from './statusBarService';
import { WorkspaceSettingsService } from './workspaceSettingsService';
import {
    EmbeddingModelSelectionService,
    type ModelInfo
} from './embeddingModelSelectionService';
import { getSupportedFilesGlob, getExcludePattern } from '../types/types';
import { TreeStructureAnalyzerPool } from './treeStructureAnalyzer';
import { ResourceDetectionService } from './resourceDetectionService';

/**
 * Options for indexing operations
 */
export interface IndexingManagerOptions {
    /** Memory to reserve for other processes in GB */
    memoryReserveGB?: number;
    /** Maximum batch size for file processing */
    batchSize?: number;
}

/**
 * IndexingManager handles all indexing operations with consistent reporting
 * for both continuous indexing and full reindexing
 */
export class IndexingManager implements vscode.Disposable {
    private indexingService: IndexingService | null = null;
    private continuousIndexingInProgress: boolean = false;
    private continuousIndexingCancellationToken: vscode.CancellationTokenSource | null = null;
    private selectedModel: string;
    private statusBarService: StatusBarService;

    // Default options
    private readonly defaultOptions: Required<IndexingManagerOptions> = {
        memoryReserveGB: 4, // Default to 4GB reserve for other processes
        batchSize: 20,      // Process files in batches of 20
    };

    private readonly options: Required<IndexingManagerOptions>;

    /**
     * Create a new IndexingManager
     * @param context VS Code extension context
     * @param workspaceSettingsService Service for workspace settings
     * @param modelSelectionService Service for embedding model selection
     * @param vectorDatabaseService Service for vector database operations
     * @param resourceDetectionService Service for resource detection
     * @param embeddingDatabaseAdapter Adapter for embedding database operations (can be null initially)
     * @param options Configuration options
     */
    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly workspaceSettingsService: WorkspaceSettingsService,
        private readonly modelSelectionService: EmbeddingModelSelectionService,
        private readonly vectorDatabaseService: VectorDatabaseService,
        private readonly resourceDetectionService: ResourceDetectionService,
        private embeddingDatabaseAdapter: EmbeddingDatabaseAdapter | null,
        options?: IndexingManagerOptions
    ) {
        this.options = { ...this.defaultOptions, ...options };
        this.statusBarService = StatusBarService.getInstance();

        const { modelInfo } = this.modelSelectionService.selectOptimalModel();
        this.selectedModel = modelInfo.name;

        // Initialize the indexing service
        this.initializeIndexingService(modelInfo);
    }

    /**
     * Initialize the TreeStructureAnalyzerPool
     * This creates a singleton pool of analyzers that can be shared across components
     */
    private initializeTreeStructureAnalyzerPool(isHighMemoryModel: boolean): void {
        try {
            const analyzerPoolSize = this.resourceDetectionService.calculateOptimalConcurrentTasks(isHighMemoryModel);
            TreeStructureAnalyzerPool.createSingleton(
                this.context.extensionPath,
                analyzerPoolSize
            );
            console.log(`Initialized TreeStructureAnalyzerPool with size: ${analyzerPoolSize}`);
        } catch (error) {
            console.warn('Failed to initialize TreeStructureAnalyzerPool:', error);
            throw error;
        }
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
    public initializeIndexingService(modelInfo: ModelInfo): IndexingService {

        this.selectedModel = modelInfo.name;

        // Initialize the TreeStructureAnalyzerPool before initializing the indexing service
        this.initializeTreeStructureAnalyzerPool(modelInfo.isHighMemory);

        // Dispose existing service if it exists
        if (this.indexingService) {
            this.indexingService.dispose();
        }

        // Calculate optimal concurrent tasks for async processing
        const concurrentTasks = this.resourceDetectionService.calculateOptimalConcurrentTasks(modelInfo.isHighMemory);

        // Create options for indexing service
        const options: IndexingServiceOptions = {
            modelBasePath: this.modelSelectionService.getBasePath(),
            modelName: this.selectedModel,
            maxConcurrentTasks: concurrentTasks,
            contextLength: modelInfo.contextLength
        };

        // Create the indexing service
        this.indexingService = new IndexingService(
            this.context,
            this.workspaceSettingsService,
            options
        );

        console.log(`Initialized IndexingService with model: ${this.selectedModel}, concurrentTasks: ${concurrentTasks}, context length: ${modelInfo?.contextLength || 'unknown'}`);

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
            throw new Error('Indexing service is not initialized');
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

                // Process files using the common indexing method
                await this.processFilesWithIndexing(progress, token, false);
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
     * Prepare files for indexing, checking which ones need to be processed
     * @param filePaths Array of file paths to check
     * @param isFullReindexing Whether to process all files or only those needing reindexing
     * @param token Cancellation token
     * @param progressCallback Callback for reporting progress
     * @returns Array of files to process
     */
    private async prepareFilesForIndexing(
        filePaths: string[],
        isFullReindexing: boolean,
        token: vscode.CancellationToken,
        progressCallback?: (checked: number, total: number, needIndexing: number) => void
    ): Promise<{
        filesToProcess: FileToProcess[],
        totalFilesChecked: number,
        totalFilesNeededIndexing: number
    }> {
        // Prepare result arrays
        const filesToProcess: FileToProcess[] = [];
        let totalFilesChecked = 0;
        let totalFilesNeededIndexing = 0;

        // Process all files to check which ones need indexing
        for (const filePath of filePaths) {
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

                // Report progress
                if (progressCallback) {
                    progressCallback(totalFilesChecked, filePaths.length, totalFilesNeededIndexing);
                }

                if (needsIndexing) {
                    // Add file for processing
                    filesToProcess.push({
                        id: filePath,
                        path: filePath,
                        content: fileContent
                    });
                    totalFilesNeededIndexing++;
                }
            } catch (error) {
                console.error(`Error checking file ${filePath}:`, error);
                totalFilesChecked++; // Still count as checked even if there was an error
            }
        }

        return { filesToProcess, totalFilesChecked, totalFilesNeededIndexing };
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

        if (!this.embeddingDatabaseAdapter) {
            vscode.window.showErrorMessage('Embedding database adapter is not initialized');
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

        let totalFilesProcessed = 0;

        // First, analyze all files to see which ones need indexing
        const { filesToProcess, totalFilesChecked, totalFilesNeededIndexing } =
            await this.prepareFilesForIndexing(
                sourceFiles,
                isFullReindexing,
                token,
                (checked, total, needIndexing) => {
                    // Update progress based on checked files
                    const checkingProgressPercent = Math.round((checked / total) * 100);
                    progress.report({
                        message: `Checked ${checked} of ${total} files (${needIndexing} need indexing)`,
                        increment: 100 / total // Increment by percentage of one file
                    });
                }
            );

        // If there are no files to process, we're done
        if (filesToProcess.length === 0 || token.isCancellationRequested) {
            progress.report({ message: `No files need indexing. Checked ${totalFilesChecked} files.` });
            return;
        }

        // Process files in optimally sized batches
        const batchSize = this.options.batchSize;

        // Now process the files that need indexing in batches
        for (let i = 0; i < filesToProcess.length; i += batchSize) {
            // Check if cancelled
            if (token.isCancellationRequested) {
                progress.report({ message: `Indexing operation cancelled after processing ${totalFilesProcessed} files` });
                break;
            }

            // Get current batch
            const batch = filesToProcess.slice(i, i + batchSize);

            // Process this batch
            const results = await this.indexingService!.processFiles(
                batch,
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
            await this.embeddingDatabaseAdapter.storeEmbeddingResults(batch, results);

            // Update counters
            totalFilesProcessed += batch.length;

            // Show overall progress
            progress.report({
                message: `Checked ${totalFilesChecked}/${sourceFiles.length} files. ` +
                    `Indexed ${totalFilesProcessed}/${totalFilesNeededIndexing} files that needed indexing.`
            });
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

        // We don't dispose the TreeStructureAnalyzerPool here since it's a singleton
        // and might be used by other components. It will be disposed when the extension
        // is deactivated.
    }
}