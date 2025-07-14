import * as vscode from 'vscode';
import type { ProcessingResult } from '../types/indexingTypes';
import type { SimilaritySearchOptions, SimilaritySearchResult } from '../types/embeddingTypes';

/**
 * Interface for embedding storage operations
 * This breaks the circular dependency between IndexingManager and EmbeddingDatabaseAdapter
 */
export interface IEmbeddingStorage {
    /**
     * Store a single file's embedding results
     */
    storeEmbeddingResult(
        file: { id: string, path: string, content: string },
        result: ProcessingResult
    ): Promise<boolean>;

    /**
     * Find relevant code context for analysis
     */
    findRelevantCodeContext(
        diff: string,
        options?: SimilaritySearchOptions,
        progressCallback?: (processed: number, total: number) => void
    ): Promise<SimilaritySearchResult[]>;

    /**
     * Generate embeddings for text content
     */
    generateEmbeddings(
        texts: string[],
        progressCallback?: (processed: number, total: number) => void,
        token?: vscode.CancellationToken
    ): Promise<Map<string, number[]>>;

    /**
     * Check if a file needs reindexing
     */
    needsReindexing(filePath: string, content: string): Promise<boolean>;

    /**
     * Get storage statistics
     */
    getStorageStats(): Promise<string>;

    /**
     * Optimize storage for performance
     */
    optimizeStorage(): void;
}