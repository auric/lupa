import * as vscode from 'vscode';
import { IndexingService, IndexingServiceOptions } from './indexingService';
import { VectorDatabaseService } from './vectorDatabaseService';
import { EmbeddingDatabaseAdapter } from './embeddingDatabaseAdapter';
import { StatusBarService } from './statusBarService';
import { WorkspaceSettingsService } from './workspaceSettingsService';
import {
    EmbeddingModelSelectionService,
    type ModelInfo
} from './embeddingModelSelectionService';
import type { FileToProcess, ProcessingResult } from '../types/indexingTypes';
import { getSupportedFilesGlob, getExcludePattern } from '../types/types';
import { ResourceDetectionService } from './resourceDetectionService';
import { Log } from './loggingService';

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
        private embeddingDatabaseAdapter: EmbeddingDatabaseAdapter | null
    ) {
        this.statusBarService = StatusBarService.getInstance();

        const { modelInfo } = this.modelSelectionService.selectOptimalModel();
        this.selectedModel = modelInfo.name;

        // Initialize the indexing service
        this.initializeIndexingService(modelInfo);
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
    public async initializeIndexingService(modelInfo: ModelInfo): Promise<IndexingService> {
        this.selectedModel = modelInfo.name;

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
            maxConcurrentEmbeddingTasks: concurrentTasks,
            contextLength: modelInfo.contextLength,
            extensionPath: this.context.extensionPath,
            embeddingOptions: {
                pooling: 'mean',
                normalize: true
            }
        };

        // Create the indexing service
        this.indexingService = new IndexingService(
            this.context,
            this.workspaceSettingsService,
            options
        );

        Log.info(`Initialized IndexingService with model: ${this.selectedModel}, concurrentTasks: ${concurrentTasks}, context length: ${modelInfo?.contextLength || 'unknown'}`);

        await this.indexingService.initialize();
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

        const statusId = 'indexing';
        
        try {
            this.statusBarService.showProgress(statusId, 'Rebuilding database', 'Full reindexing in progress');
            
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Rebuilding database',
                cancellable: true
            }, async (progress, token) => {
                // Delete all existing embeddings and chunks (database cleanup)
                progress.report({ message: 'Deleting old embeddings and chunks...' });
                await this.vectorDatabaseService.deleteAllEmbeddingsAndChunks();

                // Find files and process them using the common indexing method
                await this.processFilesWithIndexing(progress, token, true);
            });

            this.statusBarService.showTemporaryMessage('Database rebuild completed', 3000, 'check');
        } catch (error) {
            if (error instanceof vscode.CancellationError) {
                this.statusBarService.showTemporaryMessage('Operation cancelled', 3000, 'warning');
            } else {
                const errorMessage = `Failed to rebuild database: ${error instanceof Error ? error.message : String(error)}`;
                this.statusBarService.showTemporaryMessage('Rebuild failed', 3000, 'error');
                vscode.window.showErrorMessage(errorMessage);
            }
        } finally {
            this.statusBarService.hideProgress(statusId);
        }
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

        const statusId = 'indexing';

        try {
            this.statusBarService.showProgress(statusId, 'Continuous indexing', 'Indexing workspace files');

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

            this.statusBarService.showTemporaryMessage('Continuous indexing completed', 3000, 'check');
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.statusBarService.showTemporaryMessage('Indexing error', 3000, 'error');
            vscode.window.showErrorMessage(`Continuous indexing error: ${errorMessage}`);
        } finally {
            // Reset state
            this.continuousIndexingInProgress = false;
            this.continuousIndexingCancellationToken = null;

            this.statusBarService.hideProgress(statusId);
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
                Log.error(`Error checking file ${filePath}:`, error);
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
        progress.report({ message: 'Finding files to index...', increment: 0 });
        const sourceFiles = await this.findSourceFiles(workspaceRoot);

        if (sourceFiles.length === 0) {
            vscode.window.showInformationMessage('No files found to index');
            return;
        }

        // Just update the message without incrementing progress
        progress.report({ message: `Found ${sourceFiles.length} files, analyzing...` });

        // First, analyze all files to see which ones need indexing
        const { filesToProcess, totalFilesChecked, totalFilesNeededIndexing } =
            await this.prepareFilesForIndexing(
                sourceFiles,
                isFullReindexing,
                token,
                (checked, total, needIndexing) => {
                    // Just update the message without incrementing progress
                    progress.report({
                        message: `Checked ${checked} of ${total} files (${needIndexing} need indexing)`
                    });
                }
            );

        // If there are no files to process, we're done
        if (filesToProcess.length === 0 || token.isCancellationRequested) {
            progress.report({
                message: `No files need indexing. Checked ${totalFilesChecked} files.`
            });
            return;
        }

        // Now process all files that need indexing
        // All progress (100%) will be allocated to the actual file processing
        progress.report({ message: `Indexing ${filesToProcess.length} files...` });

        try {
            // Track progress statistics
            let totalProcessedForNotification = 0; // Tracks files fully processed for the vscode.Progress notification
            let totalStored = 0;
            const totalToProcess = filesToProcess.length; // This is the actual number of files that need processing
            let lastReportedPercentForNotification = 0;

            // Process the files with the IndexingService, saving results as they are yielded
            // IndexingService.processFilesGenerator does not take a progress callback directly.
            // Progress for the vscode.Progress notification will be updated based on yielded items.
            const generator = this.indexingService!.processFilesGenerator(
                filesToProcess,
                token
            );

            let filesProcessedByGenerator = 0;

            for await (const yieldedItem of generator) {
                if (token.isCancellationRequested) {
                    Log.info('[IndexingManager] Cancellation requested, stopping result processing.');
                    break;
                }

                filesProcessedByGenerator++;
                const processingResult = yieldedItem.result;

                if (processingResult.success && processingResult.embeddings && processingResult.embeddings.length > 0) {
                    const fileToStore = filesToProcess.find(f => f.id === processingResult.fileId);
                    if (fileToStore) {
                        const singleFileResultMap = new Map<string, ProcessingResult>();
                        singleFileResultMap.set(processingResult.fileId, processingResult);

                        try {
                            await this.embeddingDatabaseAdapter!.storeEmbeddingResults(
                                [fileToStore], // Array with a single file
                                singleFileResultMap,
                                (processedInStorage, totalInStorageBatch) => {
                                    // This callback is for storage progress within a batch, usually quick.
                                }
                            );
                            totalStored++;
                            // Update progress for vscode.Progress notification
                            const currentProgressMessage = `Indexing: ${totalStored}/${totalToProcess} files processed and stored.`;
                            const overallPercentForNotification = totalToProcess > 0 ? Math.round((totalStored / totalToProcess) * 100) : 0;
                            const increment = Math.max(0, overallPercentForNotification - lastReportedPercentForNotification);

                            progress.report({
                                message: currentProgressMessage,
                                increment: increment
                            });
                            if (overallPercentForNotification > lastReportedPercentForNotification) {
                                lastReportedPercentForNotification = overallPercentForNotification;
                            }
                            Log.info(`[IndexingManager] Stored embeddings for file: ${processingResult.filePath}. Total stored: ${totalStored}/${totalToProcess}`);

                        } catch (error) {
                            Log.error(`[IndexingManager] Error storing embedding result for file ${processingResult.filePath}:`, error);
                            progress.report({ message: `Error storing ${processingResult.filePath}.` });
                        }
                    } else {
                        Log.warn(`[IndexingManager] File with id ${processingResult.fileId} not found in filesToProcess list for storing.`);
                    }
                } else if (processingResult.error) {
                    Log.error(`[IndexingManager] Error processing file ${processingResult.filePath} from generator:`, processingResult.error);
                    // Update progress for vscode.Progress notification even for errors, to show activity
                    const currentProgressMessage = `Indexing: ${filesProcessedByGenerator}/${totalToProcess} files attempted. Error with ${processingResult.filePath}.`;
                    const overallPercentForNotification = totalToProcess > 0 ? Math.round((filesProcessedByGenerator / totalToProcess) * 100) : 0;
                    const increment = Math.max(0, overallPercentForNotification - lastReportedPercentForNotification);
                    progress.report({
                        message: currentProgressMessage,
                        increment: increment
                    });
                    if (overallPercentForNotification > lastReportedPercentForNotification) {
                        lastReportedPercentForNotification = overallPercentForNotification;
                    }
                } else {
                    // File processed, but no embeddings (e.g. empty file, or no content to embed)
                    Log.info(`[IndexingManager] File ${processingResult.filePath} processed by generator, no new embeddings to store.`);
                    // Update progress for vscode.Progress notification
                    const currentProgressMessage = `Indexing: ${filesProcessedByGenerator}/${totalToProcess} files analyzed.`;
                    const overallPercentForNotification = totalToProcess > 0 ? Math.round((filesProcessedByGenerator / totalToProcess) * 100) : 0;
                    const increment = Math.max(0, overallPercentForNotification - lastReportedPercentForNotification);
                    progress.report({
                        message: currentProgressMessage,
                        increment: increment
                    });
                    if (overallPercentForNotification > lastReportedPercentForNotification) {
                        lastReportedPercentForNotification = overallPercentForNotification;
                    }
                }
            }

            // Final report
            if (!token.isCancellationRequested) {
                const message = `Indexing completed. ` +
                    `Checked ${totalFilesChecked} files. ` +
                    `Indexed and stored ${totalStored} of ${totalFilesNeededIndexing} files that needed indexing.`;
                progress.report({ message });
                Log.info(message);
            } else {
                // totalProcessedForNotification is no longer updated with the new generator.
                // filesProcessedByGenerator reflects how many files had their processing completed (success or error) by IndexingService.
                const message = `Indexing cancelled. ` +
                    `Checked ${totalFilesChecked} files. ` +
                    `Attempted processing for ${filesProcessedByGenerator} files and stored ${totalStored} of ${totalFilesNeededIndexing} files that needed indexing.`;
                progress.report({ message });
                Log.info(message);
            }
        } catch (error) {
            Log.error('Error during indexing:', error);
            progress.report({
                message: `Error during indexing: ${error instanceof Error ? error.message : String(error)}`
            });
            throw error;
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