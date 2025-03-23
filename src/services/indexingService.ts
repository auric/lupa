import * as vscode from 'vscode';
import * as os from 'os';
import { StatusBarService, StatusBarMessageType, StatusBarState } from './statusBarService';
import { WorkspaceSettingsService } from './workspaceSettingsService';
import { EmbeddingOptions } from '../types/embeddingTypes';
import {
    AsyncIndexingProcessor,
    type FileToProcess,
    type ProcessingResult
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
}

/**
 * IndexingService manages embedding generation without using Piscina
 */
export class IndexingService implements vscode.Disposable {
    private readonly statusBarService: StatusBarService;

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

        this.statusBarService = StatusBarService.getInstance();

        // Register indexing management command
        const manageIndexingCommand = vscode.commands.registerCommand(
            'codelens-pr-analyzer.manageIndexing',
            () => this.showIndexingManagementOptions()
        );
        context.subscriptions.push(manageIndexingCommand);
    }

    /**
     * Get the current embedding model name
     * @returns The model name currently being used for embeddings
     */
    public getModelName(): string {
        return this.options.modelName;
    }

    /**
     * Initialize or reinitialize the processor
     */
    private createProcessor(): AsyncIndexingProcessor {
        return new AsyncIndexingProcessor(
            this.options.modelBasePath,
            this.options.modelName,
            this.options.contextLength,
            this.options.embeddingOptions
        );
    }

    /**
     * Process a batch of files with progressive updates
     * @param files Array of files to process
     * @param token Cancellation token
     * @param progressCallback Optional callback for progress updates
     * @returns Map of file IDs to embeddings
     */
    public async processFiles(
        files: FileToProcess[],
        token?: vscode.CancellationToken,
        progressCallback?: (processed: number, total: number) => void
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
            results: new Map()
        };

        // Update status to indexing
        this.statusBarService.setState(StatusBarState.Indexing, `${files.length} files`);

        // Sort files by priority (if available) to process important files first
        const sortedFiles = [...files].sort((a, b) => (b.priority || 0) - (a.priority || 0));
        try {
            // Process files concurrently but with limited concurrency
            const maxConcurrentTasks = this.options.maxConcurrentTasks;
            let completedCount = 0;

            // Process in chunks to maintain concurrency control
            for (let i = 0; i < sortedFiles.length; i += maxConcurrentTasks) {
                // Check if cancelled
                if (abortController.signal.aborted) {
                    throw new Error('Operation was cancelled');
                }

                const batch = sortedFiles.slice(i, i + maxConcurrentTasks);

                // Process the batch concurrently
                const promises = batch.map(file => {
                    const processor = this.createProcessor();
                    return processor.processFile(file, abortController.signal)
                        .then(result => {
                            if (result.success) {
                                this.currentOperation!.results.set(file.id, result);
                            }

                            // Update progress
                            completedCount++;
                            if (progressCallback) {
                                progressCallback(completedCount, files.length);
                            }

                            // Update status bar
                            const percentage = Math.round((completedCount / files.length) * 100);
                            this.statusBarService.showTemporaryMessage(
                                `Indexing: ${percentage}% (${completedCount}/${files.length})`,
                                3000,
                                StatusBarMessageType.Working
                            );

                            return result;
                        })
                        .finally(() => {
                            processor.dispose();
                        });
                });

                // Wait for the current batch to complete
                await Promise.all(promises);
            }

            // Update last indexing timestamp after successful completion
            this.workspaceSettingsService.updateLastIndexingTimestamp();

            // Set status back to ready when done
            this.statusBarService.setState(StatusBarState.Ready);

            // Return the results
            return new Map(this.currentOperation.results);
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
    private async showIndexingManagementOptions(): Promise<void> {
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
    }
}