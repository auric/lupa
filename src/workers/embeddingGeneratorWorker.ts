import {
    pipeline,
    env as transformersEnv,
    type FeatureExtractionPipeline,
    type Tensor
} from '@huggingface/transformers';
import { type EmbeddingOptions } from '../types/embeddingTypes';

/**
 * Task data for the embedding generator worker
 */
export interface EmbeddingTaskData {
    chunkText: string;
    modelName: string;
    modelBasePath: string;
    embeddingOptions: EmbeddingOptions;
}

/**
 * Result from the embedding generator worker
 */
export interface EmbeddingTaskResult {
    embedding: number[] | null;
    error?: string;
}

// Configure Hugging Face Transformers environment
transformersEnv.allowRemoteModels = false;
transformersEnv.allowLocalModels = true;
transformersEnv.useFS = true; // Ensure file system is used for model loading

// Global instance for worker reuse & pipeline caching
let pipelineInstance: FeatureExtractionPipeline | null = null;
let currentModelName: string | null = null;
// const pipelineMutex = new Mutex();
// const pipeMutex = new Mutex();

/**
 * Initializes or retrieves a cached feature-extraction pipeline.
 * Uses a mutex to prevent race conditions during initialization.
 */
async function getPipeline(
    modelName: string,
    modelBasePath: string
): Promise<FeatureExtractionPipeline> {
    if (pipelineInstance && currentModelName === modelName) {
        return pipelineInstance;
    }

    try {
        if (pipelineInstance) {
            try {
                await pipelineInstance.dispose();
            } catch (e) {
                console.warn('Error disposing old pipeline:', e);
            }
        }

        transformersEnv.allowRemoteModels = false;
        transformersEnv.allowLocalModels = true;
        transformersEnv.localModelPath = modelBasePath;
        transformersEnv.cacheDir = modelBasePath;
        transformersEnv.useFS = true;

        console.log(`EmbeddingWorker: Initializing pipeline for ${modelName} from ${modelBasePath}`);
        pipelineInstance = await pipeline('feature-extraction', modelName, {
            dtype: 'q4'
        }) as unknown as FeatureExtractionPipeline;
        currentModelName = modelName;
        console.log(`EmbeddingWorker: Pipeline for ${modelName} initialized.`);
        return pipelineInstance;
    } catch (error) {
        console.error(`EmbeddingWorker: Failed to initialize pipeline for ${modelName}:`, error);
        pipelineInstance = null; // Reset on failure
        currentModelName = null;
        throw error; // Re-throw to be caught by the main worker function
    } finally {
        // release();
    }
}

/**
 * Piscina worker function for generating embeddings for a single text chunk.
 */
export async function processEmbeddingTask(
    taskData: EmbeddingTaskData
): Promise<EmbeddingTaskResult> {
    let outputTensor: Tensor | null = null;
    try {
        if (!taskData.chunkText || taskData.chunkText.trim().length === 0) {
            return { embedding: null, error: 'Chunk text is empty or invalid' };
        }

        const pipe = await getPipeline(taskData.modelName, taskData.modelBasePath);
        outputTensor = await pipe(taskData.chunkText, {
            pooling: taskData.embeddingOptions.pooling || 'mean',
            normalize: taskData.embeddingOptions.normalize !== false,
        });

        if (!(outputTensor.data instanceof Float32Array)) {
            throw new Error('Embedding output is not a Float32Array');
        }

        if (outputTensor.data.length === 0) {
            console.warn('EmbeddingWorker: Received empty embedding for chunk:', taskData.chunkText.substring(0, 100));
            return { embedding: null, error: 'Received empty embedding' };
        }

        return { embedding: Array.from(outputTensor.data) };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error('EmbeddingWorker: Error generating embedding for chunk:', errorMessage, taskData.chunkText.substring(0, 100));
        return { embedding: null, error: errorMessage };
    } finally {
        if (outputTensor) {
            try {
                outputTensor.dispose();
            } catch (e) {
                console.warn('EmbeddingWorker: Error disposing output tensor:', e);
            }
        }
    }
};