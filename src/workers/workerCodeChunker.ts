import { CodeAnalysisService } from '../services/codeAnalysisService';
import { WorkerTokenEstimator } from './workerTokenEstimator';
import type { DetailedChunkingResult, EmbeddingOptions } from '../types/embeddingTypes';
import { LANGUAGE_QUERIES } from '../config/treeSitterQueries';

export class WorkerCodeChunker {
    private static readonly MIN_CHUNK_CHARS = 0;

    constructor(
        private readonly codeAnalysisService: CodeAnalysisService,
        private readonly tokenEstimator: WorkerTokenEstimator
    ) { }

    public async chunkCode(
        text: string,
        language: string,
        variant: string | undefined,
        options: EmbeddingOptions,
        signal: AbortSignal
    ): Promise<DetailedChunkingResult> {
        if (!text || text.trim().length === 0) {
            return this.createEmptyResult();
        }

        const maxTokens = this.tokenEstimator.getSafeChunkSize();

        try {
            if (language === 'markdown') {
                return await this.createMarkdownChunks(text, maxTokens, signal);
            }
            if (LANGUAGE_QUERIES[language]) {
                return await this.createStructureAwareChunks(text, language, variant, maxTokens, signal);
            }
        } catch (error) {
            console.error(`Advanced chunking failed for language ${language}. Falling back.`, error);
            if (signal.aborted) throw new Error('Operation cancelled');
        }
        return this.createBasicChunks(text, maxTokens);
    }

    private async createStructureAwareChunks(text: string, language: string, variant: string | undefined, maxTokens: number, signal: AbortSignal): Promise<DetailedChunkingResult> {
        const breakpointLines = await this.codeAnalysisService.getLinesForPointsOfInterest(text, language, variant);

        // Optimization: pre-calculate line offsets to avoid repeated text.split()
        const lines = text.split('\n');
        const lineOffsets: number[] = [0];
        for (let i = 0; i < lines.length; i++) {
            lineOffsets.push(lineOffsets[i] + lines[i].length + 1);
        }
        const breakpoints = breakpointLines.map(line => lineOffsets[line] ?? text.length);

        if (breakpoints.length === 0) {
            return this.createBasicChunks(text, maxTokens);
        }

        const chunks: string[] = [];
        const offsets: number[] = [];
        // Start chunking from the first identified breakpoint.
        // This correctly ignores any "header" content like imports if they are not points of interest.
        let currentOffset = breakpoints[0];

        for (const bp of [...breakpoints.slice(1), text.length]) {
            if (signal.aborted) throw new Error('Operation cancelled');
            if (bp <= currentOffset) continue;

            const segment = text.substring(currentOffset, bp);
            const tokenCount = await this.tokenEstimator.countTokens(segment);

            if (tokenCount <= maxTokens) {
                chunks.push(segment);
                offsets.push(currentOffset);
            } else {
                const subChunks = await this.createBasicChunks(segment, maxTokens);
                subChunks.chunks.forEach((sc, i) => {
                    chunks.push(sc);
                    offsets.push(currentOffset + subChunks.offsets[i]);
                });
            }
            currentOffset = bp;
        }

        return this.finalizeChunks(chunks, offsets);
    }

    private async createMarkdownChunks(text: string, maxTokens: number, signal: AbortSignal): Promise<DetailedChunkingResult> {
        const chunks: string[] = [];
        const offsets: number[] = [];
        let currentOffset = 0;

        const paragraphs = text.split(/\n\s*\n/);

        for (const p of paragraphs) {
            if (signal.aborted) throw new Error('Operation cancelled');
            const trimmedP = p.trim();
            if (trimmedP.length === 0) {
                currentOffset += p.length + (text.substring(currentOffset + p.length).match(/^\s*\n/) || [''])[0].length;
                continue;
            }

            const tokenCount = await this.tokenEstimator.countTokens(p);
            if (tokenCount <= maxTokens) {
                chunks.push(p);
                offsets.push(currentOffset);
            } else {
                const subChunks = await this.createBasicChunks(p, maxTokens);
                subChunks.chunks.forEach((sc, i) => {
                    chunks.push(sc);
                    offsets.push(currentOffset + subChunks.offsets[i]);
                });
            }
            currentOffset += p.length + (text.substring(currentOffset + p.length).match(/^\s*\n/) || [''])[0].length;
        }

        return this.finalizeChunks(chunks, offsets);
    }

    private async createBasicChunks(text: string, maxTokens: number): Promise<DetailedChunkingResult> {
        const chunks: string[] = [];
        const offsets: number[] = [];
        const lines = text.split('\n');
        let currentChunkLines: string[] = [];
        let currentChunkTokenCount = 0;
        let chunkStartOffset = 0;
        let currentCharsOffset = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            // Re-add the newline for accurate token counting, except for the last line.
            const lineWithNewline = i === lines.length - 1 ? line : line + '\n';
            const lineTokenCount = await this.tokenEstimator.countTokens(lineWithNewline);

            if (lineTokenCount > maxTokens) {
                // If the current chunk has content, push it.
                if (currentChunkLines.length > 0) {
                    chunks.push(currentChunkLines.join('\n'));
                    offsets.push(chunkStartOffset);
                }
                // Push the oversized line as its own chunk.
                chunks.push(line);
                offsets.push(currentCharsOffset);
                // Reset the current chunk.
                currentChunkLines = [];
                currentChunkTokenCount = 0;
            } else if (currentChunkTokenCount + lineTokenCount > maxTokens) {
                // Push the completed chunk.
                if (currentChunkLines.length > 0) {
                    chunks.push(currentChunkLines.join('\n'));
                    offsets.push(chunkStartOffset);
                }
                // Start a new chunk with the current line.
                currentChunkLines = [line];
                currentChunkTokenCount = lineTokenCount;
                chunkStartOffset = currentCharsOffset;
            } else {
                // Add the line to the current chunk.
                if (currentChunkLines.length === 0) {
                    chunkStartOffset = currentCharsOffset;
                }
                currentChunkLines.push(line);
                currentChunkTokenCount += lineTokenCount;
            }
            currentCharsOffset += lineWithNewline.length;
        }

        // Push any remaining content in the last chunk.
        if (currentChunkLines.length > 0) {
            chunks.push(currentChunkLines.join('\n'));
            offsets.push(chunkStartOffset);
        }

        return this.finalizeChunks(chunks, offsets);
    }


    private trimCommonLeadingWhitespace(lines: string[]): string[] {
        if (lines.length === 0) {
            return [];
        }

        let commonPrefix = lines[0].match(/^\s*/)?.[0] ?? '';
        for (let i = 1; i < lines.length; i++) {
            if (lines[i].trim() === '') continue; // Ignore empty lines for prefix calculation
            const linePrefix = lines[i].match(/^\s*/)?.[0] ?? '';
            while (!linePrefix.startsWith(commonPrefix)) {
                commonPrefix = commonPrefix.slice(0, -1);
            }
            if (commonPrefix === '') break;
        }

        if (commonPrefix.length > 0) {
            return lines.map(line => line.startsWith(commonPrefix) ? line.substring(commonPrefix.length) : line);
        }

        return lines;
    }

    private finalizeChunks(chunks: string[], offsets: number[]): DetailedChunkingResult {
        const finalChunks: string[] = [];
        const finalOffsets: number[] = [];

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const chunkOffset = offsets[i];

            const lines = chunk.split('\n');
            let firstLineIdx = 0;
            while (firstLineIdx < lines.length && lines[firstLineIdx].trim() === '') {
                firstLineIdx++;
            }

            let lastLineIdx = lines.length - 1;
            while (lastLineIdx >= firstLineIdx && lines[lastLineIdx].trim() === '') {
                lastLineIdx--;
            }

            if (firstLineIdx > lastLineIdx) {
                continue; // Skip chunks that are only whitespace
            }

            const contentLines = lines.slice(firstLineIdx, lastLineIdx + 1);
            const dedentedLines = this.trimCommonLeadingWhitespace(contentLines);
            const finalChunkText = dedentedLines.join('\n');

            if (finalChunkText.length > WorkerCodeChunker.MIN_CHUNK_CHARS) {
                // Recalculate the offset to account for the trimmed leading empty lines.
                let newOffset = chunkOffset;
                for (let j = 0; j < firstLineIdx; j++) {
                    newOffset += lines[j].length + 1; // +1 for the newline
                }

                finalChunks.push(finalChunkText);
                finalOffsets.push(newOffset);
            }
        }

        if (finalChunks.length === 0) {
            return this.createEmptyResult();
        }

        return {
            chunks: finalChunks,
            offsets: finalOffsets,
            metadata: {
                parentStructureIds: finalChunks.map(() => null),
                structureOrders: finalChunks.map(() => null),
                isOversizedFlags: finalChunks.map(() => false),
                structureTypes: finalChunks.map(() => null),
            }
        };
    }

    private createEmptyResult(): DetailedChunkingResult {
        return {
            chunks: [],
            offsets: [],
            metadata: {
                parentStructureIds: [],
                structureOrders: [],
                isOversizedFlags: [],
                structureTypes: [],
            }
        };
    }

    public dispose(): void {
        this.codeAnalysisService.dispose();
    }
}
