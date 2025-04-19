import * as vscode from 'vscode';
import { v4 as uuidv4 } from 'uuid'; // Import uuid
import { EmbeddingOptions, ChunkingResult, DetailedChunkingResult } from '../types/embeddingTypes'; // Import DetailedChunkingResult
import { WorkerTokenEstimator } from './workerTokenEstimator';
import { TreeStructureAnalyzer, TreeStructureAnalyzerResource } from '../services/treeStructureAnalyzer'; // Import CodeStructure

/**
 * WorkerCodeChunker provides intelligent code chunking capabilities within worker threads.
 * It respects natural code boundaries while ensuring chunks fit within token limits.
 */
export class WorkerCodeChunker implements vscode.Disposable {
    private readonly tokenEstimator: WorkerTokenEstimator;
    private readonly defaultOverlapSize = 100;
    private resource: TreeStructureAnalyzerResource | null = null;
    private analyzer: TreeStructureAnalyzer | null = null;
    private readonly MIN_CHUNK_CHARS = 40; // Minimum number of characters a chunk should have

    private readonly logLevel: 'debug' | 'info' | 'warn' | 'error' = 'info';

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
    private async getTreeStructureAnalyzer(): Promise<TreeStructureAnalyzer> {
        if (!this.analyzer) {
            this.resource = await TreeStructureAnalyzerResource.create();
            this.analyzer = this.resource.instance;
            return this.analyzer;
        }
        return this.analyzer;
    }

    /**
     * Utility method for consistent logging
     */
    private log(level: 'debug' | 'info' | 'warn' | 'error', message: string, ...args: any[]): void {
        // Only log if the level is at or above the configured log level
        const levelPriority = { debug: 0, info: 1, warn: 2, error: 3 };
        if (levelPriority[level] >= levelPriority[this.logLevel]) {
            const prefix = `WorkerCodeChunker [${level.toUpperCase()}]`;
            console[level](prefix, message, ...args);
        }
    }

    /**
     * Main chunking method - chunks code into pieces that respect natural boundaries and fit within token limits
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
        language: string,
        variant?: string
    ): Promise<DetailedChunkingResult> {
        // Start with analytical logging
        const chunkingStartTime = performance.now();
        this.log('info', `Starting code chunking${language ? ` for ${language}` : ''}, text length: ${text.length}`);

        // Handle empty content specially
        if (!text || text.length === 0) {
            return {
                chunks: [''],
                offsets: [0],
                metadata: {
                    parentStructureIds: [null],
                    structureOrders: [null],
                    isOversizedFlags: [false],
                    structureTypes: [null],
                }
            };
        }

        const overlapSize = options.overlapSize !== undefined ?
            options.overlapSize : this.defaultOverlapSize;

        const safeTokenLimit = this.tokenEstimator.getSafeChunkSize();
        try {
            // Use Tree-sitter for structure-aware chunking if language is supported
            if (language) {
                const analyzer = await this.getTreeStructureAnalyzer();

                // Check if the language is supported by Tree-sitter
                const isLanguageSupported = await analyzer.isLanguageSupported(language);

                if (isLanguageSupported) {
                    // Get the structural information using the analyzer
                    const result = await this.createStructureAwareChunks(
                        text,
                        safeTokenLimit,
                        overlapSize,
                        analyzer,
                        signal,
                        language,
                        variant
                    );

                    const duration = performance.now() - chunkingStartTime;
                    this.log('info', `Structure-aware chunking completed in ${duration.toFixed(2)}ms, created ${result.chunks.length} chunks`);

                    return result;
                }
            }
            // Fallback to basic chunking if language not supported or analyzer not available
            this.log('info', 'Using basic chunking as fallback');
            const result = await this.createBasicChunks(text, safeTokenLimit, overlapSize, signal, language);

            const duration = performance.now() - chunkingStartTime;
            this.log('info', `Basic chunking completed in ${duration.toFixed(2)}ms, created ${result.chunks.length} chunks`);

            return result;

        } catch (error) {
            this.log('error', 'Error during chunking:', error);
            if (signal.aborted) {
                throw new Error('Operation was cancelled');
            }

            // Last resort emergency fallback
            this.log('warn', 'Using emergency fallback chunking');
            return this.createEmergencyChunks(text, safeTokenLimit, overlapSize);
        }
    }

    /**
     * Creates chunks based on code structure analysis using Tree-sitter
     * Implements a recursive node-based chunking strategy
     */
    private async createStructureAwareChunks(
        text: string,
        maxTokens: number,
        overlapSize: number,
        analyzer: TreeStructureAnalyzer,
        signal: AbortSignal,
        language: string,
        variant?: string
    ): Promise<DetailedChunkingResult> {
        try {
            // Use TreeStructureAnalyzer to find all code structures
            const structures = await analyzer.findAllStructures(text, language, variant);
            this.log('debug', `Found ${structures.length} code structures in ${language} file`);

            // Initialize result containers
            const chunks: string[] = [];
            const offsets: number[] = [];
            const parentStructureIds: (string | null)[] = [];
            const structureOrders: (number | null)[] = [];
            const isOversizedFlags: boolean[] = [];
            const structureTypes: (string | null)[] = [];

            // Keep track of which parts of the text have been covered by structures
            const coveredRanges: { start: number, end: number }[] = [];

            // Process each structure
            for (const structure of structures) {
                if (signal.aborted) {
                    throw new Error('Operation was cancelled');
                }

                const startOffset = analyzer.positionToOffset(structure.range.startPosition, text)!;
                const endOffset = analyzer.positionToOffset(structure.range.endPosition, text)!;

                // Skip if this range is already covered by a previous structure
                if (this.isRangeCovered(startOffset, endOffset, coveredRanges)) {
                    continue;
                }

                const structureText = text.substring(startOffset, endOffset);
                const tokenCount = await this.tokenEstimator.countTokens(structureText);

                // If structure fits within token limit, include it as a whole
                if (tokenCount <= maxTokens) {
                    chunks.push(structureText);
                    offsets.push(startOffset);
                    parentStructureIds.push(null); // Top-level structure
                    structureOrders.push(null);
                    isOversizedFlags.push(false);
                    structureTypes.push(structure.type);

                    // Mark this range as covered
                    coveredRanges.push({ start: startOffset, end: endOffset });
                }
                // Otherwise, we need to split this large structure
                else {
                    this.log('info', `Structure of type ${structure.type} exceeds token limit (${tokenCount} tokens), splitting`);

                    // Create a unique parent ID for all chunks from this structure
                    const parentId = uuidv4();

                    // Split the oversized structure
                    const splitResult = await this.splitOversizedStructure(
                        structureText,
                        maxTokens,
                        overlapSize,
                        signal,
                        language
                    );

                    // Add each split chunk with proper metadata
                    for (let i = 0; i < splitResult.chunks.length; i++) {
                        chunks.push(splitResult.chunks[i]);
                        offsets.push(startOffset + splitResult.offsets[i]);
                        parentStructureIds.push(parentId);
                        structureOrders.push(i);
                        isOversizedFlags.push(true);
                        structureTypes.push(structure.type);
                    }

                    // Mark this range as covered
                    coveredRanges.push({ start: startOffset, end: endOffset });
                }
            }

            // Handle uncovered parts of the text
            await this.processUncoveredRanges(
                text,
                coveredRanges,
                maxTokens,
                overlapSize,
                chunks,
                offsets,
                parentStructureIds,
                structureOrders,
                isOversizedFlags,
                structureTypes,
                signal,
                language
            );

            // If no chunks were created, fall back to basic chunking
            if (chunks.length === 0) {
                this.log('warn', 'No chunks were created from structures, falling back to basic chunking');
                return this.createBasicChunks(text, maxTokens, overlapSize, signal, language);
            }

            // Post-process chunks to filter out or merge those that are too small
            const filteredResult = await this.filterSmallChunks(
                chunks,
                offsets,
                {
                    parentStructureIds,
                    structureOrders,
                    isOversizedFlags,
                    structureTypes
                },
                maxTokens
            );

            return {
                chunks: filteredResult.chunks,
                offsets: filteredResult.offsets,
                metadata: {
                    parentStructureIds: filteredResult.metadata.parentStructureIds,
                    structureOrders: filteredResult.metadata.structureOrders,
                    isOversizedFlags: filteredResult.metadata.isOversizedFlags,
                    structureTypes: filteredResult.metadata.structureTypes
                }
            };
        } catch (error) {
            this.log('error', `Error in structure-based chunking for ${language}:`, error);
            throw error;
        }
    }

    private isRangeCovered(start: number, end: number, coveredRanges: { start: number, end: number }[]): boolean {
        // A range is considered covered if it's entirely contained within any existing range
        return coveredRanges.some(range => start >= range.start && end <= range.end);
    }

    private async processUncoveredRanges(
        text: string,
        coveredRanges: { start: number, end: number }[],
        maxTokens: number,
        overlapSize: number,
        chunks: string[],
        offsets: number[],
        parentStructureIds: (string | null)[],
        structureOrders: (number | null)[],
        isOversizedFlags: boolean[],
        structureTypes: (string | null)[],
        signal: AbortSignal,
        language: string
    ): Promise<void> {
        if (coveredRanges.length === 0) {
            // If no ranges were covered, process the entire text
            const basicResult = await this.createBasicChunks(text, maxTokens, overlapSize, signal, language);
            chunks.push(...basicResult.chunks);
            offsets.push(...basicResult.offsets);
            parentStructureIds.push(...basicResult.metadata.parentStructureIds);
            structureOrders.push(...basicResult.metadata.structureOrders);
            isOversizedFlags.push(...basicResult.metadata.isOversizedFlags.map(flag => flag === null ? false : flag));
            structureTypes.push(...basicResult.metadata.structureTypes);
            return;
        }

        // Sort covered ranges by start position
        coveredRanges.sort((a, b) => a.start - b.start);

        // Find gaps between covered ranges
        let lastEnd = 0;

        for (const range of coveredRanges) {
            // If there's a gap between the last end and this start, process it
            if (range.start > lastEnd) {
                const gapText = text.substring(lastEnd, range.start);
                if (gapText.trim().length > 0) {
                    const gapResult = await this.splitTextByLines(gapText, maxTokens, overlapSize, signal, language === 'markdown');

                    // Add each gap chunk with metadata
                    for (let i = 0; i < gapResult.chunks.length; i++) {
                        chunks.push(gapResult.chunks[i]);
                        offsets.push(lastEnd + gapResult.offsets[i]);
                        parentStructureIds.push(null);
                        structureOrders.push(null);
                        isOversizedFlags.push(false);
                        structureTypes.push('gap');
                    }
                }
            }

            lastEnd = Math.max(lastEnd, range.end);
        }

        // If there's text after the last covered range, process it
        if (lastEnd < text.length) {
            const trailingText = text.substring(lastEnd);
            if (trailingText.trim().length > 0) {
                const trailingResult = await this.splitTextByLines(trailingText, maxTokens, overlapSize, signal, language === 'markdown');

                // Add each trailing chunk with metadata
                for (let i = 0; i < trailingResult.chunks.length; i++) {
                    chunks.push(trailingResult.chunks[i]);
                    offsets.push(lastEnd + trailingResult.offsets[i]);
                    parentStructureIds.push(null);
                    structureOrders.push(null);
                    isOversizedFlags.push(false);
                    structureTypes.push('trailing');
                }
            }
        }
    }

    private async splitOversizedStructure(
        text: string,
        maxTokens: number,
        overlapSize: number,
        signal: AbortSignal,
        language: string
    ): Promise<ChunkingResult> {
        // First try to split by logical boundaries like blank lines
        const boundaries = this.findLogicalBoundaries(text);

        if (boundaries.length > 1) {
            return this.splitByBoundaries(text, boundaries, maxTokens, overlapSize, signal);
        }

        // If no good boundaries found, fall back to line-based splitting, respecting markdown context
        this.log('debug', `No logical boundaries found for oversized structure, falling back to line splitting (isMarkdown: ${language === 'markdown'})`);
        return this.splitTextByLines(text, maxTokens, overlapSize, signal, language === 'markdown');
    }

    private findLogicalBoundaries(text: string): number[] {
        const boundaries: number[] = [0]; // Always include the start

        // Find blank lines (two or more newlines in a row)
        const blankLineMatches = text.matchAll(/\n\s*\n/g);
        for (const match of blankLineMatches) {
            if (match.index !== undefined) {
                boundaries.push(match.index + match[0].length);
            }
        }

        // Add large comment blocks as boundaries
        const commentBlockMatches = text.matchAll(/\/\*[\s\S]*?\*\//g);
        for (const match of commentBlockMatches) {
            if (match.index !== undefined && match[0].length > 50) {
                boundaries.push(match.index + match[0].length);
            }
        }

        // Add the end of the text
        boundaries.push(text.length);

        // Sort and deduplicate
        return [...new Set(boundaries)].sort((a, b) => a - b);
    }

    private async splitByBoundaries(
        text: string,
        boundaries: number[],
        maxTokens: number,
        overlapSize: number,
        signal: AbortSignal
    ): Promise<ChunkingResult> {
        const chunks: string[] = [];
        const offsets: number[] = [];

        let startBoundary = 0;
        let currentChunk = '';
        let currentTokens = 0;

        for (let i = 1; i < boundaries.length; i++) {
            if (signal.aborted) {
                throw new Error('Operation was cancelled');
            }

            const sectionText = text.substring(boundaries[startBoundary], boundaries[i]);
            const sectionTokens = await this.tokenEstimator.countTokens(sectionText);

            // If adding this section would exceed the token limit
            if (currentTokens + sectionTokens > maxTokens && currentChunk.length > 0) {
                // Add the current chunk
                chunks.push(currentChunk);
                offsets.push(boundaries[startBoundary]);

                // Start a new chunk from this boundary
                currentChunk = sectionText;
                currentTokens = sectionTokens;
                startBoundary = i;
            }
            // If this section alone exceeds the token limit
            else if (sectionTokens > maxTokens) {
                // If we have a current chunk, add it
                if (currentChunk.length > 0) {
                    chunks.push(currentChunk);
                    offsets.push(boundaries[startBoundary]);
                }

                // Split this large section by lines
                const splitResult = await this.splitTextByLines(sectionText, maxTokens, overlapSize, signal);

                // Add each split chunk with adjusted offsets
                for (let j = 0; j < splitResult.chunks.length; j++) {
                    chunks.push(splitResult.chunks[j]);
                    offsets.push(boundaries[i - 1] + splitResult.offsets[j]);
                }

                // Reset for next iteration
                currentChunk = '';
                currentTokens = 0;
                startBoundary = i;
            }
            // Section fits in current chunk
            else {
                currentChunk += sectionText;
                currentTokens += sectionTokens;
            }
        }

        // Add any remaining chunk
        if (currentChunk.length > 0) {
            chunks.push(currentChunk);
            offsets.push(boundaries[startBoundary]);
        }

        return { chunks, offsets };
    }

    /**
     * Split text with special handling for Markdown content
     */
    private async splitTextByLines(
        text: string,
        maxTokens: number,
        overlapSize: number,
        signal: AbortSignal,
        isMarkdown: boolean = false
    ): Promise<ChunkingResult> {
        const lines = text.split('\n');
        const chunks: string[] = [];
        const offsets: number[] = [];

        let currentChunk = '';
        let currentOffset = 0;
        let currentLineOffset = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const lineWithNewline = i < lines.length - 1 ? line + '\n' : line;
            const lineLength = lineWithNewline.length;
            const lineTokens = await this.tokenEstimator.countTokens(lineWithNewline);

            if (lineTokens > maxTokens) {
                // Line itself is too long, needs splitting
                this.log('warn', `Line ${i + 1} exceeds token limit (${lineTokens} tokens), splitting within line`);

                // Add existing chunk before splitting the long line
                if (currentChunk.length > 0) {
                    chunks.push(currentChunk);
                    offsets.push(currentOffset);
                    currentChunk = '';
                }
                currentOffset = currentLineOffset; // Reset offset to start of the long line

                // Find preferred split points *within* this line and identify inline code ranges
                const { splitPoints: lineSplitPoints, inlineCodeRanges } = this.findPreferredSplitPoints(lineWithNewline, isMarkdown);
                let linePos = 0;
                while (linePos < lineLength) {
                    if (signal.aborted) {
                        throw new Error('Operation was cancelled');
                    }

                    let bestSplitPoint = -1;
                    let searchEnd = linePos + Math.floor((lineLength - linePos) * (maxTokens / lineTokens)); // Estimate split pos

                    // Find the largest segment starting from linePos that fits maxTokens, ending at a preferred point
                    let low = 0;
                    let high = lineSplitPoints.length - 1;
                    let bestFitIndex = -1;

                    while (low <= high) {
                        const midIndex = Math.floor((low + high) / 2);
                        const point = lineSplitPoints[midIndex];
                        if (point <= linePos) { // Ensure point is after current position
                            low = midIndex + 1;
                            continue;
                        }
                        const segment = lineWithNewline.substring(linePos, point);
                        const segmentTokens = await this.tokenEstimator.countTokens(segment);
                        if (segmentTokens <= maxTokens) {
                            bestFitIndex = midIndex; // This point fits
                            low = midIndex + 1; // Try larger points
                        } else {
                            high = midIndex - 1; // Point is too far
                        }
                    }

                    if (bestFitIndex !== -1) {
                        bestSplitPoint = lineSplitPoints[bestFitIndex];
                    } else {
                        // No preferred point fits, fallback needed
                        // Find last whitespace before estimated token limit
                        let approxCharLimit = Math.floor(lineLength * (maxTokens / lineTokens));
                        let splitLimit = Math.min(linePos + approxCharLimit, lineLength);
                        bestSplitPoint = lineWithNewline.lastIndexOf(' ', splitLimit);

                        if (bestSplitPoint <= linePos) { // No whitespace found or only at the beginning
                            // Last resort: split at the approximate character limit based on tokens
                            bestSplitPoint = splitLimit > linePos ? splitLimit : linePos + 1; // Ensure progress
                        }
                        // Ensure we don't split mid-word if possible, adjust to nearest boundary
                        if (bestSplitPoint < lineLength && /\w/.test(lineWithNewline[bestSplitPoint - 1]) && /\w/.test(lineWithNewline[bestSplitPoint])) {
                            const prevSpace = lineWithNewline.lastIndexOf(' ', bestSplitPoint - 1);
                            if (prevSpace > linePos) {
                                bestSplitPoint = prevSpace + 1; // Split after the space
                            }
                            // If no prev space, we might have to split mid-word as last resort
                        }
                    }

                    // Check if the chosen fallback split point is inside an inline code block
                    if (isMarkdown && inlineCodeRanges) {
                        for (const range of inlineCodeRanges) {
                            if (bestSplitPoint > range.start && bestSplitPoint < range.end) {
                                // If inside, adjust the split point to the end of the inline code block
                                this.log('debug', `Adjusting fallback split point from ${bestSplitPoint} to ${range.end} to avoid splitting inline code`);
                                bestSplitPoint = range.end;
                                break; // Stop checking ranges once adjusted
                            }
                        }
                    }

                    // Ensure we make progress, even if it means splitting mid-word or after adjustment
                    if (bestSplitPoint <= linePos) {
                        // If still no progress (e.g., adjusted to end of range which was linePos), force progress
                        bestSplitPoint = linePos + Math.min(Math.floor(lineLength * (maxTokens / lineTokens)), lineLength - linePos);
                        bestSplitPoint = Math.max(bestSplitPoint, linePos + 1); // Guarantee progress of at least 1 char
                    }
                    bestSplitPoint = Math.min(bestSplitPoint, lineLength); // Don't exceed line length


                    const chunkText = lineWithNewline.substring(linePos, bestSplitPoint);
                    if (chunkText.length > 0) {
                        chunks.push(chunkText);
                        offsets.push(currentOffset + linePos);
                    }
                    linePos = bestSplitPoint;
                }

            } else if (await this.tokenEstimator.countTokens(currentChunk + lineWithNewline) <= maxTokens) {
                // Add line to current chunk
                currentChunk += lineWithNewline;
            } else {
                // Current chunk is full, start a new one
                if (currentChunk.length > 0) {
                    chunks.push(currentChunk);
                    offsets.push(currentOffset);
                }
                // Start new chunk with overlap if possible
                const overlapStart = Math.max(0, currentChunk.length - overlapSize);
                const overlapText = currentChunk.substring(overlapStart);
                const overlapTokens = await this.tokenEstimator.countTokens(overlapText);

                // Check if overlap + new line fits
                if (overlapTokens + lineTokens <= maxTokens && overlapText.length > 0) {
                    currentChunk = overlapText + lineWithNewline;
                    // Adjust offset back by the non-overlapped part of the previous chunk
                    currentOffset = currentLineOffset - overlapText.length + (lineWithNewline.startsWith('\n') ? 1 : 0); // Approximate, might need refinement
                } else {
                    // Overlap doesn't fit or isn't possible, start chunk with just the new line
                    currentChunk = lineWithNewline;
                    currentOffset = currentLineOffset;
                }
            }
            currentLineOffset += lineLength;
        }

        // Add the last chunk if it has content
        if (currentChunk.length > 0) {
            chunks.push(currentChunk);
            offsets.push(currentOffset);
        }

        return { chunks, offsets };
    }

    /**
     * Basic chunking approach as a fallback when structure-aware chunking fails
     */
    private async createBasicChunks(
        text: string,
        maxTokens: number,
        overlapSize: number,
        signal: AbortSignal,
        language: string // Add language parameter
    ): Promise<DetailedChunkingResult> {
        // Check if content is markdown
        const isMarkdown = language === 'markdown';
        this.log('info', `Using basic chunking as fallback${isMarkdown ? ' (markdown-aware)' : ''}`);

        let initialResult;

        if (isMarkdown) {
            // Use markdown-aware splitting even in basic mode
            this.log('info', 'Using markdown-aware line splitting for basic chunking');
            initialResult = await this.splitTextWithMarkdownAwareness(text, maxTokens, overlapSize, signal);
        } else {
            // Use simple line splitting for other basic content
            this.log('info', 'Using simple line splitting for basic chunking');
            initialResult = await this.splitTextByLines(text, maxTokens, overlapSize, signal, false); // Explicitly pass isMarkdown=false
        }

        initialResult = {
            ...initialResult,
            metadata: {
                parentStructureIds: initialResult.chunks.map(() => null),
                structureOrders: initialResult.chunks.map(() => null),
                isOversizedFlags: initialResult.chunks.map(() => false),
                structureTypes: initialResult.chunks.map(() => null)
            }
        };

        // Post-process chunks to filter out or merge those that are too small
        const filteredResult = await this.filterSmallChunks(
            initialResult.chunks,
            initialResult.offsets,
            initialResult.metadata,
            maxTokens
        );

        this.log('info', `Basic chunking post-processed: ${filteredResult.filtered} filtered, ${filteredResult.merged} merged`);

        return {
            chunks: filteredResult.chunks,
            offsets: filteredResult.offsets,
            metadata: filteredResult.metadata
        };
    }

    /**
     * Emergency fallback chunking that always works
     */
    private createEmergencyChunks(
        text: string,
        maxTokens: number,
        overlapSize: number
    ): DetailedChunkingResult {
        const chunks: string[] = [];
        const offsets: number[] = [];

        // Estimate characters per token (conservative estimate)
        const charsPerToken = 4;
        const chunkSize = Math.floor(maxTokens * charsPerToken * 0.8); // 80% to be safe

        for (let i = 0; i < text.length; i += chunkSize - overlapSize) {
            const end = Math.min(i + chunkSize, text.length);
            chunks.push(text.substring(i, end));
            offsets.push(i);
        }

        // If empty, add a single empty chunk
        if (chunks.length === 0) {
            chunks.push('');
            offsets.push(0);
        }

        return {
            chunks,
            offsets,
            metadata: {
                parentStructureIds: chunks.map(() => null),
                structureOrders: chunks.map(() => null),
                isOversizedFlags: chunks.map(() => false),
                structureTypes: chunks.map(() => null)
            }
        };
    }

    /**
     * Post-processes chunks to filter out or merge those that are too small
     * @param chunks Array of text chunks
     * @param offsets Array of chunk start offsets
     * @param metadata Metadata for all chunks
     * @param maxTokens Maximum tokens allowed per chunk
     * @returns Processed arrays with small chunks filtered or merged
     */
    private async filterSmallChunks(
        chunks: string[],
        offsets: number[],
        metadata: {
            parentStructureIds: (string | null)[];
            structureOrders: (number | null)[];
            isOversizedFlags: boolean[];
            structureTypes: (string | null)[];
        },
        maxTokens: number
    ): Promise<{
        chunks: string[];
        offsets: number[];
        metadata: {
            parentStructureIds: (string | null)[];
            structureOrders: (number | null)[];
            isOversizedFlags: boolean[];
            structureTypes: (string | null)[];
        };
        filtered: number;
        merged: number;
    }> {
        // Make copies of arrays to avoid modifying the originals during iteration
        const newChunks: string[] = [...chunks];
        const newOffsets: number[] = [...offsets];
        const newParentStructureIds: (string | null)[] = [...metadata.parentStructureIds];
        const newStructureOrders: (number | null)[] = [...metadata.structureOrders];
        const newIsOversizedFlags: boolean[] = [...metadata.isOversizedFlags];
        const newStructureTypes: (string | null)[] = [...metadata.structureTypes];

        // Track indexes to remove after processing
        const indexesToRemove: number[] = [];
        let filteredCount = 0;
        let mergedCount = 0;

        // Process each chunk
        for (let i = 0; i < newChunks.length; i++) {
            const chunk = newChunks[i];
            const trimmedChunk = chunk.trim();

            // Check if chunk is empty or only whitespace
            if (trimmedChunk.length === 0) {
                indexesToRemove.push(i);
                filteredCount++;
                this.log('debug', `Filtering chunk #${i} - empty or whitespace only`);
                continue;
            }

            // Check if chunk is smaller than minimum size
            if (trimmedChunk.length < this.MIN_CHUNK_CHARS) {
                // Try to merge with previous chunk first
                if (i > 0 && !indexesToRemove.includes(i - 1)) {
                    const prevChunk = newChunks[i - 1];
                    const combinedChunk = prevChunk + chunk;

                    // Check if combined chunk fits within token limit
                    const combinedTokens = await this.tokenEstimator.countTokens(combinedChunk);

                    if (combinedTokens <= maxTokens) {
                        // Merge with previous chunk
                        newChunks[i - 1] = combinedChunk;

                        // Mark if mixed structure types
                        if (newStructureTypes[i] !== newStructureTypes[i - 1]) {
                            newStructureTypes[i - 1] = 'mixed';
                        }

                        // If either chunk was oversized, the combined chunk is oversized
                        newIsOversizedFlags[i - 1] = newIsOversizedFlags[i - 1] || newIsOversizedFlags[i];

                        indexesToRemove.push(i);
                        mergedCount++;
                        this.log('debug', `Merged small chunk #${i} with previous chunk #${i - 1}`);
                        continue;
                    }
                }

                // If can't merge with previous, try with next chunk
                if (i < newChunks.length - 1 && !indexesToRemove.includes(i + 1)) {
                    const nextChunk = newChunks[i + 1];
                    const combinedChunk = chunk + nextChunk;

                    // Check if combined chunk fits within token limit
                    const combinedTokens = await this.tokenEstimator.countTokens(combinedChunk);

                    if (combinedTokens <= maxTokens) {
                        // Merge with next chunk
                        newChunks[i + 1] = combinedChunk;
                        newOffsets[i + 1] = newOffsets[i]; // Update offset to start at current chunk

                        // Mark if mixed structure types
                        if (newStructureTypes[i] !== newStructureTypes[i + 1]) {
                            newStructureTypes[i + 1] = 'mixed';
                        }

                        // If either chunk was oversized, the combined chunk is oversized
                        newIsOversizedFlags[i + 1] = newIsOversizedFlags[i + 1] || newIsOversizedFlags[i];

                        indexesToRemove.push(i);
                        mergedCount++;
                        this.log('debug', `Merged small chunk #${i} with next chunk #${i + 1}`);
                        continue;
                    }
                }

                // If we can't merge with either, consider discarding if very small
                if (trimmedChunk.length < this.MIN_CHUNK_CHARS / 2) {
                    indexesToRemove.push(i);
                    filteredCount++;
                    this.log('warn', `Discarded very small chunk #${i} (${trimmedChunk.length} chars) that couldn't be merged`);
                    continue;
                }

                // Otherwise, keep the small chunk as a last resort
                this.log('info', `Keeping small chunk #${i} (${trimmedChunk.length} chars) as it couldn't be merged`);
            }
        }        // Remove marked indexes in reverse order to avoid shifting issues
        indexesToRemove.sort((a, b) => b - a);
        for (const index of indexesToRemove) {
            newChunks.splice(index, 1);
            newOffsets.splice(index, 1);
            newParentStructureIds.splice(index, 1);
            newStructureOrders.splice(index, 1);
            newIsOversizedFlags.splice(index, 1);
            newStructureTypes.splice(index, 1);
        }

        // Special handling for the case when filtering has removed all chunks
        // Always ensure we return at least one chunk, even if it's smaller than MIN_CHUNK_CHARS
        if (newChunks.length === 0 && chunks.length > 0) {
            this.log('info', `Restoring small chunk as it's the only content available`);
            // Find the smallest index that wasn't removed (or the first one if all were marked)
            const smallestIndex = indexesToRemove.length === chunks.length
                ? 0
                : indexesToRemove.sort((a, b) => a - b).find((val, idx) => val !== idx) || 0;

            newChunks.push(chunks[smallestIndex]);
            newOffsets.push(offsets[smallestIndex]);
            newParentStructureIds.push(metadata.parentStructureIds[smallestIndex]);
            newStructureOrders.push(metadata.structureOrders[smallestIndex]);
            newIsOversizedFlags.push(metadata.isOversizedFlags[smallestIndex]);
            newStructureTypes.push(metadata.structureTypes[smallestIndex]);
        }

        return {
            chunks: newChunks,
            offsets: newOffsets,
            metadata: {
                parentStructureIds: newParentStructureIds,
                structureOrders: newStructureOrders,
                isOversizedFlags: newIsOversizedFlags,
                structureTypes: newStructureTypes
            },
            filtered: filteredCount,
            merged: mergedCount
        };
    }

    /**
     * Find preferred split points in text based on syntax-aware boundaries
     * @param text The text to analyze for split points
     * @param forceMarkdown Force the text to be processed as Markdown
     * @returns Object containing an array of split point indices and an array of inline code ranges
     */
    private findPreferredSplitPoints(text: string, forceMarkdown: boolean = false): { splitPoints: number[], inlineCodeRanges: { start: number, end: number }[] } {
        const splitPoints: number[] = [];
        const inlineCodeRanges: { start: number, end: number }[] = [];

        // Check if the text appears to be markdown or if it's explicitly flagged as markdown
        const isMarkdown = forceMarkdown ||
            /^(#|\*|-|\d+\.|>|\s*```|\s*~~~|\|)|\[.*\]\(.*\)|^\s*\*\*.*\*\*|^\s*_.*_/m.test(text);

        const wordBoundaryMatches = text.matchAll(/\b\w+\b/g);
        for (const match of wordBoundaryMatches) {
            if (match.index !== undefined) {
                splitPoints.push(match.index + match[0].length);
            }
        }

        if (isMarkdown) {
            // Markdown-specific split points
            // Avoid splitting in the middle of code blocks
            const codeBlockBoundaries = [...text.matchAll(/```|~~~|\b`[^`]*`\b/g)];
            for (const match of codeBlockBoundaries) {
                if (match.index !== undefined) {
                    // Add split point before code block markers
                    if (match.index > 0) {
                        splitPoints.push(match.index);
                    }
                    // Add split point after code block markers
                    splitPoints.push(match.index + match[0].length);
                }
            }

            // Avoid splitting inline code
            const inlineCode = [...text.matchAll(/`[^`]*`/g)]; // Allow empty/whitespace content
            for (const match of inlineCode) {
                if (match.index !== undefined) {
                    // Store the range of the inline code itself to prevent splitting *within* it later
                    inlineCodeRanges.push({ start: match.index, end: match.index + match[0].length });
                    // DO NOT add split points immediately before/after inline code,
                    // as the test expects these boundaries not to be split points.
                }
            }

            // Avoid splitting table structure
            const tableRows = [...text.matchAll(/^\|.*\|$/gm)];
            for (const match of tableRows) {
                if (match.index !== undefined) {
                    // Add split points at the beginning and end of each table row
                    if (match.index > 0) {
                        splitPoints.push(match.index);
                    }
                    splitPoints.push(match.index + match[0].length);
                }
            }

            // Split after paragraphs (blank lines)
            const paragraphBoundaries = [...text.matchAll(/\n\s*\n/g)];
            for (const match of paragraphBoundaries) {
                if (match.index !== undefined) {
                    splitPoints.push(match.index + match[0].length);
                }
            }

            // Split after headings
            const headings = [...text.matchAll(/^#+\s+.*$/gm)];
            for (const match of headings) {
                if (match.index !== undefined && match.index + match[0].length < text.length) {
                    splitPoints.push(match.index + match[0].length);
                }
            }

            // Split after list items
            const listItems = [...text.matchAll(/^(\s*[-*+]|\s*\d+\.)\s+.*$/gm)];
            for (const match of listItems) {
                if (match.index !== undefined && match.index + match[0].length < text.length) {
                    splitPoints.push(match.index + match[0].length);
                }
            }

            // Avoid splitting markdown links [text](url)
            const links = [...text.matchAll(/\[(?:[^\[\]]|\[[^\[\]]*\])*\]\([^()]*\)/g)];
            for (const match of links) {
                if (match.index !== undefined) {
                    // Add split points before and after links
                    if (match.index > 0) {
                        splitPoints.push(match.index);
                    }
                    splitPoints.push(match.index + match[0].length);
                }
            }

            // Avoid splitting YAML frontmatter blocks
            const frontmatterMatches = text.match(/^---\n[\s\S]*?\n---/);
            if (frontmatterMatches && frontmatterMatches.index !== undefined) {
                splitPoints.push(frontmatterMatches.index + frontmatterMatches[0].length);
            }
        } else {
            // Standard code handling for non-markdown content
            // Attempt 1: Find statement boundaries (semicolons, braces) and sentence endings in comments
            const statementBoundaries = [...text.matchAll(/[;](?=\s|$)|[}](?=\s|$)|(?<=\/\/.*)[.!?](?=\s|$)|(?<=\/\*.*)[.!?](?=\s|\*\/|$)/g)];
            for (const match of statementBoundaries) {
                if (match.index !== undefined) {
                    splitPoints.push(match.index + 1); // After the boundary character
                }
            }

            // Attempt 2: Find whitespace sequences that follow complete words (prioritize after statements)
            // This ensures we don't split in the middle of words
            const wordBoundaries = [...text.matchAll(/\b\s+/g)];
            for (const match of wordBoundaries) {
                if (match.index !== undefined) {
                    splitPoints.push(match.index + match[0].length); // After the whitespace
                }
            }

            // Attempt 3: Find operators and punctuation, avoiding multi-char operators and opening brackets
            // Pattern matches common operators/punctuation not followed by characters that would make them multi-char operators
            // Explicitly exclude opening brackets/braces/parentheses
            const operatorsAndPunctuation = [...text.matchAll(/(?<![\+\-\*\/\=\:\,\<\>])[\+\-\*\/\=\:\,\]\>\)](?![\+\-\=\>])/g)];
            for (const match of operatorsAndPunctuation) {
                if (match.index !== undefined) {
                    splitPoints.push(match.index + 1); // After the operator/punctuation
                }
            }

            // Attempt 4: Add newlines as potential split points if they're after a complete statement/expression
            const newlines = [...text.matchAll(/[^{([;]\n/g)];
            for (const match of newlines) {
                if (match.index !== undefined) {
                    splitPoints.push(match.index + 1); // After the character before newline
                }
            }
        }

        // Remove duplicates and sort, then filter out points inside inline code if markdown
        let finalSplitPoints = [...new Set(splitPoints)].sort((a, b) => a - b);

        if (isMarkdown) {
            finalSplitPoints = finalSplitPoints.filter(point => {
                // Check if the point falls strictly inside any inline code range
                return !inlineCodeRanges.some(range => point > range.start && point < range.end);
            });
        }

        return { splitPoints: finalSplitPoints, inlineCodeRanges };
    }

    /**
     * Split text with special handling for Markdown content
     * This method ensures that markdown structures like code blocks and tables stay intact
     */
    private async splitTextWithMarkdownAwareness(
        text: string,
        maxTokens: number,
        overlapSize: number,
        signal: AbortSignal
    ): Promise<ChunkingResult> {
        // First, let's identify markdown structures that should be kept together
        const structures: { start: number, end: number, type: string }[] = [];        // Find code blocks
        const codeBlocks = [...text.matchAll(/```[\s\S]*?```|~~~[\s\S]*?~~~/g)];
        for (const match of codeBlocks) {
            if (match.index !== undefined) {
                structures.push({
                    start: match.index,
                    end: match.index + match[0].length,
                    type: 'codeBlock'
                });
            }
        }

        // Find inline code with backticks
        const inlineCodes = [...text.matchAll(/`[^`\n]*`/g)];
        for (const match of inlineCodes) {
            if (match.index !== undefined) {
                structures.push({
                    start: match.index,
                    end: match.index + match[0].length,
                    type: 'inlineCode'
                });
            }
        }

        // Find tables
        const tables = [...text.matchAll(/(^\|.*\|$\n)+/gm)];
        for (const match of tables) {
            if (match.index !== undefined) {
                structures.push({
                    start: match.index,
                    end: match.index + match[0].length,
                    type: 'table'
                });
            }
        }

        // Find headers with content up to next header or blank line
        const headers = [...text.matchAll(/^#{1,6}\s+.*$/gm)];
        for (let i = 0; i < headers.length; i++) {
            const match = headers[i];
            if (match.index !== undefined) {
                const start = match.index;
                let end;

                if (i < headers.length - 1 && headers[i + 1].index !== undefined) {
                    // End at the next header
                    end = headers[i + 1].index;
                } else {
                    // End at the next blank line or end of text
                    const nextBlank = text.indexOf('\n\n', match.index);
                    end = nextBlank > -1 ? nextBlank + 2 : text.length;
                }

                structures.push({
                    start,
                    end,
                    type: 'header'
                });
            }
        }

        // Sort structures by start position
        structures.sort((a, b) => a.start - b.start);

        // Merge overlapping structures
        const mergedStructures: { start: number, end: number, type: string }[] = [];
        if (structures.length > 0) {
            let current = structures[0];

            for (let i = 1; i < structures.length; i++) {
                if (structures[i].start <= current.end) {
                    // Structures overlap, merge them
                    current = {
                        start: current.start,
                        end: Math.max(current.end, structures[i].end),
                        type: `${current.type}+${structures[i].type}`
                    };
                } else {
                    // No overlap, add current to result and update current
                    mergedStructures.push(current);
                    current = structures[i];
                }
            }

            // Add the last structure
            mergedStructures.push(current);
        }

        // Now chunk the text respecting these structures
        const chunks: string[] = [];
        const offsets: number[] = [];

        let lastEnd = 0;

        // Process each structure and text between structures
        for (const structure of mergedStructures) {
            if (signal.aborted) {
                throw new Error('Operation was cancelled');
            }

            // Process text before this structure if any
            if (structure.start > lastEnd) {
                const textBefore = text.substring(lastEnd, structure.start);
                if (textBefore.trim().length > 0) {
                    // Use line-based splitting for text between structures
                    const beforeResult = await this.splitTextByLines(textBefore, maxTokens, overlapSize, signal, true);

                    for (let i = 0; i < beforeResult.chunks.length; i++) {
                        chunks.push(beforeResult.chunks[i]);
                        offsets.push(lastEnd + beforeResult.offsets[i]);
                    }
                }
            }

            // Process the structure itself
            const structureText = text.substring(structure.start, structure.end);
            const structureTokens = await this.tokenEstimator.countTokens(structureText);

            if (structureTokens <= maxTokens) {
                // Structure fits in a single chunk
                chunks.push(structureText);
                offsets.push(structure.start);
            } else {
                // Structure is too large, need to split it while respecting markdown syntax
                // Use findPreferredSplitPoints to get optimal split locations and inline code ranges
                const { splitPoints, inlineCodeRanges } = this.findPreferredSplitPoints(structureText, true); // Force markdown true here

                let position = 0;
                while (position < structureText.length) {
                    // Get remaining text
                    const remaining = structureText.substring(position);

                    // Find best split point
                    let splitPosition = Math.min(remaining.length, Math.floor(maxTokens / 3));

                    if (splitPoints.length > 0) {
                        // Binary search for best split point that fits token limit
                        let left = 0;
                        let right = splitPoints.length - 1;

                        while (left <= right) {
                            const mid = Math.floor((left + right) / 2);
                            const point = splitPoints[mid];

                            if (point >= remaining.length) {
                                right = mid - 1;
                                continue;
                            }

                            const chunk = remaining.substring(0, point);
                            const tokens = await this.tokenEstimator.countTokens(chunk);

                            if (tokens <= maxTokens) {
                                splitPosition = point;
                                left = mid + 1;
                            } else {
                                right = mid - 1;
                            }
                        }
                    }

                    // Check if the chosen split point is inside an inline code block within the structure
                    for (const range of inlineCodeRanges) {
                        // Adjust range to be relative to the structureText start (which is 0)
                        const relativeStart = range.start - structure.start;
                        const relativeEnd = range.end - structure.start;
                        if (splitPosition > relativeStart && splitPosition < relativeEnd) {
                            this.log('debug', `Adjusting structure split point from ${splitPosition} to ${relativeEnd} to avoid splitting inline code`);
                            splitPosition = relativeEnd;
                            break;
                        }
                    }

                    // Ensure progress even after adjustment
                    if (splitPosition <= 0) {
                        splitPosition = Math.min(remaining.length, Math.floor(maxTokens / 3)); // Revert to basic split if adjustment failed
                        splitPosition = Math.max(splitPosition, 1); // Ensure at least 1 char progress
                    }
                    splitPosition = Math.min(splitPosition, remaining.length); // Don't exceed remaining length


                    // Add chunk
                    const chunk = remaining.substring(0, splitPosition);
                    chunks.push(chunk);
                    offsets.push(structure.start + position);

                    position += splitPosition;
                }
            }

            lastEnd = structure.end;
        }

        // Process any remaining text after the last structure
        if (lastEnd < text.length) {
            const remaining = text.substring(lastEnd);
            if (remaining.trim().length > 0) {
                const remainingResult = await this.splitTextByLines(remaining, maxTokens, overlapSize, signal, true);

                for (let i = 0; i < remainingResult.chunks.length; i++) {
                    chunks.push(remainingResult.chunks[i]);
                    offsets.push(lastEnd + remainingResult.offsets[i]);
                }
            }
        }

        // Handle empty result case
        if (chunks.length === 0) {
            chunks.push(text);
            offsets.push(0);
        }

        return { chunks, offsets };
    }

    /**
     * Dispose resources
     */
    dispose() {
        this.resource?.dispose();
        this.resource = null;
        this.analyzer = null;
    }
}
