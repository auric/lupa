import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { MessageChannel } from 'worker_threads';
import Piscina from 'piscina';
import { StatusBarService, StatusBarMessageType, StatusBarState } from './statusBarService';
import { WorkspaceSettingsService } from './workspaceSettingsService';
import { type ProcessFileTask, type ProcessingResult } from '../workers/indexingWorker';

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
 * Options for embedding generation
 */
export interface EmbeddingOptions {
    pooling?: 'mean' | 'cls' | 'none';
    normalize?: boolean;
    overlapSize?: number;
}

/**
 * Options for the indexing service
 */
export interface IndexingServiceOptions {
    maxWorkers?: number;                 // Maximum number of workers
    embeddingOptions?: EmbeddingOptions; // Options for embedding generation
    modelName: string;                   // Name of the embedding model to use
    contextLength: number;               // Context length of the model (required)
}

/**
 * Tracks an active processing operation
 */
interface ProcessingOperation {
    files: FileToProcess[];
    results: Array<Promise<ProcessingResult>>;
    messageChannels: MessageChannel[];
}

/**
 * IndexingService manages multi-threaded embedding generation using Piscina
 */
export class IndexingService implements vscode.Disposable {
    private piscina: Piscina | null = null;
    private readonly statusBarService: StatusBarService;

    // Track current processing operation
    private currentOperation: ProcessingOperation | null = null;

    private readonly defaultOptions: Required<Omit<IndexingServiceOptions, 'modelName' | 'contextLength'>> = {
        maxWorkers: Math.max(1, Math.floor(os.availableParallelism ? os.availableParallelism() : (os.cpus().length + 1) / 2)),
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
            ...options,
            modelName: options.modelName,
            contextLength: options.contextLength
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
        }
        return this.piscina;
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

        if (token) {
            token.onCancellationRequested(async () => {
                await this.cancelProcessing();
            });
        }

        const messageChannels = files.map(() => new MessageChannel());

        // Create a new operation
        this.currentOperation = { files, results: [], messageChannels };

        // Get Piscina instance
        const piscina = this.getPiscina();

        // Update status to indexing
        this.statusBarService.setState(StatusBarState.Indexing, `${files.length} files`);

        // Sort files by priority (if available) to process important files first
        const sortedFiles = [...files].sort((a, b) => (b.priority || 0) - (a.priority || 0));

        try {
            // Create a task for each file
            const tasks = sortedFiles.map((file, index) => {
                const task: ProcessFileTask = {
                    index,
                    fileId: file.id,
                    filePath: file.path,
                    content: file.content,
                    modelName: this.options.modelName,
                    contextLength: this.options.contextLength, // Pass context length to the worker
                    options: {
                        ...this.options.embeddingOptions
                    },
                    messagePort: this.currentOperation!.messageChannels[index].port2
                };
                return task;
            });

            // Process all files in parallel with progress tracking
            const resultMap = new Map<string, ProcessingResult>();
            let completed = 0;

            // Process in batches to provide progressive updates
            const BATCH_SIZE = 10;

            for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
                // Check if cancelled via VS Code token
                if (token?.isCancellationRequested) {
                    throw new Error('Operation cancelled');
                }

                const batch = tasks.slice(i, i + BATCH_SIZE);
                const promises: Array<Promise<ProcessingResult>> = batch.map(task =>
                    // Don't pass AbortSignal to Piscina tasks, since it may lead to crashes
                    piscina.run(task, { transferList: [this.currentOperation!.messageChannels[task.index].port2] })
                );

                this.currentOperation.results.push(...promises);
                // Wait for batch to complete
                const results = await Promise.all(promises);

                // Add results to map
                for (const result of results) {
                    if (result.success) {
                        resultMap.set(result.fileId, result);
                    }
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

            // Update last indexing timestamp after successful completion
            this.workspaceSettingsService.updateLastIndexingTimestamp();

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
            // Clean up the current operation if it's still the active one
            this.currentOperation = null;
        }
    }

    /**
     * Cancel any in-progress indexing operations
     */
    public async cancelProcessing(): Promise<void> {
        if (this.currentOperation) {
            // Abort the operation - add try/catch to handle errors
            this.currentOperation.messageChannels.forEach(channel => {
                try {
                    channel.port1.postMessage('abort');
                } catch (error) {
                    // Ignore errors from posting to closed ports
                    console.log('Error posting abort message:', error);
                }
            });

            try {
                await Promise.all(this.currentOperation.results);
            } catch (error) {
                // Ignore errors from promises that may be rejected due to cancellation
                console.log('Error waiting for operation results:', error);
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
    private async showIndexingManagementOptions(): Promise<void> {
        const options = [
            "Cancel current indexing",
            "Restart workers",
            "Show worker status",
            "Shutdown workers"
        ];

        const selected = await vscode.window.showQuickPick(options, {
            placeHolder: "Select indexing management action"
        });

        if (!selected) return;

        switch (selected) {
            case "Cancel current indexing":
                await this.cancelProcessing();
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
        }
    }

    /**
     * Restart all workers
     */
    private async restartWorkers(): Promise<void> {
        try {
            // Cancel any ongoing operations
            await this.cancelProcessing();

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

            // Set status back to ready
            this.statusBarService.setState(StatusBarState.Ready);
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
                await this.cancelProcessing();

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
            model: this.options.modelName,
            contextLength: this.options.contextLength,
            activeOperation: this.currentOperation ? true : false
        };

        const memoryUsage = process.memoryUsage();
        const memoryInfo = `Memory: ${Math.round(memoryUsage.rss / 1024 / 1024)}MB RSS, ${Math.round(memoryUsage.heapUsed / 1024 / 1024)}MB Heap`;
        const osMemInfo = `System: ${Math.round(os.totalmem() / 1024 / 1024 / 1024)}GB total, ${Math.round(os.freemem() / 1024 / 1024 / 1024)}GB free`;

        const statusDetails = [
            `Active threads: ${stats.threadsCount}`,
            `Queue size: ${stats.queueSize}`,
            `Tasks completed: ${stats.completed}`,
            `Active operation: ${stats.activeOperation ? 'Yes' : 'No'}`,
            `Utilization: ${Math.round(stats.utilization * 100)}%`,
            `Model: ${stats.model}`,
            `Context length: ${stats.contextLength}`,
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