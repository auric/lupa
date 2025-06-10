import {
    pipeline,
    env as transformersEnv,
    type FeatureExtractionPipeline,
    type Tensor
} from '@huggingface/transformers';
import { type EmbeddingOptions } from '../types/embeddingTypes';
import { Mutex } from 'async-mutex';
import MutexInterface from 'async-mutex/lib/MutexInterface';

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
    embedding: Float32Array | null;
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

    //const release = await pipelineMutex.acquire();
    try {
        // Double-check after acquiring the lock
        if (pipelineInstance && currentModelName === modelName) {
            return pipelineInstance;
        }

        // If a previous pipeline exists for a different model, dispose it
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
export default async function processEmbeddingTask(
    taskData: EmbeddingTaskData
): Promise<EmbeddingTaskResult> {
    let release: MutexInterface.Releaser | null = null;
    let pipe: FeatureExtractionPipeline | null = null;
    let outputTensor: Tensor | null = null;
    console.log('EmbeddingWorker: Processing task for chunk:', taskData.chunkText.substring(0, 100));
    try {
        if (!taskData.chunkText || taskData.chunkText.trim().length === 0) {
            return { embedding: new Float32Array(0) }; // Handle empty chunks
        }

        pipe = await getPipeline(taskData.modelName, taskData.modelBasePath);
        // release = await pipeMutex.acquire();
        outputTensor = await pipe(taskData.chunkText, {
            pooling: taskData.embeddingOptions.pooling || 'mean',
            normalize: taskData.embeddingOptions.normalize !== false, // Default to true
        }) as Tensor;
        // release();
        release = null;

        if (!(outputTensor.data instanceof Float32Array)) {
            throw new Error('Embedding output is not a Float32Array');
        }
        // Return a copy of the data to ensure the tensor can be disposed.
        return { embedding: new Float32Array(outputTensor.data) };
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
        // if (release) {
        //     release();
        // }
        // Note: The pipeline itself is cached and reused, not disposed after each task.
        // It can be disposed if the model changes or when the worker pool is destroyed.
    }
};