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

/**
 * Metadata about code structures and their chunking
 */
export interface ChunkingMetadata {
    parentStructureIds: (string | null)[];  // Links chunks from split structures
    structureOrders: (number | null)[];     // Order within split structures
    isOversizedFlags: (boolean | null)[];   // Marks chunks that exceed strict limits
    structureTypes: (string | null)[];      // Optional: e.g., 'function', 'class'
}

/**
 * Extended result from chunking, including metadata for split structures
 */
export interface DetailedChunkingResult extends ChunkingResult {
    metadata: ChunkingMetadata;
}

export interface StructureAwareChunkingResult {
    chunks: string[];
    metadata: {
        offsets: number[];
        parentStructureIds: string[];
        structureOrders: number[];
        isOversizedFlags: boolean[];
        structureTypes: string[];
    };
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
    // Structure metadata fields
    parentStructureId?: string | null;  // Matches DB schema: parent_structure_id TEXT
    structureOrder?: number | null;     // Matches DB schema: structure_order INTEGER
    isOversized?: boolean | null;       // Matches DB schema: is_oversized BOOLEAN
    structureType?: string | null;      // Matches DB schema: structure_type TEXT
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
