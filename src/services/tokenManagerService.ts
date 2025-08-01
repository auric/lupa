import { CopilotModelManager } from '../models/copilotModelManager';
import type { AnalysisMode } from '../types/modelTypes';
import type {
    ContextSnippet,
    ContentPrioritization,
    TokenComponents,
    TokenAllocation,
    TruncatedTokenComponents,
    OptimizationResult
} from '../types/contextTypes';
import { PromptGenerator } from '../models/promptGenerator';
import { TokenCalculator } from '../models/tokenCalculator';
import { WaterfallTruncator } from '../models/waterfallTruncator';
import { ContextOptimizer } from '../models/contextOptimizer';

/**
 * Service for managing token calculations and optimizations
 * Acts as a coordinator that delegates to specialized token management classes
 *
 * This refactored service maintains the same public API while delegating
 * responsibilities to focused, single-purpose classes:
 * - TokenCalculator: Token allocation and calculation logic
 * - WaterfallTruncator: Advanced truncation algorithms
 * - ContextOptimizer: Snippet selection and optimization
 */
export class TokenManagerService {
    private readonly tokenCalculator: TokenCalculator;
    private readonly waterfallTruncator: WaterfallTruncator;
    private readonly contextOptimizer: ContextOptimizer;

    constructor(
        private readonly modelManager: CopilotModelManager,
        private readonly promptGenerator: PromptGenerator
    ) {
        // Initialize specialized classes with dependencies
        this.tokenCalculator = new TokenCalculator(modelManager);
        this.waterfallTruncator = new WaterfallTruncator(modelManager);
        this.contextOptimizer = new ContextOptimizer(modelManager);
    }

    /**
     * Calculate token allocation for all components with a specific model
     * @param components All components that will consume tokens
     * @param analysisMode Current analysis mode
     * @returns Token allocation details
     */
    async calculateTokenAllocation(
        components: TokenComponents,
        analysisMode: AnalysisMode
    ): Promise<TokenAllocation> {
        return this.tokenCalculator.calculateTokenAllocation(components, analysisMode);
    }

    /**
     * Set the content prioritization order
     * @param prioritization Content prioritization configuration
     */
    setContentPrioritization(prioritization: ContentPrioritization): void {
        this.waterfallTruncator.setContentPrioritization(prioritization);
        this.contextOptimizer.setContentPrioritization(prioritization);
    }

    /**
     * Get current content prioritization order
     * @returns Current content prioritization configuration
     */
    getContentPrioritization(): ContentPrioritization {
        return this.waterfallTruncator.getContentPrioritization();
    }

    /**
     * Perform waterfall truncation based on configured prioritization.
     * Uses a waterfall approach: try to preserve highest priority content fully,
     * but allow truncation if needed to make room for lower priority content.
     * @param components Token components to truncate
     * @param targetTokens Target token limit to fit within
     * @returns Truncated components that fit within the token limit
     */
    async performProportionalTruncation(
        components: TokenComponents,
        targetTokens: number
    ): Promise<TruncatedTokenComponents> {
        return this.waterfallTruncator.performProportionalTruncation(components, targetTokens);
    }

    /**
     * Optimizes a list of context snippets to fit within available token allocation
     * by prioritizing based on relevance.
     * @param snippets A list of ContextSnippet objects.
     * @param availableTokens Maximum tokens that can be allocated to the context.
     * @returns An object containing the array of optimized snippets and a boolean indicating if truncation occurred.
     */
    async optimizeContext(
        snippets: ContextSnippet[],
        availableTokens: number
    ): Promise<OptimizationResult> {
        return this.contextOptimizer.optimizeContext(snippets, availableTokens);
    }

    /**
     * Formats a list of context snippets into a single markdown string.
     * @param snippets The list of ContextSnippet objects to format.
     * @param wasTruncated Whether to add a truncation message at the end.
     * @returns A formatted markdown string.
     */
    formatContextSnippetsToString(snippets: ContextSnippet[], wasTruncated: boolean = false): string {
        return this.contextOptimizer.formatContextSnippetsToString(snippets, wasTruncated);
    }

    /**
     * Get the current model's token limit
     * @returns Maximum input tokens for current model
     */
    async getModelTokenLimit(): Promise<number> {
        return this.tokenCalculator.getModelTokenLimit();
    }

    /**
     * Calculate tokens for a given text using current model
     * @param text Text to calculate tokens for
     * @returns Token count
     */
    async calculateTokens(text: string): Promise<number> {
        return this.tokenCalculator.calculateTokens(text);
    }

    /**
     * Calculate total tokens for complete message array that will be sent to model
     * @param systemPrompt System prompt content
     * @param userPrompt User prompt content
     * @param responsePrefill Response prefill content
     * @returns Total token count including message overhead
     */
    async calculateCompleteMessageTokens(
        systemPrompt: string,
        userPrompt: string,
        responsePrefill?: string
    ): Promise<number> {
        return this.tokenCalculator.calculateCompleteMessageTokens(systemPrompt, userPrompt, responsePrefill);
    }

    /**
     * Get system prompt for a given analysis mode
     * @param mode Analysis mode
     * @returns System prompt text
     */
    getSystemPromptForMode(mode: AnalysisMode): string {
        return this.promptGenerator.getSystemPrompt();
    }

    /**
     * Get response prefill to guide output format
     * @returns Response prefill text
     */
    getResponsePrefill(): string {
        return this.promptGenerator.getResponsePrefill();
    }

    /**
     * Dispose of all resources
     */
    dispose(): void {
        this.tokenCalculator.dispose();
        this.waterfallTruncator.dispose();
        this.contextOptimizer.dispose();
    }
}
