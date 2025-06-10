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
    type EmbeddingGenerationOutput
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
    initialFiles: FileToProcess[]; // Renamed from 'files' for clarity as per plan
    abortController: AbortController;
    results: Map<string, ProcessingResult>; // Final or error results per fileId

    // Chunking Phase
    filesChunkingAttemptedCount: number;
    filesSuccessfullyChunkedCount: number; // Files that yielded chunks
    totalChunksGeneratedCount: number; // Total individual code chunks from all files

    // Embedding Phase
    embeddingsProcessedCount: number; // Individual chunk embeddings processed (success or failure)
    filesEmbeddingsCompletedCount: number; // Files with ALL their chunks' embeddings processed

    // Internal tracking for pending embedding operations, needed for implementation
    pendingFileEmbeddings: Array<{
        fileId: string,
        filePath: string, // Added for easier access during result aggregation
        detailedChunkingResult: DetailedChunkingResult,
        embeddingPromise: Promise<EmbeddingGenerationOutput[]>
    }>;
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
     * @returns Map of file IDs to embeddings
     */
    public async processFiles(
        files: FileToProcess[],
        token?: vscode.CancellationToken,
        progressCallback?: (processedItems: number, totalItems: number, phase?: 'chunking' | 'embedding', processedFiles?: number, totalFiles?: number) => void,
        batchCompletedCallback?: (batchResults: Map<string, ProcessingResult>) => Promise<void>
    ): Promise<Map<string, ProcessingResult>> {
        if (files.length === 0) {
            console.log('[IndexingService] No files provided for processing.');
            return new Map();
        }

        // Ensure services are initialized (assuming constructor/initialize sets them up)
        if (!this.codeChunkingService || !this.embeddingGenerationService) {
            console.error('[IndexingService] Dependent services (CodeChunkingService or EmbeddingGenerationService) are not initialized.');
            this.statusBarService.setState(StatusBarState.Error, 'Service initialization error before processing.');
            throw new Error('IndexingService or its dependent services are not properly initialized.');
        }

        // Cancel any existing operation, as per plan
        if (this.currentOperation) {
            console.log('[IndexingService] New processing request received, cancelling previous operation.');
            await this.cancelProcessing(); // Ensure this properly cleans up
        }

        const abortController = new AbortController();
        const tokenRegistration = token?.onCancellationRequested(() => {
            if (!abortController.signal.aborted) {
                console.log('[IndexingService] VS Code CancellationToken triggered: Aborting current operation.');
                abortController.abort();
            }
        });

        // Initialize currentOperation based on the new structure from the plan
        this.currentOperation = {
            initialFiles: [...files].sort((a, b) => (b.priority || 0) - (a.priority || 0)), // Sort by priority
            abortController,
            results: new Map(),
            filesChunkingAttemptedCount: 0,
            filesSuccessfullyChunkedCount: 0,
            totalChunksGeneratedCount: 0,
            embeddingsProcessedCount: 0,
            filesEmbeddingsCompletedCount: 0,
            pendingFileEmbeddings: [],
        };
        const op = this.currentOperation; // Alias for convenience

        this.statusBarService.setState(StatusBarState.Indexing, `Preparing ${op.initialFiles.length} files...`);
        console.log(`[IndexingService] Starting processing for ${op.initialFiles.length} files.`);

        let livenessTimer: NodeJS.Timeout | null = setInterval(() => {
            console.log(`[LIVENESS] IndexingService main thread is alive during processing at ${new Date().toISOString()}`);
        }, 30000);


        try {
            // --- Phase 1: Per-File Chunking & Embedding Dispatch ---
            console.log('[IndexingService] Starting Phase 1: Per-File Chunking & Embedding Dispatch.');
            for (const file of op.initialFiles) {
                if (op.abortController.signal.aborted) {
                    console.log(`[IndexingService] Operation aborted during Phase 1 (file: ${file.path}).`);
                    throw new Error('Operation cancelled during file preparation loop.'); // Propagate to finally block
                }

                op.filesChunkingAttemptedCount++;
                this.updateOverallStatus(); // Update status bar for files attempted

                let detailedChunkingResult: DetailedChunkingResult | null = null;
                try {
                    // Pass the service-level embeddingOptions, not a per-file one unless the API changes
                    detailedChunkingResult = await this.codeChunkingService.chunkFile(
                        file,
                        this.options.embeddingOptions,
                        op.abortController.signal
                    );
                } catch (chunkError) { // Should be rare if chunkFile handles its errors and returns null
                    console.error(`[IndexingService] Critical error during codeChunkingService.chunkFile for ${file.path}:`, chunkError);
                    detailedChunkingResult = null; // Ensure it's null
                }

                if (op.abortController.signal.aborted) {
                    console.log(`[IndexingService] Operation aborted after attempting to chunk file ${file.path}.`);
                    break; // Exit loop, will be handled by finally
                }

                if (detailedChunkingResult && detailedChunkingResult.chunks.length > 0) {
                    op.filesSuccessfullyChunkedCount++;
                    op.totalChunksGeneratedCount += detailedChunkingResult.chunks.length;

                    const chunksForEmbedding: ChunkForEmbedding[] = detailedChunkingResult.chunks.map((chunkText, index) => ({
                        fileId: file.id,
                        filePath: file.path, // Store filePath for easier access later
                        chunkIndexInFile: index,
                        text: chunkText,
                        offsetInFile: detailedChunkingResult.offsets[index],
                    }));

                    // Dispatch embedding generation for these chunks
                    const embeddingPromise = this.embeddingGenerationService.generateEmbeddingsForChunks(
                        chunksForEmbedding,
                        op.abortController.signal
                    );

                    op.pendingFileEmbeddings.push({
                        fileId: file.id,
                        filePath: file.path, // Store filePath here too
                        detailedChunkingResult,
                        embeddingPromise,
                    });
                    console.log(`[IndexingService] Dispatched ${chunksForEmbedding.length} chunks for embedding for file: ${file.path}`);
                } else {
                    const reason = detailedChunkingResult === null ? "chunking failed or was cancelled" : "file yielded no chunks";
                    console.log(`[IndexingService] File ${file.path} ${reason}.`);
                    op.results.set(file.id, {
                        fileId: file.id,
                        filePath: file.path,
                        success: false,
                        error: `File processing error: ${reason}.`,
                        embeddings: [],
                        chunkOffsets: detailedChunkingResult?.offsets || [],
                        metadata: detailedChunkingResult?.metadata || { parentStructureIds: [], structureOrders: [], isOversizedFlags: [], structureTypes: [] },
                    });
                }

                if (progressCallback) {
                    progressCallback(
                        op.filesChunkingAttemptedCount,
                        op.initialFiles.length,
                        'chunking',
                        op.filesChunkingAttemptedCount,
                        op.initialFiles.length
                    );
                }
            } // End of Phase 1 loop

            console.log(`[IndexingService] Finished Phase 1. Attempted: ${op.filesChunkingAttemptedCount}, Succeeded chunking: ${op.filesSuccessfullyChunkedCount}, Total chunks: ${op.totalChunksGeneratedCount}, Files for embedding: ${op.pendingFileEmbeddings.length}`);

            if (op.abortController.signal.aborted) {
                console.log('[IndexingService] Operation aborted after Phase 1 completion.');
                // Fall through to finally block for cleanup and result handling
            }

            if (op.pendingFileEmbeddings.length === 0 && !op.abortController.signal.aborted) {
                this.statusBarService.setState(StatusBarState.Ready, 'No content to embed from any file.');
                if (batchCompletedCallback && op.results.size > 0) { // Call for files that failed chunking
                    await batchCompletedCallback(new Map(op.results));
                }
                // Ensure liveness timer is cleared before returning
                if (livenessTimer) clearInterval(livenessTimer);
                tokenRegistration?.dispose();
                this.currentOperation = null;
                return new Map(op.results);
            }
            // --- Phase 2: Await All Embedding Promises ---
            if (!op.abortController.signal.aborted && op.pendingFileEmbeddings.length > 0) {
                console.log(`[IndexingService] Starting Phase 2: Awaiting ${op.pendingFileEmbeddings.length} File Embedding Promises.`);
                this.updateOverallStatus(); // Update status before awaiting

                const allEmbeddingPromises = op.pendingFileEmbeddings.map(p => p.embeddingPromise);
                // Use Promise.allSettled to ensure all promises complete, even if some reject,
                // allowing us to process partial results or errors for each file.
                const settledEmbeddingOutputsArray = await Promise.allSettled(allEmbeddingPromises);
                console.log('[IndexingService] Finished Phase 2: All Embedding Promises Settled.');

                if (op.abortController.signal.aborted) {
                    console.log('[IndexingService] Operation aborted after awaiting embedding promises during Phase 2.');
                    // Fall through to finally for cleanup
                }

                // --- Phase 3: Result Aggregation ---
                console.log('[IndexingService] Starting Phase 3: Result Aggregation.');
                const temporaryBatchResultsForCallback = new Map<string, ProcessingResult>();
                // Define a batch size for calling batchCompletedCallback, e.g., 50 files or based on options
                const batchSizeForCallback = this.options.maxConcurrentEmbeddingTasks ? this.options.maxConcurrentEmbeddingTasks * 2 : 50;


                for (let i = 0; i < settledEmbeddingOutputsArray.length; i++) {
                    if (op.abortController.signal.aborted) {
                        console.log(`[IndexingService] Aborting Phase 3 result aggregation early.`);
                        break; // Exit loop if aborted
                    }

                    const settledResult = settledEmbeddingOutputsArray[i];
                    // Retrieve corresponding original file data and chunking result
                    const { fileId, filePath, detailedChunkingResult } = op.pendingFileEmbeddings[i];

                    if (settledResult.status === 'fulfilled') {
                        const embeddingOutputsForFile = settledResult.value; // This is EmbeddingGenerationOutput[]
                        const finalEmbeddings: Float32Array[] = [];
                        const fileSpecificErrors: string[] = [];

                        embeddingOutputsForFile.forEach(output => {
                            op.embeddingsProcessedCount++;
                            if (output.embedding) {
                                finalEmbeddings.push(output.embedding);
                            } else if (output.error) {
                                // Log individual chunk errors, but don't let them stop processing for other chunks/files
                                // Avoid noisy logging for expected abort errors.
                                if (output.error !== 'Operation aborted by signal' && output.error !== 'Operation aborted' && !op.abortController.signal.aborted) {
                                    console.warn(`[IndexingService] Error embedding chunk ${output.originalChunkInfo.chunkIndexInFile} for file ${filePath}: ${output.error}`);
                                }
                                fileSpecificErrors.push(`Chunk ${output.originalChunkInfo.chunkIndexInFile}: ${output.error}`);
                            }
                        });

                        const allChunksSuccessfullyEmbedded = fileSpecificErrors.length === 0 && finalEmbeddings.length === detailedChunkingResult.chunks.length;
                        if (allChunksSuccessfullyEmbedded) {
                            op.filesEmbeddingsCompletedCount++;
                        }

                        const processingResult: ProcessingResult = {
                            fileId,
                            filePath, // Include filePath in the final result
                            success: allChunksSuccessfullyEmbedded,
                            embeddings: finalEmbeddings,
                            chunkOffsets: detailedChunkingResult.offsets,
                            metadata: detailedChunkingResult.metadata,
                            error: fileSpecificErrors.length > 0 ? fileSpecificErrors.join('; ') : undefined,
                        };
                        op.results.set(fileId, processingResult);
                        temporaryBatchResultsForCallback.set(fileId, processingResult);
                        console.log(`[IndexingService] Aggregated results for file ${filePath}. Success: ${processingResult.success}`);

                    } else { // settledResult.status === 'rejected'
                        // This means the entire `generateEmbeddingsForChunks` promise for a file was rejected.
                        // This should be rare if `generateEmbeddingsForChunks` is robust.
                        op.embeddingsProcessedCount += detailedChunkingResult.chunks.length; // Assume all chunks for this file "processed" (as failures)
                        const errorMessage = `Embedding generation critically failed for file ${filePath}: ${settledResult.reason instanceof Error ? settledResult.reason.message : String(settledResult.reason)}`;
                        console.error(`[IndexingService] ${errorMessage}`);
                        const errorResult: ProcessingResult = {
                            fileId,
                            filePath,
                            success: false,
                            error: errorMessage,
                            embeddings: [],
                            chunkOffsets: detailedChunkingResult.offsets,
                            metadata: detailedChunkingResult.metadata,
                        };
                        op.results.set(fileId, errorResult);
                        temporaryBatchResultsForCallback.set(fileId, errorResult);
                    }

                    this.updateOverallStatus(); // Update status bar after each file's embeddings are processed

                    if (progressCallback) {
                        progressCallback(
                            op.embeddingsProcessedCount, // Processed individual embeddings
                            op.totalChunksGeneratedCount, // Total chunks that were generated
                            'embedding',
                            op.filesEmbeddingsCompletedCount, // Files fully embedded
                            op.pendingFileEmbeddings.length // Total files that went into embedding phase
                        );
                    }

                    // Call batchCompletedCallback if batch size is reached or it's the last item
                    if (batchCompletedCallback &&
                        (temporaryBatchResultsForCallback.size >= batchSizeForCallback || i === settledEmbeddingOutputsArray.length - 1)) {
                        if (temporaryBatchResultsForCallback.size > 0) {
                            console.log(`[IndexingService] Calling batchCompletedCallback with ${temporaryBatchResultsForCallback.size} results.`);
                            try {
                                await batchCompletedCallback(new Map(temporaryBatchResultsForCallback));
                            } catch (cbError) {
                                console.error('[IndexingService] Error in batchCompletedCallback during Phase 3:', cbError);
                            }
                            temporaryBatchResultsForCallback.clear();
                        }
                    }
                } // End of Phase 3 loop
                console.log('[IndexingService] Finished Phase 3: Result Aggregation.');
            } else if (op.abortController.signal.aborted) {
                console.log('[IndexingService] Skipped Phase 2 & 3 due to prior cancellation.');
            } else {
                console.log('[IndexingService] No files pending embedding, skipping Phase 2 & 3.');
            }

            // Final status update before exiting try block
            if (!op.abortController.signal.aborted) {
                if (op.pendingFileEmbeddings.length > 0 && op.filesEmbeddingsCompletedCount === op.pendingFileEmbeddings.length && op.filesSuccessfullyChunkedCount === op.pendingFileEmbeddings.length) {
                    this.workspaceSettingsService.updateLastIndexingTimestamp();
                    this.statusBarService.setState(StatusBarState.Ready, 'Indexing complete');
                    console.log('[IndexingService] Indexing completed successfully for all dispatched files.');
                } else if (op.initialFiles.length > 0 && op.filesChunkingAttemptedCount === op.initialFiles.length && op.pendingFileEmbeddings.length === 0) {
                    // All files attempted, but none yielded content for embedding
                    this.statusBarService.setState(StatusBarState.Ready, 'No content to embed from files.');
                    console.log('[IndexingService] All files processed, but no content was found to embed.');
                }
                else if (op.initialFiles.length > 0 && op.filesChunkingAttemptedCount === op.initialFiles.length) { // Partial completion or errors
                    this.statusBarService.setState(StatusBarState.Error, 'Indexing finished with some issues.');
                    console.warn('[IndexingService] Indexing finished with some issues or was incomplete.');
                }
            }
            // Results are returned in the finally block


        } catch (error) { // Catch errors from the main try block (e.g., cancellation throws from Phase 1)
            if (error instanceof Error && error.name === 'AbortError') {
                console.log('[IndexingService] Operation was aborted during processing.', error.message);
                // Status bar update will be handled in finally
            } else {
                console.error('[IndexingService] Critical error during file processing:', error);
                this.statusBarService.setState(StatusBarState.Error, error instanceof Error ? error.message : 'Unknown critical error during indexing');
            }
            // Results will be handled in finally
            // Ensure liveness timer is cleared if an error escapes the loop
            if (livenessTimer) {
                clearInterval(livenessTimer);
                livenessTimer = null;
            }
            // Rethrow if it's not an AbortError, or handle as per desired error propagation
            // For now, we'll let finally handle the results.
            // If we rethrow, the `finally` block still executes.
            if (!(error instanceof Error && error.name === 'AbortError')) {
                throw error; // Or transform into a more specific error
            }
            return new Map(this.currentOperation?.results || []); // Should be captured in finally
        } finally {
            console.log('[IndexingService] Entering finally block of processFiles.');
            if (livenessTimer) {
                clearInterval(livenessTimer);
                console.log('[LIVENESS] IndexingService liveness timer cleared in finally.');
            }
            tokenRegistration?.dispose();

            const finalResults = new Map(this.currentOperation?.results); // Capture results before nullifying

            if (this.currentOperation?.abortController.signal.aborted) {
                this.statusBarService.showTemporaryMessage('Indexing cancelled', 3000, StatusBarMessageType.Warning);
                // Add error results for any pending files that were not processed due to cancellation
                this.currentOperation.pendingFileEmbeddings.forEach(pending => {
                    if (!finalResults.has(pending.fileId)) {
                        finalResults.set(pending.fileId, {
                            fileId: pending.fileId,
                            filePath: pending.filePath, // Added filePath
                            success: false,
                            error: 'Operation cancelled before embeddings could be generated/processed.',
                            embeddings: [],
                            chunkOffsets: pending.detailedChunkingResult.offsets,
                            metadata: pending.detailedChunkingResult.metadata,
                        });
                    }
                });
            }
            // Call batchCompletedCallback with all accumulated results if it hasn't been called for them
            // This might be complex if batching was done incrementally.
            // For simplicity now, if a batch callback exists and there are results, call it.
            // This needs refinement if incremental batch callbacks were made.
            if (batchCompletedCallback && finalResults.size > 0) {
                try {
                    // This might send results that were already sent if batching was incremental.
                    // A more robust solution would track what's been sent.
                    console.log(`[IndexingService] Calling final batchCompletedCallback with ${finalResults.size} results in finally block.`);
                    await batchCompletedCallback(finalResults);
                } catch (cbError) {
                    console.error('[IndexingService] Error in final batchCompletedCallback in finally block:', cbError);
                }
            }


            this.currentOperation = null; // Clear current operation
            this.updateOverallStatus(); // Update status based on (now null) currentOperation
            console.log('[IndexingService] Exiting processFiles.');
            return finalResults;
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
        // Files that are successfully chunked and thus dispatched/queued for embedding
        const filesDispatchedForEmbedding = op.pendingFileEmbeddings.length;


        if (op.filesChunkingAttemptedCount < totalInitialFiles && op.filesChunkingAttemptedCount >= 0) {
            const chunkingProgressPercent = totalInitialFiles > 0
                ? Math.round((op.filesChunkingAttemptedCount / totalInitialFiles) * 100)
                : 0;
            this.statusBarService.showTemporaryMessage(
                `Indexing: Preparing files ${op.filesChunkingAttemptedCount}/${totalInitialFiles} (${chunkingProgressPercent}%)`,
                5000, StatusBarMessageType.Working // Increased duration for visibility
            );
        } else if (filesDispatchedForEmbedding > 0 && op.filesEmbeddingsCompletedCount < filesDispatchedForEmbedding) {
            const embeddingProgressPercent = filesDispatchedForEmbedding > 0
                ? Math.round((op.filesEmbeddingsCompletedCount / filesDispatchedForEmbedding) * 100)
                : 0;
            this.statusBarService.showTemporaryMessage(
                `Indexing: Embeddings ${op.filesEmbeddingsCompletedCount}/${filesDispatchedForEmbedding} files (${embeddingProgressPercent}%)`,
                5000, StatusBarMessageType.Working // Increased duration
            );
        } else if (op.filesChunkingAttemptedCount === totalInitialFiles && filesDispatchedForEmbedding === 0 && totalInitialFiles > 0) {
            // All files chunked, none yielded chunks. Final state set by processFiles.
        } else if (op.filesChunkingAttemptedCount === 0 && totalInitialFiles > 0) {
            this.statusBarService.setState(StatusBarState.Indexing, `Preparing ${totalInitialFiles} files...`);
        }
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

            // Await settlement of promises that were part of pendingFileEmbeddings.
            const pendingEmbeddingPromises = opToCancel.pendingFileEmbeddings.map(p => p.embeddingPromise);
            if (pendingEmbeddingPromises.length > 0) {
                console.log(`[IndexingService] Waiting for ${pendingEmbeddingPromises.length} pending file embedding operations to settle after cancellation signal.`);
                try {
                    await Promise.allSettled(pendingEmbeddingPromises);
                    console.log('[IndexingService] All pending file embedding operations have settled after cancellation signal.');
                } catch (settleError) {
                    console.warn('[IndexingService] Unexpected error while waiting for embedding promises to settle during cancellation:', settleError);
                }
            }

            // Important: Nullify currentOperation only *after* all cleanup related to it is done or captured.
            this.currentOperation = null;

            // Log statistics of the cancelled operation
            console.log(`[IndexingService] Indexing operation cancelled. Stats: Initial Files: ${opToCancel.initialFiles.length}, Chunking Attempted: ${opToCancel.filesChunkingAttemptedCount}, Chunking Succeeded: ${opToCancel.filesSuccessfullyChunkedCount}, Chunks Generated: ${opToCancel.totalChunksGeneratedCount}, Files for Embedding: ${opToCancel.pendingFileEmbeddings.length}, Embeddings Processed (Chunks): ${opToCancel.embeddingsProcessedCount}, Files Fully Embedded: ${opToCancel.filesEmbeddingsCompletedCount}.`);

            this.statusBarService.showTemporaryMessage('Indexing cancelled', 3000, StatusBarMessageType.Warning);
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
    - Chunking: ${op.filesChunkingAttemptedCount} attempted, ${op.filesSuccessfullyChunkedCount} succeeded, ${op.totalChunksGeneratedCount} chunks generated.
    - Files Dispatched for Embedding: ${op.pendingFileEmbeddings.length}
    - Embeddings Processed (Chunks): ${op.embeddingsProcessedCount}
    - Files Fully Embedded: ${op.filesEmbeddingsCompletedCount}
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