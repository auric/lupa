import { EmbeddingOptions, ChunkingResult } from '../models/types';
import { WorkerTokenEstimator } from './workerTokenEstimator';

/**
 * WorkerCodeChunker provides intelligent code chunking capabilities within worker threads.
 * It respects natural code boundaries while ensuring chunks fit within token limits.
 */
export class WorkerCodeChunker {
    private readonly tokenEstimator: WorkerTokenEstimator;
    private readonly defaultOverlapSize = 200;

    /**
     * Creates a new worker code chunker
     * @param tokenEstimator The token estimator to use for token counting
     */
    constructor(tokenEstimator: WorkerTokenEstimator) {
        this.tokenEstimator = tokenEstimator;
    }

    /**
     * Chunks code into pieces that respect natural boundaries and fit within token limits
     * @param text The code text to chunk
     * @param options Optional embedding options that may include overlap size
     * @returns ChunkingResult with chunks and their offsets in the original text
     */
    async chunkCode(text: string, options?: EmbeddingOptions): Promise<ChunkingResult> {
        const overlapSize = options?.overlapSize || this.defaultOverlapSize;
        const safeTokenLimit = this.tokenEstimator.getSafeChunkSize();

        try {
            // First check if the entire text fits within token limits
            const willFit = await this.tokenEstimator.willFitContextWindow(text);
            if (willFit) {
                return {
                    chunks: [text],
                    offsets: [0]
                };
            }

            // Otherwise, use smart chunking based on token counts and code structure
            return this.createSmartChunks(text, safeTokenLimit, overlapSize);
        } catch (error) {
            console.error('Worker: Error during smart chunking:', error);

            // Fallback to simple chunking if tokenization-based chunking fails
            return this.createSimpleChunks(text, overlapSize);
        }
    }

    /**
     * Create intelligent chunks by respecting code structure and token limits
     * This implements a smart algorithm that tries to chunk at natural code boundaries
     */
    private async createSmartChunks(
        text: string,
        maxTokens: number,
        overlapSize: number
    ): Promise<ChunkingResult> {
        const chunks: string[] = [];
        const offsets: number[] = [];

        // Process text line by line to build chunks
        const lines = text.split('\n');
        let currentChunk = '';
        let currentOffset = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const potentialChunk = currentChunk ? currentChunk + '\n' + line : line;

            // Check if adding this line would exceed the token limit
            try {
                const tokenCount = await this.tokenEstimator.countTokens(potentialChunk);

                if (currentChunk && tokenCount > maxTokens) {
                    // Need to split - try to find a good break point
                    const splitPoint = this.findCodeBreakPoint(currentChunk);

                    if (splitPoint.breakFound && splitPoint.beforeBreak.length > 0) {
                        // Found a good break point
                        chunks.push(splitPoint.beforeBreak);
                        offsets.push(currentOffset);

                        // Calculate position for next chunk
                        currentOffset = currentOffset + splitPoint.beforeBreak.length;
                        currentChunk = splitPoint.afterBreak + '\n' + line;
                    } else {
                        // No good break point found, just add the current chunk
                        chunks.push(currentChunk);
                        offsets.push(currentOffset);

                        // Start a new chunk with this line
                        currentOffset = currentOffset + currentChunk.length;
                        currentChunk = line;
                    }
                } else {
                    // This line fits, add it to the current chunk
                    currentChunk = potentialChunk;
                }
            } catch (error) {
                console.error('Worker: Error estimating tokens during chunking:', error);

                // If token counting fails, make a best guess
                if (currentChunk && potentialChunk.length > 8000) {  // Use character length as fallback heuristic
                    chunks.push(currentChunk);
                    offsets.push(currentOffset);
                    currentOffset = currentOffset + currentChunk.length;
                    currentChunk = line;
                } else {
                    currentChunk = potentialChunk;
                }
            }
        }

        // Add the last chunk if there's anything left
        if (currentChunk) {
            chunks.push(currentChunk);
            offsets.push(currentOffset);
        }

        // Process chunks to add overlapping context between them
        return this.addOverlappingContext(chunks, offsets, overlapSize);
    }

    /**
     * Find a good break point in code for chunking
     * Prioritizes natural code boundaries like function/class endings
     */
    private findCodeBreakPoint(text: string): {
        breakFound: boolean;
        beforeBreak: string;
        afterBreak: string;
    } {
        // Look for function or class ending
        const blockEndMatch = text.match(/^([\s\S]*?\n})(\s*\n[\s\S]*?)$/);
        if (blockEndMatch) {
            return {
                breakFound: true,
                beforeBreak: blockEndMatch[1],
                afterBreak: blockEndMatch[2]
            };
        }

        // Look for statement endings (semicolons)
        const statementEndMatch = text.match(/^([\s\S]*?;\s*\n)(\s*\n[\s\S]*?)$/);
        if (statementEndMatch) {
            return {
                breakFound: true,
                beforeBreak: statementEndMatch[1],
                afterBreak: statementEndMatch[2]
            };
        }

        // Look for blank lines as break points
        const blankLineMatch = text.match(/^([\s\S]*?\n\s*\n)(\s*\n[\s\S]*?)$/);
        if (blankLineMatch) {
            return {
                breakFound: true,
                beforeBreak: blankLineMatch[1],
                afterBreak: blankLineMatch[2]
            };
        }

        // No good break point found
        return {
            breakFound: false,
            beforeBreak: text,
            afterBreak: ''
        };
    }

    /**
     * Add overlapping context between chunks for better coherence
     */
    private addOverlappingContext(
        chunks: string[],
        offsets: number[],
        overlapSize: number
    ): ChunkingResult {
        if (chunks.length <= 1) {
            return { chunks, offsets };
        }

        const processedChunks: string[] = [chunks[0]];
        const processedOffsets: number[] = [offsets[0]];

        for (let i = 1; i < chunks.length; i++) {
            const prevChunk = chunks[i - 1];
            const currentChunk = chunks[i];

            // Take the end of the previous chunk as context
            const contextLines = prevChunk.split('\n').slice(-5).join('\n');

            // Add this context to the beginning of the current chunk
            processedChunks.push(contextLines + '\n' + currentChunk);

            // Keep the original offset for proper mapping
            processedOffsets.push(offsets[i]);
        }

        return {
            chunks: processedChunks,
            offsets: processedOffsets
        };
    }

    /**
     * Create simple chunks based on character count as a fallback when tokenization fails
     * Still attempts to break at natural code boundaries
     */
    private createSimpleChunks(text: string, overlapSize: number): ChunkingResult {
        const chunks: string[] = [];
        const offsets: number[] = [];

        // Estimate characters per token (conservative)
        const charsPerToken = 4;
        const estimatedChunkSize = Math.floor(this.tokenEstimator.getSafeChunkSize() * charsPerToken);

        let position = 0;

        while (position < text.length) {
            offsets.push(position);

            let end = Math.min(position + estimatedChunkSize, text.length);

            // Try to end at a natural break point
            if (end < text.length) {
                // Try to find a block end, statement end, or newline near the end position
                const nearbyBlockEnd = text.lastIndexOf('}\n', end);
                const nearbyStatementEnd = text.lastIndexOf(';\n', end);
                const nearbyNewline = text.lastIndexOf('\n', end);

                // Find the closest break point that's not too far back
                const candidates = [nearbyBlockEnd, nearbyStatementEnd, nearbyNewline]
                    .filter(pos => pos > position && pos > position + estimatedChunkSize - 500);

                if (candidates.length > 0) {
                    end = Math.max(...candidates) + 1; // Include the matched character
                }
            }

            chunks.push(text.substring(position, end));

            // Calculate next position with overlap
            const nextPosition = end - overlapSize;
            position = nextPosition <= position ? position + (estimatedChunkSize / 2) : nextPosition;
        }

        return { chunks, offsets };
    }

    /**
     * Implements the sliding window approach from the provided algorithm
     * This is a more sophisticated approach that tokenizes the entire text first
     * and then creates precisely controlled token-sized chunks
     */
    async createTokenBasedChunks(
        text: string,
        maxLength: number,
        overlap = 100
    ): Promise<{ chunks: string[], offsets: number[] }> {
        try {
            // Tokenize the full text
            const tokenIds = await this.tokenEstimator.tokenize(text);
            const tokenizer = await this.tokenEstimator.initialize();

            // If it fits within limits, return as is
            if (tokenIds.length <= maxLength) {
                return {
                    chunks: [text],
                    offsets: [0]
                };
            }

            // Otherwise, create overlapping chunks
            const chunks: string[] = [];
            const offsets: number[] = [];

            for (let i = 0; i < tokenIds.length; i += (maxLength - overlap)) {
                const chunkTokens = tokenIds.slice(i, i + maxLength);
                const chunkText = await tokenizer.decode(chunkTokens);

                // Calculate the character offset of this chunk in the original text
                const startText = await tokenizer.decode(tokenIds.slice(0, i));
                const offset = startText.length;

                chunks.push(chunkText);
                offsets.push(offset);

                // Break if we've covered all tokens
                if (i + maxLength >= tokenIds.length) break;
            }

            return { chunks, offsets };
        } catch (error) {
            console.error('Worker: Error in token-based chunking:', error);

            // Fall back to simple chunking if token-based approach fails
            return this.createSimpleChunks(text, 200);
        }
    }
}