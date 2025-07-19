import { ChunkingMetadata } from './embeddingTypes';

/**
 * Interface representing a file to be processed
 */
export interface FileToProcess {
    /**
     * Unique identifier for the file.
     */
    id: string;

    /**
     * The path to the file in the file system.
     */
    path: string;

    /**
     * The content of the file as a string.
     */
    content: string;

    /**
     * The priority of the file for processing.
     * Higher numbers indicate higher priority.
     */
    priority?: number;
}

/**
 * Processing result from a single file
 */
export interface ProcessingResult {
    fileId: string;
    filePath: string;
    embeddings: number[][];
    chunkOffsets: number[];
    metadata: ChunkingMetadata;
    success: boolean;
    error?: string;
}

export interface ChunkForEmbedding {
    fileId: string;
    filePath: string;
    chunkIndexInFile: number;
    text: string;
    offsetInFile: number;
}

export interface EmbeddingGenerationOutput {
    originalChunkInfo: ChunkForEmbedding;
    embedding: number[] | null;
    error?: string;
}
