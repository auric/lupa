import { pipeline } from '@huggingface/transformers';
import { Worker } from 'worker_threads';

// Define interfaces for clear typing
interface EmbeddingOptions {
    pooling?: 'mean' | 'cls' | 'none';
    normalize?: boolean;
    chunkSize?: number;
    overlapSize?: number;
}

interface ProcessFileTask {
    fileId: string;
    filePath: string;
    content: string;
    options?: EmbeddingOptions;
    modelName: string;
    signal?: AbortSignal;
}

interface ProcessingResult {
    fileId: string;
    embeddings: Float32Array[];
    chunkOffsets: number[];
    success: boolean;
    error?: string;
}

// Setup constants
const DEFAULT_CHUNK_SIZE = 4096; // Smaller than model's context length for safety
const DEFAULT_OVERLAP_SIZE = 200; // Overlap between chunks to maintain context

// Module-level state
const modelCache = new Map<string, any>();
const modelInitPromises = new Map<string, Promise<any>>();

/**
 * Initialize the model only once per model name
 */
async function getOrInitializeModel(modelName: string): Promise<any> {
    // Return cached pipeline if available
    if (modelCache.has(modelName)) {
        return modelCache.get(modelName);
    }

    // If initialization is in progress, wait for it
    if (modelInitPromises.has(modelName)) {
        return await modelInitPromises.get(modelName);
    }

    // Start new initialization
    const initPromise = initializeModel(modelName);
    modelInitPromises.set(modelName, initPromise);

    try {
        const model = await initPromise;
        // Cache the result
        modelCache.set(modelName, model);
        return model;
    } finally {
        // Clean up promise reference
        modelInitPromises.delete(modelName);
    }
}

/**
 * Initialize the embedding model
 */
async function initializeModel(modelName: string): Promise<any> {
    try {
        console.log(`Worker: Initializing model ${modelName}`);

        // Create the pipeline
        const embeddingPipeline = await pipeline('feature-extraction', modelName, {
            revision: 'main',
            dtype: 'q4'
        });

        if (!embeddingPipeline) {
            throw new Error(`Failed to initialize embedding pipeline for ${modelName}`);
        }

        console.log(`Worker: Model ${modelName} initialized successfully`);
        return embeddingPipeline;
    } catch (error) {
        console.error(`Worker: Failed to initialize model:`, error);
        throw error;
    }
}

/**
 * Split text into smaller chunks for processing
 */
function chunkText(text: string, chunkSize: number = DEFAULT_CHUNK_SIZE, overlapSize: number = DEFAULT_OVERLAP_SIZE): { chunks: string[], offsets: number[] } {
    const chunks: string[] = [];
    const offsets: number[] = [];

    if (text.length === 0) {
        return { chunks: [], offsets: [] };
    }

    let position = 0;

    while (position < text.length) {
        // Record the starting offset
        offsets.push(position);

        // Take a chunk of text
        let end = Math.min(position + chunkSize, text.length);

        // Try to end at a newline or punctuation if possible
        if (end < text.length) {
            const nearbyNewline = text.lastIndexOf('\n', end);
            const nearbyPeriod = text.lastIndexOf('.', end);
            const nearbyBreak = Math.max(nearbyNewline, nearbyPeriod);

            if (nearbyBreak > position && nearbyBreak > position + chunkSize - overlapSize) {
                end = nearbyBreak + 1; // Include the newline or period
            }
        }

        // Add the chunk to our list
        chunks.push(text.substring(position, end));

        // Move to next position with overlap
        const nextPosition = end - overlapSize;

        // Ensure we're making progress
        if (nextPosition <= position) {
            // If we're not making progress, move position by at least 1 character
            position = Math.min(end + 1, text.length);
        } else {
            position = nextPosition;
        }

        // Safety check - if we've reached the end, break out
        if (position >= text.length) {
            break;
        }
    }

    return { chunks, offsets };
}

/**
 * Generate embeddings for chunks of code
 */
async function generateEmbeddings(
    text: string,
    embeddingPipeline: any,
    options: EmbeddingOptions = {},
    signal?: AbortSignal
): Promise<{ embeddings: Float32Array[], chunkOffsets: number[] }> {
    // Use provided options or defaults
    const chunkSize = options.chunkSize || DEFAULT_CHUNK_SIZE;
    const overlapSize = options.overlapSize || DEFAULT_OVERLAP_SIZE;
    const poolingStrategy = options.pooling || 'mean';
    const shouldNormalize = options.normalize !== false; // Default to true if not specified

    // Split text into chunks
    const { chunks, offsets } = chunkText(text, chunkSize, overlapSize);

    // Generate embeddings for each chunk
    const embeddings: Float32Array[] = [];
    for (const chunk of chunks) {
        // Check for cancellation before processing each chunk
        if (signal?.aborted) {
            throw new Error('Operation was cancelled');
        }

        try {
            // Skip empty chunks
            if (chunk.trim().length === 0) {
                // Push an empty embedding for placeholding
                embeddings.push(new Float32Array(0));
                continue;
            }

            // Generate embedding for this chunk
            const output = await embeddingPipeline(chunk, {
                pooling: poolingStrategy,
                normalize: shouldNormalize
            });

            // Extract the embedding (usually in data property)
            const embedding = output.data;
            if (!(embedding instanceof Float32Array)) {
                throw new Error('Embedding output not in expected format');
            }

            embeddings.push(embedding);
        } catch (error) {
            if (signal?.aborted) {
                throw new Error('Operation was cancelled');
            }
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
export default async function processFile(task: ProcessFileTask): Promise<ProcessingResult> {
    try {
        // Get or initialize the model
        const embeddingPipeline = await getOrInitializeModel(task.modelName);

        // Check if operation was cancelled during model initialization
        if (task.signal?.aborted) {
            return {
                fileId: task.fileId,
                embeddings: [],
                chunkOffsets: [],
                success: false,
                error: 'Operation was cancelled'
            };
        }

        // Generate embeddings for the file content
        const { embeddings, chunkOffsets } = await generateEmbeddings(
            task.content,
            embeddingPipeline,
            task.options,
            task.signal
        );

        return {
            fileId: task.fileId,
            embeddings,
            chunkOffsets,
            success: true
        };
    } catch (error) {
        console.error('Error processing file:', error);

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
