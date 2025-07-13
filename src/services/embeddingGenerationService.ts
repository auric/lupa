import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { Tinypool } from 'tinypool';
import { ChunkForEmbedding, EmbeddingGenerationOutput } from '../types/indexingTypes';
import { EmbeddingOptions } from '../types/embeddingTypes';
import { EmbeddingTaskData, EmbeddingTaskResult } from '../workers/embeddingGeneratorWorker.js';
import { Log } from './loggingService';

/**
 * Options for configuring the EmbeddingGenerationService.
 */
export interface EmbeddingGenerationServiceOptions {
    /**
     * The name of the embedding model to use.
     */
    modelName: string;
    /**
     * The base path where the embedding model is located.
     */
    modelBasePath: string;
    /**
     * Specific options for the embedding process.
     */
    embeddingOptions: EmbeddingOptions;
    /**
     * The path to the extension, used to locate worker scripts.
     */
    extensionPath: string;
    /**
     * The maximum number of concurrent tasks for embedding generation.
     * Defaults to a value based on the number of CPU cores.
     */
    maxConcurrentTasks?: number;
}

/**
 * Service responsible for managing a Tinypool worker pool and generating embeddings
 * for a collection of code chunks.
 */
export class EmbeddingGenerationService {
    /**
     * Default maximum number of concurrent tasks, calculated based on CPU cores.
     */
    private static readonly defaultMaxConcurrentTasks = Math.max(2, Math.ceil(os.cpus().length / 2));
    /**
     * The configured options for the service, with defaults applied.
     */
    private readonly options: Required<EmbeddingGenerationServiceOptions>;
    /**
     * The Tinypool instance for managing worker threads. Null if not initialized or disposed.
     */
    private piscina: Tinypool | null = null;
    /**
     * Flag indicating whether the service has been initialized.
     */
    private isInitialized: boolean = false;

    /**
     * Creates an instance of EmbeddingGenerationService.
     * @param options - The configuration options for the service.
     */
    constructor(options: EmbeddingGenerationServiceOptions) {
        this.options = {
            ...options,
            maxConcurrentTasks: options.maxConcurrentTasks ?? EmbeddingGenerationService.defaultMaxConcurrentTasks,
        };
    }

    /**
     * Initializes the service, setting up the Tinypool worker pool.
     * If already initialized, this method does nothing.
     * @throws Will throw an error if Tinypool initialization fails.
     */
    public async initialize(): Promise<void> {
        if (this.isInitialized) {
            return;
        }

        const workerFilename = path.join(this.options.extensionPath, 'dist', 'workers', 'embeddingGeneratorWorker.js');
        const workerFileURL = pathToFileURL(workerFilename).toString();

        Log.info(`Initializing EmbeddingGenerationService with worker file: ${workerFileURL}`);

        try {
            this.piscina = new Tinypool({
                filename: workerFileURL,
                name: 'processEmbeddingTask',
                runtime: 'child_process',
                maxThreads: this.options.maxConcurrentTasks,
            });
            this.isInitialized = true;
            Log.info('EmbeddingGenerationService initialized successfully.');
        } catch (error) {
            Log.error('Failed to initialize Tinypool for EmbeddingGenerationService:', error);
            throw error;
        }
    }

    /**
     * Generates embeddings for a given array of code chunks.
     * @param chunksToEmbed - An array of ChunksForEmbedding to process.
     * @param abortSignal - An AbortSignal to allow cancellation of the embedding tasks.
     * @returns A Promise that resolves to an array of EmbeddingGenerationOutput,
     *          containing the original chunk info, the generated embedding (or null if an error occurred),
     *          and any error message.
     *          Returns an array of error results if the service is not initialized.
     */
    public async generateEmbeddingsForChunks(
        chunksToEmbed: ChunkForEmbedding[],
        abortSignal: AbortSignal
    ): Promise<EmbeddingGenerationOutput[]> {
        if (!this.isInitialized || !this.piscina) {
            Log.error('EmbeddingGenerationService is not initialized or piscina is not available.');
            return chunksToEmbed.map(chunk => ({
                originalChunkInfo: chunk,
                embedding: null,
                error: 'Service not initialized',
            }));
        }

        const piscinaInstance = this.piscina; // Capture for use in promises, as this.piscina could be nulled by dispose()

        const promises = chunksToEmbed.map(chunk => {
            const taskData: EmbeddingTaskData = {
                chunkText: chunk.text,
                modelName: this.options.modelName,
                modelBasePath: this.options.modelBasePath,
                embeddingOptions: this.options.embeddingOptions,
            };

            return piscinaInstance.run(taskData, { signal: abortSignal })
                .then((result: EmbeddingTaskResult) => ({
                    originalChunkInfo: chunk,
                    embedding: result.embedding,
                    error: result.error,
                }))
                .catch((error: Error) => ({
                    originalChunkInfo: chunk,
                    embedding: null,
                    error: error.message,
                }));
        });

        return await Promise.all(promises);
    }

    /**
     * Disposes of the service, destroying the Tinypool worker pool.
     * Sets the service to an uninitialized state.
     */
    public async dispose(): Promise<void> {
        if (this.piscina) {
            try {
                await this.piscina.destroy();
            } catch (error) {
                Log.error('Error disposing Tinypool in EmbeddingGenerationService:', error);
                // Log error but don't re-throw, as dispose should be idempotent and not fail critically
            }
            this.piscina = null;
        }
        this.isInitialized = false;
        Log.info('EmbeddingGenerationService disposed.');
    }
}
