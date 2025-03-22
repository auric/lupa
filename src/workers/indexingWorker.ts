import * as path from 'path';
import { pipeline, env as transformersEnv, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { MessagePort } from 'worker_threads';
import { EmbeddingOptions } from '../types/embeddingTypes';
import { WorkerTokenEstimator } from './workerTokenEstimator';
import { WorkerCodeChunker } from './workerCodeChunker';
import { getLanguageForExtension } from '../types/types';

// Module-level variables for caching
let embeddingPipeline: FeatureExtractionPipeline | null = null;
let tokenEstimator: WorkerTokenEstimator | null = null;
let codeChunker: WorkerCodeChunker | null = null;
let currentModelName: string | null = null;

// Define interfaces for clear typing
export interface ProcessFileTask {
    index: number;
    fileId: string;
    filePath: string;
    content: string;
    modelBasePath: string;
    modelName: string;
    contextLength: number;
    extensionPath: string;
    messagePort: MessagePort;
    options?: EmbeddingOptions;
}

export interface ProcessingResult {
    fileId: string;
    embeddings: Float32Array[];
    chunkOffsets: number[];
    success: boolean;
    error?: string;
}

/**
 * Get language from file path
 * @param filePath File path
 * @returns Language identifier or undefined if not recognized
 */
function getLanguageFromFilePath(filePath: string): string | undefined {
    const extension = path.extname(filePath).substring(1).toLowerCase();
    const langData = getLanguageForExtension(extension);
    return langData?.language;
}

/**
 * Initialize the embedding model once per worker
 * @param modelName Name of the model to initialize
 * @param signal AbortSignal for cancellation
 */
async function initializeModel(
    modelBasePath: string,
    modelName: string,
    contextWindow: number,
    extensionPath: string,
    signal: AbortSignal
): Promise<FeatureExtractionPipeline> {
    // Check for cancellation
    if (signal.aborted) {
        throw new Error('Operation was cancelled during model initialization');
    }

    // If model is already initialized with the same name, reuse it
    if (embeddingPipeline && currentModelName === modelName) {
        return embeddingPipeline;
    }

    try {
        console.log(`Worker: Initializing model ${modelName}`);

        // Check for cancellation before starting expensive operation
        if (signal.aborted) {
            throw new Error('Operation was cancelled before model initialization');
        }

        transformersEnv.allowRemoteModels = false;
        transformersEnv.allowLocalModels = true;
        transformersEnv.cacheDir = modelBasePath;

        // Create the pipeline
        embeddingPipeline = await pipeline('feature-extraction', modelName, {
            dtype: 'q4'
        });

        if (!embeddingPipeline) {
            throw new Error(`Failed to initialize embedding pipeline for ${modelName}`);
        }

        // Store the current model name
        currentModelName = modelName;

        // Initialize token estimator
        tokenEstimator = new WorkerTokenEstimator(
            modelName,
            contextWindow
        );
        codeChunker = new WorkerCodeChunker(extensionPath, tokenEstimator);
        console.log(`Worker: Model ${modelName} initialized successfully`);

        return embeddingPipeline;
    } catch (error) {
        // Check if the error is due to cancellation
        if (signal.aborted) {
            console.log(`Worker: Model initialization cancelled for ${modelName}`);
            throw new Error('Operation was cancelled');
        }

        console.error(`Worker: Failed to initialize model:`, error);
        // Reset state on failure
        embeddingPipeline = null;
        currentModelName = null;
        throw error;
    }
}

/**
 * Generate embeddings for chunks of code
 */
async function generateEmbeddings(
    text: string,
    filePath: string,
    pipe: FeatureExtractionPipeline,
    options: EmbeddingOptions = {},
    signal: AbortSignal
): Promise<{ embeddings: Float32Array[], chunkOffsets: number[] }> {
    // Use provided options or defaults
    const poolingStrategy = options.pooling || 'mean';
    const shouldNormalize = options.normalize !== false; // Default to true if not specified

    // Detect language from file path for better structure-aware chunking
    const language = getLanguageFromFilePath(filePath);

    // Chunk the text using smart code-aware chunking
    const { chunks, offsets } = await codeChunker!.chunkCode(text, options, signal, language);

    // Yield to the event loop to process any pending messages
    await new Promise(resolve => setTimeout(resolve, 0));

    // Generate embeddings for each chunk
    const embeddings: Float32Array[] = [];
    for (const chunk of chunks) {
        // Check for cancellation before processing each chunk
        if (signal.aborted) {
            throw new Error('Operation was cancelled');
        }

        try {
            // Skip empty chunks
            if (chunk.trim().length === 0) {
                embeddings.push(new Float32Array(0));
                continue;
            }

            // Generate embedding for this chunk
            const output = await pipe(chunk, {
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
        }
    }

    return {
        embeddings,
        chunkOffsets: offsets
    };
}

/**
 * Main worker function that processes a file and generates embeddings
 * This is the function that will be called by Piscina
 */
export default async function processFile(
    task: ProcessFileTask
): Promise<ProcessingResult> {
    const abortController = new AbortController();
    task.messagePort.on('message', (message: string) => {
        if (message === 'abort') {
            abortController.abort();
        }
    });
    const signal = abortController.signal;

    try {
        // Check for early cancellation
        if (signal.aborted) {
            throw new Error('Operation was cancelled');
        }

        // Ensure contextLength is provided
        if (!task.contextLength) {
            throw new Error('Context length must be provided');
        }

        // Initialize model if needed
        const pipe = await initializeModel(
            task.modelBasePath,
            task.modelName,
            task.contextLength,
            task.extensionPath,
            signal
        );

        // Check if operation was cancelled during initialization
        if (signal.aborted) {
            throw new Error('Operation was cancelled');
        }

        // Generate embeddings for the file content using our token-aware chunking
        const { embeddings, chunkOffsets } = await generateEmbeddings(
            task.content,
            task.filePath,
            pipe,
            task.options,
            signal
        );

        return {
            fileId: task.fileId,
            embeddings,
            chunkOffsets,
            success: true
        };
    } catch (error) {
        // Log the error unless it's a cancellation
        if (!(signal.aborted && error instanceof Error && error.message.includes('cancelled'))) {
            console.error('Error processing file:', error);
        }

        // Return error result
        return {
            fileId: task.fileId,
            embeddings: [],
            chunkOffsets: [],
            success: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}
