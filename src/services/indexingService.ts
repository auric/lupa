import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { EventEmitter } from 'events';
import Piscina from 'piscina';
import { StatusBarService, StatusBarMessageType, StatusBarState } from './statusBarService';
import { ResourceDetectionService } from './resourceDetectionService';
import { ModelSelectionService, EmbeddingModel } from './modelSelectionService';
import { WorkspaceSettingsService } from './workspaceSettingsService';

/**
 * Interface representing a file to be processed
 */
export interface FileToProcess {
    id: string;          // Unique identifier for the file
    path: string;        // File system path
    content: string;     // File content
    priority?: number;   // Priority (higher numbers = higher priority)
}

/**
 * Result of processing a file
 */
export interface ProcessingResult {
    fileId: string;
    embeddings: Float32Array[];
    chunkOffsets: number[];
    success: boolean;
    error?: string;
}

/**
 * Options for embedding generation
 */
export interface EmbeddingOptions {
    pooling?: 'mean' | 'cls' | 'none';
    normalize?: boolean;
}

/**
 * Options for the indexing service
 */
export interface IndexingServiceOptions {
    maxWorkers?: number;                 // Maximum number of workers
    embeddingOptions?: EmbeddingOptions; // Options for embedding generation
    chunkSize?: number;                  // Size of text chunks
    overlapSize?: number;                // Overlap between chunks
    chunkSizeSafetyFactor?: number;      // Safety factor for chunk size (to account for token/character ratio)
}

/**
 * IndexingService manages multi-threaded embedding generation using Piscina
 */
export class IndexingService implements vscode.Disposable {
    private piscina: Piscina | null = null;
    private readonly statusBarService: StatusBarService;
    private currentCancellationEmitter: EventEmitter | null = null;
    private readonly defaultOptions: Required<IndexingServiceOptions> = {
        maxWorkers: Math.max(1, Math.floor((os.cpus().length + 1) / 2)), // Default to half of CPU cores
        embeddingOptions: {
            pooling: 'mean',
            normalize: true
        },
        chunkSize: 3000,               // Default chunk size (smaller than model context length)
        overlapSize: 200,              // Overlap between chunks
        chunkSizeSafetyFactor: 0.75,   // Use 75% of model's context length to account for token/char differences
    };
    private readonly options: Required<IndexingServiceOptions>;

    /**
     * Create a new IndexingService
     * @param context VS Code extension context
     * @param resourceDetectionService Service for detecting system resources
     * @param modelSelectionService Service for selecting optimal embedding model
     * @param workspaceSettingsService Service for persisting workspace settings
     * @param options Configuration options
     */
    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly resourceDetectionService: ResourceDetectionService,
        private readonly modelSelectionService: ModelSelectionService,
        private readonly workspaceSettingsService: WorkspaceSettingsService,
        options?: IndexingServiceOptions
    ) {
        this.options = { ...this.defaultOptions, ...options };
        this.statusBarService = StatusBarService.getInstance();

        // Register indexing management command
        const manageIndexingCommand = vscode.commands.registerCommand(
            'codelens-pr-analyzer.manageIndexing',
            () => this.showIndexingManagementOptions()
        );
        context.subscriptions.push(manageIndexingCommand);

        // Register command to change model
        const selectModelCommand = vscode.commands.registerCommand(
            'codelens-pr-analyzer.selectEmbeddingModel',
            () => this.showModelSelectionOptions()
        );
        context.subscriptions.push(selectModelCommand);
    }

    /**
     * Get or create the Piscina instance
     */
    private getPiscina(): Piscina {
        if (!this.piscina) {
            const workerScriptPath = path.join(this.context.extensionPath, 'dist', 'workers', 'indexingWorker.js');

            // Ensure worker script exists
            if (!fs.existsSync(workerScriptPath)) {
                throw new Error(`Worker script not found at ${workerScriptPath}`);
            }

            // Create new Piscina instance
            this.piscina = new Piscina({
                filename: workerScriptPath,
                minThreads: 1,
                maxThreads: this.options.maxWorkers,
                idleTimeout: 60000, // Keep threads alive for 1 minute to avoid frequent restarts
            });

            console.log(`Created Piscina with ${this.options.maxWorkers} max workers`);

            // Update settings after creating Piscina
            this.workspaceSettingsService.updateLastIndexingTimestamp();
        }
        return this.piscina;
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

        // Update settings based on selection
        switch (selected) {
            case options[0]: // Automatic
                this.workspaceSettingsService.setSelectedEmbeddingModel(undefined);
                break;

            case options[1]: // Force high-memory
                this.workspaceSettingsService.setSelectedEmbeddingModel(EmbeddingModel.JinaEmbeddings);
                break;

            case options[2]: // Force low-memory
                this.workspaceSettingsService.setSelectedEmbeddingModel(EmbeddingModel.MiniLM);
                break;
        }

        // If piscina exists, offer to restart it
        if (this.piscina) {
            const restartResponse = await vscode.window.showInformationMessage(
                'Restart workers to apply new model selection?',
                'Yes', 'No'
            );

            if (restartResponse === 'Yes') {
                await this.restartWorkers();
            }
        }
    }

    /**
     * Select the embedding model to use based on workspace settings and system resources
     */
    private selectEmbeddingModel(): {
        model: string;
        useHighMemoryModel: boolean;
        modelInfo: any;
    } {
        // First check if a specific model is specified in workspace settings
        const savedModel = this.workspaceSettingsService.getSelectedEmbeddingModel();

        if (savedModel) {
            // User has explicitly selected a model
            const selection = this.modelSelectionService.selectOptimalModel();
            const modelInfo = selection.modelInfo;

            const isHighMemory = savedModel === EmbeddingModel.JinaEmbeddings;

            return {
                model: savedModel,
                useHighMemoryModel: isHighMemory,
                modelInfo
            };
        }

        // Otherwise use the model selection service
        const selection = this.modelSelectionService.selectOptimalModel();

        return {
            model: selection.model,
            useHighMemoryModel: selection.useHighMemoryModel,
            modelInfo: selection.modelInfo
        };
    }

    /**
     * Get the optimal chunk size based on the selected model's context length
     */
    private getOptimalChunkSize(): number {
        const { modelInfo } = this.selectEmbeddingModel();

        // If we have context length info, use it to calculate optimal chunk size
        if (modelInfo?.contextLength) {
            // Use the safety factor to account for token/char ratio differences
            return Math.floor(modelInfo.contextLength * this.options.chunkSizeSafetyFactor);
        }

        // Fallback to the default chunk size
        return this.options.chunkSize;
    }

    /**
     * Calculate optimal worker count based on system resources
     */
    private calculateOptimalResources(): { workerCount: number, useHighMemoryModel: boolean } {
        // Select the embedding model
        const { useHighMemoryModel } = this.selectEmbeddingModel();

        // Calculate optimal worker count using the resource detection service
        const workerCount = this.resourceDetectionService.calculateOptimalWorkerCount(
            useHighMemoryModel,
            this.options.maxWorkers
        );

        return { workerCount, useHighMemoryModel };
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

        // Get Piscina instance
        const piscina = this.getPiscina();

        // Create a cancellation emitter that can be passed to workers
        this.cancelProcessing();  // Cancel any previous operation first
        this.currentCancellationEmitter = new EventEmitter();
        const cancellationEmitter = this.currentCancellationEmitter;

        // If token was provided, listen for cancellation
        if (token) {
            token.onCancellationRequested(() => {
                if (this.currentCancellationEmitter === cancellationEmitter) {
                    cancellationEmitter.emit('abort');
                }
            });
        }

        // Update status to indexing
        this.statusBarService.setState(StatusBarState.Indexing, `${files.length} files`);

        // Sort files by priority (if available) to process important files first
        const sortedFiles = [...files].sort((a, b) => (b.priority || 0) - (a.priority || 0));

        // Get the selected model
        const { model } = this.selectEmbeddingModel();

        // Get optimal chunk size
        const chunkSize = this.getOptimalChunkSize();

        try {
            // Create a task for each file
            const tasks = sortedFiles.map(file => {
                return {
                    fileId: file.id,
                    filePath: file.path,
                    content: file.content,
                    modelName: model,
                    options: {
                        ...this.options.embeddingOptions,
                        chunkSize,
                        overlapSize: this.options.overlapSize
                    },
                    signal: cancellationEmitter  // Using EventEmitter as signal
                };
            });

            // Process all files in parallel with progress tracking
            const resultMap = new Map<string, ProcessingResult>();
            let completed = 0;

            // Process in batches to provide progressive updates
            const BATCH_SIZE = 10;

            for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
                // Check if cancelled
                if (token?.isCancellationRequested) {
                    throw new Error('Operation cancelled');
                }

                const batch = tasks.slice(i, i + BATCH_SIZE);
                const promises = batch.map(task => piscina.run(task));

                // Wait for batch to complete
                const results = await Promise.all(promises);

                // Add results to map
                for (const result of results) {
                    resultMap.set(result.fileId, result);
                }

                // Update progress
                completed += batch.length;
                if (progressCallback) {
                    progressCallback(completed, files.length);
                }

                // Update status bar with progress
                const percentage = Math.round((completed / files.length) * 100);
                this.statusBarService.showTemporaryMessage(
                    `Indexing: ${percentage}% (${completed}/${files.length})`,
                    3000,
                    StatusBarMessageType.Working
                );
            }

            // Set status back to ready when done
            this.statusBarService.setState(StatusBarState.Ready);

            return resultMap;
        } catch (error) {
            // Handle errors
            console.error('Error processing files:', error);
            this.statusBarService.setState(StatusBarState.Error,
                error instanceof Error ? error.message : 'Unknown error');

            throw error;
        } finally {
            // Clean up
            this.currentCancellationEmitter = null;
        }
    }

    /**
     * Cancel any in-progress indexing operations
     */
    public cancelProcessing(): void {
        if (this.currentCancellationEmitter) {
            this.currentCancellationEmitter.emit('abort');
            this.currentCancellationEmitter = null;

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
            "Restart workers",
            "Show worker status",
            "Shutdown workers",
            "Optimize worker count"
        ];

        const selected = await vscode.window.showQuickPick(options, {
            placeHolder: "Select indexing management action"
        });

        if (!selected) return;

        switch (selected) {
            case "Cancel current indexing":
                this.cancelProcessing();
                break;

            case "Restart workers":
                await this.restartWorkers();
                break;

            case "Show worker status":
                this.showWorkerStatus();
                break;

            case "Shutdown workers":
                await this.shutdownPiscina();
                break;

            case "Optimize worker count":
                await this.optimizeWorkerCount();
                break;
        }
    }

    /**
     * Restart all workers
     */
    private async restartWorkers(): Promise<void> {
        try {
            // Cancel any ongoing operations
            this.cancelProcessing();

            // Set status to restarting workers
            this.statusBarService.setState(StatusBarState.Indexing, 'restarting workers');

            // Terminate current piscina
            await this.shutdownPiscina();

            // Create new piscina (will happen on next request)
            this.getPiscina();

            vscode.window.showInformationMessage('Workers restarted successfully');
            this.statusBarService.showTemporaryMessage(
                'Workers restarted successfully',
                3000,
                StatusBarMessageType.Info
            );
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to restart workers: ${errorMsg}`);
            this.statusBarService.setState(StatusBarState.Error, 'Failed to restart workers');
        }
    }

    /**
     * Shutdown Piscina
     */
    private async shutdownPiscina(): Promise<void> {
        if (this.piscina) {
            try {
                // Cancel any ongoing operations
                this.cancelProcessing();

                // Set status to shutting down workers
                this.statusBarService.setState(StatusBarState.Indexing, 'shutting down workers');

                // Terminate piscina
                await this.piscina.destroy();
                this.piscina = null;

                // Update status bar
                this.statusBarService.setState(StatusBarState.Ready);
            } catch (error) {
                console.error('Error shutting down piscina:', error);
                this.statusBarService.setState(StatusBarState.Error, 'Error shutting down workers');
            }
        }
    }

    /**
     * Show status of all workers
     */
    private showWorkerStatus(): void {
        if (!this.piscina) {
            vscode.window.showInformationMessage('No workers are currently running.');
            return;
        }

        const piscina = this.piscina;

        // Get stats from Piscina
        const stats = {
            threadsCount: piscina.threads.length,
            queueSize: piscina.queueSize,
            completed: piscina.completed,
            duration: piscina.duration,
            utilization: piscina.utilization,
            model: this.selectEmbeddingModel().model
        };

        const memoryUsage = process.memoryUsage();
        const memoryInfo = `Memory: ${Math.round(memoryUsage.rss / 1024 / 1024)}MB RSS, ${Math.round(memoryUsage.heapUsed / 1024 / 1024)}MB Heap`;
        const osMemInfo = `System: ${Math.round(os.totalmem() / 1024 / 1024 / 1024)}GB total, ${Math.round(os.freemem() / 1024 / 1024 / 1024)}GB free`;

        const statusDetails = [
            `Active threads: ${stats.threadsCount}`,
            `Queue size: ${stats.queueSize}`,
            `Tasks completed: ${stats.completed}`,
            `Utilization: ${Math.round(stats.utilization * 100)}%`,
            `Model: ${stats.model}`,
            memoryInfo,
            osMemInfo
        ].join('\n');

        vscode.window.showInformationMessage(statusDetails, { modal: true });
    }

    /**
     * Optimize the number of workers based on system resources
     */
    private async optimizeWorkerCount(): Promise<void> {
        try {
            const { workerCount } = this.calculateOptimalResources();

            // Store current count for comparison
            const currentCount = this.options.maxWorkers;

            if (workerCount === currentCount) {
                vscode.window.showInformationMessage(`Already using optimal worker count (${workerCount})`);
                return;
            }

            // Ask for confirmation
            const action = workerCount > currentCount ? 'increase' : 'decrease';
            const confirmation = await vscode.window.showWarningMessage(
                `This will ${action} the number of workers from ${currentCount} to ${workerCount}. Continue?`,
                'Yes', 'No'
            );

            if (confirmation !== 'Yes') {
                return;
            }

            // Update max workers option
            this.options.maxWorkers = workerCount;

            // Restart piscina with new worker count
            await this.restartWorkers();

            vscode.window.showInformationMessage(`Worker count adjusted to ${workerCount}`);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to optimize worker count: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Dispose resources
     */
    public async dispose(): Promise<void> {
        // Cancel any ongoing operations
        this.cancelProcessing();

        // Shutdown piscina
        if (this.piscina) {
            try {
                await this.piscina.destroy();
                this.piscina = null;
            } catch (error) {
                console.error('Error destroying piscina during dispose:', error);
            }
        }
    }
}