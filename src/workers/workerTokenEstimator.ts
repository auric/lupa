import {
    AutoTokenizer,
    type PreTrainedTokenizer
} from '@huggingface/transformers';
import { Mutex } from 'async-mutex';
/**
 * WorkerTokenEstimator provides token counting functionality in worker threads.
 * It initializes a tokenizer for a specific model and offers methods to count tokens
 * and check if text fits within context windows.
 */
export class WorkerTokenEstimator {
    private static readonly mutex = new Mutex();
    private tokenizer: PreTrainedTokenizer | null = null;
    private readonly modelName: string;
    private readonly contextLength: number;

    /**
     * Creates a new token estimator for worker thread
     * @param modelName The model name to use for tokenization
     * @param contextLength The context length of the model in tokens
     */
    constructor(modelName: string, contextLength: number) {
        this.modelName = modelName;
        this.contextLength = contextLength;
    }

    /**
     * Initializes the tokenizer if not already initialized
     * @returns The initialized tokenizer instance
     * @throws Error if initialization fails
     */
    async initialize(): Promise<PreTrainedTokenizer> {
        if (this.tokenizer) {
            return this.tokenizer;
        }
        const releaser = await WorkerTokenEstimator.mutex.acquire();
        try {
            if (!this.tokenizer) {
                console.log(`Worker: Initializing tokenizer for ${this.modelName}`);
                this.tokenizer = await AutoTokenizer.from_pretrained(this.modelName);
            }
        } catch (error) {
            console.error(`Worker: Failed to initialize tokenizer for ${this.modelName}:`, error);
            throw new Error(`Failed to initialize tokenizer: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            releaser();
        }
        return this.tokenizer;
    }

    /**
     * Counts tokens in a piece of text
     * @param text The text to count tokens for
     * @returns The number of tokens
     * @throws Error if tokenization fails
     */
    async countTokens(text: string): Promise<number> {
        const tokenizer = await this.initialize();
        try {
            const encoded = await tokenizer.encode(text);
            return encoded.length;
        } catch (error) {
            console.error('Worker: Error counting tokens:', error);
            throw new Error(`Token counting failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Tokenize text and return the encoded version
     * @param text The text to tokenize
     * @returns The tokenized text as an array of token IDs
     * @throws Error if tokenization fails
     */
    async tokenize(text: string): Promise<number[]> {
        const tokenizer = await this.initialize();
        try {
            const encoded = await tokenizer.encode(text);
            return Array.from(encoded);
        } catch (error) {
            console.error('Worker: Error tokenizing text:', error);
            throw new Error(`Tokenization failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Checks if text will fit within the model's context length
     * @param text The text to check
     * @param safetyFactor Optional safety factor (0-1) to leave margin
     * @returns Whether the text fits within the limit
     */
    async willFitContextWindow(text: string, safetyFactor = 0.95): Promise<boolean> {
        const tokenCount = await this.countTokens(text);
        const effectiveLimit = Math.floor(this.contextLength * safetyFactor);
        return tokenCount <= effectiveLimit;
    }

    /**
     * Gets the model's context length
     * @returns The context length
     */
    getContextLength(): number {
        return this.contextLength;
    }

    /**
     * Gets a safe chunk size (tokens) based on context length
     * @param safetyFactor Safety factor (0-1) to determine how much of the context length to use
     * @returns Safe maximum chunk size in tokens
     */
    getSafeChunkSize(safetyFactor = 0.85): number {
        return Math.floor(this.contextLength * safetyFactor);
    }
}