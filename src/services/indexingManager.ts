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
    public initializeIndexingService(modelInfo: ModelInfo): IndexingService {
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
            let totalProcessed = 0;
            let totalStored = 0;
            const totalToProcess = filesToProcess.length; // This is the actual number of files that need processing
            let lastProcessedPercent = 0;

            // Process the files with the IndexingService, saving results as batches complete
            const results = await this.indexingService!.processFiles(
                filesToProcess,
                token,
                (processed, total) => {
                    // Update progress message showing overall indexing progress
                    totalProcessed = processed;

                    // Calculate percentage based on the actual number of files to process
                    // not the total files checked
                    const processedPercent = Math.round((processed / totalToProcess) * 100);

                    // Calculate the increment for the progress bar
                    // We allocate 100% of the progress bar to the processing phase
                    if (processed > 0) {
                        // Calculate the increment based on the progress since last update
                        // Use a percentage of the total files to process as the progress indicator
                        const currentProcessedPercent = (processed / totalToProcess) * 100;
                        const incrementValue = Math.max(0, currentProcessedPercent - lastProcessedPercent);
                        lastProcessedPercent = currentProcessedPercent;

                        if (incrementValue > 0) {
                            progress.report({
                                message: `Indexing ${processed} of ${totalToProcess} files (${processedPercent}%)...`,
                                increment: incrementValue
                            });
                        } else {
                            // Just update the message without incrementing
                            progress.report({
                                message: `Indexing ${processed} of ${totalToProcess} files (${processedPercent}%)...`
                            });
                        }
                    }
                },
                // Batch completion callback - store embeddings as each batch completes
                async (batchResults) => {
                    try {
                        // Store this batch of embeddings immediately
                        const batchFiles = filesToProcess.filter(file =>
                            batchResults.has(file.id) && batchResults.get(file.id)!.success
                        );

                        if (batchFiles.length > 0) {
                            await this.embeddingDatabaseAdapter!.storeEmbeddingResults(
                                batchFiles,
                                batchResults,
                                (processed, total) => {
                                    // Only update the message, not the progress bar
                                    // The progress bar is only updated based on file processing
                                    const newStored = totalStored + processed;
                                    progress.report({
                                        message: `Processed: ${totalProcessed}/${totalToProcess}, Stored: ${newStored}/${totalToProcess}`
                                    });
                                }
                            );

                            // Update the total stored count after the batch is complete
                            totalStored += batchFiles.length;

                            // Log batch completion
                            console.log(`Saved batch of ${batchFiles.length} files. Total stored: ${totalStored}/${totalToProcess}`);
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

                // Just update the message without incrementing
                progress.report({ message });
                console.log(message);
            } else {
                // If cancelled, show how many files were successfully processed and stored
                const message = `Indexing cancelled. ` +
                    `Checked ${totalFilesChecked} files. ` +
                    `Processed ${totalProcessed} and stored ${totalStored} of ${totalFilesNeededIndexing} files that needed indexing.`;

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