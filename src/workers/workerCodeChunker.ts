import { CodeAnalysisService } from '../services/codeAnalysisService';
import { WorkerTokenEstimator } from './workerTokenEstimator';
import type { DetailedChunkingResult, EmbeddingOptions } from '../types/embeddingTypes';
import { LANGUAGE_QUERIES } from '../config/treeSitterQueries';

export class WorkerCodeChunker {
    private static readonly MIN_CHUNK_CHARS = 1;

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
        const breakpoints = breakpointLines.map(line => this.getOffsetForLine(text, line + 1));

        if (breakpoints.length === 0) {
            return this.createBasicChunks(text, maxTokens);
        }

        const chunks: string[] = [];
        const offsets: number[] = [];
        let currentOffset = 0;

        for (const bp of [...breakpoints, text.length]) {
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

        for (const line of lines) {
            const lineWithNewline = line + '\n';
            const lineTokenCount = await this.tokenEstimator.countTokens(lineWithNewline);

            if (lineTokenCount > maxTokens) {
                if (currentChunkLines.length > 0) {
                    chunks.push(currentChunkLines.join(''));
                    offsets.push(chunkStartOffset);
                }
                chunks.push(lineWithNewline);
                offsets.push(currentCharsOffset);
                currentChunkLines = [];
                currentChunkTokenCount = 0;
            } else if (currentChunkTokenCount + lineTokenCount > maxTokens) {
                if (currentChunkLines.length > 0) {
                    chunks.push(currentChunkLines.join(''));
                    offsets.push(chunkStartOffset);
                }
                currentChunkLines = [lineWithNewline];
                currentChunkTokenCount = lineTokenCount;
                chunkStartOffset = currentCharsOffset;
            } else {
                if (currentChunkLines.length === 0) {
                    chunkStartOffset = currentCharsOffset;
                }
                currentChunkLines.push(lineWithNewline);
                currentChunkTokenCount += lineTokenCount;
            }
            currentCharsOffset += lineWithNewline.length;
        }

        if (currentChunkLines.length > 0) {
            chunks.push(currentChunkLines.join(''));
            offsets.push(chunkStartOffset);
        }

        if (chunks.length > 0) {
            const lastChunkIndex = chunks.length - 1;
            if (chunks[lastChunkIndex].endsWith('\n')) {
                chunks[lastChunkIndex] = chunks[lastChunkIndex].slice(0, -1);
            }
        }

        return this.finalizeChunks(chunks, offsets);
    }

    private getOffsetForLine(text: string, lineNum: number): number {
        const lines = text.split('\n');
        let offset = 0;
        for (let i = 0; i < lineNum - 1 && i < lines.length; i++) {
            offset += lines[i].length + 1;
        }
        return offset;
    }

    private finalizeChunks(chunks: string[], offsets: number[]): DetailedChunkingResult {
        const finalChunks: string[] = [];
        const finalOffsets: number[] = [];

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            if (chunk.trim().length >= WorkerCodeChunker.MIN_CHUNK_CHARS) {
                finalChunks.push(chunk);
                finalOffsets.push(offsets[i]);
            }
        }

        if (finalChunks.length === 0 && chunks.length > 0) {
            let largestChunk = '';
            let largestChunkOffset = 0;
            for (let i = 0; i < chunks.length; i++) {
                if (chunks[i].length > largestChunk.length) {
                    largestChunk = chunks[i];
                    largestChunkOffset = offsets[i];
                }
            }
            finalChunks.push(largestChunk);
            finalOffsets.push(largestChunkOffset);
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
