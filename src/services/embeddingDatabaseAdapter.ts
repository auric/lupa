import * as vscode from 'vscode';
import { hash } from 'crypto';
import { VectorDatabaseService } from './vectorDatabaseService';
import { WorkspaceSettingsService } from './workspaceSettingsService';
import { IndexingService } from './indexingService';
import { IEmbeddingStorage } from '../interfaces/embeddingStorage';
import type { ProcessingResult } from '../types/indexingTypes';
import { SimilaritySearchOptions, SimilaritySearchResult } from '../types/embeddingTypes';
import { Log } from './loggingService';
import { quickHash } from '../lib/hashUtils';

/**
 * EmbeddingDatabaseAdapter provides high-level operations to integrate
 * the VectorDatabaseService with the IndexingService and PR analysis workflow
 */
export class EmbeddingDatabaseAdapter implements IEmbeddingStorage, vscode.Disposable {
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
            Log.info(`Updated embedding model to ${newModel} from IndexingService`);
        }
    }

    /**
     * Store a single file's embedding results
     * @param file File that was processed
     * @param result Processing result for the file
     * @returns Promise that resolves when the file is stored
     */
    async storeEmbeddingResult(
        file: { id: string, path: string, content: string },
        result: ProcessingResult
    ): Promise<boolean> {
        try {
            // Skip if no valid embeddings
            if (!result || !result.success) {
                Log.info(`Skipping file ${file.path} - no valid embeddings`);
                return false;
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

                // Store chunks with their offsets and metadata
                const chunkRecords = await this.vectorDb.storeChunks(
                    fileRecord.id,
                    chunks,
                    result.chunkOffsets,
                    result.metadata
                );

                // Store embeddings
                if (result.embeddings.length === chunkRecords.length) {
                    await this.vectorDb.storeEmbeddings(
                        chunkRecords.map((chunk, index) => ({
                            chunkId: chunk.id,
                            vector: result.embeddings[index]
                        }))
                    );
                } else {
                    Log.error(`Mismatch between chunks (${chunkRecords.length}) and embeddings (${result.embeddings.length}) for file ${file.path}`);
                    return false;
                }
            }

            // Mark file as indexed
            await this.vectorDb.markFileAsIndexed(fileRecord.id);
            return true;

        } catch (error) {
            Log.error(`Error storing embeddings for file ${file.path}:`, error);
            return false;
        }
    }

    /**
     * Store embeddings results from the IndexingService
     * @param files List of files that were processed
     * @param results Map of file IDs to embedding results
     * @param progressCallback Optional callback for progress updates
     */
    async storeEmbeddingResults(
        files: Array<{ id: string, path: string, content: string }>,
        results: Map<string, ProcessingResult>,
        progressCallback?: (processed: number, total: number) => void
    ): Promise<void> {
        Log.info(`Storing embeddings for ${files.length} files`);

        let processedCount = 0;
        const totalFiles = files.length;

        // Process files in parallel with a concurrency limit
        const concurrencyLimit = 5; // Process up to 5 files at once

        // Process files in batches to maintain concurrency control
        for (let i = 0; i < files.length; i += concurrencyLimit) {
            const batch = files.slice(i, i + concurrencyLimit);

            // Process the batch concurrently
            const batchPromises = batch.map(async (file) => {
                const result = results.get(file.id);
                if (!result) {
                    Log.info(`No result found for file ${file.path}`);
                    processedCount++;
                    if (progressCallback) {
                        progressCallback(processedCount, totalFiles);
                    }
                    return false;
                }

                const success = await this.storeEmbeddingResult(file, result);

                // Update progress
                processedCount++;
                if (progressCallback) {
                    progressCallback(processedCount, totalFiles);
                }

                return success;
            });

            // Wait for the current batch to complete
            await Promise.all(batchPromises);
        }

        // Update database metadata
        this.vectorDb.updateLastIndexingTimestamp();
        // this.vectorDb.setEmbeddingModel(this.embeddingModel); // Model is set when it changes
    }

    /**
     * Find relevant code context for a diff or PR
     * @param diff The PR diff text or relevant code snippet
     * @param options Search options
     * @param progressCallback Optional callback for progress updates
     * @returns Relevant code snippets with similarity scores
     */
    async findRelevantCodeContext(
        diff: string,
        options?: SimilaritySearchOptions,
        progressCallback?: (processed: number, total: number) => void
    ): Promise<SimilaritySearchResult[]> {
        try {
            // Generate embedding for the diff using the batch method with a single item
            const embeddingsMap = await this.generateEmbeddings([diff], progressCallback);
            const entries = Array.from(embeddingsMap.entries());

            if (entries.length === 0 || !entries[0][1]) {
                Log.error('Failed to generate embedding for diff');
                return [];
            }

            const diffEmbedding = entries[0][1];

            // Find similar code using the vector database
            const initialResults = await this.vectorDb.findSimilarCode(
                diffEmbedding,
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
                    const structureChunks = await this.vectorDb.getCompleteStructureForChunk(result.chunkId);

                    if (structureChunks && structureChunks.length > 0) {
                        // Sort the chunks by structure order if they're part of a split structure
                        structureChunks.sort((a, b) => {
                            return (a.structureOrder ?? 0) - (b.structureOrder ?? 0);
                        });

                        // Combine all chunks into a single content
                        const combinedContent = structureChunks.map(chunk => chunk.content).join('\n');
                        const firstChunk = structureChunks[0];
                        const lastChunk = structureChunks[structureChunks.length - 1];

                        // Use the complete structure instead of the fragment
                        enhancedResults.push({
                            ...result,
                            content: combinedContent,
                            startOffset: firstChunk.startOffset,
                            endOffset: lastChunk.endOffset,
                            chunkId: firstChunk.id,
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
                    Log.error(`Error enhancing result for chunk ${result.chunkId}:`, error);
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
            Log.error('Error finding relevant code context:', error);
            return [];
        }
    }

    /**
     * Generate embedding vectors for multiple text chunks at once
     * This ensures we only have one call to processFiles for all chunks
     * @param texts Array of text chunks to generate embeddings for
     * @param progressCallback Optional callback for progress updates
     * @param token Optional cancellation token
     * @returns Map of chunk IDs to embedding vectors
     */
    async generateEmbeddings(
        texts: string[],
        progressCallback?: (processed: number, total: number) => void,
        token?: vscode.CancellationToken
    ): Promise<Map<string, number[]>> {
        try {
            // Check for cancellation
            if (token?.isCancellationRequested) {
                throw new Error('Operation cancelled');
            }

            if (texts.length === 0) {
                return new Map();
            }

            const fileIdToOriginalIndex = new Map<string, number>();
            // Create temporary files for each text chunk
            const filesToProcess = texts.map((text, index) => {
                const tempFileId = `temp-embed-batch-${Date.now()}-${index}-${Math.random().toString(36).substring(7)}`;
                fileIdToOriginalIndex.set(tempFileId, index);
                return {
                    id: tempFileId,
                    path: `memory://temp-${index}.txt`, // Path is mostly for logging/debugging in IndexingService
                    content: text,
                    priority: 0, // Low priority for ad-hoc embeddings
                };
            });

            const embeddings = new Map<string, number[]>();
            let processedCount = 0;
            const totalToProcess = filesToProcess.length;

            // Process files one by one using the new single-file API
            for (const file of filesToProcess) {
                if (token?.isCancellationRequested) {
                    throw new Error('Operation cancelled during embedding generation');
                }

                try {
                    const result = await this.indexingService.processFile(file, token);
                    const originalIndex = fileIdToOriginalIndex.get(result.fileId);

                    if (originalIndex !== undefined) {
                        const originalText = texts[originalIndex];
                        if (result.success && result.embeddings.length > 0) {
                            // Use the first embedding if multiple chunks were created from the text
                            embeddings.set(originalText, result.embeddings[0]);
                        } else if (!result.success) {
                            Log.warn(`Failed to generate embedding for text (index ${originalIndex}): ${result.error || 'Unknown error'}`);
                        }
                    } else {
                        Log.warn(`Received embedding result for unknown fileId: ${result.fileId}`);
                    }
                } catch (error) {
                    if (token?.isCancellationRequested) {
                        throw new Error('Operation cancelled during embedding generation');
                    }
                    const originalIndex = fileIdToOriginalIndex.get(file.id);
                    Log.error(`Error processing temporary file for embedding (index ${originalIndex}):`, error);
                    // Continue with next file rather than failing the entire batch
                }

                processedCount++;
                if (progressCallback) {
                    progressCallback(processedCount, totalToProcess);
                }
            }

            // Final check for cancellation after loop, in case the generator finished early due to cancellation
            if (token?.isCancellationRequested) {
                throw new Error('Operation cancelled');
            }

            return embeddings;
        } catch (error) {
            // Explicitly check for cancellation and rethrow
            if (token?.isCancellationRequested && !(error instanceof Error && error.message.includes('cancel'))) {
                throw new Error('Operation cancelled');
            }
            Log.error('Error generating embeddings via IndexingService:', error);
            throw error; // Rethrow the error instead of returning an empty map
        }
    }

    /**
     * Find relevant code context for multiple chunks at once
     * @param chunks The code chunks to find context for
     * @param options Optional search options
     * @param progressCallback Optional callback for progress updates
     * @param token Optional cancellation token
     * @returns Array of similarity search results
     */
    async findRelevantCodeContextForChunks(
        chunks: string[],
        options?: SimilaritySearchOptions,
        progressCallback?: (processed: number, total: number) => void,
        token?: vscode.CancellationToken
    ): Promise<SimilaritySearchResult[]> {
        if (chunks.length === 0) {
            return [];
        }

        try {
            // Check for cancellation
            if (token?.isCancellationRequested) {
                throw new Error('Operation cancelled');
            }

            Log.info(`Finding relevant code context for ${chunks.length} chunks`);

            // Generate embeddings for all chunks in a single batch
            const embeddingsMap = await this.generateEmbeddings(chunks, progressCallback, token);

            // Check for cancellation
            if (token?.isCancellationRequested) {
                throw new Error('Operation cancelled');
            }

            // Prepare search options with defaults
            const searchOptions = this.prepareSearchOptions(options);

            // Collect all results
            const allResults: SimilaritySearchResult[] = [];

            // For each chunk, find similar documents
            for (let i = 0; i < chunks.length; i++) {
                // Check for cancellation
                if (token?.isCancellationRequested) {
                    throw new Error('Operation cancelled');
                }

                const chunk = chunks[i];
                const embedding = embeddingsMap.get(chunk);

                if (!embedding) {
                    Log.warn(`No embedding generated for chunk: ${chunk.substring(0, 50)}...`);
                    continue;
                }

                // Find similar documents using the embedding
                const results = await this.vectorDb.findSimilarCode(
                    embedding,
                    {
                        limit: searchOptions.limit,
                        minScore: searchOptions.minScore
                    }
                );

                // Check for cancellation after each search
                if (token?.isCancellationRequested) {
                    throw new Error('Operation cancelled');
                }

                if (results.length > 0) {
                    // Add the original chunk to each result
                    const resultsWithQuery = results.map((result: SimilaritySearchResult) => ({
                        ...result,
                        query: chunk
                    }));

                    allResults.push(...resultsWithQuery);
                }

                // Report progress for similarity search if callback provided
                if (progressCallback) {
                    progressCallback(i + 1, chunks.length);
                }
            }

            // Sort all results by score in descending order
            return allResults.sort((a, b) => b.score - a.score);
        } catch (error) {
            if (token?.isCancellationRequested) {
                throw new Error('Operation cancelled');
            }
            Log.error('Error finding relevant code context for chunks:', error);
            throw error;
        }
    }

    /**
     * Prepare search options with defaults
     * @param options Optional search options
     * @returns Search options with defaults applied
     */
    private prepareSearchOptions(options?: SimilaritySearchOptions): SimilaritySearchOptions {
        return {
            limit: options?.limit || 10,
            minScore: options?.minScore || 0.7,
            ...options
        };
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
            const contentHash = quickHash(result.content);
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
     * Generate an embedding vector for text content using the indexingService
     * This ensures we only have one instance of the embedding model loaded
     * @param text The text to generate an embedding for
     * @param progressCallback Optional callback for progress updates
     * @returns A number[] embedding vector or null if generation fails
     */
    async generateEmbedding(
        text: string,
        progressCallback?: (processed: number, total: number) => void
    ): Promise<number[] | null> {
        try {
            // Use the batch method with a single item for consistency
            const embeddingsMap = await this.generateEmbeddings([text], progressCallback);
            const entries = Array.from(embeddingsMap.entries());

            if (entries.length === 0 || !entries[0][1]) {
                return null;
            }

            return entries[0][1];
        } catch (error) {
            Log.error('Error generating embedding via IndexingService:', error);
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

            Log.info(`Set embedding model to ${modelName}`);
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
            Log.error(`Error checking if file needs reindexing: ${filePath}`, error);
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
