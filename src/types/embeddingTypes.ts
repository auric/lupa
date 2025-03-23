
/**
 * Options for embedding generation
 */
export interface EmbeddingOptions {
    pooling?: 'mean' | 'cls' | 'none';
    normalize?: boolean;
    overlapSize?: number;
}

export interface TokenEstimatorOptions {
    modelName: string;
    contextLength: number;
}

export interface ChunkingResult {
    chunks: string[];
    offsets: number[];
}

export interface CodeChunkingOptions {
    overlapSize?: number;
}

/**
 * Database-related interfaces
 */

/**
 * Represents a file in the embeddings database
 */
export interface FileRecord {
    id: string;
    path: string;
    hash: string;
    lastModified: number;
    language?: string;
    isIndexed: boolean;
    size: number;
}

/**
 * Represents a chunk of code from a file
 */
export interface ChunkRecord {
    id: string;
    fileId: string;
    content: string;
    startOffset: number;
    endOffset: number;
    tokenCount?: number;
}

/**
 * Represents an embedding vector for a chunk
 */
export interface EmbeddingRecord {
    id: string;
    chunkId: string;
    vector: Float32Array;
    model: string;
    dimension: number;
    createdAt: number;
}

/**
 * Options for similarity search
 */
export interface SimilaritySearchOptions {
    limit?: number;
    minScore?: number;
    fileFilter?: string[];
    languageFilter?: string[];
}

/**
 * Result of a similarity search
 */
export interface SimilaritySearchResult {
    chunkId: string;
    fileId: string;
    filePath: string;
    content: string;
    startOffset: number;
    endOffset: number;
    score: number;
}

/**
 * Database configuration options
 */
export interface DatabaseConfig {
    dbPath: string;
    maxConnections?: number;
    busyTimeout?: number;
    migrationsPath?: string;
}

/**
 * Storage statistics
 */
export interface StorageStats {
    fileCount: number;
    chunkCount: number;
    embeddingCount: number;
    databaseSizeBytes: number;
    lastIndexed: number | null;
    embeddingModel: string;
}

