import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import Piscina from 'piscina';
import { StatusBarService, StatusBarMessageType, StatusBarState } from './statusBarService';
import { WorkspaceSettingsService } from './workspaceSettingsService';
import { EmbeddingOptions } from '../types/embeddingTypes';
import {
    type FileToProcess,
    type ProcessingResult,
    type PiscinaTaskData
} from '../workers/asyncIndexingProcessor';

/**
 * Options for the indexing service
 */
export interface IndexingServiceOptions {
    modelBasePath: string;               // Base path for the embedding model
    modelName: string;                   // Name of the embedding model to use
    contextLength: number;               // Context length of the model (required)
    maxConcurrentTasks?: number;         // Maximum number of concurrent processing tasks
    embeddingOptions?: EmbeddingOptions; // Options for embedding generation
}

/**
 * Tracks an active processing operation
 */
interface ProcessingOperation {
    files: FileToProcess[];
    abortController: AbortController;
    completedCount: number;
    results: Map<string, ProcessingResult>;
    promises: Promise<ProcessingResult>[];
}

/**
 * IndexingService manages embedding generation using Piscina worker pool
 */
export class IndexingService implements vscode.Disposable {
    private readonly statusBarService: StatusBarService;
    private piscina: Piscina | null = null;

    // Track current processing operation
    private currentOperation: ProcessingOperation | null = null;

    private readonly defaultOptions: Required<Omit<IndexingServiceOptions, 'modelBasePath' | 'modelName' | 'contextLength'>> = {
        maxConcurrentTasks: Math.max(2, Math.ceil(os.cpus().length / 2)), // Default to half of CPU cores
        embeddingOptions: {
            pooling: 'mean',
            normalize: true
        }
    };

    private readonly options: Required<IndexingServiceOptions>;

    /**
     * Create a new IndexingService
     * @param context VS Code extension context
     * @param workspaceSettingsService Service for persisting workspace settings
     * @param options Configuration options including model name and context length
     */
    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly workspaceSettingsService: WorkspaceSettingsService,
        options: IndexingServiceOptions
    ) {
        // Ensure required parameters are provided
        if (!options.modelName) {
            throw new Error('Model name must be provided to IndexingService');
        }
        if (!options.contextLength) {
            throw new Error('Context length must be provided to IndexingService');
        }

        this.options = {
            ...this.defaultOptions,
            ...options
        } as Required<IndexingServiceOptions>;

        // Initialize Piscina worker pool
        this.initializePiscinaPool();

        this.statusBarService = StatusBarService.getInstance();
    }

    /**
     * Initialize Piscina worker pool
     */
    private initializePiscinaPool(): void {
        // Determine the path to the distributable asyncIndexingProcessor.js
        const workerFilename = path.join(this.context.extensionPath, 'dist', 'workers', 'asyncIndexingProcessor.js');

        this.piscina = new Piscina({
            filename: workerFilename,
            maxThreads: this.options.maxConcurrentTasks,
            workerData: {
                modelBasePath: this.options.modelBasePath,
                modelName: this.options.modelName,
                contextLength: this.options.contextLength,
                embeddingOptions: this.options.embeddingOptions
            }
        });
    }

    /**
     * Get the current embedding model name
     * @returns The model name currently being used for embeddings
     */
    public getModelName(): string {
        return this.options.modelName;
    }

    /**
     * Process a batch of files with progressive updates
     * @param files Array of files to process
     * @param token Cancellation token
     * @param progressCallback Optional callback for progress updates
     * @param batchCompletedCallback Optional callback when a batch is completed
     * @returns Map of file IDs to embeddings
     */
    public async processFiles(
        files: FileToProcess[],
        token?: vscode.CancellationToken,
        progressCallback?: (processed: number, total: number) => void,
        batchCompletedCallback?: (batchResults: Map<string, ProcessingResult>) => Promise<void>
    ): Promise<Map<string, ProcessingResult>> {
        if (files.length === 0) {
            return new Map();
        }

        // Cancel any existing operation
        if (this.currentOperation) {
            await this.cancelProcessing();
        }

        // Create abort controller and link to VS Code token if provided
        const abortController = new AbortController();
        if (token) {
            token.onCancellationRequested(() => {
                abortController.abort();
            });
        }

        // Create a new operation
        this.currentOperation = {
            files,
            abortController,
            completedCount: 0,
            results: new Map(),
            promises: []
        };

        // Update status to indexing
        this.statusBarService.setState(StatusBarState.Indexing, `${files.length} files`);

        // Sort files by priority (if available) to process important files first
        const sortedFiles = [...files].sort((a, b) => (b.priority || 0) - (a.priority || 0));

        try {
            if (!this.piscina) {
                throw new Error('Piscina worker pool is not initialized');
            }

            let completedCount = 0;
            const totalFiles = sortedFiles.length;

            // Temporary batch storage for batching results
            const temporaryBatchResults = new Map<string, ProcessingResult>();
            const batchSize = Math.min(50, this.options.maxConcurrentTasks * 2); // Configurable batch size

            // Submit all tasks to Piscina
            const taskPromises = sortedFiles.map(file =>
                this.piscina!.run(
                    { file } as PiscinaTaskData,
                    { signal: abortController.signal }
                ).then((result: ProcessingResult) => {
                    // Update progress as each task completes
                    completedCount++;

                    if (progressCallback) {
                        progressCallback(completedCount, totalFiles);
                    }

                    // Update status bar with overall progress
                    const percentage = Math.round((completedCount / totalFiles) * 100);
                    this.statusBarService.showTemporaryMessage(
                        `Indexing: ${percentage}% (${completedCount}/${totalFiles})`,
                        3000,
                        StatusBarMessageType.Working
                    );

                    return result;
                }).catch((error: Error) => {
                    // Handle individual task errors
                    console.error(`Error processing file ${file.path}:`, error);
                    completedCount++;

                    if (progressCallback) {
                        progressCallback(completedCount, totalFiles);
                    }

                    return {
                        fileId: file.id,
                        success: false,
                        error: error instanceof Error ? error.message : String(error),
                        metadata: {
                            parentStructureIds: [],
                            structureOrders: [],
                            isOversizedFlags: [],
                            structureTypes: []
                        },
                        embeddings: [],
                        chunkOffsets: []
                    } as ProcessingResult;
                })
            );

            // Store all task promises for cancellation
            this.currentOperation!.promises = taskPromises;

            // Process results as they complete and batch them
            for (const taskPromise of taskPromises) {
                try {
                    const result = await taskPromise;

                    // Check if operation was cancelled
                    if (!this.currentOperation) {
                        break;
                    }

                    if (result.success) {
                        this.currentOperation.results.set(result.fileId, result);
                        temporaryBatchResults.set(result.fileId, result);
                    }

                    // If we've reached the batch size or this is the last result, process the batch
                    if (temporaryBatchResults.size >= batchSize ||
                        (this.currentOperation && this.currentOperation.results.size === sortedFiles.filter(f =>
                            this.currentOperation!.results.has(f.id) || temporaryBatchResults.has(f.id)
                        ).length)) {

                        if (batchCompletedCallback && temporaryBatchResults.size > 0) {
                            try {
                                await batchCompletedCallback(new Map(temporaryBatchResults));
                            } catch (error) {
                                console.error('Error in batch completion callback:', error);
                            }
                        }

                        // Clear the temporary batch
                        temporaryBatchResults.clear();
                    }
                } catch (error) {
                    console.error('Error waiting for task result:', error);
                }
            }

            // Update last indexing timestamp after successful completion
            this.workspaceSettingsService.updateLastIndexingTimestamp();

            // Set status back to ready when done
            this.statusBarService.setState(StatusBarState.Ready);

            // Return the results (check if operation still exists)
            return new Map(this.currentOperation?.results || []);
        } catch (error) {
            // Handle errors
            console.error('Error processing files:', error);
            this.statusBarService.setState(StatusBarState.Error,
                error instanceof Error ? error.message : 'Unknown error');

            throw error;
        } finally {
            // Clean up any remaining processors
            this.currentOperation = null;
        }
    }

    /**
     * Cancel any in-progress indexing operations
     */
    public async cancelProcessing(): Promise<void> {
        if (this.currentOperation) {
            // Abort the operation
            this.currentOperation.abortController.abort();

            try {
                // Wait for all promises to settle
                await Promise.allSettled(this.currentOperation.promises);
            } catch (error) {
                // Ignore errors during cancellation
                console.warn('Errors during cancellation cleanup:', error);
            }

            this.currentOperation = null;

            this.statusBarService.showTemporaryMessage(
                'Indexing cancelled',
                3000,
                StatusBarMessageType.Warning
            );

            this.statusBarService.setState(StatusBarState.Ready);
        }
    }

    /**
     * Show indexing management options
     */
    public async showIndexingManagementOptions(): Promise<void> {
        const options = [
            "Cancel current indexing",
            "Restart processor",
            "Show processor status"
        ];

        const selected = await vscode.window.showQuickPick(options, {
            placeHolder: "Select indexing management action"
        });

        if (!selected) return;

        switch (selected) {
            case "Cancel current indexing":
                await this.cancelProcessing();
                break;
            case "Show processor status":
                this.showProcessorStatus();
                break;
        }
    }

    /**
     * Show processor status
     */
    private showProcessorStatus(): void {
        const memoryUsage = process.memoryUsage();
        const memoryInfo = `Memory: ${Math.round(memoryUsage.rss / 1024 / 1024)}MB RSS, ${Math.round(memoryUsage.heapUsed / 1024 / 1024)}MB Heap`;
        const osMemInfo = `System: ${Math.round(os.totalmem() / 1024 / 1024 / 1024)}GB total, ${Math.round(os.freemem() / 1024 / 1024 / 1024)}GB free`;
        const modelInfo = `Model: ${this.options.modelName}`;
        const contextInfo = `Context length: ${this.options.contextLength}`;
        const operationStatus = this.currentOperation ?
            `Active operation: ${this.currentOperation.completedCount}/${this.currentOperation.files.length} files processed` :
            'No active operation';

        const statusDetails = [
            modelInfo,
            contextInfo,
            operationStatus,
            memoryInfo,
            osMemInfo
        ].join('\n');

        vscode.window.showInformationMessage(statusDetails, { modal: true });
    }

    /**
     * Dispose resources
     */
    public async dispose(): Promise<void> {
        // Cancel any ongoing operations
        await this.cancelProcessing();

        // Destroy Piscina worker pool
        if (this.piscina) {
            await this.piscina.destroy();
            this.piscina = null;
        }
    }
}