import * as vscode from 'vscode';
import { PreTrainedTokenizer } from '@huggingface/transformers';
import { EmbeddingOptions, ChunkingResult } from '../types/embeddingTypes';
import { WorkerTokenEstimator } from './workerTokenEstimator';
import { TreeStructureAnalyzer } from '../services/treeStructureAnalyzer';

/**
 * WorkerCodeChunker provides intelligent code chunking capabilities within worker threads.
 * It respects natural code boundaries while ensuring chunks fit within token limits.
 */
export class WorkerCodeChunker {
    private readonly tokenEstimator: WorkerTokenEstimator;
    private readonly defaultOverlapSize = 100;
    private treeStructureAnalyzer: TreeStructureAnalyzer | null = null;

    /**
     * Creates a new worker code chunker
     * @param tokenEstimator The token estimator to use for token counting
     */
    constructor(
        readonly extensionPath: string,
        tokenEstimator: WorkerTokenEstimator
    ) {
        this.tokenEstimator = tokenEstimator;
    }

    /**
     * Initialize the tree structure analyzer if available
     */
    private async getTreeStructureAnalyzer(): Promise<TreeStructureAnalyzer | null> {
        if (!this.treeStructureAnalyzer) {
            try {
                this.treeStructureAnalyzer = TreeStructureAnalyzer.getInstance(this.extensionPath);
            } catch (error) {
                console.warn('Tree-sitter not available, falling back to regex-based chunking:', error);
                return null;
            }
        }
        return this.treeStructureAnalyzer;
    }

    /**
     * Chunks code into pieces that respect natural boundaries and fit within token limits
     * @param text The code text to chunk
     * @param options Optional embedding options that may include overlap size
     * @param signal AbortSignal for cancellation
     * @param language Optional language for structure-aware chunking
     * @returns ChunkingResult with chunks and their offsets in the original text
     */
    async chunkCode(
        text: string,
        options: EmbeddingOptions,
        signal: AbortSignal,
        language?: string
    ): Promise<ChunkingResult> {
        const overlapSize = options.overlapSize !== undefined ?
            options.overlapSize :
            this.defaultOverlapSize;

        const safeTokenLimit = this.tokenEstimator.getSafeChunkSize();

        try {
            console.log(`Worker: Processing file of ${text.length} characters`);

            // For medium-sized files, check token count
            if (await this.tokenEstimator.willFitContextWindow(text)) {
                return {
                    chunks: [text],
                    offsets: [0]
                };
            }

            // Try to use tree-sitter for language-aware chunking if language is provided
            if (language) {
                const analyzer = await this.getTreeStructureAnalyzer();
                if (analyzer) {
                    const structureResult = await this.createStructureAwareChunks(
                        text,
                        language,
                        safeTokenLimit,
                        overlapSize,
                        analyzer,
                        signal
                    );

                    if (structureResult) {
                        return structureResult;
                    }
                }
            }

            // For large files, use optimized token chunking
            return this.createOptimizedTokenChunks(text, safeTokenLimit, overlapSize, signal);
        } catch (error) {
            if (signal.aborted && error instanceof Error && error.message.includes('cancelled')) {
                throw error;
            }

            console.error('Worker: Error during token-based chunking:', error);

            // Fallback to simple chunking
            console.log('Worker: Falling back to simple chunking method');
            return this.createSimpleChunks(text, overlapSize);
        }
    }

    /**
     * Creates chunks based on code structure analysis using Tree-sitter
     * This ensures that function boundaries are respected
     */
    private async createStructureAwareChunks(
        text: string,
        language: string,
        maxTokens: number,
        overlapSize: number,
        analyzer: TreeStructureAnalyzer,
        signal: AbortSignal
    ): Promise<ChunkingResult | null> {
        try {
            console.log(`Worker: Starting structure-aware chunking for ${language}`);

            // Find all structure break points (function/method/class boundaries)
            const breakPoints = await analyzer.findStructureBreakPoints(text, language);

            if (breakPoints.length === 0) {
                console.log('Worker: No structure break points found, falling back to token chunking');
                return null;
            }

            console.log(`Worker: Found ${breakPoints.length} structure break points`);

            // Get functions and classes to prioritize preserving whole structures
            const functions = await analyzer.findFunctions(text, language);
            const classes = await analyzer.findClasses(text, language);

            console.log(`Worker: Found ${functions.length} functions and ${classes.length} classes`);

            // Create a map of important code structures with their ranges
            const codeStructures = new Map<number, { end: number, type: string }>();

            // Add function boundaries (more important to preserve)
            for (const func of functions) {
                const start = this.positionToOffset(text, func.range.startPosition.row, func.range.startPosition.column);
                const end = this.positionToOffset(text, func.range.endPosition.row, func.range.endPosition.column);
                if (start !== null && end !== null) {
                    codeStructures.set(start, { end, type: 'function' });
                }
            }

            // Add class boundaries (also important to preserve)
            for (const cls of classes) {
                const start = this.positionToOffset(text, cls.range.startPosition.row, cls.range.startPosition.column);
                const end = this.positionToOffset(text, cls.range.endPosition.row, cls.range.endPosition.column);
                if (start !== null && end !== null) {
                    codeStructures.set(start, { end, type: 'class' });
                }
            }

            // Generate chunks based on structure break points and token limits
            const chunks: string[] = [];
            const offsets: number[] = [];

            let startPos = 0;
            let breakPointIndex = 0;
            let lastEndPos = -1; // Track the last ending position to detect lack of progress

            while (startPos < text.length) {
                if (signal.aborted) {
                    throw new Error('Operation was cancelled');
                }

                offsets.push(startPos);

                // Check if we're at the start of an important structure
                const structure = codeStructures.get(startPos);
                if (structure) {
                    // Create a chunk for this entire function/class if it fits with some flexibility
                    const structureChunk = text.substring(startPos, structure.end);

                    try {
                        const tokenCount = await this.tokenEstimator.countTokens(structureChunk);

                        // Allow up to 25% over the token limit for important structures
                        // This ensures functions and classes stay intact when possible
                        const flexibleTokenLimit = Math.min(maxTokens * 1.25, maxTokens + 500);

                        if (tokenCount <= flexibleTokenLimit) {
                            // This structure fits within our flexible token limit, use it as a chunk
                            chunks.push(structureChunk);

                            // Update position and continue
                            startPos = structure.end;

                            // Advance break point index beyond this structure's end
                            while (breakPointIndex < breakPoints.length &&
                                breakPoints[breakPointIndex].position <= structure.end) {
                                breakPointIndex++;
                            }

                            continue; // Skip the normal chunking logic for this iteration
                        }
                        // If structure doesn't fit even with flexibility, fall through to normal chunking
                    } catch (error) {
                        console.warn('Error estimating tokens for structure:', error);
                        // Fall through to normal chunking
                    }
                }

                // Find the next viable break point
                let endPos = text.length;
                let foundBreakPoint = false;

                // Loop through break points to find one that keeps us under the token limit
                while (breakPointIndex < breakPoints.length) {
                    const breakPoint = breakPoints[breakPointIndex];

                    // Skip break points that are before or at our current position
                    if (breakPoint.position <= startPos) {
                        breakPointIndex++;
                        continue;
                    }

                    const potentialChunk = text.substring(startPos, breakPoint.position);

                    try {
                        const tokenCount = await this.tokenEstimator.countTokens(potentialChunk);

                        // Allow a small amount of flexibility (10%) for good quality break points
                        const flexibleLimit = breakPoint.quality >= 8 ?
                            Math.min(maxTokens * 1.1, maxTokens + 200) : maxTokens;

                        if (tokenCount <= flexibleLimit) {
                            // This break point keeps us under the token limit
                            endPos = breakPoint.position;
                            foundBreakPoint = true;
                            breakPointIndex++;
                            break; // Exit the while loop once we find a valid break point
                        } else {
                            // This chunk would exceed token limit, try another strategy
                            break;
                        }
                    } catch (error) {
                        console.warn('Error estimating tokens:', error);
                        break;
                    }
                }

                // If no viable break point was found, we need to force a break based on tokens
                if (!foundBreakPoint) {
                    // Find the largest possible chunk under token limit
                    const estCharsPerToken = 4; // Conservative estimate
                    const estMaxChars = maxTokens * estCharsPerToken;

                    // Try increasingly larger chunks until we hit token limit
                    let tokenCount = 0;
                    let testEndPos = Math.min(startPos + estMaxChars, text.length);

                    while (testEndPos > startPos) {
                        const testChunk = text.substring(startPos, testEndPos);

                        try {
                            tokenCount = await this.tokenEstimator.countTokens(testChunk);

                            if (tokenCount <= maxTokens) {
                                // This fits within token limit
                                endPos = testEndPos;
                                break;
                            }

                            // Reduce chunk size and try again
                            testEndPos = Math.floor(startPos + (testEndPos - startPos) * 0.8);
                        } catch (error) {
                            console.warn('Error during token estimation:', error);
                            testEndPos = Math.floor(startPos + (testEndPos - startPos) * 0.8);
                        }
                    }

                    // Skip past this break point index
                    while (breakPointIndex < breakPoints.length &&
                        breakPoints[breakPointIndex].position <= endPos) {
                        breakPointIndex++;
                    }
                }

                // Add the chunk
                const chunk = text.substring(startPos, endPos);
                chunks.push(chunk);

                // Calculate next start position with overlap
                let nextStartPos = endPos - overlapSize;

                // Fix the infinite loop issue by ensuring we always make progress
                if (nextStartPos <= startPos) {
                    // If we wouldn't make any progress due to a large overlap, force progress
                    // Move forward by at least 1/4 of the chunk size or 100 characters, whichever is larger
                    const minProgress = Math.max(Math.floor((endPos - startPos) / 4), 100);
                    nextStartPos = startPos + minProgress;

                    // If we're near the end, make sure we don't get stuck in a loop
                    if (nextStartPos >= text.length - 100) {
                        nextStartPos = text.length;
                    }
                }

                // Extra safety check: if we're somehow not making progress, force it
                if (endPos === lastEndPos) {
                    console.warn('Worker: Detected potential infinite loop - forcing progress');
                    nextStartPos = endPos + 1;

                    // If we're at the end of text, break out
                    if (nextStartPos >= text.length) {
                        break;
                    }
                }

                lastEndPos = endPos;
                startPos = nextStartPos;

                console.log(`Worker: Created structure-aware chunk of ${chunk.length} chars, next start at ${startPos}/${text.length}`);
            }

            return { chunks, offsets };
        } catch (error) {
            console.error('Error creating structure-aware chunks:', error);
            return null;
        }
    }

    /**
     * Convert position (row, column) to character offset
     * @param text Source text
     * @param row Zero-based row
     * @param column Zero-based column
     * @returns Character offset or null if invalid
     */
    private positionToOffset(text: string, row: number, column: number): number | null {
        const lines = text.split('\n');

        if (row >= lines.length) {
            return null;
        }

        let offset = 0;
        for (let i = 0; i < row; i++) {
            offset += lines[i].length + 1; // +1 for the newline
        }

        if (column > lines[row].length) {
            return null;
        }

        offset += column;
        return offset;
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
     * Enhanced token-based chunking with custom token position mapping
     */
    async createOptimizedTokenChunks(
        text: string,
        maxTokens: number,
        overlap: number,
        signal: AbortSignal
    ): Promise<ChunkingResult> {
        // Early return for empty text
        if (!text || text.length === 0) {
            return { chunks: [], offsets: [] };
        }

        console.log(`Worker: Starting token-based chunking for ${text.length} characters`);
        const startTime = performance.now();

        // Initialize tokenizer
        const tokenizer = await this.tokenEstimator.initialize();

        // Get all tokens first
        const tokens = await this.tokenEstimator.tokenize(text);
        console.log(`Worker: Text tokenized into ${tokens.length} tokens`);

        // Map tokens to their positions in the text
        const tokenPositions = await this.mapTokensToPositions(text, tokens, tokenizer);
        console.log(`Worker: Mapped ${tokenPositions.length} token positions`);

        // If it fits in one chunk, return as is
        if (tokens.length <= maxTokens) {
            return {
                chunks: [text],
                offsets: [0]
            };
        }

        // Find code structure break points
        const breakPoints = this.findCodeBreakPoints(text);
        console.log(`Worker: Found ${breakPoints.length} potential break points`);

        // Create chunks with token-awareness and code structure
        const chunks: string[] = [];
        const offsets: number[] = [];
        let startTokenIdx = 0;

        while (startTokenIdx < tokens.length) {
            if (signal.aborted) {
                throw new Error('Operation was cancelled');
            }
            // Determine target end index
            const targetEndTokenIdx = Math.min(startTokenIdx + maxTokens, tokens.length);
            console.log(`Worker: Chunking progress - processing tokens ${startTokenIdx}/${tokens.length}`);

            // If we're at the end, add final chunk
            if (targetEndTokenIdx >= tokens.length) {
                const chunkText = text.substring(tokenPositions[startTokenIdx].start);
                chunks.push(chunkText);
                offsets.push(tokenPositions[startTokenIdx].start);
                break;
            }

            // Find best break point near target end
            const targetCharPos = tokenPositions[targetEndTokenIdx - 1].end;
            const searchWindow = 500; // Look 500 chars around target

            const bestBreakPoint = this.findBestBreakPoint(
                breakPoints,
                targetCharPos - searchWindow,
                targetCharPos + searchWindow
            );

            // If no good break point, use target token boundary
            const breakPos = bestBreakPoint !== null ?
                bestBreakPoint.pos :
                tokenPositions[targetEndTokenIdx - 1].end;

            // Create chunk
            const chunkText = text.substring(tokenPositions[startTokenIdx].start, breakPos);
            if (chunkText.trim().length > 0) {
                chunks.push(chunkText);
                offsets.push(tokenPositions[startTokenIdx].start);
            }

            // Find overlap in tokens rather than characters for more accuracy
            const overlapTokens = Math.min(overlap, Math.floor((targetEndTokenIdx - startTokenIdx) / 3));
            const nextStartTokenIdx = this.findTokenIndexNearPosition(
                tokenPositions,
                breakPos - 100, // Look back ~100 chars for good overlap
                signal
            );

            // Ensure we always make forward progress
            startTokenIdx = Math.max(startTokenIdx + 1, nextStartTokenIdx);

            console.log(`Worker: Created chunk of ${chunkText.length} chars (${chunkText.split('\n').length} lines), next start at token ${startTokenIdx}/${tokens.length}`);
        }

        const endTime = performance.now();
        console.log(`Worker: Chunking completed in ${(endTime - startTime).toFixed(2)}ms - created ${chunks.length} chunks`);

        return { chunks, offsets };
    }

    /**
     * Map tokens to their positions in the original text
     * @param text Original text
     * @param tokens Array of token IDs
     * @param tokenizer The tokenizer instance
     * @returns Array of token positions {start, end}
     */
    private async mapTokensToPositions(
        text: string,
        tokens: number[],
        tokenizer: PreTrainedTokenizer
    ): Promise<Array<{ start: number, end: number }>> {
        const positions: Array<{ start: number, end: number }> = [];
        let currentPos = 0;
        let remainingText = text;

        console.log(`Worker: Mapping ${tokens.length} tokens to positions`);
        const progressStep = Math.max(1, Math.floor(tokens.length / 10));

        // Process tokens in batches for efficiency
        const batchSize = 100;
        for (let i = 0; i < tokens.length; i += batchSize) {
            const batch = tokens.slice(i, i + batchSize);

            // Process each token in batch
            for (let j = 0; j < batch.length; j++) {
                const token = batch[j];
                const tokenIdx = i + j;

                try {
                    // Decode the token to get its text representation
                    const tokenText = await tokenizer.decode([token], {
                        skip_special_tokens: true
                    });

                    if (tokenText && tokenText.length > 0) {
                        // Try to find the token text in the remaining text
                        const tokenPos = remainingText.indexOf(tokenText);

                        if (tokenPos !== -1) {
                            // Found exact match
                            positions.push({
                                start: currentPos + tokenPos,
                                end: currentPos + tokenPos + tokenText.length
                            });

                            // Update positions for next token
                            currentPos += tokenPos + tokenText.length;
                            remainingText = remainingText.substring(tokenPos + tokenText.length);
                        } else {
                            // Handle the case where direct match fails
                            // This can happen with special tokens, whitespace differences, etc.
                            // Use approximate matching
                            const approximatePos = this.findApproximateTokenPosition(
                                remainingText, tokenText, currentPos
                            );

                            positions.push(approximatePos);

                            // Update positions for next token
                            currentPos = approximatePos.end;
                            remainingText = text.substring(currentPos);
                        }
                    } else {
                        // Handle empty token (shouldn't normally happen)
                        positions.push({
                            start: currentPos,
                            end: currentPos + 1
                        });

                        // Move forward cautiously
                        currentPos += 1;
                        remainingText = text.substring(currentPos);
                    }
                } catch (error) {
                    console.warn(`Worker: Error decoding token at index ${tokenIdx}:`, error);

                    // Use fallback position
                    positions.push({
                        start: currentPos,
                        end: currentPos + 1
                    });

                    currentPos += 1;
                    remainingText = text.substring(currentPos);
                }

                // Log progress periodically
                if ((tokenIdx + 1) % progressStep === 0 || tokenIdx === tokens.length - 1) {
                    console.log(`Worker: Mapping progress - mapped ${tokenIdx + 1}/${tokens.length} tokens`);
                }
            }
        }

        // Handle edge cases
        if (positions.length < tokens.length) {
            console.warn(`Worker: Mapped ${positions.length} positions for ${tokens.length} tokens, filling in gaps`);

            // Fill in gaps with estimated positions
            while (positions.length < tokens.length) {
                const lastPos = positions[positions.length - 1];
                positions.push({
                    start: lastPos.end,
                    end: lastPos.end + 1
                });
            }
        }

        // Validate final position mapping
        this.validateTokenPositions(positions, text.length);

        return positions;
    }

    /**
     * Find approximate position for a token that doesn't directly match
     */
    private findApproximateTokenPosition(
        text: string,
        tokenText: string,
        basePos: number
    ): { start: number, end: number } {
        // Check for substrings or similar patterns
        for (let i = 0; i < Math.min(tokenText.length, 5); i++) {
            const subPattern = tokenText.substring(0, tokenText.length - i);
            if (subPattern.length >= 2) {
                const subPatternPos = text.indexOf(subPattern);
                if (subPatternPos !== -1) {
                    return {
                        start: basePos + subPatternPos,
                        end: basePos + subPatternPos + tokenText.length
                    };
                }
            }
        }

        // If we still can't find a match, estimate based on character classes
        // This helps with whitespace and special character differences
        const normalizedToken = tokenText.replace(/\s+/g, ' ');
        const firstNonWsChar = normalizedToken.match(/[^\s]/);

        if (firstNonWsChar) {
            const firstChar = firstNonWsChar[0];
            const charPos = text.indexOf(firstChar);

            if (charPos !== -1) {
                return {
                    start: basePos + charPos,
                    end: basePos + charPos + tokenText.length
                };
            }
        }

        // Last resort: just advance a bit
        return {
            start: basePos,
            end: basePos + tokenText.length
        };
    }

    /**
     * Validate token positions to ensure they're within text boundaries
     */
    private validateTokenPositions(
        positions: Array<{ start: number, end: number }>,
        textLength: number
    ): void {
        for (let i = 0; i < positions.length; i++) {
            // Ensure positions are within bounds
            positions[i].start = Math.max(0, Math.min(positions[i].start, textLength));
            positions[i].end = Math.max(positions[i].start + 1, Math.min(positions[i].end, textLength));

            // Ensure positions increase monotonically
            if (i > 0 && positions[i].start < positions[i - 1].end) {
                positions[i].start = positions[i - 1].end;
                positions[i].end = Math.max(positions[i].start + 1, positions[i].end);
            }
        }
    }

    /**
     * Find token index closest to a character position using binary search
     */
    private findTokenIndexNearPosition(
        tokenPositions: Array<{ start: number, end: number }>,
        targetPos: number,
        signal: AbortSignal
    ): number {
        // Binary search for efficiency with large token arrays
        let left = 0;
        let right = tokenPositions.length - 1;

        while (left <= right) {
            if (signal.aborted) {
                throw new Error('Operation was cancelled');
            }

            const mid = Math.floor((left + right) / 2);

            // Check if we found the position
            if (tokenPositions[mid].start <= targetPos &&
                tokenPositions[mid].end > targetPos) {
                return mid;
            }

            // Adjust search range
            if (tokenPositions[mid].start > targetPos) {
                right = mid - 1;
            } else {
                left = mid + 1;
            }
        }

        // If exact match not found, return closest
        if (left >= tokenPositions.length) return tokenPositions.length - 1;
        if (right < 0) return 0;

        // Choose the closer position
        const leftDist = Math.abs(tokenPositions[left].start - targetPos);
        const rightDist = Math.abs(tokenPositions[right].start - targetPos);

        return leftDist < rightDist ? left : right;
    }

    /**
     * Find potential break points in code with quality ratings
     */
    private findCodeBreakPoints(text: string): Array<{ pos: number, quality: number }> {
        const breakPoints: Array<{ pos: number, quality: number }> = [];

        // Define patterns with quality ratings (higher = better break point)
        const patterns: Array<{ regex: RegExp, quality: number }> = [
            { regex: /}\s*\n/g, quality: 5 },      // End of code block
            { regex: /;\s*\n\s*\n/g, quality: 4 }, // Statement end + blank line
            { regex: /;\s*\n/g, quality: 3 },      // Statement end
            { regex: /\)\s*\{/g, quality: 2 },     // Function opening
            { regex: /\n\s*\n/g, quality: 1 }      // Blank line
        ];

        // Find all matches for each pattern
        for (const { regex, quality } of patterns) {
            let match: RegExpExecArray | null;
            while ((match = regex.exec(text)) !== null) {
                breakPoints.push({
                    pos: match.index + match[0].length,
                    quality
                });
            }
        }

        // Sort by position for easier searching
        breakPoints.sort((a, b) => a.pos - b.pos);
        return breakPoints;
    }

    /**
     * Find best break point within a range
     */
    private findBestBreakPoint(
        breakPoints: Array<{ pos: number, quality: number }>,
        minPos: number,
        maxPos: number
    ): { pos: number, quality: number } | null {
        let bestBreakPoint: { pos: number, quality: number } | null = null;

        // Use binary search to find starting point in the sorted array
        const startIdx = this.binarySearchBreakPoints(breakPoints, minPos);

        // Scan forward from start index to find best quality break point in range
        for (let i = startIdx;
            i < breakPoints.length && breakPoints[i].pos <= maxPos;
            i++) {

            if (!bestBreakPoint || breakPoints[i].quality > bestBreakPoint.quality) {
                bestBreakPoint = breakPoints[i];
            }
        }

        return bestBreakPoint;
    }

    /**
     * Binary search to find index of first break point at or after position
     */
    private binarySearchBreakPoints(
        breakPoints: Array<{ pos: number, quality: number }>,
        position: number
    ): number {
        let low = 0;
        let high = breakPoints.length - 1;

        while (low <= high) {
            const mid = Math.floor((low + high) / 2);

            if (breakPoints[mid].pos < position) {
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }

        return low;
    }
}