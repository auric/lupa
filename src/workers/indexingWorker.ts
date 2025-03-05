import { parentPort } from 'worker_threads';
import { pipeline, env } from '@huggingface/transformers';

// Define message types for worker communication
interface WorkerInitMessage {
    type: 'initialize';
    modelName: string;
}

interface WorkerProcessMessage {
    type: 'process';
    fileId: string;
    filePath: string;
    content: string;
    options?: {
        pooling?: 'mean' | 'cls' | 'none';
        normalize?: boolean;
        chunkSize?: number;
        overlapSize?: number;
    };
}

interface WorkerResultMessage {
    type: 'result';
    fileId: string;
    embeddings?: Float32Array[];
    chunkOffsets?: number[];
    success: boolean;
    error?: string;
}

interface WorkerStatusMessage {
    type: 'status';
    status: 'idle' | 'busy' | 'ready' | 'error';
    modelName?: string;
    error?: string;
}

type WorkerMessage = WorkerInitMessage | WorkerProcessMessage;
type WorkerResponseMessage = WorkerResultMessage | WorkerStatusMessage;

// Setup constants
const DEFAULT_CHUNK_SIZE = 4096; // Smaller than model's context length for safety
const DEFAULT_OVERLAP_SIZE = 200; // Overlap between chunks to maintain context

// Worker global state
let embeddingPipeline: any = null;
let currentModelName: string = '';
let isInitializing: boolean = false;
let initializationPromise: Promise<void> | null = null;

/**
 * Safely initialize the embedding model with mutex-like pattern
 * to prevent multiple simultaneous initializations
 */
async function initializeModel(message: WorkerInitMessage): Promise<void> {
    // If already initialized with the same model, return immediately
    if (embeddingPipeline && currentModelName === message.modelName) {
        sendMessage({
            type: 'status',
            status: 'ready',
            modelName: currentModelName
        });
        return;
    }

    // If initialization is already in progress, wait for it
    if (isInitializing && initializationPromise) {
        await initializationPromise;
        return;
    }

    // Set initializing flag and create promise
    isInitializing = true;
    initializationPromise = _initializeModel(message);

    try {
        await initializationPromise;
    } finally {
        isInitializing = false;
        initializationPromise = null;
    }
}

/**
 * Actual implementation of model initialization
 */
async function _initializeModel(message: WorkerInitMessage): Promise<void> {
    try {
        // Update status to initializing
        sendMessage({
            type: 'status',
            status: 'busy',
            modelName: message.modelName
        });

        console.log(`Worker: Initializing model ${message.modelName}`);

        // Create the pipeline - this will load the model
        embeddingPipeline = await pipeline('feature-extraction', message.modelName, {
            revision: 'main',
            dtype: 'q4'
        });

        if (!embeddingPipeline) {
            throw new Error(`Failed to initialize embedding pipeline for ${message.modelName}`);
        }

        // Store the current model name
        currentModelName = message.modelName;

        // Send ready status message
        sendMessage({
            type: 'status',
            status: 'ready',
            modelName: message.modelName
        });

        // Also send idle status to indicate we're ready for work
        sendMessage({
            type: 'status',
            status: 'idle'
        });

        console.log(`Worker: Model ${message.modelName} initialized successfully`);
    } catch (error) {
        console.error(`Worker: Failed to initialize model:`, error);

        // Send error status
        sendMessage({
            type: 'status',
            status: 'error',
            error: error instanceof Error ? error.message : String(error)
        });

        // Rethrow to ensure worker terminates
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
async function generateEmbeddings(text: string, options: WorkerProcessMessage['options'] = {}): Promise<{ embeddings: Float32Array[], chunkOffsets: number[] }> {
    if (!embeddingPipeline) {
        throw new Error('Embedding model not initialized');
    }

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
 * Process a file and generate embeddings
 */
async function processFile(message: WorkerProcessMessage): Promise<void> {
    // Make sure we're in idle state at start
    sendMessage({
        type: 'status',
        status: 'busy'
    });

    try {
        // Generate embeddings for the file content
        const { embeddings, chunkOffsets } = await generateEmbeddings(message.content, message.options);

        // Send result back to main thread
        sendMessage({
            type: 'result',
            fileId: message.fileId,
            embeddings,
            chunkOffsets,
            success: true
        });

        // Update status back to idle
        sendMessage({
            type: 'status',
            status: 'idle'
        });
    } catch (error) {
        console.error('Error processing file:', error);

        // Send error result
        sendMessage({
            type: 'result',
            fileId: message.fileId,
            success: false,
            error: error instanceof Error ? error.message : String(error)
        });

        // Update status to error but still set idle so we can get more work
        sendMessage({
            type: 'status',
            status: 'error',
            error: error instanceof Error ? error.message : String(error)
        });

        sendMessage({
            type: 'status',
            status: 'idle'
        });
    }
}

/**
 * Send message back to main thread
 */
function sendMessage(message: WorkerResponseMessage): void {
    if (parentPort) {
        parentPort.postMessage(message);
    } else {
        console.error('No parent port available to send message');
    }
}

// Set up message handling
parentPort?.on('message', async (message: WorkerMessage) => {
    try {
        if (!message || !message.type) {
            throw new Error('Invalid message format');
        }

        switch (message.type) {
            case 'initialize':
                await initializeModel(message);
                break;

            case 'process':
                await processFile(message);
                break;

            default:
                console.warn('Unknown message type:', (message as any).type);
        }
    } catch (error) {
        console.error('Error handling message:', error);

        // Send error status
        sendMessage({
            type: 'status',
            status: 'error',
            error: error instanceof Error ? error.message : String(error)
        });

        // Still set to idle so we can receive more work
        sendMessage({
            type: 'status',
            status: 'idle'
        });
    }
});
