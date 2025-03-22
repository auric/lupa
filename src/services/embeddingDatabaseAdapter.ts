import * as vscode from 'vscode';
import { hash } from 'crypto';
import { VectorDatabaseService } from './vectorDatabaseService';
import { WorkspaceSettingsService } from './workspaceSettingsService';
import { IndexingService } from './indexingService';
import { ProcessingResult } from '../workers/indexingWorker';
import { SimilaritySearchOptions, SimilaritySearchResult } from '../types/embeddingTypes';

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
            const initialResults = await this.vectorDb.findSimilarCode(
                diffEmbedding,
                this.embeddingModel,
                options
            );

            // Return empty results if nothing found
            if (initialResults.length === 0) {
                return [];
            }

            // Enhance results with complete code structures
            const enhancedResults: SimilaritySearchResult[] = [];

            // Process each result to get complete code structures where possible
            for (const result of initialResults) {
                try {
                    // Try to find a complete structure containing this chunk
                    const completeStructure = await this.vectorDb.getCompleteStructureForChunk(result.chunkId);

                    if (completeStructure) {
                        // Use the complete structure instead of the fragment
                        enhancedResults.push({
                            ...result,
                            content: completeStructure.content,
                            startOffset: completeStructure.startOffset,
                            endOffset: completeStructure.endOffset,
                            chunkId: completeStructure.id,
                            // Preserve the original score but add a small boost for complete structures
                            score: Math.min(1.0, result.score * 1.05)
                        });
                    } else {
                        // If no complete structure found, try to get adjacent chunks
                        const adjacentChunks = await this.vectorDb.getAdjacentChunks(result.chunkId);

                        if (adjacentChunks.length > 0) {
                            // Join the adjacent chunks into a larger context
                            // Sort by start offset to ensure correct order
                            const allChunks = [result, ...adjacentChunks.map(chunk => ({
                                chunkId: chunk.id,
                                fileId: chunk.fileId,
                                filePath: result.filePath,
                                content: chunk.content,
                                startOffset: chunk.startOffset,
                                endOffset: chunk.endOffset,
                                score: result.score * 0.9 // Slightly lower score for adjacent chunks
                            }))].sort((a, b) => a.startOffset - b.startOffset);

                            // Combine chunks into a single context
                            const combinedContent = allChunks.map(c => c.content).join('\n// ...\n');

                            enhancedResults.push({
                                ...result,
                                content: combinedContent,
                                startOffset: allChunks[0].startOffset,
                                endOffset: allChunks[allChunks.length - 1].endOffset
                            });
                        } else {
                            // No adjacent chunks, keep the original result
                            enhancedResults.push(result);
                        }
                    }
                } catch (error) {
                    console.error(`Error enhancing result for chunk ${result.chunkId}:`, error);
                    // Include the original result if enhancement fails
                    enhancedResults.push(result);
                }
            }

            // Remove any duplicate content which might have been introduced
            // through the structure completion process
            const uniqueResults = this.removeDuplicateResults(enhancedResults);

            // Resort by score since we might have adjusted scores during enhancement
            return uniqueResults.sort((a, b) => b.score - a.score);
        } catch (error) {
            console.error('Error finding relevant code context:', error);
            return [];
        }
    }

    /**
     * Remove duplicate results based on content overlap
     * @param results Array of search results that might contain duplicates
     * @returns Deduplicated results array
     */
    private removeDuplicateResults(results: SimilaritySearchResult[]): SimilaritySearchResult[] {
        const unique: SimilaritySearchResult[] = [];
        const seen = new Set<string>();

        for (const result of results) {
            // Create a key based on file path and content hash
            const contentHash = this.quickHash(result.content);
            const key = `${result.filePath}:${contentHash}`;

            // Skip if we've already seen this content
            if (seen.has(key)) {
                continue;
            }

            // Otherwise, mark as seen and add to unique results
            seen.add(key);
            unique.push(result);
        }

        return unique;
    }

    /**
     * Generate a simple hash for deduplication purposes
     * @param content Content to hash
     * @returns Simple hash value
     */
    private quickHash(content: string): number {
        let hash = 0;
        if (content.length === 0) return hash;

        for (let i = 0; i < content.length; i++) {
            const char = content.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32bit integer
        }

        return hash;
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