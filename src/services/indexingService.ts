import * as vscode from 'vscode';
import * as os from 'os';
import { StatusBarService } from './statusBarService';
import { WorkspaceSettingsService } from './workspaceSettingsService';
import {
    type EmbeddingOptions,
    type DetailedChunkingResult,
} from '../types/embeddingTypes';
import {
    type FileToProcess,
    type ProcessingResult,
    type ChunkForEmbedding,
    type EmbeddingGenerationOutput,
} from '../types/indexingTypes';
import { CodeChunkingService, type CodeChunkingServiceOptions } from './codeChunkingService';
import { EmbeddingGenerationService, type EmbeddingGenerationServiceOptions } from './embeddingGenerationService';
import { Log } from './loggingService';

/**
 * Options for the indexing service
 */
export interface IndexingServiceOptions {
    modelName: string;
    modelBasePath: string;
    contextLength: number;
    embeddingOptions: EmbeddingOptions;
    extensionPath: string;
    maxConcurrentEmbeddingTasks?: number;
}

/**
 * Custom error types for better error handling
 */
export class ChunkingError extends Error {
    constructor(message: string, public readonly filePath: string, cause?: Error) {
        super(message);
        this.name = 'ChunkingError';
        this.cause = cause;
    }
}

export class EmbeddingError extends Error {
    constructor(message: string, public readonly filePath: string, cause?: Error) {
        super(message);
        this.name = 'EmbeddingError';
        this.cause = cause;
    }
}

/**
 * IndexingService focused on single-file processing.
 * Batch orchestration is handled by higher-level services (IndexingManager).
 */
export class IndexingService implements vscode.Disposable {
    private readonly statusBarService: StatusBarService;
    private readonly codeChunkingService: CodeChunkingService;
    private readonly embeddingGenerationService: EmbeddingGenerationService;
    private readonly options: Required<IndexingServiceOptions>;
    private isInitialized: boolean = false;

    // Default options
    private readonly defaultOptions: Pick<Required<IndexingServiceOptions>, 'maxConcurrentEmbeddingTasks'> = {
        maxConcurrentEmbeddingTasks: Math.max(2, Math.ceil(os.cpus().length / 2)),
    };

    /**
     * Create a new IndexingService
     */
    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly workspaceSettingsService: WorkspaceSettingsService,
        options: IndexingServiceOptions
    ) {
        this.validateOptions(options);

        this.options = {
            ...options,
            embeddingOptions: options.embeddingOptions || { pooling: 'mean', normalize: true },
            maxConcurrentEmbeddingTasks: options.maxConcurrentEmbeddingTasks ?? this.defaultOptions.maxConcurrentEmbeddingTasks,
        } as Required<IndexingServiceOptions>;

        this.statusBarService = StatusBarService.getInstance();
        this.codeChunkingService = this.createCodeChunkingService();
        this.embeddingGenerationService = this.createEmbeddingGenerationService();
    }

    /**
     * Validate required options
     */
    private validateOptions(options: IndexingServiceOptions): void {
        if (!options.modelName) {
            throw new Error('Model name must be provided to IndexingService');
        }
        if (!options.contextLength) {
            throw new Error('Context length must be provided to IndexingService');
        }
        if (!options.extensionPath) {
            throw new Error('Extension path must be provided to IndexingService');
        }
    }

    /**
     * Create CodeChunkingService instance
     */
    private createCodeChunkingService(): CodeChunkingService {
        const options: CodeChunkingServiceOptions = {
            modelName: this.options.modelName,
            contextLength: this.options.contextLength,
            extensionPath: this.options.extensionPath,
        };
        return new CodeChunkingService(options);
    }

    /**
     * Create EmbeddingGenerationService instance
     */
    private createEmbeddingGenerationService(): EmbeddingGenerationService {
        const options: EmbeddingGenerationServiceOptions = {
            modelName: this.options.modelName,
            modelBasePath: this.options.modelBasePath,
            embeddingOptions: this.options.embeddingOptions,
            extensionPath: this.options.extensionPath,
            maxConcurrentTasks: this.options.maxConcurrentEmbeddingTasks,
        };
        return new EmbeddingGenerationService(options);
    }

    /**
     * Initialize the IndexingService and its underlying services
     */
    public async initialize(): Promise<void> {
        try {
            await this.codeChunkingService.initialize();
            await this.embeddingGenerationService.initialize();
            this.isInitialized = true;
            Log.info("IndexingService and its components initialized successfully.");
        } catch (error) {
            Log.error("Failed to initialize IndexingService or its components:", error);
            throw new Error(`IndexingService initialization failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Process a single file and return the result
     * @param file The file to process
     * @param token Optional cancellation token
     * @returns Promise resolving to ProcessingResult
     */
    public async processFile(
        file: FileToProcess,
        token?: vscode.CancellationToken
    ): Promise<ProcessingResult> {
        this.validateInitialization();

        Log.info(`[IndexingService] Processing file: ${file.path}`);

        try {
            // Step 1: Chunk the file
            const chunkingResult = await this.chunkFile(file, token);

            // Step 2: Handle empty chunks (success case)
            if (chunkingResult.chunks.length === 0) {
                Log.info(`[IndexingService] File ${file.path} yielded no chunks.`);
                return this.createSuccessResult(file, [], chunkingResult);
            }

            // Step 3: Generate embeddings
            const embeddings = await this.generateEmbeddings(file, chunkingResult, token);

            // Step 4: Create final result
            const result = this.createSuccessResult(file, embeddings, chunkingResult);
            Log.info(`[IndexingService] Successfully processed file ${file.path}`);

            return result;

        } catch (error) {
            return this.handleProcessingError(file, error);
        }
    }

    /**
     * Get the current embedding model name
     */
    public getModelName(): string {
        return this.options.modelName;
    }

    /**
     * Update last indexing timestamp (called by higher-level orchestrator)
     */
    public updateLastIndexingTimestamp(): void {
        this.workspaceSettingsService.updateLastIndexingTimestamp();
    }

    /**
     * Chunk a single file
     */
    private async chunkFile(
        file: FileToProcess,
        token?: vscode.CancellationToken
    ): Promise<DetailedChunkingResult> {
        // Create an AbortController for cancellation handling
        const abortController = new AbortController();

        // Set up cancellation listener if token is provided
        const tokenRegistration = token?.onCancellationRequested(() => {
            abortController.abort();
        });

        try {
            const result = await this.codeChunkingService.chunkFile(
                file,
                this.options.embeddingOptions,
                abortController.signal
            );

            if (!result) {
                throw new ChunkingError('Chunking returned null result', file.path);
            }

            return result;
        } catch (error) {
            if (token?.isCancellationRequested || abortController.signal.aborted) {
                throw new ChunkingError('Operation cancelled during chunking', file.path, error as Error);
            }
            throw new ChunkingError(
                `Chunking failed: ${error instanceof Error ? error.message : String(error)}`,
                file.path,
                error as Error
            );
        } finally {
            tokenRegistration?.dispose();
        }
    }

    /**
     * Generate embeddings for chunked file
     */
    private async generateEmbeddings(
        file: FileToProcess,
        chunkingResult: DetailedChunkingResult,
        token?: vscode.CancellationToken
    ): Promise<number[][]> {
        const chunksForEmbedding: ChunkForEmbedding[] = chunkingResult.chunks.map((chunkText, index) => ({
            fileId: file.id,
            filePath: file.path,
            chunkIndexInFile: index,
            text: chunkText,
            offsetInFile: chunkingResult.offsets[index],
        }));

        // Create an AbortController for cancellation handling
        const abortController = new AbortController();

        // Set up cancellation listener if token is provided
        const tokenRegistration = token?.onCancellationRequested(() => {
            abortController.abort();
        });

        try {
            Log.info(`[IndexingService] Generating embeddings for ${chunksForEmbedding.length} chunks from file: ${file.path}`);

            const embeddingOutputs = await this.embeddingGenerationService.generateEmbeddingsForChunks(
                chunksForEmbedding,
                abortController.signal
            );

            return this.processEmbeddingOutputs(file, embeddingOutputs);
        } catch (error) {
            if (token?.isCancellationRequested || abortController.signal.aborted) {
                throw new EmbeddingError('Operation cancelled during embedding generation', file.path, error as Error);
            }
            throw new EmbeddingError(
                `Embedding generation failed: ${error instanceof Error ? error.message : String(error)}`,
                file.path,
                error as Error
            );
        } finally {
            tokenRegistration?.dispose();
        }
    }

    /**
     * Process embedding outputs and extract valid embeddings
     */
    private processEmbeddingOutputs(
        file: FileToProcess,
        embeddingOutputs: EmbeddingGenerationOutput[]
    ): number[][] {
        const embeddings: number[][] = [];
        const errors: string[] = [];

        embeddingOutputs.forEach(output => {
            if (output.embedding) {
                embeddings.push(output.embedding);
            } else if (output.error) {
                Log.warn(`[IndexingService] Error embedding chunk ${output.originalChunkInfo.chunkIndexInFile} for file ${file.path}: ${output.error}`);
                errors.push(`Chunk ${output.originalChunkInfo.chunkIndexInFile}: ${output.error}`);
            }
        });

        if (errors.length > 0 && embeddings.length === 0) {
            throw new EmbeddingError(`All chunks failed embedding: ${errors.join('; ')}`, file.path);
        }

        if (errors.length > 0) {
            Log.warn(`[IndexingService] Partial embedding failure for ${file.path}: ${errors.join('; ')}`);
        }

        return embeddings;
    }

    /**
     * Create a successful processing result
     */
    private createSuccessResult(
        file: FileToProcess,
        embeddings: number[][],
        chunkingResult: DetailedChunkingResult
    ): ProcessingResult {
        return {
            fileId: file.id,
            filePath: file.path,
            success: true,
            embeddings,
            chunkOffsets: chunkingResult.offsets,
            metadata: chunkingResult.metadata,
            error: undefined,
        };
    }

    /**
     * Handle processing errors and create appropriate error results
     */
    private handleProcessingError(file: FileToProcess, error: unknown): ProcessingResult {
        let errorMessage: string;

        if (error instanceof ChunkingError || error instanceof EmbeddingError) {
            errorMessage = error.message;
            Log.error(`[IndexingService] ${error.name} for ${file.path}:`, error);
        } else {
            errorMessage = `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
            Log.error(`[IndexingService] Unexpected error processing ${file.path}:`, error);
        }

        return {
            fileId: file.id,
            filePath: file.path,
            success: false,
            error: errorMessage,
            embeddings: [],
            chunkOffsets: [],
            metadata: { parentStructureIds: [], structureOrders: [], isOversizedFlags: [], structureTypes: [] },
        };
    }

    /**
     * Validate that the service is properly initialized
     */
    private validateInitialization(): void {
        if (!this.isInitialized) {
            throw new Error('IndexingService or its dependent services are not properly initialized.');
        }
    }


    /**
     * Shows indexing management options to the user
     */
    public async showIndexingManagementOptions(): Promise<void> {
        const items: vscode.QuickPickItem[] = [];
        items.push({ label: "$(info) Show processor status", description: "Displays current service details and memory usage." });

        const selectedItem = await vscode.window.showQuickPick(items, {
            placeHolder: "Select indexing management action"
        });

        if (selectedItem?.label.includes("Show processor status")) {
            this.showProcessorStatus();
        }
    }


    /**
     * Display detailed status information
     */
    private showProcessorStatus(): void {
        const memoryUsage = process.memoryUsage();
        const memoryInfo = `Memory: ${Math.round(memoryUsage.rss / (1024 * 1024))}MB RSS, ${Math.round(memoryUsage.heapUsed / (1024 * 1024))}MB Heap`;
        const osMemInfo = `System: ${Math.round(os.totalmem() / (1024 * 1024 * 1024))}GB total, ${Math.round(os.freemem() / (1024 * 1024 * 1024))}GB free`;
        const modelInfo = `Model: ${this.options.modelName}`;
        const contextInfo = `Context Length: ${this.options.contextLength}`;
        const embeddingServiceConfig = `Max Concurrent Embedding Tasks: ${this.options.maxConcurrentEmbeddingTasks}`;
        const codeChunkingServiceStatus = this.codeChunkingService ? 'CodeChunkingService: Initialized' : 'CodeChunkingService: Not Initialized';
        const embeddingGenerationServiceStatus = this.embeddingGenerationService ? `EmbeddingGenerationService: Initialized (Max Tasks: ${this.options.maxConcurrentEmbeddingTasks})` : 'EmbeddingGenerationService: Not Initialized';

        const lastIndexed = this.workspaceSettingsService.getLastIndexingTimestamp();
        const lastIndexedInfo = lastIndexed ? `Last Successful Indexing: ${new Date(lastIndexed).toLocaleString()}` : 'Last Successful Indexing: Never';

        const statusDetails = [
            lastIndexedInfo,
            modelInfo,
            contextInfo,
            embeddingServiceConfig,
            codeChunkingServiceStatus,
            embeddingGenerationServiceStatus,
            memoryInfo,
            osMemInfo
        ].join('\n');

        vscode.window.showInformationMessage(statusDetails, { modal: true });
    }

    /**
     * Dispose of resources
     */
    public async dispose(): Promise<void> {
        Log.info('[IndexingService] Disposing...');

        if (this.codeChunkingService) {
            this.codeChunkingService.dispose();
            Log.info('[IndexingService] CodeChunkingService disposed.');
        }
        if (this.embeddingGenerationService) {
            await this.embeddingGenerationService.dispose();
            Log.info('[IndexingService] EmbeddingGenerationService disposed.');
        }

        Log.info('[IndexingService] IndexingService disposed successfully.');
    }
}
