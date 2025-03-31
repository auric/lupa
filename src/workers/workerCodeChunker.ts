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
        language?: string
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
                this.log('info', `Using structure-aware chunking for ${language}`);

                // Get the structural information using the analyzer
                const result = await this.createStructureAwareChunks(
                    text,
                    language,
                    safeTokenLimit,
                        overlapSize,
                        analyzer,
                        signal
                    );

                const duration = performance.now() - chunkingStartTime;
                this.log('info', `Structure-aware chunking completed in ${duration.toFixed(2)}ms, created ${result.chunks.length} chunks`);

                return result;
            }

            // Fallback to basic chunking if language not supported or analyzer not available
            this.log('info', 'Using basic chunking as fallback');
            const result = await this.createBasicChunks(text, safeTokenLimit, overlapSize, signal);

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
        language: string,
        maxTokens: number,
        overlapSize: number,
        analyzer: TreeStructureAnalyzer,
        signal: AbortSignal
    ): Promise<DetailedChunkingResult> {
        try {
            // Use TreeStructureAnalyzer to find all code structures
            const structures = await analyzer.findAllStructures(text, language);
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
                        signal
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
                signal
            );

            // If no chunks were created, fall back to basic chunking
            if (chunks.length === 0) {
                this.log('warn', 'No chunks were created from structures, falling back to basic chunking');
                return this.createBasicChunks(text, maxTokens, overlapSize, signal);
            }

            return {
                chunks,
                offsets,
                metadata: {
                    parentStructureIds,
                    structureOrders,
                    isOversizedFlags,
                    structureTypes
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
        signal: AbortSignal
    ): Promise<void> {
        if (coveredRanges.length === 0) {
            // If no ranges were covered, process the entire text
            const basicResult = await this.createBasicChunks(text, maxTokens, overlapSize, signal);
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
                    const gapResult = await this.splitTextByLines(gapText, maxTokens, overlapSize, signal);

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
                const trailingResult = await this.splitTextByLines(trailingText, maxTokens, overlapSize, signal);

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
        signal: AbortSignal
    ): Promise<ChunkingResult> {
        // First try to split by logical boundaries like blank lines
        const boundaries = this.findLogicalBoundaries(text);

        if (boundaries.length > 1) {
            return this.splitByBoundaries(text, boundaries, maxTokens, overlapSize, signal);
        }

        // If no good boundaries found, fall back to line-based splitting
        return this.splitTextByLines(text, maxTokens, overlapSize, signal);
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
     * Split text by lines trying to respect token limits
     */
    private async splitTextByLines(
        text: string,
        maxTokens: number,
        overlapSize: number,
        signal: AbortSignal
    ): Promise<ChunkingResult> {
        const chunks: string[] = [];
        const offsets: number[] = [];

        // Split the text into lines
        const lines = text.split(/\r?\n/);
        let currentChunk: string[] = [];
        let currentOffset = 0;
        let currentTokens = 0;

        for (let i = 0; i < lines.length; i++) {
            if (signal.aborted) throw new Error('Operation was cancelled');

            const line = lines[i] + (i < lines.length - 1 ? '\n' : '');
            const lineTokens = await this.tokenEstimator.countTokens(line);

            // If a single line exceeds token limit, split it by characters
            if (lineTokens > maxTokens) {
                // Add current chunk if not empty
                if (currentChunk.length > 0) {
                    const chunk = currentChunk.join('');
                    chunks.push(chunk);
                    offsets.push(currentOffset);
                    currentChunk = [];
                    currentTokens = 0;
                }

                // Split the long line
                let startChar = 0;
                let textOffset = 0;
                for (let j = 0; j < line.length; j += maxTokens / 2) {
                    const endChar = Math.min(j + maxTokens / 2, line.length);
                    const segment = line.substring(startChar, endChar);

                    chunks.push(segment);
                    offsets.push(currentOffset + textOffset);

                    textOffset += segment.length;
                    startChar = endChar;
                }

                currentOffset += line.length;
            }
            // If adding this line would exceed token limit
            else if (currentTokens + lineTokens > maxTokens && currentChunk.length > 0) {
                // Add current chunk
                const chunk = currentChunk.join('');
                chunks.push(chunk);
                offsets.push(currentOffset);

                // Start new chunk with this line
                currentChunk = [line];
                currentTokens = lineTokens;
                currentOffset += chunk.length;
            }
            // Line fits in current chunk
            else {
                currentChunk.push(line);
                currentTokens += lineTokens;
            }
        }

        // Add final chunk if not empty
        if (currentChunk.length > 0) {
            const chunk = currentChunk.join('');
            chunks.push(chunk);
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
        signal: AbortSignal
    ): Promise<DetailedChunkingResult> {
        return this.splitTextByLines(text, maxTokens, overlapSize, signal).then(result => ({
            ...result,
            metadata: {
                parentStructureIds: result.chunks.map(() => null),
                structureOrders: result.chunks.map(() => null),
                isOversizedFlags: result.chunks.map(() => false),
                structureTypes: result.chunks.map(() => null)
            }
        }));
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
     * Dispose resources
     */
    dispose() {
        this.resource?.dispose();
        this.resource = null;
        this.analyzer = null;
    }
}
