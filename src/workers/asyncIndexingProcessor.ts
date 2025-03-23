import path from 'path';
import {
    pipeline,
    env as transformersEnv,
    type FeatureExtractionPipeline,
    type Tensor
} from '@huggingface/transformers';
import { EmbeddingOptions } from '../types/embeddingTypes';
import { WorkerTokenEstimator } from '../workers/workerTokenEstimator';
import { WorkerCodeChunker } from '../workers/workerCodeChunker';
import { getLanguageForExtension } from '../types/types';

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
    success: boolean;
    error?: string;
}

/**
 * An async file processor that generates embeddings without worker threads
 */
export class AsyncIndexingProcessor {
    private tokenEstimator: WorkerTokenEstimator | null = null;
    private codeChunker: WorkerCodeChunker | null = null;
    private pipeline: FeatureExtractionPipeline | null = null;

    /**
     * Create a new async file processor
     */
    constructor(
        private readonly modelBasePath: string,
        private readonly modelName: string,
        private readonly contextLength: number,
        private readonly embeddingOptions: EmbeddingOptions = {}
    ) { }

    /**
     * Initialize the processor
     */
    private async initialize(): Promise<void> {
        try {
            // Set up transformer environment
            transformersEnv.allowRemoteModels = false;
            transformersEnv.allowLocalModels = true;
            transformersEnv.cacheDir = this.modelBasePath;

            // Create embedding pipeline
            this.pipeline = await pipeline('feature-extraction', this.modelName, {
                dtype: 'q4'
            });

            if (!this.pipeline) {
                throw new Error(`Failed to initialize embedding pipeline for ${this.modelName}`);
            }

            if (!this.codeChunker) {
                // Initialize token estimator
                this.tokenEstimator = new WorkerTokenEstimator(
                    this.modelName,
                    this.contextLength
                );

                // Initialize code chunker with the tokenEstimator
                this.codeChunker = new WorkerCodeChunker(this.tokenEstimator);
            }
            console.log(`AsyncIndexingProcessor: Model ${this.modelName} initialized successfully`);
        } catch (error) {
            console.error('Error initializing AsyncIndexingProcessor:', error);
            this.dispose();
            throw error;
        }
    }

    /**
     * Get language from file path
     */
    private getLanguageFromFilePath(filePath: string): string | undefined {
        const extension = path.extname(filePath).substring(1).toLowerCase();
        const langData = getLanguageForExtension(extension);
        return langData?.language;
    }

    /**
     * Generate embeddings for chunks of code
     */
    private async generateEmbeddings(
        text: string,
        filePath: string,
        options: EmbeddingOptions = {},
        signal: AbortSignal
    ): Promise<{ embeddings: Float32Array[], chunkOffsets: number[] }> {
        if (!this.pipeline || !this.codeChunker) {
            await this.initialize();
        }

        if (signal.aborted) {
            throw new Error('Operation was cancelled');
        }

        // Use provided options or defaults
        const poolingStrategy = options.pooling || 'mean';
        const shouldNormalize = options.normalize !== false; // Default to true if not specified

        // Detect language from file path for better structure-aware chunking
        const language = this.getLanguageFromFilePath(filePath);

        // Chunk the text using smart code-aware chunking
        const { chunks, offsets } = await this.codeChunker!.chunkCode(text, options, signal, language);

        // Generate embeddings for each chunk
        const embeddings: Float32Array[] = [];
        let output: Tensor | null = null;
        for (const chunk of chunks) {
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

                // Generate embedding for this chunk
                output = await this.pipeline!(chunk, {
                    pooling: poolingStrategy,
                    normalize: shouldNormalize
                });

                // Extract the embedding
                const embedding = output!.data;
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
                }
            }
        }

        return {
            embeddings,
            chunkOffsets: offsets
        };
    }

    /**
     * Process a single file
     */
    public async processFile(file: FileToProcess, signal: AbortSignal): Promise<ProcessingResult> {
        try {
            // Generate embeddings
            const { embeddings, chunkOffsets } = await this.generateEmbeddings(
                file.content,
                file.path,
                this.embeddingOptions,
                signal
            );

            return {
                fileId: file.id,
                embeddings,
                chunkOffsets,
                success: true
            };
        } catch (error) {
            // Check if it's a cancellation error
            if (signal?.aborted && error instanceof Error && error.message === 'Operation was cancelled') {
                return {
                    fileId: file.id,
                    embeddings: [],
                    chunkOffsets: [],
                    success: false,
                    error: 'Operation was cancelled'
                };
            }

            console.error(`Error processing file ${file.path}:`, error);

            return {
                fileId: file.id,
                embeddings: [],
                chunkOffsets: [],
                success: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    /**
     * Dispose resources
     */
    public dispose(): void {
        if (this.pipeline) {
            try {
                this.pipeline.dispose();
            } catch (error) {
                console.error('Error disposing embedding pipeline:', error);
            }
            this.pipeline = null;
        }

        // Note: We don't dispose the TreeStructureAnalyzerPool here as it's a singleton
        // managed externally and shared with other components

        this.tokenEstimator = null;
        this.codeChunker = null;
    }
}
