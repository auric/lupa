import * as vscode from 'vscode';
import * as path from 'path';
import { FileToProcess } from '../types/indexingTypes';
import { EmbeddingOptions, DetailedChunkingResult } from '../types/embeddingTypes';
import { WorkerCodeChunker } from '../workers/workerCodeChunker';
import { WorkerTokenEstimator } from '../workers/workerTokenEstimator';
import { CodeAnalysisService } from './codeAnalysisService';
import { getLanguageForExtension } from '../types/types';

/**
 * Defines the options required to configure the CodeChunkingService.
 */
export interface CodeChunkingServiceOptions {
    /** The identifier of the embedding model, used for token estimation. */
    modelName: string;
    /** The maximum number of tokens the model can handle in a single context. */
    contextLength: number;
    /** Filesystem path to the extension's root directory, used for resource loading. */
    extensionPath: string;
}

/**
 * Provides functionality to divide source code files into manageable, structured chunks.
 * This service orchestrates token estimation and code analysis to produce relevant chunks
 * for further processing, such as embedding generation.
 * Implements vscode.Disposable for resource cleanup.
 */
export class CodeChunkingService implements vscode.Disposable {
    private readonly options: CodeChunkingServiceOptions;
    private workerCodeChunker: WorkerCodeChunker | null = null;
    private isInitialized: boolean = false;

    /**
     * Initializes a new instance of the CodeChunkingService.
     * @param options The configuration options for this service.
     */
    constructor(options: CodeChunkingServiceOptions) {
        this.options = options;
    }

    /**
     * Asynchronously sets up the service by initializing its internal components.
     * This includes the CodeAnalysisService and the WorkerCodeChunker.
     * Must be called successfully before `chunkFile` can be used.
     * @returns A Promise that resolves when initialization is complete, or rejects on error.
     */
    public async initialize(): Promise<void> {
        if (this.isInitialized) {
            return;
        }

        let codeAnalysisService: CodeAnalysisService | null = null;
        try {
            const tokenEstimator = new WorkerTokenEstimator(this.options.modelName, this.options.contextLength);
            codeAnalysisService = new CodeAnalysisService();
            this.workerCodeChunker = new WorkerCodeChunker(codeAnalysisService, tokenEstimator);
            this.isInitialized = true;
        } catch (error) {
            codeAnalysisService?.dispose();
            console.error('Failed to initialize CodeChunkingService:', error);
            throw error;
        }
    }

    /**
     * Processes a given file and divides its content into detailed code chunks.
     * @param file The file object containing path and content to be chunked.
     * @param embeddingOptions Options that guide the chunking process (e.g., token limits).
     * @param abortSignal An AbortSignal to allow cancellation of the chunking operation.
     * @returns A Promise resolving to a DetailedChunkingResult if successful, or null if the
     * service is not initialized, an error occurs, or the operation is aborted.
     */
    public async chunkFile(
        file: FileToProcess,
        embeddingOptions: EmbeddingOptions,
        abortSignal: AbortSignal
    ): Promise<DetailedChunkingResult | null> {
        if (!this.isInitialized || !this.workerCodeChunker) {
            console.error('CodeChunkingService is not initialized or workerCodeChunker is not available.');
            return null;
        }

        try {
            const langData = getLanguageForExtension(path.extname(file.path).substring(1));
            if (abortSignal.aborted) {
                console.log('Code chunking aborted before starting for file:', file.path);
                return null;
            }
            const result = await this.workerCodeChunker.chunkCode(
                file.content,
                langData?.language || '',
                langData?.variant,
                embeddingOptions,
                abortSignal,
            );
            return result;
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                console.log('Code chunking operation was aborted for file:', file.path);
            } else {
                console.error('Error during code chunking for file:', file.path, error);
            }
            return null;
        }
    }

    /**
     * Releases resources used by the CodeChunkingService.
     * This includes disposing of the worker code chunker.
     */
    public dispose(): void {
        this.isInitialized = false;
        this.workerCodeChunker?.dispose();
        this.workerCodeChunker = null;
        console.log('CodeChunkingService disposed.');
    }
}
