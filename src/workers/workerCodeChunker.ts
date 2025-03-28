import * as vscode from 'vscode';
import { v4 as uuidv4 } from 'uuid'; // Import uuid
import { PreTrainedTokenizer } from '@huggingface/transformers';
import { EmbeddingOptions, ChunkingResult, DetailedChunkingResult } from '../types/embeddingTypes'; // Import DetailedChunkingResult
import { WorkerTokenEstimator } from './workerTokenEstimator';
import { TreeStructureAnalyzer, TreeStructureAnalyzerPool, CodeStructure } from '../services/treeStructureAnalyzer'; // Import CodeStructure

/**
 * WorkerCodeChunker provides intelligent code chunking capabilities within worker threads.
 * It respects natural code boundaries while ensuring chunks fit within token limits.
 */
export class WorkerCodeChunker {
    private readonly tokenEstimator: WorkerTokenEstimator;
    private readonly defaultOverlapSize = 100;
    private treeStructureAnalyzerPool: TreeStructureAnalyzerPool | null = null;

    /**
     * Creates a new worker code chunker
     * @param tokenEstimator The token estimator to use for token counting
     */
    constructor(
        tokenEstimator: WorkerTokenEstimator
    ) {
        this.tokenEstimator = tokenEstimator;
    }

    /**
     * Get a TreeStructureAnalyzer from the pool
     */
    private async getTreeStructureAnalyzer(): Promise<TreeStructureAnalyzer | null> {
        if (!this.treeStructureAnalyzerPool) {
            try {
                // Get the pool instance instead of creating a new analyzer
                this.treeStructureAnalyzerPool = TreeStructureAnalyzerPool.getInstance();
                if (!this.treeStructureAnalyzerPool) {
                    console.warn('TreeStructureAnalyzerPool not available, falling back to regex-based chunking');
                    return null;
                }
            } catch (error) {
                console.warn('Tree-sitter not available, falling back to regex-based chunking:', error);
                return null;
            }
        }

        // Get an analyzer from the pool
        try {
            return await this.treeStructureAnalyzerPool.getAnalyzer();
        } catch (error) {
            console.warn('Failed to get analyzer from pool:', error);
            return null;
        }
    }

    /**
     * Chunks code into pieces that respect natural boundaries and fit within token limits
     * @param text The code text to chunk
     * @param options Optional embedding options that may include overlap size
     * @param signal AbortSignal for cancellation
     * @param language Optional language for structure-aware chunking
     * @returns DetailedChunkingResult with chunks, offsets, and metadata
     */
    async chunkCode(
        text: string,
        options: EmbeddingOptions,
        signal: AbortSignal,
        language?: string
    ): Promise<DetailedChunkingResult> { // Updated return type
        const overlapSize = options.overlapSize !== undefined ?
            options.overlapSize :
            this.defaultOverlapSize;

        const safeTokenLimit = this.tokenEstimator.getSafeChunkSize();
        // Define a flexible limit (e.g., 1.5x strict limit or +1000 tokens)
        const flexibleTokenLimit = Math.min(safeTokenLimit * 1.5, safeTokenLimit + 1000);

        try {
            // For files that fit entirely, return single chunk with null metadata
            if (await this.tokenEstimator.willFitContextWindow(text)) {
                return {
                    chunks: [text],
                    offsets: [0],
                    metadata: {
                        parentStructureIds: [null],
                        structureOrders: [null],
                        isOversizedFlags: [false], // Not oversized if it fits
                        structureTypes: [null]
                    }
                };
            }

            // Try to use tree-sitter for language-aware chunking if language is provided
            if (language) {
                const analyzer = await this.getTreeStructureAnalyzer();
                if (analyzer) {
                    try {
                        const structureResult = await this.createStructureAwareChunks(
                            text,
                            language,
                            safeTokenLimit,
                            flexibleTokenLimit, // Pass flexible limit
                            overlapSize,
                            analyzer,
                            signal
                        );
                        if (structureResult) {
                            return structureResult;
                        }
                    } finally {
                        // Ensure analyzer is always released
                        this.treeStructureAnalyzerPool?.releaseAnalyzer(analyzer);
                    }
                }
            }

            // Fallback: For large files or unsupported languages, use optimized token chunking
            console.log('Worker: Falling back to optimized token chunking');
            return this.createOptimizedTokenChunks(text, safeTokenLimit, overlapSize, signal);
        } catch (error) {
            if (signal.aborted && error instanceof Error && error.message.includes('cancelled')) {
                throw error;
            }

            console.error('Worker: Error during chunking:', error);

            // Fallback to simple chunking on error
            console.log('Worker: Falling back to simple chunking method due to error');
            return this.createSimpleChunks(text, overlapSize);
        }
    }

    /**
     * Creates chunks based on code structure analysis using Tree-sitter
     * Handles class/method hierarchy and preserves complete structures
     */
    private async createStructureAwareChunks(
        text: string,
        language: string,
        maxTokens: number, // Strict limit
        flexibleTokenLimit: number, // More generous limit for whole structures
        overlapSize: number,
        analyzer: TreeStructureAnalyzer,
        signal: AbortSignal
    ): Promise<DetailedChunkingResult | null> {
        try {
            // Find all structure break points
            const breakPoints = await analyzer.findStructureBreakPoints(text, language);

            // Get all major structures (functions, classes, etc.)
            const allStructures = await analyzer.findAllStructures(text, language);

            // Create a map of structures keyed by their start offset for quick lookup
            const structureMap = new Map<number, CodeStructure>();
            for (const struct of allStructures) {
                const startOffset = this.positionToOffset(text, struct.range.startPosition.row, struct.range.startPosition.column);
                if (startOffset !== null) {
                    structureMap.set(startOffset, struct);
                }
            }

            // --- Initialize arrays for DetailedChunkingResult ---
            const chunks: string[] = [];
            const offsets: number[] = [];
            const parentStructureIds: (string | null)[] = [];
            const structureOrders: (number | null)[] = [];
            const isOversizedFlags: (boolean | null)[] = [];
            const structureTypes: (string | null)[] = [];
            // ---

            let currentPos = 0;
            let currentBreakPointIndex = 0;

            while (currentPos < text.length) {
                if (signal.aborted) throw new Error('Operation was cancelled');

                let chunkEndPos = text.length;
                let chunkText = '';
                let isOversized = false;
                let structureType: string | null = null;

                // Check if current position is the start of a known structure
                const currentStructure = structureMap.get(currentPos);

                if (currentStructure) {
                    structureType = currentStructure.type; // Store type
                    const structureEndOffset = this.positionToOffset(text, currentStructure.range.endPosition.row, currentStructure.range.endPosition.column)!;
                    const structureText = text.substring(currentPos, structureEndOffset);
                    const tokenCount = await this.tokenEstimator.countTokens(structureText);

                    if (tokenCount <= flexibleTokenLimit) {
                        // Structure fits (possibly using flexible limit)
                        chunkText = structureText;
                        chunkEndPos = structureEndOffset;
                        isOversized = tokenCount > maxTokens; // Mark if it exceeded strict limit

                        // Add chunk and metadata
                        offsets.push(currentPos);
                        chunks.push(chunkText);
                        parentStructureIds.push(null);
                        structureOrders.push(null);
                        isOversizedFlags.push(isOversized);
                        structureTypes.push(structureType);

                        // Advance position past this structure
                        currentPos = chunkEndPos;
                        // Advance breakpoint index past this structure
                        while (currentBreakPointIndex < breakPoints.length && breakPoints[currentBreakPointIndex].position <= currentPos) {
                            currentBreakPointIndex++;
                        }
                        continue; // Process next part of the text
                    } else {
                        // Structure is too large, needs splitting
                        console.log(`Worker: Structure ${currentStructure.name || currentStructure.type} at ${currentPos} exceeds flexible limit (${tokenCount} > ${flexibleTokenLimit}), attempting split.`);
                        const parentId = uuidv4();
                        const subChunks = await this.splitOversizedStructure(
                            structureText,
                            language,
                            maxTokens,
                            overlapSize,
                            analyzer,
                            signal
                        );

                        // Add sub-chunks with metadata
                        for (let i = 0; i < subChunks.chunks.length; i++) {
                            offsets.push(currentPos + subChunks.offsets[i]); // Adjust offset relative to file start
                            chunks.push(subChunks.chunks[i]);
                            parentStructureIds.push(parentId);
                            structureOrders.push(i);
                            isOversizedFlags.push(false); // Sub-chunks are not oversized by definition
                            structureTypes.push(structureType);
                        }

                        // Advance position past the original oversized structure
                        currentPos = structureEndOffset;
                        // Advance breakpoint index past this structure
                        while (currentBreakPointIndex < breakPoints.length && breakPoints[currentBreakPointIndex].position <= currentPos) {
                            currentBreakPointIndex++;
                        }
                        continue; // Process next part of the text
                    }
                }

                // --- If not at a structure start, find the next chunk boundary ---
                let foundBreak = false;
                while (currentBreakPointIndex < breakPoints.length) {
                    const bp = breakPoints[currentBreakPointIndex];
                    if (bp.position <= currentPos) {
                        currentBreakPointIndex++;
                        continue;
                    }

                    const potentialText = text.substring(currentPos, bp.position);
                    const tokenCount = await this.tokenEstimator.countTokens(potentialText);

                    if (tokenCount <= maxTokens) {
                        // This breakpoint works
                        chunkEndPos = bp.position;
                        foundBreak = true;
                        // Don't increment index yet, might reuse this breakpoint if overlap occurs
                        break;
                    } else {
                        // This breakpoint makes the chunk too large, stop searching breakpoints
                        break;
                    }
                }

                if (!foundBreak) {
                    // No suitable breakpoint found, or next breakpoint makes chunk too large.
                    // Force break based on maxTokens.
                    chunkEndPos = await this.findPositionByTokenLimit(text, currentPos, maxTokens);
                }

                // Ensure we make progress
                if (chunkEndPos <= currentPos) {
                    console.warn(`Worker: Chunk end position (${chunkEndPos}) not advancing from start (${currentPos}). Forcing advance.`);
                    chunkEndPos = Math.min(currentPos + 100, text.length); // Force minimal progress
                    if (chunkEndPos <= currentPos) chunkEndPos = text.length; // If still stuck, go to end
                }


                chunkText = text.substring(currentPos, chunkEndPos);

                // Add the regular chunk and null metadata
                offsets.push(currentPos);
                chunks.push(chunkText);
                parentStructureIds.push(null);
                structureOrders.push(null);
                isOversizedFlags.push(false);
                structureTypes.push(null);

                // Calculate next start position with overlap, ensuring it doesn't regress
                const nextPos = Math.max(currentPos + 1, chunkEndPos - overlapSize);
                currentPos = Math.min(nextPos, text.length); // Ensure we don't go past the end

                // Advance breakpoint index past the current chunk end
                while (currentBreakPointIndex < breakPoints.length && breakPoints[currentBreakPointIndex].position <= chunkEndPos) {
                    currentBreakPointIndex++;
                }
            }

            return { chunks, offsets, metadata: { parentStructureIds, structureOrders, isOversizedFlags, structureTypes } };
        } catch (error) {
            console.error('Error creating structure-aware chunks:', error);
            return null; // Indicate failure
        }
    }

    /**
     * Splits an oversized structure into smaller chunks, trying to respect internal boundaries.
     */
    private async splitOversizedStructure(
        structureText: string,
        language: string,
        maxTokens: number,
        overlapSize: number,
        analyzer: TreeStructureAnalyzer,
        signal: AbortSignal
    ): Promise<ChunkingResult> { // Returns simple ChunkingResult for internal use
        // TODO: Implement more sophisticated internal splitting using tree-sitter
        // For now, fallback to token-based splitting *within* the structure text
        console.log("Worker: Oversized structure splitting using token fallback.");
        const result = await this.createOptimizedTokenChunks(structureText, maxTokens, overlapSize, signal);
        // We only need chunks and relative offsets within the structureText
        return { chunks: result.chunks, offsets: result.offsets };
    }

    /**
    * Finds the end position for a chunk starting at startPos to not exceed maxTokens.
    */
    private async findPositionByTokenLimit(text: string, startPos: number, maxTokens: number): Promise<number> {
        let low = startPos;
        let high = text.length;
        let bestEndPos = startPos;

        // Estimate initial high point based on characters
        const estimatedChars = maxTokens * 5; // Generous estimate
        high = Math.min(startPos + estimatedChars, text.length);

        // Binary search for the optimal end position
        while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            if (mid <= startPos) break; // Avoid getting stuck

            const subText = text.substring(startPos, mid);
            try {
                const tokenCount = await this.tokenEstimator.countTokens(subText);

                if (tokenCount <= maxTokens) {
                    bestEndPos = mid; // This position is valid, try larger
                    low = mid + 1;
                } else {
                    high = mid - 1; // Too large, try smaller
                }
            } catch (e) {
                console.warn("Token estimation failed during binary search, reducing range.", e);
                high = mid - 1; // Reduce range on error
            }
        }
        // Ensure we return a position greater than startPos if possible
        return Math.max(bestEndPos, startPos + 1);
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
            if (lines[i] === undefined) return null;
            offset += lines[i].length + 1; // +1 for the newline
        }

        if (lines[row] === undefined || column > lines[row].length) {
            if (lines[row] !== undefined && column === lines[row].length) {
                // Valid position at end of line
            } else {
                return null;
            }
        }

        offset += column;
        return Math.min(offset, text.length);
    }

    /**
     * Create simple chunks based on character count as a fallback.
     * Returns DetailedChunkingResult with null metadata.
     */
    private createSimpleChunks(text: string, overlapSize: number): DetailedChunkingResult {
        const simpleResult = this._createSimpleChunksInternal(text, overlapSize);
        return {
            ...simpleResult,
            metadata: {
                parentStructureIds: simpleResult.chunks.map(() => null),
                structureOrders: simpleResult.chunks.map(() => null),
                isOversizedFlags: simpleResult.chunks.map(() => false),
                structureTypes: simpleResult.chunks.map(() => null),
            }
        };
    }

    /**
     * Internal simple chunking logic.
     */
    private _createSimpleChunksInternal(text: string, overlapSize: number): ChunkingResult {
        const chunks: string[] = [];
        const offsets: number[] = [];
        const charsPerToken = 4;
        const estimatedChunkSize = Math.floor(this.tokenEstimator.getSafeChunkSize() * charsPerToken);
        let position = 0;

        while (position < text.length) {
            offsets.push(position);
            let end = Math.min(position + estimatedChunkSize, text.length);

            if (end < text.length) {
                const nearbyNewline = text.lastIndexOf('\n', end);
                if (nearbyNewline > position) {
                    end = nearbyNewline + 1;
                }
            }

            chunks.push(text.substring(position, end));
            const nextPosition = Math.max(position + 1, end - overlapSize);
            position = Math.min(nextPosition, text.length);
        }
        return { chunks, offsets };
    }

    /**
     * Enhanced token-based chunking.
     * Returns DetailedChunkingResult with null metadata.
     */
    async createOptimizedTokenChunks(
        text: string,
        maxTokens: number,
        overlap: number,
        signal: AbortSignal
    ): Promise<DetailedChunkingResult> {
        // Early return for empty text
        if (!text || text.length === 0) {
            return {
                chunks: [], offsets: [], metadata: {
                    parentStructureIds: [], structureOrders: [], isOversizedFlags: [], structureTypes: []
                }
            };
        }

        const startTime = performance.now();
        const tokenizer = await this.tokenEstimator.initialize();
        const tokens = await this.tokenEstimator.tokenize(text);
        const tokenPositions = await this.mapTokensToPositions(text, tokens, tokenizer);

        if (tokens.length <= maxTokens) {
            return {
                chunks: [text], offsets: [0],
                metadata: {
                    parentStructureIds: [null], structureOrders: [null], isOversizedFlags: [false], structureTypes: [null]
                }
            };
        }

        const breakPoints = this.findCodeBreakPoints(text); // Use simple breakpoints as fallback
        console.log(`Worker (Optimized): Found ${breakPoints.length} potential break points`);

        const chunks: string[] = [];
        const offsets: number[] = [];
        let startTokenIdx = 0;

        while (startTokenIdx < tokens.length) {
            if (signal.aborted) throw new Error('Operation was cancelled');

            const targetEndTokenIdx = Math.min(startTokenIdx + maxTokens, tokens.length);

            if (targetEndTokenIdx >= tokens.length) {
                if (startTokenIdx < tokenPositions.length) { // Check if startTokenIdx is valid
                    const chunkText = text.substring(tokenPositions[startTokenIdx].start);
                    if (chunkText.trim().length > 0) {
                        chunks.push(chunkText);
                        offsets.push(tokenPositions[startTokenIdx].start);
                    }
                }
                break;
            }

            // Ensure targetEndTokenIdx-1 is a valid index
            const safeTargetEndIdx = Math.max(0, targetEndTokenIdx - 1);
            if (safeTargetEndIdx >= tokenPositions.length) {
                console.warn(`Worker: safeTargetEndIdx ${safeTargetEndIdx} out of bounds for tokenPositions (len ${tokenPositions.length}). Breaking loop.`);
                break; // Prevent out-of-bounds access
            }
            const targetCharPos = tokenPositions[safeTargetEndIdx].end;


            const searchWindow = 500;
            const bestBreakPoint = this.findBestBreakPoint(
                breakPoints,
                targetCharPos - searchWindow,
                targetCharPos + searchWindow
            );

            const breakPos = bestBreakPoint !== null ? bestBreakPoint.pos : tokenPositions[safeTargetEndIdx].end;

            // Ensure startTokenIdx is valid before accessing tokenPositions
            if (startTokenIdx >= tokenPositions.length) {
                console.warn(`Worker: startTokenIdx ${startTokenIdx} out of bounds for tokenPositions (len ${tokenPositions.length}). Breaking loop.`);
                break;
            }

            const chunkText = text.substring(tokenPositions[startTokenIdx].start, breakPos);
            if (chunkText.trim().length > 0) {
                chunks.push(chunkText);
                offsets.push(tokenPositions[startTokenIdx].start);
            }

            // Find overlap start position carefully
            const overlapCharTarget = Math.max(tokenPositions[startTokenIdx].start, breakPos - 150); // Look back ~150 chars for overlap start
            let nextStartTokenIdx = this.findTokenIndexNearPosition(
                tokenPositions,
                overlapCharTarget,
                signal
            );

            // Ensure we always make forward progress
            if (nextStartTokenIdx <= startTokenIdx) {
                nextStartTokenIdx = startTokenIdx + 1;
            }

            startTokenIdx = nextStartTokenIdx;
        }

        const endTime = performance.now();
        console.log(`Worker: Optimized token chunking completed in ${(endTime - startTime).toFixed(2)}ms - created ${chunks.length} chunks`);

        // Return DetailedChunkingResult with null metadata
        return {
            chunks,
            offsets,
            metadata: {
                parentStructureIds: chunks.map(() => null),
                structureOrders: chunks.map(() => null),
                isOversizedFlags: chunks.map(() => false),
                structureTypes: chunks.map(() => null),
            }
        };
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
                        // Be more robust with whitespace handling
                        const trimmedTokenText = tokenText.trim();
                        let tokenPos = -1;
                        let searchStart = 0;

                        // Search for trimmed version first, then original if needed
                        if (trimmedTokenText.length > 0) {
                            tokenPos = remainingText.indexOf(trimmedTokenText, searchStart);
                        }

                        // If trimmed not found, or if original token had leading/trailing space, search original
                        if (tokenPos === -1 || tokenText !== trimmedTokenText) {
                            tokenPos = remainingText.indexOf(tokenText, searchStart);
                        }


                        if (tokenPos !== -1) {
                            // Found match
                            const start = currentPos + tokenPos;
                            const end = start + tokenText.length; // Use original token length
                            positions.push({ start, end });

                            // Update positions for next token
                            currentPos = end;
                            remainingText = text.substring(currentPos); // Reset remainingText based on absolute position
                        } else {
                            // Handle the case where direct match fails
                            console.warn(`Worker: Token "${tokenText}" not found directly at pos ${currentPos}. Using fallback.`);
                            const approximatePos = this.findApproximateTokenPosition(
                                remainingText, tokenText, currentPos
                            );
                            positions.push(approximatePos);
                            currentPos = approximatePos.end;
                            remainingText = text.substring(currentPos);
                        }
                    } else {
                        // Handle empty or special token
                        positions.push({ start: currentPos, end: currentPos }); // Zero-length range for empty tokens
                    }
                } catch (error) {
                    console.warn(`Worker: Error decoding token at index ${tokenIdx}:`, error);
                    positions.push({ start: currentPos, end: currentPos + 1 }); // Fallback
                    currentPos += 1;
                    remainingText = text.substring(currentPos);
                }
            }
        }

        // Final validation and gap filling
        if (positions.length > 0) {
            let lastEnd = 0;
            for (let i = 0; i < positions.length; i++) {
                if (positions[i].start < lastEnd) {
                    positions[i].start = lastEnd;
                }
                positions[i].end = Math.max(positions[i].start, positions[i].end); // Ensure end >= start
                lastEnd = positions[i].end;
            }
        }


        if (positions.length < tokens.length) {
            console.warn(`Worker: Mapped ${positions.length} positions for ${tokens.length} tokens, filling gaps.`);
            const lastPos = positions.length > 0 ? positions[positions.length - 1] : { start: 0, end: 0 };
            while (positions.length < tokens.length) {
                positions.push({ start: lastPos.end, end: lastPos.end + 1 }); // Estimate length 1 for missing tokens
            }
        }

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
        // Simple fallback: assume token starts right after previous one
        return { start: basePos, end: basePos + Math.max(1, tokenText.length) }; // Ensure at least length 1
    }

    /**
     * Validate token positions to ensure they're within text boundaries
     */
    private validateTokenPositions(
        positions: Array<{ start: number, end: number }>,
        textLength: number
    ): void {
        let lastEnd = 0;
        for (let i = 0; i < positions.length; i++) {
            positions[i].start = Math.max(0, Math.min(positions[i].start, textLength));
            // Ensure end is at least start, and within bounds
            positions[i].end = Math.max(positions[i].start, Math.min(positions[i].end, textLength));

            // Ensure positions increase monotonically (or at least don't overlap incorrectly)
            if (positions[i].start < lastEnd) {
                console.warn(`Correcting overlapping token position at index ${i}`);
                positions[i].start = lastEnd;
                positions[i].end = Math.max(positions[i].start, positions[i].end);
            }
            lastEnd = positions[i].end;
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
        if (tokenPositions.length === 0) return 0; // Handle empty array

        // Ensure targetPos is within bounds
        targetPos = Math.max(0, Math.min(targetPos, tokenPositions[tokenPositions.length - 1].end));


        let left = 0;
        let right = tokenPositions.length - 1;
        let bestIndex = 0;

        while (left <= right) {
            if (signal.aborted) throw new Error('Operation was cancelled');
            const mid = Math.floor((left + right) / 2);

            if (tokenPositions[mid].start <= targetPos && tokenPositions[mid].end > targetPos) {
                return mid; // Exact match (targetPos is within this token)
            }

            if (tokenPositions[mid].start > targetPos) {
                right = mid - 1;
            } else {
                bestIndex = mid; // This token starts before or at targetPos, potential candidate
                left = mid + 1;
            }
        }

        // After loop, 'bestIndex' holds the index of the last token starting <= targetPos
        // Check if the next token (if exists) is closer
        if (bestIndex + 1 < tokenPositions.length) {
            const distBest = targetPos - tokenPositions[bestIndex].start;
            const distNext = tokenPositions[bestIndex + 1].start - targetPos;
            if (distNext < distBest) {
                return bestIndex + 1;
            }
        }

        return bestIndex;
    }

    /**
     * Find potential break points in code with quality ratings
     */
    private findCodeBreakPoints(text: string): Array<{ pos: number, quality: number }> {
        const breakPoints: Array<{ pos: number, quality: number }> = [];
        const patterns: Array<{ regex: RegExp, quality: number }> = [
            { regex: /}\s*\n/g, quality: 5 },
            { regex: /;\s*\n\s*\n/g, quality: 4 },
            { regex: /;\s*\n/g, quality: 3 },
            { regex: /\)\s*\{/g, quality: 2 },
            { regex: /\n\s*\n/g, quality: 1 }
        ];

        for (const { regex, quality } of patterns) {
            let match: RegExpExecArray | null;
            while ((match = regex.exec(text)) !== null) {
                breakPoints.push({ pos: match.index + match[0].length, quality });
            }
        }
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
        const startIdx = this.binarySearchBreakPoints(breakPoints, minPos);

        for (let i = startIdx; i < breakPoints.length && breakPoints[i].pos <= maxPos; i++) {
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
