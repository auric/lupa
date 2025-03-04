import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { Worker } from 'worker_threads';
import { ModelCacheService } from './modelCacheService';
import { StatusBarService, StatusBarMessageType } from './statusBarService';

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
    highMemoryThreshold?: number;        // Threshold in GB for high memory
    memoryReserveGB?: number;            // Memory to reserve for other processes
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
        chunkSize: 4096,
        overlapSize: 200,
        highMemoryThreshold: 8, // GB
        memoryReserveGB: 4      // 4GB reserve for other processes
    };
    private modelsPath: string;
    private workersInitialized: boolean = false;
    private initializationPromise: Promise<void> | null = null;

    /**
     * Create a new IndexingService
     * @param context VS Code extension context
     * @param modelCacheService Model cache service to use for model paths and status bar
     * @param options Configuration options
     */
    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly modelCacheService: ModelCacheService,
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

        // Get models path from service
        this.modelsPath = modelCacheService.getModelsPath();

        // Register indexing management command
        const manageIndexingCommand = vscode.commands.registerCommand(
            'codelens-pr-analyzer.manageIndexing',
            () => this.showIndexingManagementOptions()
        );
        context.subscriptions.push(manageIndexingCommand);
    }

    /**
     * Determine optimal worker count and memory allocation based on system resources
     */
    private calculateOptimalResources(): { workerCount: number, useHighMemoryModel: boolean } {
        const totalMemoryGB = os.totalmem() / 1024 / 1024 / 1024; // Convert to GB
        const availableMemoryGB = os.freemem() / 1024 / 1024 / 1024; // Convert to GB

        // Check if we have enough memory for the high-memory model
        const useHighMemoryModel = availableMemoryGB >= this.options.highMemoryThreshold;

        // Calculate optimal worker count based on available memory and CPUs
        const cpuCount = os.cpus().length;
        let workerCount = Math.max(1, Math.min(cpuCount - 1, this.options.maxWorkers));

        // If we're using the high memory model, we might need to reduce worker count
        if (useHighMemoryModel) {
            // Ensure at least 8GB per worker for high-memory model
            const maxWorkersForMemory = Math.max(1, Math.floor(availableMemoryGB / 8));
            workerCount = Math.min(workerCount, maxWorkersForMemory);
        }

        console.log(`Worker calculation: cpus=${cpuCount}, totalMemoryGB=${totalMemoryGB.toFixed(2)}, availableMemoryGB=${availableMemoryGB.toFixed(2)}, highMemoryModel=${useHighMemoryModel}, workerCount=${workerCount}`);
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
                await this.createAndInitializeWorker(useHighMemoryModel);
                // Add a small delay between worker initializations to avoid resource contention
                await new Promise(resolve => setTimeout(resolve, 500));
            }

            this.workersInitialized = true;
            this.updateStatusBar();
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
    private createAndInitializeWorker(useHighMemoryModel: boolean): Promise<void> {
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

                // Determine model paths based on model option
                const primaryModelPath = path.join(this.modelsPath, 'jinaai', 'jina-embeddings-v2-base-code');
                const fallbackModelPath = path.join(this.modelsPath, 'Xenova', 'all-MiniLM-L6-v2');

                // Choose which path to use
                const cachePath = useHighMemoryModel ? primaryModelPath : fallbackModelPath;

                // Initialize the worker with appropriate model
                const modelName = useHighMemoryModel ?
                    'jinaai/jina-embeddings-v2-base-code' :
                    'Xenova/all-MiniLM-L6-v2';

                // Check if models exist
                if (!fs.existsSync(cachePath) || fs.readdirSync(cachePath).length === 0) {
                    reject(new Error(`Model not found at ${cachePath}. Please run "npm run prepare-models" to download the required models.`));
                    return;
                }

                // Send initialization message
                console.log(`Initializing worker with model: ${modelName} at path: ${cachePath}`);
                worker.postMessage({
                    type: 'initialize',
                    modelName,
                    cachePath
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
            await this.createAndInitializeWorker(useHighMemoryModel);

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
            // Send the work item to the worker
            workerInfo.worker.postMessage({
                type: 'process',
                fileId: workItem.id,
                filePath: workItem.path,
                content: workItem.content,
                options: {
                    ...this.options.embeddingOptions,
                    chunkSize: this.options.chunkSize,
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
     * Process a batch of files and generate embeddings
     * @param files Array of files to process
     * @param token Cancellation token
     * @returns Map of file IDs to embeddings
     */
    public async processFiles(
        files: FileToProcess[],
        token?: vscode.CancellationToken
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

        // Create a promise for each file
        const filePromises = files.map(file => {
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

                // Start processing if not already started
                if (!this.isProcessing) {
                    this.isProcessing = true;
                    this.processNextItem();
                }
            });
        });

        // Set up cancellation handling
        const cancellationPromise = new Promise<never>((_, reject) => {
            if (effectiveToken.isCancellationRequested) {
                reject(new Error('Operation cancelled'));
                return;
            }

            const cancelListener = effectiveToken.onCancellationRequested(() => {
                reject(new Error('Operation cancelled'));
            });

            // Ensure we dispose the listener
            Promise.allSettled(filePromises).finally(() => cancelListener.dispose());
        });

        try {
            // Wait for all files to be processed or cancellation
            const results = await Promise.race([
                Promise.all(filePromises),
                cancellationPromise
            ]) as ProcessingResult[];

            // Map results by file ID
            const resultMap = new Map<string, ProcessingResult>();
            for (const result of results) {
                resultMap.set(result.fileId, result);
            }

            return resultMap;
        } catch (error) {
            console.error('Error processing files:', error);

            // Clean up queue on error
            this.workQueue = this.workQueue.filter(item =>
                !files.some(file => file.id === item.id)
            );

            // Re-throw error
            throw error;
        } finally {
            this.isProcessing = this.workQueue.length > 0;
            this.updateStatusBar();

            // Dispose our cancellation token source if we created it
            if (this.cancelTokenSource) {
                this.cancelTokenSource.dispose();
                this.cancelTokenSource = undefined;
            }

            // If there are no more items to process, shut down workers after a delay
            if (this.workQueue.length === 0 && this.workers.length > 0) {
                setTimeout(() => {
                    // Double check that queue is still empty
                    if (this.workQueue.length === 0 && !this.isProcessing) {
                        // Don't shut down workers automatically - keep them ready
                        // Just update the status bar
                        this.updateStatusBar();
                    }
                }, 2000); // 2 seconds delay
            }
        }
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