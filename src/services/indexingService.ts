import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { Worker } from 'worker_threads';
import { StatusBarService } from './statusBarService';
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
 * Interface representing a work item for embedding generation
 */
interface WorkItem extends FileToProcess {
    resolve: (result: ProcessingResult) => void;
    reject: (error: Error) => void;
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

interface WorkerData {
    worker: Worker;
    status: 'idle' | 'busy' | 'initializing' | 'error';
    modelName?: string;
}

/**
 * IndexingService manages multi-threaded embedding generation
 */
export class IndexingService implements vscode.Disposable {
    private workers: Array<WorkerData> = [];
    private workQueue: WorkItem[] = [];
    private activeProcessing: Map<string, WorkItem> = new Map(); // Track files that are actively being processed
    private isProcessing: boolean = false;
    private readonly statusBarId = 'prAnalyzer.indexing';
    private cancelTokenSource?: vscode.CancellationTokenSource;
    private extensionPath: string;
    private totalItems: number = 0;
    private processedItems: number = 0;
    private options: Required<IndexingServiceOptions>;
    private defaultOptions: Required<IndexingServiceOptions> = {
        maxWorkers: Math.max(1, os.cpus().length - 1), // Default to CPU count - 1
        embeddingOptions: {
            pooling: 'mean',
            normalize: true
        },
        chunkSize: 3000,               // Default chunk size (smaller than model context length)
        overlapSize: 200,              // Overlap between chunks
        chunkSizeSafetyFactor: 0.75,   // Use 75% of model's context length to account for token/char differences
    };
    private workersInitialized: boolean = false;
    private initializationPromise: Promise<void> | null = null;

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
        this.extensionPath = context.extensionPath;

        // Create a status bar item via StatusBarService
        const statusBarService = StatusBarService.getInstance();
        const statusBar = statusBarService.getOrCreateItem(this.statusBarId, vscode.StatusBarAlignment.Right, 90);
        statusBar.text = "$(database) PR Indexer";
        statusBar.tooltip = "PR Analyzer Indexing";
        statusBar.command = "codelens-pr-analyzer.manageIndexing";
        statusBar.hide(); // Hide initially until needed

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
     * Show options for selecting embedding model
     */
    private async showModelSelectionOptions(): Promise<void> {
        // Check if workers are initialized
        if (this.workersInitialized) {
            const response = await vscode.window.showWarningMessage(
                'Changing the embedding model will require restarting all workers and may cause inconsistencies with existing embeddings. Continue?',
                { modal: true },
                'Yes', 'No'
            );

            if (response !== 'Yes') {
                return;
            }
        }

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

        // If workers are already initialized, offer to restart them
        if (this.workersInitialized) {
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
            const modelInfos = selection.modelInfo;

            const isHighMemory = savedModel === EmbeddingModel.JinaEmbeddings;

            return {
                model: savedModel,
                useHighMemoryModel: isHighMemory,
                modelInfo: modelInfos
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
        if (modelInfo && modelInfo.contextLength) {
            // Use the safety factor to account for token/char ratio differences
            // Most models use about 4-5 chars per token, but we're conservative
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
     * Initialize worker pool on demand
     */
    private initializeWorkers(): Promise<void> {
        // If workers are already initialized, return immediately
        if (this.workersInitialized) {
            return Promise.resolve();
        }

        // If initialization is in progress, return the existing promise
        if (this.initializationPromise) {
            return this.initializationPromise;
        }

        // Create a new initialization promise
        this.initializationPromise = this._initializeWorkers();

        // Once initialization completes (success or failure), clear the promise
        this.initializationPromise.finally(() => {
            this.initializationPromise = null;
        });

        return this.initializationPromise;
    }

    /**
     * Actual worker initialization implementation
     */
    private async _initializeWorkers(): Promise<void> {
        try {
            const statusBarService = StatusBarService.getInstance();
            const statusBar = statusBarService.getOrCreateItem(this.statusBarId);
            statusBar.text = '$(sync~spin) PR Indexer [init]';
            statusBar.tooltip = 'PR Analyzer: Initializing workers';
            statusBar.show();

            const { workerCount, useHighMemoryModel } = this.calculateOptimalResources();

            console.log(`Initializing ${workerCount} workers with ${useHighMemoryModel ? 'high' : 'low'} memory model`);

            // Create workers one by one to avoid race conditions in pipeline initialization
            for (let i = 0; i < workerCount; i++) {
                console.log(`Initializing worker ${i + 1} of ${workerCount}`);
                await this.createAndInitializeWorker();
                // Add a small delay between worker initializations to avoid resource contention
                await new Promise(resolve => setTimeout(resolve, 500));
            }

            this.workersInitialized = true;
            this.updateStatusBar();

            // Record that we've initialized with the current model
            this.workspaceSettingsService.updateLastIndexingTimestamp();
        } catch (error) {
            console.error('Failed to initialize workers:', error);
            vscode.window.showErrorMessage(`Failed to initialize indexing workers: ${error instanceof Error ? error.message : String(error)}`);

            const statusBarService = StatusBarService.getInstance();
            const statusBar = statusBarService.getOrCreateItem(this.statusBarId);
            statusBar.text = '$(error) PR Indexer';
            statusBar.tooltip = 'PR Analyzer: Failed to initialize workers';
            statusBar.show();

            // Re-throw so caller knows initialization failed
            throw error;
        }
    }

    /**
     * Create and initialize a single worker
     */
    private createAndInitializeWorker(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            try {
                // Find the worker script path
                const workerScriptPath = path.join(this.extensionPath, 'dist', 'workers', 'indexingWorker.js');

                // Ensure worker script exists
                if (!fs.existsSync(workerScriptPath)) {
                    reject(new Error(`Worker script not found at ${workerScriptPath}`));
                    return;
                }

                // Create new worker
                const worker = new Worker(workerScriptPath);

                // Add to worker pool as initializing
                const workerInfo: WorkerData = {
                    worker,
                    status: 'initializing'
                };
                this.workers.push(workerInfo);

                // Set up event handlers for this worker
                const readyHandler = (message: any) => {
                    if (message.type === 'status' && message.status === 'ready') {
                        // Worker is ready, resolve the promise
                        workerInfo.status = 'idle';
                        workerInfo.modelName = message.modelName;
                        worker.off('message', readyHandler);
                        resolve();
                    }
                };

                // Set up message handling for this worker
                worker.on('message', readyHandler);
                worker.on('message', (message: any) => this.handleWorkerMessage(worker, message));
                worker.on('error', (error) => {
                    reject(error);
                    this.handleWorkerError(worker, error);
                });
                worker.on('exit', (code) => this.handleWorkerExit(worker, code));

                // Get the selected model
                const { model } = this.selectEmbeddingModel();
                const modelPath = path.join(this.context.extensionPath, 'models', model);

                // Check if models exist
                if (!fs.existsSync(modelPath) || fs.readdirSync(modelPath).length === 0) {
                    reject(new Error(`Model not found at ${modelPath}. Please reinstall the extension or download model files.`));
                    return;
                }

                // Send initialization message
                console.log(`Initializing worker with model: ${model} at path: ${modelPath}`);
                worker.postMessage({
                    type: 'initialize',
                    modelName: model,
                    cachePath: modelPath
                });

                // Wait for worker to be ready (will be updated via message handler)
                // Promise will be resolved by the readyHandler
            } catch (error) {
                reject(error);
            }
        });
    }

    /**
     * Handle messages from worker threads
     */
    private handleWorkerMessage(worker: Worker, message: any): void {
        if (!message || !message.type) {
            console.error('Invalid message from worker:', message);
            return;
        }

        const workerIndex = this.workers.findIndex(w => w.worker === worker);
        if (workerIndex === -1) {
            console.error('Message from unknown worker');
            return;
        }

        switch (message.type) {
            case 'status':
                this.handleWorkerStatusMessage(workerIndex, message);
                break;

            case 'result':
                this.handleWorkerResultMessage(workerIndex, message);
                break;

            default:
                console.warn('Unknown message type from worker:', message.type);
        }
    }

    /**
     * Handle status message from worker
     */
    private handleWorkerStatusMessage(workerIndex: number, message: any): void {
        const worker = this.workers[workerIndex];

        if (message.status) {
            worker.status = message.status;

            if (message.modelName) {
                worker.modelName = message.modelName;
            }

            if (message.status === 'ready' || message.status === 'idle') {
                // Worker is available for processing
                this.processNextItem();
            } else if (message.status === 'error' && message.error) {
                console.error(`Worker ${workerIndex} error: ${message.error}`);
            }
        }

        this.updateStatusBar();
    }

    /**
     * Handle result message from worker
     */
    private handleWorkerResultMessage(workerIndex: number, message: any): void {
        if (!message.fileId) {
            console.error('Worker result missing fileId:', message);
            return;
        }

        // Find the corresponding work item in the active processing map
        const fileId = message.fileId;
        const workItem = this.activeProcessing.get(fileId);

        if (!workItem) {
            console.warn(`No pending work item found for fileId: ${fileId}`);
            return;
        }

        // Remove from active processing
        this.activeProcessing.delete(fileId);

        if (message.success) {
            // Update progress tracking
            this.processedItems++;
            this.updateProgress();

            // Resolve the promise with the result
            workItem.resolve({
                fileId: message.fileId,
                embeddings: message.embeddings || [],
                chunkOffsets: message.chunkOffsets || [],
                success: true
            });
        } else {
            workItem.reject(new Error(message.error || 'Unknown error processing file'));
        }

        // Process next item in queue if available
        this.processNextItem();
    }

    /**
     * Handle worker errors
     */
    private handleWorkerError(worker: Worker, error: Error): void {
        const workerIndex = this.workers.findIndex(w => w.worker === worker);

        console.error(`Worker ${workerIndex !== -1 ? workerIndex : 'unknown'} error:`, error);

        if (workerIndex !== -1) {
            this.workers[workerIndex].status = 'error';
            this.updateStatusBar();

            // Attempt to recreate the worker
            this.recreateWorker(workerIndex);
        }
    }

    /**
     * Handle worker exit
     */
    private handleWorkerExit(worker: Worker, code: number): void {
        const workerIndex = this.workers.findIndex(w => w.worker === worker);

        console.log(`Worker ${workerIndex !== -1 ? workerIndex : 'unknown'} exited with code ${code}`);

        if (workerIndex !== -1 && code !== 0 && this.workersInitialized) {
            // Non-zero exit code indicates an error
            this.workers[workerIndex].status = 'error';
            this.updateStatusBar();

            // Attempt to recreate the worker
            this.recreateWorker(workerIndex);
        }
    }

    /**
     * Recreate a worker after error
     */
    private async recreateWorker(workerIndex: number): Promise<void> {
        try {
            // Get useHighMemoryModel value from existing model name if available
            const currentModel = this.workers[workerIndex].modelName;
            const useHighMemoryModel = currentModel === 'jinaai/jina-embeddings-v2-base-code';

            // Remove old worker reference
            const oldWorker = this.workers[workerIndex].worker;
            this.workers.splice(workerIndex, 1);

            try {
                // Attempt graceful termination
                await oldWorker.terminate();
            } catch (e) {
                // Ignore errors during termination
                console.warn('Error terminating worker:', e);
            }

            // Create a new worker
            await this.createAndInitializeWorker();

            // Process next items if available
            this.processNextItem();
        } catch (error) {
            console.error('Failed to recreate worker:', error);
            vscode.window.showErrorMessage(`Failed to recover worker thread: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Update status bar with worker status
     */
    private updateStatusBar(): void {
        const statusBarService = StatusBarService.getInstance();
        const statusBar = statusBarService.getOrCreateItem(this.statusBarId);

        const idleCount = this.workers.filter(w => w.status === 'idle').length;
        const busyCount = this.workers.filter(w => w.status === 'busy').length;
        const initCount = this.workers.filter(w => w.status === 'initializing').length;
        const errorCount = this.workers.filter(w => w.status === 'error').length;

        const queueLength = this.workQueue.length;
        const activeCount = this.activeProcessing.size;

        // Show busy indicator if we have busy workers or pending items
        if (busyCount > 0 || queueLength > 0 || activeCount > 0) {
            // Show spinner, busy count, and queue length
            statusBar.text = `$(sync~spin) PR Indexer [${busyCount}/${this.workers.length}] ${queueLength}q`;
            statusBar.tooltip = `PR Analyzer: ${busyCount} busy, ${activeCount} active, ${idleCount} idle, ${queueLength} queued`;
            statusBar.show();
        } else if (initCount > 0) {
            // Show initializing indicator
            statusBar.text = `$(sync~spin) PR Indexer [init]`;
            statusBar.tooltip = `PR Analyzer: Initializing workers (${initCount}/${this.workers.length})`;
            statusBar.show();
        } else if (errorCount > 0) {
            // Show error indicator
            statusBar.text = `$(error) PR Indexer [${errorCount} errors]`;
            statusBar.tooltip = `PR Analyzer: ${errorCount} workers have errors. Click to manage.`;
            statusBar.show();
        } else if (this.workers.length > 0) {
            // Show ready indicator only if workers exist
            statusBar.text = `$(database) PR Indexer`;

            const primaryCount = this.workers.filter(w => w.modelName === 'jinaai/jina-embeddings-v2-base-code').length;
            const fallbackCount = this.workers.filter(w => w.modelName === 'Xenova/all-MiniLM-L6-v2').length;

            if (primaryCount > 0 && fallbackCount > 0) {
                statusBar.tooltip = `PR Analyzer: ${primaryCount} primary, ${fallbackCount} fallback workers ready`;
            } else if (primaryCount > 0) {
                statusBar.tooltip = `PR Analyzer: ${primaryCount} primary workers ready`;
            } else if (fallbackCount > 0) {
                statusBar.tooltip = `PR Analyzer: ${fallbackCount} fallback workers ready`;
            } else {
                statusBar.tooltip = `PR Analyzer: ${this.workers.length} workers ready`;
            }

            statusBar.show();
        } else {
            // Hide status bar if no workers exist
            statusBar.hide();
        }
    }

    /**
     * Update progress reporting
     */
    private updateProgress(): void {
        if (this.totalItems === 0) {
            return;
        }

        const percentage = Math.round((this.processedItems / this.totalItems) * 100);
        vscode.window.setStatusBarMessage(`Indexing: ${percentage}% (${this.processedItems}/${this.totalItems})`, 3000);
    }

    /**
     * Process the next work item in the queue
     */
    private processNextItem(): void {
        // Find an idle worker
        const idleWorkerIndex = this.workers.findIndex(w => w.status === 'idle');

        if (idleWorkerIndex === -1 || this.workQueue.length === 0) {
            // No idle workers or no work to do
            return;
        }

        // Get next work item (prioritize by priority, then FIFO)
        this.workQueue.sort((a, b) => (b.priority || 0) - (a.priority || 0));
        const workItem = this.workQueue[0];

        // Remove from queue
        this.workQueue.shift();

        // Get the worker
        const workerInfo = this.workers[idleWorkerIndex];
        workerInfo.status = 'busy';

        try {
            // Get optimal chunk size based on the selected model
            const chunkSize = this.getOptimalChunkSize();

            // Send the work item to the worker
            workerInfo.worker.postMessage({
                type: 'process',
                fileId: workItem.id,
                filePath: workItem.path,
                content: workItem.content,
                options: {
                    ...this.options.embeddingOptions,
                    chunkSize: chunkSize,
                    overlapSize: this.options.overlapSize
                }
            });

            // Add to active processing map
            this.activeProcessing.set(workItem.id, workItem);

            this.updateStatusBar();
        } catch (error) {
            // Handle error sending message to worker
            console.error('Error sending work to worker:', error);
            workerInfo.status = 'error';

            // Put the work item back in the queue
            this.workQueue.unshift(workItem);

            // Try to recreate the worker
            this.recreateWorker(idleWorkerIndex);
        }
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

        // Initialize workers on first use
        if (!this.workersInitialized) {
            await this.initializeWorkers();
        }

        // Create a new cancellation token source if none provided
        this.cancelTokenSource = token ? undefined : new vscode.CancellationTokenSource();
        const effectiveToken = token || this.cancelTokenSource!.token;

        // Reset progress tracking
        this.totalItems = files.length;
        this.processedItems = 0;

        // Show indexer status bar during processing
        const statusBarService = StatusBarService.getInstance();
        const statusBar = statusBarService.getOrCreateItem(this.statusBarId);
        statusBar.show();

        // Sort files by priority (if available) to process important files first
        const sortedFiles = [...files].sort((a, b) => (b.priority || 0) - (a.priority || 0));

        // Process files in batches to provide progressive results
        const resultMap = new Map<string, ProcessingResult>();
        const batchSize = Math.max(5, Math.ceil(files.length / 10)); // Process in roughly 10 batches

        for (let i = 0; i < sortedFiles.length; i += batchSize) {
            if (effectiveToken.isCancellationRequested) {
                throw new Error('Operation cancelled');
            }

            const batch = sortedFiles.slice(i, i + batchSize);

            // Create a promise for each file in the batch
            const batchPromises = batch.map(file => {
                return new Promise<ProcessingResult>((resolve, reject) => {
                    // Create work item
                    const workItem: WorkItem = {
                        ...file,
                        resolve,
                        reject
                    };

                    // Check if operation was cancelled
                    if (effectiveToken.isCancellationRequested) {
                        reject(new Error('Operation cancelled'));
                        return;
                    }

                    // Add to queue
                    this.workQueue.push(workItem);
                });
            });

            // Start processing if not already started
            if (!this.isProcessing) {
                this.isProcessing = true;
                this.processNextItem();
            }

            // Wait for this batch to complete
            const batchResults = await Promise.all(batchPromises);

            // Add results to the map
            for (const result of batchResults) {
                resultMap.set(result.fileId, result);
            }

            // Update progress
            if (progressCallback) {
                progressCallback(Math.min(i + batchSize, files.length), files.length);
            }
        }

        return resultMap;
    }

    /**
     * Cancel any in-progress indexing operations
     */
    public cancelProcessing(): void {
        if (this.cancelTokenSource) {
            this.cancelTokenSource.cancel();
            this.cancelTokenSource = undefined;
        }

        // Clear the work queue
        const pendingItems = [...this.workQueue];
        this.workQueue = [];

        // Reject all pending promises
        for (const item of pendingItems) {
            item.reject(new Error('Operation cancelled'));
        }

        this.isProcessing = false;
        this.updateStatusBar();
        vscode.window.setStatusBarMessage('Indexing cancelled', 3000);
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
            "Start workers",
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
                await this.shutdownWorkers();
                break;

            case "Start workers":
                await this.initializeWorkers();
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

            // Terminate all workers
            await this.shutdownWorkers();

            // Initialize new workers
            await this.initializeWorkers();

            vscode.window.showInformationMessage('Workers restarted successfully');
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to restart workers: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Shutdown all workers
     */
    private async shutdownWorkers(): Promise<void> {
        try {
            // Cancel any ongoing operations
            this.cancelProcessing();

            // Reset initialization flag to prevent workers recriation
            this.workersInitialized = false;

            // Terminate all workers
            const workersCopy = [...this.workers];
            for (const workerInfo of workersCopy) {
                try {
                    await workerInfo.worker.terminate();
                } catch (e) {
                    console.warn('Error terminating worker:', e);
                }
            }

            // Clear workers array
            this.workers = [];

            // Update status bar
            this.updateStatusBar();

            console.log('Workers shutdown successfully');
        } catch (error) {
            console.error('Error shutting down workers:', error);
        }
    }

    /**
     * Show status of all workers
     */
    private showWorkerStatus(): void {
        if (!this.workersInitialized || this.workers.length === 0) {
            vscode.window.showInformationMessage('No workers are currently running.');
            return;
        }

        const statusDetails = this.workers.map((w, i) => {
            return `Worker #${i}: ${w.status}${w.modelName ? ` (${w.modelName})` : ''}`;
        }).join('\n');

        const memoryUsage = process.memoryUsage();
        const memoryInfo = `Memory usage: ${Math.round(memoryUsage.rss / 1024 / 1024)}MB RSS, ${Math.round(memoryUsage.heapUsed / 1024 / 1024)}MB Heap`;

        const osMemInfo = `System memory: ${Math.round(os.totalmem() / 1024 / 1024 / 1024)}GB total, ${Math.round(os.freemem() / 1024 / 1024 / 1024)}GB free`;

        const queueInfo = `Queue: ${this.workQueue.length} items`;

        const message = `${statusDetails}\n\n${memoryInfo}\n${osMemInfo}\n${queueInfo}`;

        vscode.window.showInformationMessage(message, { modal: true });
    }

    /**
     * Optimize the number of workers based on system resources
     */
    private async optimizeWorkerCount(): Promise<void> {
        try {
            const { workerCount, useHighMemoryModel } = this.calculateOptimalResources();

            if (!this.workersInitialized) {
                // Just set the option and initialize
                this.options.maxWorkers = workerCount;
                await this.initializeWorkers();
                return;
            }

            // If we already have the correct number of workers, no need to change
            if (workerCount === this.workers.length) {
                vscode.window.showInformationMessage(`Already using optimal worker count (${workerCount})`);
                return;
            }

            // Ask for confirmation
            const action = workerCount > this.workers.length ? 'increase' : 'decrease';
            const confirmation = await vscode.window.showWarningMessage(
                `This will ${action} the number of workers from ${this.workers.length} to ${workerCount}. Continue?`,
                'Yes', 'No'
            );

            if (confirmation !== 'Yes') {
                return;
            }

            // Cancel ongoing operations
            this.cancelProcessing();

            // Terminate all workers
            await this.shutdownWorkers();

            // Update max workers option
            this.options.maxWorkers = workerCount;

            // Initialize new workers
            await this.initializeWorkers();

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
        if (this.cancelTokenSource) {
            // Use try-catch to prevent errors during dispose
            try {
                this.cancelTokenSource.cancel();
            } catch (e) {
                console.warn('Error cancelling operations during dispose:', e);
            }
            this.cancelTokenSource = undefined;
        }

        // Clear the work queue without rejecting promises (to avoid errors during dispose)
        this.workQueue = [];
        this.activeProcessing.clear();

        // Terminate all workers
        try {
            await this.shutdownWorkers();
        } catch (e) {
            console.warn('Error shutting down workers during dispose:', e);
        }
    }
}