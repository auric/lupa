import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { StatusBarService, StatusBarMessageType, StatusBarState } from './statusBarService';
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
    type YieldedProcessingOutput
} from '../types/indexingTypes';
import { getLanguageForExtension } from '../types/types'; // type SupportedLanguage is not directly used
import { CodeChunkingService, type CodeChunkingServiceOptions } from './codeChunkingService'; // Added import
import { EmbeddingGenerationService, type EmbeddingGenerationServiceOptions } from './embeddingGenerationService'; // Added import

/**
 * Options for the indexing service
 */
export interface IndexingServiceOptions {
    modelName: string;                   // Name of the embedding model to use
    modelBasePath: string;               // For EmbeddingGenerationService
    contextLength: number;               // For CodeChunkingService
    embeddingOptions: EmbeddingOptions; // For EmbeddingGenerationService (no longer optional at this level, ensure it's provided)
    extensionPath: string;               // For both new services
    maxConcurrentEmbeddingTasks?: number; // For EmbeddingGenerationService
    // Callbacks are passed to processFiles, not stored in options typically
    // progressCallback?: ProgressCallback; // This type is not defined here, assuming it's part of a larger system
    // batchCompletedCallback?: BatchCompletedCallback; // This type is not defined here
    // statusAggregator?: StatusAggregator; // This type is not defined here
}




/**
 * Tracks an active processing operation.
 * This structure is based on section 5 of indexing_refactor_plan.md.
 */
interface ProcessingOperation {
    initialFiles: FileToProcess[];
    abortController: AbortController;
    results: Map<string, ProcessingResult>;

    // Chunking Phase
    filesChunkingAttemptedCount: number;
    filesSuccessfullyChunkedCount: number; // Files that yielded chunks and were sent for embedding
    totalChunksGeneratedCount: number;

    // Embedding Phase
    embeddingsProcessedCount: number; // Total individual chunk embeddings processed (success or failure from EmbeddingGenerationService)
    filesEmbeddingsCompletedCount: number; // Files for which embedding generation has completed (successfully or with errors)
}

/**
 * IndexingService orchestrates code chunking and embedding generation.
 */
export class IndexingService implements vscode.Disposable {
    private readonly statusBarService: StatusBarService;
    private readonly codeChunkingService: CodeChunkingService;
    private readonly embeddingGenerationService: EmbeddingGenerationService;

    // Track current processing operation
    private currentOperation: ProcessingOperation | null = null;

    // Default options are simpler now as many are passed down or required
    private readonly defaultOptions: Pick<Required<IndexingServiceOptions>, 'maxConcurrentEmbeddingTasks'> = {
        maxConcurrentEmbeddingTasks: Math.max(2, Math.ceil(os.cpus().length / 2)),
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
        if (!options.modelName) {
            throw new Error('Model name must be provided to IndexingService');
        }
        if (!options.contextLength) {
            throw new Error('Context length must be provided to IndexingService');
        }
        if (!options.extensionPath) {
            throw new Error('Extension path must be provided to IndexingService');
        }

        // Ensure embeddingOptions is always defined, even if user passes undefined for the optional top-level one.
        // However, the interface now makes it required.
        const finalEmbeddingOptions = options.embeddingOptions || { pooling: 'mean', normalize: true };

        this.options = {
            ...options, // User-provided options take precedence
            embeddingOptions: finalEmbeddingOptions, // Ensure it's set
            maxConcurrentEmbeddingTasks: options.maxConcurrentEmbeddingTasks ?? this.defaultOptions.maxConcurrentEmbeddingTasks,
        } as Required<IndexingServiceOptions>;


        this.statusBarService = StatusBarService.getInstance();

        // Instantiate new services
        const codeChunkingOptions: CodeChunkingServiceOptions = {
            modelName: this.options.modelName,
            contextLength: this.options.contextLength,
            extensionPath: this.options.extensionPath,
        };
        this.codeChunkingService = new CodeChunkingService(codeChunkingOptions);

        const embeddingGenerationOptions: EmbeddingGenerationServiceOptions = {
            modelName: this.options.modelName,
            modelBasePath: this.options.modelBasePath,
            embeddingOptions: this.options.embeddingOptions,
            extensionPath: this.options.extensionPath,
            maxConcurrentTasks: this.options.maxConcurrentEmbeddingTasks,
        };
        this.embeddingGenerationService = new EmbeddingGenerationService(embeddingGenerationOptions);

        // Initialization of new services will be handled by an explicit initialize() method
        // Note: The original constructor called initialize methods which is not ideal for async.
        // The new `initialize` public method should be called by the consumer of IndexingService.
    }

    /**
     * Initializes the IndexingService and its underlying services (`CodeChunkingService` and `EmbeddingGenerationService`).
     * This method MUST be called and complete successfully before `processFiles` can be used.
     * It sets the service to a ready state or an error state if initialization fails.
     */
    public async initialize(): Promise<void> {
        this.statusBarService.setState(StatusBarState.Indexing, 'Initializing indexing services...');
        try {
            await this.codeChunkingService.initialize();
            await this.embeddingGenerationService.initialize();
            this.statusBarService.setState(StatusBarState.Ready, 'Indexing services initialized');
            console.log("IndexingService and its components initialized successfully.");
        } catch (error) {
            console.error("Failed to initialize IndexingService or its components:", error);
            this.statusBarService.setState(StatusBarState.Error, 'Initialization failed');
            // Rethrow to allow the caller (e.g., IndexingManager) to handle this critical failure.
            throw new Error(`IndexingService initialization failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    // Old initialization methods (initializeMainThreadChunker, initializePiscinaPool) are removed
    // as their responsibilities are now within CodeChunkingService and EmbeddingGenerationService.

    /**
     * Get the current embedding model name.
     * @returns The model name currently being used for embeddings.
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
     * @returns An async generator yielding `YieldedProcessingOutput` objects.
     */
    public async *processFilesGenerator(
        files: FileToProcess[],
        token?: vscode.CancellationToken
    ): AsyncGenerator<YieldedProcessingOutput, Map<string, ProcessingResult>, undefined> {
        if (files.length === 0) {
            console.log('[IndexingService] No files provided for processing.');
            return new Map();
        }

        if (!this.codeChunkingService || !this.embeddingGenerationService) {
            const errorMsg = 'IndexingService or its dependent services are not properly initialized.';
            console.error(`[IndexingService] ${errorMsg}`);
            this.statusBarService.setState(StatusBarState.Error, 'Service initialization error before processing.');
            throw new Error(errorMsg);
        }

        if (this.currentOperation) {
            console.log('[IndexingService] New processing request received, cancelling previous operation.');
            await this.cancelProcessing();
        }

        const abortController = new AbortController();
        const tokenRegistration = token?.onCancellationRequested(() => {
            if (!abortController.signal.aborted) {
                console.log('[IndexingService] VS Code CancellationToken triggered: Aborting current operation.');
                abortController.abort();
            }
        });

        this.currentOperation = {
            initialFiles: [...files].sort((a, b) => (b.priority || 0) - (a.priority || 0)),
            abortController,
            results: new Map(),
            filesChunkingAttemptedCount: 0,
            filesSuccessfullyChunkedCount: 0,
            totalChunksGeneratedCount: 0,
            embeddingsProcessedCount: 0,
            filesEmbeddingsCompletedCount: 0,
        };
        const op = this.currentOperation;

        this.statusBarService.setState(StatusBarState.Indexing, `Preparing ${op.initialFiles.length} files...`);
        console.log(`[IndexingService] Starting processing for ${op.initialFiles.length} files.`);

        let livenessTimer: NodeJS.Timeout | null = setInterval(() => {
            console.log(`[LIVENESS] IndexingService main thread is alive during processing at ${new Date().toISOString()}`);
        }, 30000);

        try {
            for (const file of op.initialFiles) {
                if (op.abortController.signal.aborted) {
                    console.log(`[IndexingService] Operation aborted before processing file ${file.path}.`);
                    if (!op.results.has(file.id)) {
                        const cancelledResult: ProcessingResult = {
                            fileId: file.id,
                            filePath: file.path,
                            success: false,
                            error: 'Operation cancelled before processing could start for this file.',
                            embeddings: [],
                            chunkOffsets: [],
                            metadata: { parentStructureIds: [], structureOrders: [], isOversizedFlags: [], structureTypes: [] },
                        };
                        op.results.set(file.id, cancelledResult);
                        yield { filePath: file.path, result: cancelledResult };
                    }
                    continue;
                }

                this.updateOverallStatus(); // Update status before processing each file

                // Await the full processing (chunking and embedding) for the single file.
                // The helper method _processSingleFileSequentially will handle chunking, embedding, and result construction.
                const processingResult = await this._processSingleFileSequentially(file, op, this.options.embeddingOptions);

                // The helper _processSingleFileSequentially is expected to always return a ProcessingResult,
                // even in cases of error or cancellation during its execution for that file.
                op.results.set(file.id, processingResult);
                yield { filePath: file.path, result: processingResult };
                console.log(`[IndexingService] Yielded results for file ${file.path}. Success: ${processingResult.success}`);

                this.updateOverallStatus(); // Update status after processing each file
            }
            console.log('[IndexingService] All files have been processed sequentially.');

            // Final status update
            if (!op.abortController.signal.aborted) {
                const allFilesAttemptedAndResulted = op.initialFiles.every(f => op.results.has(f.id));
                const filesThatShouldHaveEmbeddings = op.filesSuccessfullyChunkedCount; // Files that produced chunks

                // Check if all files that were supposed to be embedded were indeed processed for embedding
                const allEmbeddingAttemptsCompleted = op.filesEmbeddingsCompletedCount === filesThatShouldHaveEmbeddings;

                // Determine if all files that were supposed to be embedded were actually successfully embedded.
                let allEmbeddingsSuccessful = true;
                if (filesThatShouldHaveEmbeddings > 0) {
                    let successfullyEmbeddedFileCount = 0;
                    // Iterate over all results to find those that were successfully chunked and embedded.
                    op.results.forEach(result => {
                        const wasChunked = result.chunkOffsets && result.chunkOffsets.length > 0;
                        const hasEmbeddings = result.embeddings && result.embeddings.length > 0;
                        // A file is considered fully successful in this context if it was chunked,
                        // has embeddings, and its overall processing result was success.
                        if (result.success && wasChunked && hasEmbeddings) {
                            successfullyEmbeddedFileCount++;
                        }
                    });
                    allEmbeddingsSuccessful = (successfullyEmbeddedFileCount === filesThatShouldHaveEmbeddings);
                } else {
                    // If no files were expected to produce embeddings (e.g., all empty, or all failed chunking),
                    // then this condition is vacuously true.
                    allEmbeddingsSuccessful = true;
                }


                if (allFilesAttemptedAndResulted && filesThatShouldHaveEmbeddings === 0 && op.filesChunkingAttemptedCount === op.initialFiles.length) {
                    this.statusBarService.setState(StatusBarState.Ready, 'No content to embed from files, or all failed before embedding.');
                    console.log('[IndexingService] All files processed; no content found/generated for embedding or all failed chunking.');
                } else if (allFilesAttemptedAndResulted && allEmbeddingAttemptsCompleted && allEmbeddingsSuccessful) {
                    this.workspaceSettingsService.updateLastIndexingTimestamp();
                    this.statusBarService.setState(StatusBarState.Ready, 'Indexing complete');
                    console.log('[IndexingService] Indexing completed successfully for all dispatched files.');
                } else if (allFilesAttemptedAndResulted) {
                    this.statusBarService.setState(StatusBarState.Error, 'Indexing finished with some issues.');
                    console.warn('[IndexingService] Indexing finished with some issues or was incomplete.');
                } else {
                    this.statusBarService.setState(StatusBarState.Ready, 'Indexing finished.'); // Default if other conditions not met
                    console.log('[IndexingService] Indexing process finished.');
                }
            }
        } catch (error) { // Catch errors from the main try block (e.g., if _processSingleFileSequentially rethrows a critical one)
            if (error instanceof Error && error.name === 'AbortError') {
                console.log('[IndexingService] Operation was aborted during processing (generator).', error.message);
            } else {
                console.error('[IndexingService] Critical error during file processing (generator):', error);
                this.statusBarService.setState(StatusBarState.Error, error instanceof Error ? error.message : 'Unknown critical error during indexing');
            }
            // Yield error for any initial files that don't have a result yet
            if (op) {
                for (const file of op.initialFiles) {
                    if (!op.results.has(file.id)) {
                        const errorMsg = error instanceof Error ? error.message : String(error);
                        const criticalErrorResult: ProcessingResult = {
                            fileId: file.id,
                            filePath: file.path,
                            success: false,
                            error: `Critical processing error: ${errorMsg}`,
                            embeddings: [], chunkOffsets: [], metadata: { parentStructureIds: [], structureOrders: [], isOversizedFlags: [], structureTypes: [] }
                        };
                        op.results.set(file.id, criticalErrorResult);
                        try { yield { filePath: file.path, result: criticalErrorResult }; } catch (yieldError) { /* ignore if generator closed */ }
                    }
                }
            }
            if (!(error instanceof Error && error.name === 'AbortError')) {
                throw error; // Rethrow to terminate the generator with an error
            }
        } finally {
            console.log('[IndexingService] Entering finally block of processFilesGenerator.');
            if (livenessTimer) {
                clearInterval(livenessTimer);
                console.log('[LIVENESS] IndexingService liveness timer cleared in finally.');
            }
            tokenRegistration?.dispose();

            const finalResults = new Map(this.currentOperation?.results);

            if (this.currentOperation?.abortController.signal.aborted) {
                this.statusBarService.showTemporaryMessage('Indexing cancelled', 3000, StatusBarMessageType.Warning);
                // Ensure all initial files have a result, even if it's a cancellation error
                this.currentOperation.initialFiles.forEach(file => {
                    if (!finalResults.has(file.id)) {
                        const cancelledResult: ProcessingResult = {
                            fileId: file.id,
                            filePath: file.path,
                            success: false,
                            error: 'Operation cancelled before completion.',
                            embeddings: [],
                            chunkOffsets: [],
                            metadata: { parentStructureIds: [], structureOrders: [], isOversizedFlags: [], structureTypes: [] },
                        };
                        finalResults.set(file.id, cancelledResult);
                        // Cannot yield from finally if generator already closed/errored.
                        // The main loop should have handled yielding for cancellations.
                    }
                });
            }

            this.currentOperation = null;
            this.updateOverallStatus();
            console.log('[IndexingService] Exiting processFilesGenerator.');
            return finalResults; // Return all accumulated results (successes and failures)
        }
    }

    /**
     * Processes a single file sequentially: chunks it, generates embeddings, and constructs the result.
     * This method is called by `processFilesGenerator` for each file.
     * @param file The file to process.
     * @param op The current processing operation.
     * @param embeddingOptions Options for embedding.
     * @returns A ProcessingResult for the file.
     */
    private async _processSingleFileSequentially(
        file: FileToProcess,
        op: ProcessingOperation,
        embeddingOptions: EmbeddingOptions
    ): Promise<ProcessingResult> {
        op.filesChunkingAttemptedCount++;
        let detailedChunkingResult: DetailedChunkingResult | null = null;

        try {
            detailedChunkingResult = await this.codeChunkingService.chunkFile(
                file,
                embeddingOptions,
                op.abortController.signal
            );
        } catch (chunkError) {
            const errorMsg = chunkError instanceof Error ? chunkError.message : String(chunkError);
            console.error(`[IndexingService] Critical error during codeChunkingService.chunkFile for ${file.path}:`, chunkError);
            // If chunkFile itself throws, detailedChunkingResult might be null or incomplete.
            // The error will be caught by the outer try-catch if not handled here.
            // For now, construct an error result.
            return {
                fileId: file.id,
                filePath: file.path,
                success: false,
                error: `Chunking failed: ${errorMsg}`,
                embeddings: [],
                chunkOffsets: [],
                metadata: { parentStructureIds: [], structureOrders: [], isOversizedFlags: [], structureTypes: [] },
            };
        }

        if (op.abortController.signal.aborted) {
            console.log(`[IndexingService] Operation aborted after attempting to chunk file ${file.path}.`);
            return {
                fileId: file.id,
                filePath: file.path,
                success: false,
                error: 'Operation cancelled during chunking.',
                embeddings: [],
                chunkOffsets: detailedChunkingResult?.offsets || [], // Use if available
                metadata: detailedChunkingResult?.metadata || { parentStructureIds: [], structureOrders: [], isOversizedFlags: [], structureTypes: [] },
            };
        }

        if (!detailedChunkingResult || detailedChunkingResult.chunks.length === 0) {
            const reason = detailedChunkingResult === null
                ? "chunking critically failed or was cancelled by signal"
                : "file yielded no chunks";
            console.log(`[IndexingService] File ${file.path} ${reason}.`);
            return {
                fileId: file.id,
                filePath: file.path,
                success: true, // Technically not a failure if file is empty or unchunkable by design
                error: detailedChunkingResult === null ? `File processing error: ${reason}.` : undefined, // Error only if chunking failed
                embeddings: [],
                chunkOffsets: detailedChunkingResult?.offsets || [],
                metadata: detailedChunkingResult?.metadata || { parentStructureIds: [], structureOrders: [], isOversizedFlags: [], structureTypes: [] },
            };
        }

        // If chunking was successful and produced chunks
        op.filesSuccessfullyChunkedCount++;
        op.totalChunksGeneratedCount += detailedChunkingResult.chunks.length;

        const chunksForEmbedding: ChunkForEmbedding[] = detailedChunkingResult.chunks.map((chunkText, index) => ({
            fileId: file.id,
            filePath: file.path,
            chunkIndexInFile: index,
            text: chunkText,
            offsetInFile: detailedChunkingResult.offsets[index],
        }));

        console.log(`[IndexingService] Generating embeddings for ${chunksForEmbedding.length} chunks from file: ${file.path}`);
        let embeddingOutputs: EmbeddingGenerationOutput[] = [];
        try {
            embeddingOutputs = await this.embeddingGenerationService.generateEmbeddingsForChunks(
                chunksForEmbedding,
                op.abortController.signal
            );
            op.filesEmbeddingsCompletedCount++; // Mark this file's embeddings as processed (attempted)

            const finalEmbeddings: number[][] = [];
            const fileSpecificErrors: string[] = [];

            embeddingOutputs.forEach(output => {
                op.embeddingsProcessedCount++; // Count each chunk's embedding attempt
                if (output.embedding) {
                    finalEmbeddings.push(output.embedding);
                } else if (output.error) {
                    // Don't log "aborted" errors if the global signal is set, as it's expected.
                    if (output.error !== 'Operation aborted by signal' && output.error !== 'Operation aborted' && !op.abortController.signal.aborted) {
                        console.warn(`[IndexingService] Error embedding chunk ${output.originalChunkInfo.chunkIndexInFile} for file ${file.path}: ${output.error}`);
                    }
                    fileSpecificErrors.push(`Chunk ${output.originalChunkInfo.chunkIndexInFile}: ${output.error}`);
                }
            });

            const allChunksSuccessfullyEmbedded = fileSpecificErrors.length === 0 && finalEmbeddings.length === detailedChunkingResult.chunks.length;
            return {
                fileId: file.id,
                filePath: file.path,
                success: allChunksSuccessfullyEmbedded,
                embeddings: finalEmbeddings,
                chunkOffsets: detailedChunkingResult.offsets,
                metadata: detailedChunkingResult.metadata,
                error: fileSpecificErrors.length > 0 ? fileSpecificErrors.join('; ') : undefined,
            };

        } catch (embeddingError) {
            op.filesEmbeddingsCompletedCount++; // Still mark as processed for embedding attempt
            const errorMessage = embeddingError instanceof Error ? embeddingError.message : String(embeddingError);
            let finalError = `Embedding generation failed for file ${file.path}: ${errorMessage}`;
            if (op.abortController.signal.aborted || errorMessage.toLowerCase().includes('cancel') || errorMessage.toLowerCase().includes('abort')) {
                finalError = `Operation cancelled during embedding generation for ${file.path}.`;
            }
            console.error(`[IndexingService] ${finalError}`);
            return {
                fileId: file.id,
                filePath: file.path,
                success: false,
                error: finalError,
                embeddings: [],
                chunkOffsets: detailedChunkingResult.offsets, // Keep chunking info if available
                metadata: detailedChunkingResult.metadata,
            };
        }
    }

    /**
     * Updates the overall status bar message based on the current operation state.
     */
    private updateOverallStatus(): void {
        const op = this.currentOperation; // Capture current state

        if (!op) {
            // If no operation, set to Ready, unless there was a persistent error state we want to show.
            // For simplicity, just Ready, but only if not already in an error state or disabled.
            const currentState = this.statusBarService.getCurrentState();
            if (currentState !== StatusBarState.Error && currentState !== StatusBarState.Disabled) {
                this.statusBarService.setState(StatusBarState.Ready);
            }
            return;
        }

        if (op.abortController.signal.aborted) {
            // If aborted, message is handled by cancelProcessing or finally block in processFiles.
            // The `finally` block in `processFiles` or `cancelProcessing` itself will set the final state.
            return;
        }

        const totalInitialFiles = op.initialFiles.length;
        // Files that are successfully chunked and thus are candidates for embedding
        const filesSuccessfullyChunked = op.filesSuccessfullyChunkedCount;

        if (op.abortController.signal.aborted) return; // Status will be handled by cancellation logic

        // Progress through files being attempted for chunking (initial phase)
        if (op.filesChunkingAttemptedCount < totalInitialFiles && op.filesEmbeddingsCompletedCount === 0) {
            const progressPercent = totalInitialFiles > 0
                ? Math.round((op.filesChunkingAttemptedCount / totalInitialFiles) * 100)
                : 0;
            this.statusBarService.showTemporaryMessage(
                `Indexing: Processing file ${op.filesChunkingAttemptedCount}/${totalInitialFiles} (${progressPercent}%)`,
                3000, StatusBarMessageType.Working
            );
        }
        // Progress through files having their embeddings generated
        // op.filesEmbeddingsCompletedCount tracks files for which embedding generation has finished (success or fail)
        // op.filesSuccessfullyChunkedCount tracks files that *should* have embeddings generated
        else if (filesSuccessfullyChunked > 0 && op.filesEmbeddingsCompletedCount < filesSuccessfullyChunked) {
            const embeddingProgressPercent = filesSuccessfullyChunked > 0
                ? Math.round((op.filesEmbeddingsCompletedCount / filesSuccessfullyChunked) * 100)
                : 0;
            this.statusBarService.showTemporaryMessage(
                `Indexing: Embeddings ${op.filesEmbeddingsCompletedCount}/${filesSuccessfullyChunked} files (${embeddingProgressPercent}%)`,
                3000, StatusBarMessageType.Working
            );
        }
        // All files attempted for chunking, but none yielded chunks (e.g., all empty or unchunkable)
        else if (op.filesChunkingAttemptedCount === totalInitialFiles && filesSuccessfullyChunked === 0 && totalInitialFiles > 0) {
            // This state will be finalized by processFilesGenerator's main loop.
            // No specific temporary message here, as it's a terminal state for this batch.
        }
        // Initial state if no files have been processed yet
        else if (op.filesChunkingAttemptedCount === 0 && totalInitialFiles > 0) {
            this.statusBarService.setState(StatusBarState.Indexing, `Preparing ${totalInitialFiles} files...`);
        }
        // If all files that were chunked have had their embeddings processed,
        // the main generator loop will set the final Ready/Error state.
        // Terminal states (Ready, Error) are set by processFiles try/finally or cancelProcessing.
    }


    /**
     * Cancel any in-progress indexing operations.
     * It signals abortion to the current operation and attempts to wait for pending tasks to settle.
     */
    public async cancelProcessing(): Promise<void> {
        const opToCancel = this.currentOperation; // Capture current operation at the start

        if (opToCancel) {
            console.log('[IndexingService] Attempting to cancel current indexing operation.');
            this.statusBarService.showTemporaryMessage('Cancelling indexing...', 2000, StatusBarMessageType.Working);

            if (!opToCancel.abortController.signal.aborted) {
                opToCancel.abortController.abort(); // Signal abortion
            }

            // With sequential processing, there's no list of pending promises to explicitly await here.
            // The AbortSignal is passed to chunkFile and generateEmbeddingsForChunks.
            // The main loop in processFilesGenerator will break or handle errors thrown due to abortion.
            // The `finally` block in processFilesGenerator is responsible for cleanup.

            // Log statistics of the (partially) cancelled operation
            // Note: filesSuccessfullyChunkedCount now means files that produced chunks.
            // filesEmbeddingsCompletedCount means files whose embedding stage (success/fail) was reached.
            console.log(`[IndexingService] Indexing operation cancelled. Stats: Initial Files: ${opToCancel.initialFiles.length}, Chunking Attempted: ${opToCancel.filesChunkingAttemptedCount}, Files Yielding Chunks: ${opToCancel.filesSuccessfullyChunkedCount}, Total Chunks Generated: ${opToCancel.totalChunksGeneratedCount}, Embeddings Processed (Chunks): ${opToCancel.embeddingsProcessedCount}, Files Reaching Embedding Stage: ${opToCancel.filesEmbeddingsCompletedCount}.`);

            // currentOperation will be set to null by the finally block of processFilesGenerator
            // or if cancelProcessing is called when processFilesGenerator is not active.
            // For safety, if this cancelProcessing is called outside the generator's flow:
            if (this.currentOperation === opToCancel) { // Check if it's still the same operation
                this.currentOperation = null;
            }
            this.statusBarService.showTemporaryMessage('Indexing cancelled', 3000, StatusBarMessageType.Warning); // This might be overwritten by finally block
            this.updateOverallStatus(); // This will now see currentOperation as null and set to Ready (if no other error state).
        } else {
            console.log('[IndexingService] No active indexing operation to cancel.');
            // Ensure status is Ready if no operation was active and cancel was called.
            if (this.statusBarService.getCurrentState() !== StatusBarState.Error && this.statusBarService.getCurrentState() !== StatusBarState.Disabled) {
                this.statusBarService.setState(StatusBarState.Ready);
            }
        }
    }

    /**
     * Shows indexing management options to the user via a quick pick menu.
     * Currently supports cancelling indexing and showing processor status.
     */
    public async showIndexingManagementOptions(): Promise<void> {
        const items: vscode.QuickPickItem[] = [];
        if (this.currentOperation && !this.currentOperation.abortController.signal.aborted) {
            items.push({ label: "$(debug-stop) Cancel current indexing", description: "Stops the ongoing indexing process." });
        }
        items.push({ label: "$(info) Show processor status", description: "Displays current operation details and memory usage." });
        // Example of how a restart could be added, though implementation is complex.
        // items.push({ label: "$(refresh) Restart indexing services", description: "Re-initializes the indexing services (experimental)." });


        const selectedItem = await vscode.window.showQuickPick(items, {
            placeHolder: "Select indexing management action"
        });

        if (!selectedItem) {
            return;
        }

        if (selectedItem.label.includes("Cancel current indexing")) {
            await this.cancelProcessing();
        } else if (selectedItem.label.includes("Show processor status")) {
            this.showProcessorStatus();
        }
        // else if (selectedItem.label.includes("Restart indexing services")) {
        //     vscode.window.showInformationMessage("Restarting indexing services... This may take a moment.", { modal: true });
        //     await this.dispose();
        //     try {
        //         await this.initialize();
        //         vscode.window.showInformationMessage("Indexing services restarted successfully.");
        //     } catch (e) {
        //         vscode.window.showErrorMessage(`Failed to restart indexing services: ${e instanceof Error ? e.message : String(e)}`);
        //     }
        // }
    }

    /**
     * Displays detailed status information about the IndexingService,
     * including model details, memory usage, and active operation progress.
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


        let operationStatus = 'No active operation.';
        if (this.currentOperation) {
            const op = this.currentOperation;
            operationStatus = `Active Operation:
    - Initial Files: ${op.initialFiles.length}
    - Chunking Attempted: ${op.filesChunkingAttemptedCount}
    - Files Yielding Chunks: ${op.filesSuccessfullyChunkedCount}
    - Total Chunks Generated: ${op.totalChunksGeneratedCount}
    - Embeddings Processed (Individual Chunks): ${op.embeddingsProcessedCount}
    - Files Reaching Embedding Stage (Completed/Failed): ${op.filesEmbeddingsCompletedCount}
    - Aborted: ${op.abortController.signal.aborted}`;
        }

        const statusDetails = [
            `Current Status: ${this.statusBarService.getCurrentStateText()}`,
            lastIndexedInfo,
            modelInfo,
            contextInfo,
            embeddingServiceConfig,
            codeChunkingServiceStatus,
            embeddingGenerationServiceStatus,
            operationStatus,
            memoryInfo,
            osMemInfo
        ].join('\n');

        vscode.window.showInformationMessage(statusDetails, { modal: true });
    }

    /**
     * Disposes of resources used by the IndexingService.
     * This includes cancelling any ongoing operations and disposing of the
     * `CodeChunkingService` and `EmbeddingGenerationService`.
     */
    public async dispose(): Promise<void> {
        console.log('[IndexingService] Disposing...');
        await this.cancelProcessing(); // Ensure any active operation is stopped and cleaned up

        // Dispose new services
        if (this.codeChunkingService) {
            this.codeChunkingService.dispose();
            console.log('[IndexingService] CodeChunkingService disposed.');
        }
        if (this.embeddingGenerationService) {
            await this.embeddingGenerationService.dispose();
            console.log('[IndexingService] EmbeddingGenerationService disposed.');
        }
        // No Piscina pool to destroy directly in this class anymore

        this.statusBarService.setState(StatusBarState.Disabled, 'Indexing services disposed');
        console.log('[IndexingService] IndexingService disposed successfully.');
    }
}