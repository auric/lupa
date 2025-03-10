import * as vscode from 'vscode';
import { hash } from 'crypto';
import { VectorDatabaseService } from './vectorDatabaseService';
import { WorkspaceSettingsService } from './workspaceSettingsService';
import { IndexingService } from './indexingService';
import { ProcessingResult } from '../workers/indexingWorker';
import { SimilaritySearchOptions, SimilaritySearchResult } from '../models/types';

/**
 * EmbeddingDatabaseAdapter provides high-level operations to integrate
 * the VectorDatabaseService with the IndexingService and PR analysis workflow
 */
export class EmbeddingDatabaseAdapter implements vscode.Disposable {
    private static instance: EmbeddingDatabaseAdapter | null = null;
    private embeddingModel: string;

    /**
     * Get singleton instance of EmbeddingDatabaseAdapter
     */
    public static getInstance(
        context: vscode.ExtensionContext,
        vectorDb: VectorDatabaseService,
        settings: WorkspaceSettingsService,
        indexingService: IndexingService
    ): EmbeddingDatabaseAdapter {
        if (!this.instance) {
            this.instance = new EmbeddingDatabaseAdapter(context, vectorDb, settings, indexingService);
        } else if (this.instance.indexingService !== indexingService) {
            // Update the instance if the indexing service has changed
            this.instance.updateIndexingService(indexingService);
        }
        return this.instance;
    }

    /**
     * Private constructor (use getInstance)
     */
    private constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly vectorDb: VectorDatabaseService,
        private readonly settings: WorkspaceSettingsService,
        private indexingService: IndexingService
    ) {
        // Get the model name from indexing service
        this.embeddingModel = indexingService.getModelName();

        // Update database metadata with the current model name
        this.vectorDb.setEmbeddingModel(this.embeddingModel);
    }

    /**
     * Update the indexing service when it changes (e.g., when model is changed)
     * This ensures we're always using the latest model configuration
     */
    private updateIndexingService(indexingService: IndexingService): void {
        this.indexingService = indexingService;

        // Update model name from the new indexing service
        const newModel = indexingService.getModelName();
        if (this.embeddingModel !== newModel) {
            this.embeddingModel = newModel;
            this.vectorDb.setEmbeddingModel(newModel);
            console.log(`Updated embedding model to ${newModel} from IndexingService`);
        }
    }

    /**
     * Store embeddings results from the IndexingService
     * @param files List of files that were processed
     * @param results Map of file IDs to embedding results
     */
    async storeEmbeddingResults(
        files: Array<{ id: string, path: string, content: string }>,
        results: Map<string, ProcessingResult>
    ): Promise<void> {
        console.log(`Storing embeddings for ${files.length} files`);

        for (const file of files) {
            try {
                // Get the processing result for this file
                const result = results.get(file.id);
                if (!result || !result.success) {
                    console.log(`Skipping file ${file.path} - no valid embeddings`);
                    continue;
                }

                // Store file record
                const fileRecord = await this.vectorDb.storeFile(file.path, file.content);

                // Store chunks
                if (result.chunkOffsets.length > 0) {
                    // Extract chunks from the file content based on offsets
                    const chunks: string[] = [];
                    for (let i = 0; i < result.chunkOffsets.length; i++) {
                        const startOffset = result.chunkOffsets[i];
                        const endOffset = i < result.chunkOffsets.length - 1
                            ? result.chunkOffsets[i + 1]
                            : file.content.length;

                        chunks.push(file.content.substring(startOffset, endOffset));
                    }

                    // Store chunks with their offsets
                    const chunkRecords = await this.vectorDb.storeChunks(
                        fileRecord.id,
                        chunks,
                        result.chunkOffsets
                    );

                    // Store embeddings
                    if (result.embeddings.length === chunkRecords.length) {
                        this.vectorDb.storeEmbeddings(
                            chunkRecords.map((chunk, index) => ({
                                chunkId: chunk.id,
                                vector: result.embeddings[index],
                                model: this.embeddingModel,
                                dimension: result.embeddings[index].length
                            }))
                        );
                    } else {
                        console.error(`Mismatch between chunks (${chunkRecords.length}) and embeddings (${result.embeddings.length}) for file ${file.path}`);
                    }
                }

                // Mark file as indexed
                this.vectorDb.markFileAsIndexed(fileRecord.id);

            } catch (error) {
                console.error(`Error storing embeddings for file ${file.path}:`, error);
            }
        }

        // Update database metadata
        this.vectorDb.updateLastIndexingTimestamp();
        this.vectorDb.setEmbeddingModel(this.embeddingModel);
    }

    /**
     * Find relevant code context for a diff or PR
     * @param diff The PR diff text or relevant code snippet
     * @param options Search options
     * @returns Relevant code snippets with similarity scores
     */
    async findRelevantCodeContext(
        diff: string,
        options?: SimilaritySearchOptions
    ): Promise<SimilaritySearchResult[]> {
        try {
            // Generate embedding for the diff using the IndexingService
            const diffEmbedding = await this.generateEmbedding(diff);
            if (!diffEmbedding) {
                console.error('Failed to generate embedding for diff');
                return [];
            }

            // Find similar code using the vector database
            return await this.vectorDb.findSimilarCode(
                diffEmbedding,
                this.embeddingModel,
                options
            );
        } catch (error) {
            console.error('Error finding relevant code context:', error);
            return [];
        }
    }

    /**
     * Generate an embedding vector for text content using the indexingService
     * This ensures we only have one instance of the embedding model loaded
     * @param text The text to generate an embedding for
     * @returns A float32 embedding vector or null if generation fails
     */
    async generateEmbedding(text: string): Promise<Float32Array | null> {
        try {
            // Create a temporary ID for this embedding generation
            const tempFileId = `temp-embed-${Date.now()}`;
            const fileToProcess = {
                id: tempFileId,
                path: 'memory://temp.txt',
                content: text,
                priority: 0 // Low priority
            };

            // Process the text to get embeddings
            const results = await this.indexingService.processFiles([fileToProcess]);
            const result = results.get(tempFileId);

            if (result && result.success && result.embeddings.length > 0) {
                return result.embeddings[0];
            }

            return null;
        } catch (error) {
            console.error('Error generating embedding via IndexingService:', error);
            return null;
        }
    }

    /**
     * Set the embedding model - this should be called when the model changes
     * @param modelName Name of the model
     */
    setEmbeddingModel(modelName: string): void {
        if (this.embeddingModel !== modelName) {
            this.embeddingModel = modelName;

            // Update in database
            this.vectorDb.setEmbeddingModel(modelName);

            console.log(`Set embedding model to ${modelName}`);
        }
    }

    /**
     * Check if a file needs reindexing
     * @param filePath Path to the file
     * @param content Current file content
     * @returns True if the file needs reindexing
     */
    async needsReindexing(filePath: string, content: string): Promise<boolean> {
        try {
            // Get the file record
            const fileRecord = await this.vectorDb.getFileByPath(filePath);

            // If file doesn't exist in database, it needs indexing
            if (!fileRecord) {
                return true;
            }

            // If file is not marked as indexed, it needs indexing
            if (!fileRecord.isIndexed) {
                return true;
            }

            // Check if content has changed by comparing hash
            const newHash = await this.getContentHash(content);
            return newHash !== fileRecord.hash;

        } catch (error) {
            console.error(`Error checking if file needs reindexing: ${filePath}`, error);
            // When in doubt, reindex
            return true;
        }
    }

    /**
     * Calculate a hash for file content
     * @param content File content
     * @returns SHA-256 hash
     */
    private async getContentHash(content: string): Promise<string> {
        return await hash('sha256', content, 'hex');
    }

    /**
     * Get database storage statistics
     * @returns Formatted statistics as a string
     */
    async getStorageStats(): Promise<string> {
        const stats = await this.vectorDb.getStorageStats();

        const formatSize = (bytes: number): string => {
            if (bytes < 1024) return `${bytes} bytes`;
            if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
            return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
        };

        const lastIndexedDate = stats.lastIndexed
            ? new Date(stats.lastIndexed).toLocaleString()
            : 'Never';

        return [
            `Files indexed: ${stats.fileCount}`,
            `Code chunks: ${stats.chunkCount}`,
            `Embeddings: ${stats.embeddingCount}`,
            `Database size: ${formatSize(stats.databaseSizeBytes)}`,
            `Last indexed: ${lastIndexedDate}`,
            `Embedding model: ${stats.embeddingModel}`,
            `Current model: ${this.embeddingModel}`
        ].join('\n');
    }

    /**
     * Optimize the database for best performance
     */
    optimizeStorage(): void {
        this.vectorDb.optimizeDatabase();
    }

    /**
     * Dispose resources
     */
    dispose(): void {
        // Clear singleton instance
        if (EmbeddingDatabaseAdapter.instance === this) {
            EmbeddingDatabaseAdapter.instance = null;
        }
    }
}