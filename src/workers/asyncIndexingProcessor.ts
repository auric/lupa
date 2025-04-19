import path from 'path';
import {
    pipeline,
    env as transformersEnv,
    type FeatureExtractionPipeline,
    type Tensor
} from '@huggingface/transformers';
import { Mutex } from 'async-mutex';
import { EmbeddingOptions, ChunkingMetadata } from '../types/embeddingTypes';
import { WorkerTokenEstimator } from '../workers/workerTokenEstimator';
import { WorkerCodeChunker } from '../workers/workerCodeChunker';
import {
    getLanguageForExtension,
    type SupportedLanguage
} from '../types/types';

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
 * Processing result from a single file
 */
export interface ProcessingResult {
    fileId: string;
    embeddings: Float32Array[];
    chunkOffsets: number[];
    metadata: ChunkingMetadata;
    success: boolean;
    error?: string;
}

/**
 * An async file processor that generates embeddings without worker threads
 */
export class AsyncIndexingProcessor {
    private static readonly mutex = new Mutex();
    private codeChunker: WorkerCodeChunker | null = null;

    /**
     * Create a new async file processor
     */
    constructor(
        private readonly modelBasePath: string,
        private readonly modelName: string,
        private readonly contextLength: number,
        private readonly embeddingOptions: EmbeddingOptions = {}
    ) {
        transformersEnv.allowRemoteModels = false;
        transformersEnv.allowLocalModels = true;
        transformersEnv.cacheDir = this.modelBasePath;
        try {
            const tokenEstimator = new WorkerTokenEstimator(
                this.modelName,
                this.contextLength
            );

            this.codeChunker = new WorkerCodeChunker(tokenEstimator);
        } catch (error) {
            console.error('Error initializing AsyncIndexingProcessor:', error);
            throw error;
        }
    }

    /**
     * Get language from file path
     */
    private getLanguageFromFilePath(filePath: string): SupportedLanguage | undefined {
        const extension = path.extname(filePath).substring(1).toLowerCase();
        const langData = getLanguageForExtension(extension);
        return langData;
    }

    /**
     * Generate embeddings for chunks of code
     */
    private async generateEmbeddings(
        text: string,
        filePath: string,
        signal: AbortSignal
    ): Promise<{ embeddings: Float32Array[], chunkOffsets: number[], metadata: ChunkingMetadata }> {
        if (!this.codeChunker) {
            throw new Error('Code chunker is not initialized');
        }
        if (signal.aborted) {
            throw new Error('Operation was cancelled');
        }

        // Use provided options or defaults
        const poolingStrategy = this.embeddingOptions.pooling || 'mean';
        const shouldNormalize = this.embeddingOptions.normalize !== false; // Default to true if not specified

        // Detect language from file path for better structure-aware chunking
        const supportedLanguage = this.getLanguageFromFilePath(filePath);

        // Chunk the text using smart code-aware chunking
        const result = await this.codeChunker!.chunkCode(
            text,
            this.embeddingOptions,
            signal,
            supportedLanguage?.language || '',
            supportedLanguage?.variant
        );

        // Generate embeddings for each chunk
        const embeddings: Float32Array[] = [];
        let pipe: FeatureExtractionPipeline | null = null;
        let output: Tensor | null = null;
        for (const chunk of result.chunks) {
            // Check for cancellation before processing each chunk
            if (signal?.aborted) {
                throw new Error('Operation was cancelled');
            }

            try {
                // Skip empty chunks
                if (chunk.trim().length === 0) {
                    embeddings.push(new Float32Array(0));
                    continue;
                }

                pipe = await AsyncIndexingProcessor.mutex.runExclusive(async () => {
                    return await pipeline('feature-extraction', this.modelName, {
                        dtype: 'q4'
                    });
                });

                // Generate embedding for this chunk
                output = await pipe(chunk, {
                    pooling: poolingStrategy,
                    normalize: shouldNormalize
                });

                // Extract the embedding
                const embedding = output.data;
                if (!(embedding instanceof Float32Array)) {
                    throw new Error('Embedding output not in expected format');
                }

                embeddings.push(embedding);
            } catch (error) {
                console.error('Error generating embedding for chunk:', error);
                throw error;
            } finally {
                if (output) {
                    output.dispose();
                    output = null;
                }
                if (pipe) {
                    pipe.dispose();
                    pipe = null;
                }
            }
        }

        return {
            embeddings,
            chunkOffsets: result.offsets,
            metadata: result.metadata
        };
    }

    /**
     * Process a single file
     */
    public async processFile(file: FileToProcess, signal: AbortSignal): Promise<ProcessingResult> {
        try {
            // Generate embeddings with metadata
            const { embeddings, chunkOffsets, metadata } = await this.generateEmbeddings(
                file.content,
                file.path,
                signal
            );

            return {
                fileId: file.id,
                embeddings,
                chunkOffsets,
                success: true,
                metadata
            };
        } catch (error) {
            // Check if it's a cancellation error
            if (signal?.aborted && error instanceof Error && error.message === 'Operation was cancelled') {
                return {
                    fileId: file.id,
                    embeddings: [],
                    chunkOffsets: [],
                    metadata: {
                        parentStructureIds: [],
                        structureOrders: [],
                        isOversizedFlags: [],
                        structureTypes: []
                    },
                    success: false,
                    error: 'Operation was cancelled'
                };
            }

            console.error(`Error processing file ${file.path}:`, error);

            return {
                fileId: file.id,
                embeddings: [],
                chunkOffsets: [],
                metadata: {
                    parentStructureIds: [],
                    structureOrders: [],
                    isOversizedFlags: [],
                    structureTypes: []
                },
                success: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    /**
     * Dispose resources
     */
    public dispose(): void {
        if (this.codeChunker) {
            this.codeChunker.dispose();
        }

        this.codeChunker = null;
    }
}
