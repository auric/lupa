import * as vscode from 'vscode';
import { IndexingService, IndexingServiceOptions } from './indexingService';
import { VectorDatabaseService } from './vectorDatabaseService';
import { EmbeddingDatabaseAdapter } from './embeddingDatabaseAdapter';
import { StatusBarService, StatusBarState } from './statusBarService';
import { WorkspaceSettingsService } from './workspaceSettingsService';
import {
    EmbeddingModelSelectionService,
    type ModelInfo
} from './embeddingModelSelectionService';
import type { FileToProcess } from '../types/indexingTypes';
import { getSupportedFilesGlob, getExcludePattern } from '../types/types';
import { ResourceDetectionService } from './resourceDetectionService';

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

        console.log(`Initialized IndexingService with model: ${this.selectedModel}, concurrentTasks: ${concurrentTasks}, context length: ${modelInfo?.contextLength || 'unknown'}`);

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

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Rebuilding database',
            cancellable: true
        }, async (progress, token) => {
            try {
                // Delete all existing embeddings and chunks (database cleanup)
                progress.report({ message: 'Deleting old embeddings and chunks...' });
                await this.vectorDatabaseService.deleteAllEmbeddingsAndChunks();

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

            // Process the files with the IndexingService, saving results as batches complete
            const results = await this.indexingService!.processFiles(
                filesToProcess,
                token,
                (processedItems, totalItems, phase, phaseProcessedFiles, phaseTotalFiles) => {
                    // processedItems, totalItems: items within the current phase (files for chunking, chunks for embedding)
                    // phaseProcessedFiles, phaseTotalFiles: files completed/total in current phase by IndexingService

                    let currentProgressMessage = '';
                    let currentCompletionRatio = 0; // Represents overall progress from 0.0 to 1.0

                    if (phase === 'chunking') {
                        // phaseProcessedFiles is filesChunkingAttemptedCount out of initialFiles.length (from IndexingService's perspective)
                        if (phaseProcessedFiles !== undefined && phaseTotalFiles !== undefined && phaseTotalFiles > 0) {
                            currentProgressMessage = `Analyzing content: ${phaseProcessedFiles}/${phaseTotalFiles} files checked.`;
                            // Chunking is a preliminary step. We can assign a small portion of the overall progress to it.
                            // For example, if chunking completes for all initial files, it's 10% of the way for `totalToProcess`.
                            // This is an approximation as `totalToProcess` might be different from `phaseTotalFiles`.
                            const chunkingProgress = phaseProcessedFiles / phaseTotalFiles;
                            currentCompletionRatio = chunkingProgress * 0.1; // Chunking contributes up to 10%
                        } else {
                            currentProgressMessage = `Analyzing file content...`;
                        }
                    } else if (phase === 'embedding') {
                        // phaseProcessedFiles is filesEmbeddingsCompletedCount
                        // phaseTotalFiles is op.pendingFileEmbeddings.length (files that had actual chunks)
                        totalProcessedForNotification = phaseProcessedFiles ?? 0;
                        const targetForEmbeddingPhase = phaseTotalFiles ?? 0;

                        if (targetForEmbeddingPhase > 0) {
                            currentProgressMessage = `Embedding: ${totalProcessedForNotification}/${targetForEmbeddingPhase} files completed.`;
                            // Embedding is the main work. It contributes the remaining 90%.
                            // Progress within embedding phase: totalProcessedForNotification / targetForEmbeddingPhase
                            // This needs to be scaled to the overall totalToProcess.

                            let filesWithoutChunks = Math.max(0, totalToProcess - targetForEmbeddingPhase);
                            // Effective processed count: files that had no chunks + files that completed embedding
                            const overallEffectivelyProcessed = filesWithoutChunks + totalProcessedForNotification;
                            currentCompletionRatio = totalToProcess > 0 ? (overallEffectivelyProcessed / totalToProcess) : 0;

                        } else if (totalToProcess > 0 && phaseTotalFiles === 0) {
                            // All files were chunked (or attempted), but none yielded chunks for embedding.
                            currentProgressMessage = `All ${totalToProcess} files analyzed, no new content to embed.`;
                            currentCompletionRatio = 1.0; // 100% done from IndexingManager's perspective
                        } else {
                            currentProgressMessage = `Embedding content...`;
                        }
                    } else {
                        currentProgressMessage = `Indexing...`; // Fallback
                    }

                    const overallPercentForNotification = Math.round(currentCompletionRatio * 100);
                    const increment = Math.max(0, overallPercentForNotification - lastReportedPercentForNotification);

                    progress.report({
                        message: currentProgressMessage,
                        increment: increment
                    });

                    if (overallPercentForNotification > lastReportedPercentForNotification) {
                        lastReportedPercentForNotification = overallPercentForNotification;
                    }
                },
                // Batch completion callback - store embeddings as each batch completes
                async (batchResults) => {
                    try {
                        const successfulBatchFiles = filesToProcess.filter(file =>
                            batchResults.has(file.id) && batchResults.get(file.id)!.success
                        );

                        if (successfulBatchFiles.length > 0) {
                            await this.embeddingDatabaseAdapter!.storeEmbeddingResults(
                                successfulBatchFiles,
                                batchResults,
                                (processedInStorage, totalInStorageBatch) => {
                                    // This callback is for storage progress within a batch, usually quick.
                                    // The main progress message for storage is updated after the batch.
                                }
                            );
                            totalStored += successfulBatchFiles.length;
                            console.log(`Saved batch of ${successfulBatchFiles.length} files. Total stored: ${totalStored}/${totalToProcess}`);
                            progress.report({
                                message: `Storing embeddings: ${totalStored}/${totalToProcess} files saved.`
                            });
                        }
                    } catch (error) {
                        console.error('Error storing batch results:', error);
                    }
                }
            );

            // Final report
            if (!token.isCancellationRequested) {
                const message = `Indexing completed. ` +
                    `Checked ${totalFilesChecked} files. ` +
                    `Indexed and stored ${totalStored} of ${totalFilesNeededIndexing} files that needed indexing.`;
                progress.report({ message });
                console.log(message);
            } else {
                const message = `Indexing cancelled. ` +
                    `Checked ${totalFilesChecked} files. ` +
                    `Processed ${totalProcessedForNotification} (embedding phase) and stored ${totalStored} of ${totalFilesNeededIndexing} files that needed indexing.`;
                progress.report({ message });
                console.log(message);
            }
        } catch (error) {
            console.error('Error during indexing:', error);
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