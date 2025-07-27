import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { CopilotModelManager } from '../models/copilotModelManager';
import { AnalysisMode } from '../types/modelTypes';
import { ContextSnippet, ContentType } from '../types/contextTypes';
import { Log } from './loggingService';
import { PromptGenerator } from './promptGenerator';


/**
 * Components of an analysis that consume tokens
 */
export interface TokenComponents {
    systemPrompt?: string;
    diffText?: string; // Original flat diff, can be used as fallback or for non-interleaved
    contextSnippets?: ContextSnippet[]; // Original context snippets for type-aware truncation
    embeddingContext?: string; // Context from embedding search
    lspReferenceContext?: string; // Context from LSP references
    lspDefinitionContext?: string; // Context from LSP definitions
    userMessages?: string[];
    assistantMessages?: string[];
    diffStructureTokens?: number; // Tokens for the diff's structural representation in an interleaved prompt
    responsePrefill?: string; // Response prefill content that will be sent to the model
}

/**
 * Result of token allocation calculation
 */
export interface TokenAllocation {
    totalAvailableTokens: number;
    totalRequiredTokens: number;
    systemPromptTokens: number;
    diffTextTokens: number;
    contextTokens: number; // Tokens of the preliminary formatted string
    userMessagesTokens: number;
    assistantMessagesTokens: number;
    responsePrefillTokens: number; // Tokens for response prefill content
    messageOverheadTokens: number; // Overhead for chat message structure
    otherTokens: number; // Reserved for formatting, metadata, etc.
    fitsWithinLimit: boolean;
    contextAllocationTokens: number; // How many tokens can be allocated to context
}

/**
 * Content prioritization order configuration
 */
export interface ContentPrioritization {
    order: ContentType[];
}

/**
 * Service for managing token calculations and optimizations
 * Follows Single Responsibility Principle by focusing only on token management
 */
export class TokenManagerService {
    // Token calculation constants - could be made configurable in future
    private static readonly TOKEN_OVERHEAD_PER_MESSAGE = 5;
    private static readonly FORMATTING_OVERHEAD = 50;
    private static readonly SAFETY_MARGIN_RATIO = 0.95; // 5% safety margin

    // Truncation constants
    private static readonly TRUNCATION_MESSAGES = {
        CONTEXT: '\n\n[Context truncated to fit token limit. Some information might be missing.]',
        PARTIAL: '\n\n[File content partially truncated to fit token limit]'
    } as const;

    // Context optimization constants
    private static readonly MIN_CONTENT_TOKENS_FOR_PARTIAL = 10;
    private static readonly SAFETY_BUFFER_FOR_PARTIAL = 5;
    private static readonly CHARS_PER_TOKEN_ESTIMATE = 4.0;

    private currentModel: vscode.LanguageModelChat | null = null;
    private modelDetails: { family: string; maxInputTokens: number } | null = null;
    private contentPrioritization: ContentPrioritization = {
        order: ['diff', 'embedding', 'lsp-reference', 'lsp-definition']
    };

    constructor(
        private readonly modelManager: CopilotModelManager,
        private readonly promptGenerator: PromptGenerator
    ) {
    }

    /**
     * Calculate token allocation for all components with a specific model
     * @param components All components that will consume tokens
     * @param analysisMode Current analysis mode
     * @returns Token allocation details
     */
    public async calculateTokenAllocation(
        components: TokenComponents,
        analysisMode: AnalysisMode
    ): Promise<TokenAllocation> {
        await this.updateModelInfo();

        const maxInputTokens = this.modelDetails?.maxInputTokens || 8000;
        const safeMaxTokens = Math.floor(maxInputTokens * TokenManagerService.SAFETY_MARGIN_RATIO);

        const systemPromptTokens = components.systemPrompt
            ? await this.currentModel!.countTokens(components.systemPrompt) : 0;
        const diffTokens = components.diffStructureTokens !== undefined
            ? components.diffStructureTokens
            : (components.diffText ? await this.currentModel!.countTokens(components.diffText) : 0);

        // Calculate context tokens from separated fields
        let contextTokens = 0;
        if (components.embeddingContext) {
            contextTokens += await this.currentModel!.countTokens(components.embeddingContext);
        }
        if (components.lspReferenceContext) {
            contextTokens += await this.currentModel!.countTokens(components.lspReferenceContext);
        }
        if (components.lspDefinitionContext) {
            contextTokens += await this.currentModel!.countTokens(components.lspDefinitionContext);
        }

        // Calculate content tokens only (without message overhead)
        let userMessagesTokens = 0;
        let userMessageCount = 0;
        if (components.userMessages) {
            for (const message of components.userMessages) {
                userMessagesTokens += await this.currentModel!.countTokens(message) || 0;
                userMessageCount++;
            }
        }

        let assistantMessagesTokens = 0;
        let assistantMessageCount = 0;
        if (components.assistantMessages) {
            for (const message of components.assistantMessages) {
                assistantMessagesTokens += await this.currentModel!.countTokens(message) || 0;
                assistantMessageCount++;
            }
        }

        // Calculate response prefill content tokens only
        const responsePrefillTokens = components.responsePrefill
            ? await this.currentModel!.countTokens(components.responsePrefill) : 0;

        // Calculate total message overhead based on actual message count
        const messageCount = (components.systemPrompt ? 1 : 0) +
            userMessageCount +
            assistantMessageCount +
            (components.responsePrefill ? 1 : 0);
        const messageOverheadTokens = messageCount * TokenManagerService.TOKEN_OVERHEAD_PER_MESSAGE;

        const otherTokens = TokenManagerService.FORMATTING_OVERHEAD;
        const totalRequiredTokens = systemPromptTokens + diffTokens + contextTokens +
            userMessagesTokens + assistantMessagesTokens + responsePrefillTokens + messageOverheadTokens + otherTokens;

        const nonContextTokens = systemPromptTokens + diffTokens +
            userMessagesTokens + assistantMessagesTokens + responsePrefillTokens + messageOverheadTokens + otherTokens;
        const contextAllocation = Math.max(0, safeMaxTokens - nonContextTokens);

        return {
            totalAvailableTokens: safeMaxTokens,
            totalRequiredTokens,
            systemPromptTokens,
            diffTextTokens: diffTokens, // This now reflects either flat diff or structured diff tokens
            contextTokens, // Tokens of the full unoptimized context string
            userMessagesTokens,
            assistantMessagesTokens,
            responsePrefillTokens,
            messageOverheadTokens,
            otherTokens,
            fitsWithinLimit: totalRequiredTokens <= safeMaxTokens,
            contextAllocationTokens: contextAllocation
        };
    }

    /**
     * Set the content prioritization order
     * @param prioritization Content prioritization configuration
     */
    public setContentPrioritization(prioritization: ContentPrioritization): void {
        this.contentPrioritization = prioritization;
    }

    /**
     * Get current content prioritization order
     * @returns Current content prioritization configuration
     */
    public getContentPrioritization(): ContentPrioritization {
        return { ...this.contentPrioritization };
    }

    /**
     * Perform waterfall truncation based on configured prioritization.
     * Uses a waterfall approach: try to preserve highest priority content fully,
     * but allow truncation if needed to make room for lower priority content.
     * @param components Token components to truncate
     * @param targetTokens Target token limit to fit within
     * @returns Truncated components that fit within the token limit
     */
    public async performProportionalTruncation(
        components: TokenComponents,
        targetTokens: number
    ): Promise<{ truncatedComponents: TokenComponents, wasTruncated: boolean }> {
        await this.updateModelInfo();

        // Ensure we have separated context fields
        const normalizedComponents = this.ensureSeparatedContextFields(components);

        const currentTokens = await this.calculateComponentTokens(normalizedComponents);
        if (currentTokens <= targetTokens) {
            return { truncatedComponents: normalizedComponents, wasTruncated: false };
        }
        const truncatedComponents = { ...normalizedComponents };
        let wasTruncated = false;

        // Calculate fixed overhead tokens (non-truncatable components)
        const fixedTokens = await this.calculateFixedTokens(components);
        const availableTokensForContent = Math.max(0, targetTokens - fixedTokens);

        if (availableTokensForContent <= 0) {
            // Not enough space even for fixed components - clear truncatable content
            truncatedComponents.diffText = '';
            truncatedComponents.embeddingContext = '';
            truncatedComponents.lspReferenceContext = '';
            truncatedComponents.lspDefinitionContext = '';
            return { truncatedComponents: truncatedComponents, wasTruncated: true };
        }

        // Calculate current content sizes
        const diffTokens = truncatedComponents.diffText ?
            await this.currentModel!.countTokens(truncatedComponents.diffText) : 0;
        const embeddingTokens = truncatedComponents.embeddingContext ?
            await this.currentModel!.countTokens(truncatedComponents.embeddingContext) : 0;
        const lspRefTokens = truncatedComponents.lspReferenceContext ?
            await this.currentModel!.countTokens(truncatedComponents.lspReferenceContext) : 0;
        const lspDefTokens = truncatedComponents.lspDefinitionContext ?
            await this.currentModel!.countTokens(truncatedComponents.lspDefinitionContext) : 0;
        // Strategy: Waterfall allocation in priority order
        // Calculate total content tokens using separated fields
        const totalContextTokens = embeddingTokens + lspRefTokens + lspDefTokens;
        const totalContentTokens = diffTokens + totalContextTokens;

        if (totalContentTokens <= availableTokensForContent) {
            // Everything fits - no truncation needed
            return { truncatedComponents: truncatedComponents, wasTruncated: false };
        }

        // Apply waterfall allocation based on priority order
        const waterfallResult = await this.applyWaterfallAllocation(
            truncatedComponents,
            availableTokensForContent,
            { diff: diffTokens, embedding: embeddingTokens, 'lsp-reference': lspRefTokens, 'lsp-definition': lspDefTokens }
        );
        wasTruncated = waterfallResult.wasTruncated;

        // Return the truncated components with separate context fields
        return { truncatedComponents: truncatedComponents, wasTruncated };
    }

    /**
     * Apply waterfall allocation in priority order with type safety
     * @param components Components to potentially truncate
     * @param availableTokens Total tokens available for all content
     * @param contentTokenCounts Current token usage by content type
     * @returns Truncation result
     */
    private async applyWaterfallAllocation(
        components: TokenComponents,
        availableTokens: number,
        contentTokenCounts: Record<ContentType, number>
    ): Promise<{ wasTruncated: boolean }> {
        let remainingTokens = availableTokens;
        let wasTruncated = false;

        // Process content types in priority order (highest first)
        for (const contentType of this.contentPrioritization.order) {
            if (remainingTokens <= 0) {
                // No tokens left - clear all remaining content types
                this.clearRemainingContentByType(components, contentType);
                wasTruncated = true;
                break;
            }

            const result = await this.processContentTypeInWaterfall(
                components,
                contentType,
                contentTokenCounts[contentType],
                remainingTokens
            );

            remainingTokens = result.remainingTokens;
            wasTruncated = wasTruncated || result.wasTruncated;
        }

        return { wasTruncated };
    }

    /**
     * Process a single content type during waterfall allocation
     * @param components Components to modify
     * @param contentType Type of content to process
     * @param currentTokens Current token usage for this type
     * @param remainingTokens Available tokens for this and remaining types
     * @returns Updated token counts and truncation status
     */
    private async processContentTypeInWaterfall(
        components: TokenComponents,
        contentType: ContentType,
        currentTokens: number,
        remainingTokens: number
    ): Promise<{ remainingTokens: number; wasTruncated: boolean }> {
        if (currentTokens === 0) {
            return { remainingTokens, wasTruncated: false };
        }

        if (currentTokens <= remainingTokens) {
            // Content fits completely - allocate full space
            return { remainingTokens: remainingTokens - currentTokens, wasTruncated: false };
        }

        // Content is too large - truncate to fit remaining space
        const tokensToRemove = currentTokens - remainingTokens;
        const truncationResult = await this.truncateContentByType(components, contentType, tokensToRemove);

        return {
            remainingTokens: 0, // All remaining tokens used
            wasTruncated: truncationResult.wasTruncated
        };
    }

    /**
     * Truncate content for a specific content type with emergency fallbacks
     * @param components Components to modify
     * @param contentType Type of content to truncate
     * @param tokensToRemove Number of tokens to remove
     * @returns Truncation result
     */
    private async truncateContentByType(
        components: TokenComponents,
        contentType: ContentType,
        tokensToRemove: number
    ): Promise<{ wasTruncated: boolean }> {
        switch (contentType) {
            case 'diff':
                if (components.diffText) {
                    const result = await this.truncateDiffWithEmergencyFallback(
                        components.diffText,
                        tokensToRemove
                    );
                    components.diffText = result.content;
                    return { wasTruncated: result.wasTruncated };
                }
                break;

            case 'embedding':
                if (components.embeddingContext) {
                    const result = await this.truncateContent(components.embeddingContext, tokensToRemove);
                    components.embeddingContext = result.content;
                    return { wasTruncated: result.wasTruncated };
                }
                break;

            case 'lsp-reference':
                if (components.lspReferenceContext) {
                    const result = await this.truncateContent(components.lspReferenceContext, tokensToRemove);
                    components.lspReferenceContext = result.content;
                    return { wasTruncated: result.wasTruncated };
                }
                break;

            case 'lsp-definition':
                if (components.lspDefinitionContext) {
                    const result = await this.truncateContent(components.lspDefinitionContext, tokensToRemove);
                    components.lspDefinitionContext = result.content;
                    return { wasTruncated: result.wasTruncated };
                }
                break;

            default:
                // Type guard to ensure we handle all ContentType cases
                const _exhaustiveCheck: never = contentType;
                return _exhaustiveCheck;
        }

        return { wasTruncated: false };
    }

    /**
     * Truncate diff content with emergency fallbacks for extremely large diffs
     * @param diffText Diff content to truncate
     * @param tokensToRemove Number of tokens to remove
     * @returns Truncation result with emergency handling
     */
    private async truncateDiffWithEmergencyFallback(
        diffText: string,
        tokensToRemove: number
    ): Promise<{ content: string, wasTruncated: boolean }> {
        // Try normal truncation first
        const normalResult = await this.truncateContent(diffText, tokensToRemove);

        // If normal truncation worked, return it
        if (normalResult.content.length > 0) {
            return normalResult;
        }

        // Emergency fallback: Try to preserve at least the first few hunks
        Log.warn('Diff content extremely large, applying emergency hunk-based truncation');
        return await this.emergencyTruncateDiffByHunks(diffText, tokensToRemove);
    }

    /**
     * Emergency truncation that preserves diff structure by keeping complete hunks
     * @param diffText Original diff content
     * @param tokensToRemove Number of tokens to remove
     * @returns Emergency truncated diff
     */
    private async emergencyTruncateDiffByHunks(
        diffText: string,
        tokensToRemove: number
    ): Promise<{ content: string, wasTruncated: boolean }> {
        if (!this.currentModel) {
            return { content: '', wasTruncated: true };
        }

        const currentTokens = await this.currentModel.countTokens(diffText);
        const targetTokens = currentTokens - tokensToRemove;

        // If even the target is too small, return a minimal diff summary
        if (targetTokens < 100) {
            const summary = this.createMinimalDiffSummary(diffText);
            return { content: summary, wasTruncated: true };
        }

        // Split diff into hunks and keep as many complete hunks as possible
        const lines = diffText.split('\n');
        const preservedLines: string[] = [];
        let currentTokenCount = 0;
        let inHunk = false;
        let currentHunk: string[] = [];

        for (const line of lines) {
            const lineTokens = await this.currentModel.countTokens(line + '\n');

            // Check if this line starts a new hunk
            if (line.startsWith('@@')) {
                // Finish previous hunk if we were in one
                if (inHunk && currentHunk.length > 0) {
                    const hunkTokens = await this.currentModel.countTokens(currentHunk.join('\n'));
                    if (currentTokenCount + hunkTokens <= targetTokens) {
                        preservedLines.push(...currentHunk);
                        currentTokenCount += hunkTokens;
                        currentHunk = [];
                    } else {
                        // Can't fit this hunk, stop here
                        break;
                    }
                }

                // Start new hunk
                inHunk = true;
                currentHunk = [line];
            } else if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('+++') || line.startsWith('---')) {
                // File headers - always include if we have space
                if (currentTokenCount + lineTokens <= targetTokens) {
                    preservedLines.push(line);
                    currentTokenCount += lineTokens;
                }
            } else if (inHunk) {
                // Part of current hunk
                currentHunk.push(line);
            }
        }

        // Add final hunk if it fits
        if (currentHunk.length > 0) {
            const hunkTokens = await this.currentModel.countTokens(currentHunk.join('\n'));
            if (currentTokenCount + hunkTokens <= targetTokens) {
                preservedLines.push(...currentHunk);
            }
        }

        const result = preservedLines.join('\n');
        const truncationMessage = '\n\n[Large diff truncated to preserve structural integrity. Some hunks omitted to fit token limits.]';

        return {
            content: result + truncationMessage,
            wasTruncated: true
        };
    }

    /**
     * Create a minimal diff summary when even hunk-based truncation isn't possible
     * @param diffText Original diff content
     * @returns Minimal summary of the diff
     */
    private createMinimalDiffSummary(diffText: string): string {
        const lines = diffText.split('\n');
        const fileHeaders = lines.filter(line =>
            line.startsWith('diff --git') ||
            line.startsWith('+++') ||
            line.startsWith('---')
        );

        // Extract file paths from headers
        const changedFiles = new Set<string>();
        for (const header of fileHeaders) {
            if (header.startsWith('+++') || header.startsWith('---')) {
                const path = header.substring(4).replace(/^[ab]\//, '');
                if (path !== '/dev/null') {
                    changedFiles.add(path);
                }
            }
        }

        const fileList = Array.from(changedFiles).slice(0, 10); // Limit to 10 files
        const summary = [
            '[EMERGENCY TRUNCATION: Diff too large for analysis]',
            '',
            `Files modified (${changedFiles.size} total${changedFiles.size > 10 ? ', showing first 10' : ''}):`,
            ...fileList.map(file => `- ${file}`),
            '',
            '[Complete diff analysis unavailable due to token limits. Consider analyzing smaller change sets.]'
        ].join('\n');

        return summary;
    }

    /**
     * Get priority weight for content type (higher number = higher priority)
     * @param contentType The content type to get priority for
     * @returns Priority weight
     */
    private getPriorityWeight(contentType: ContentType): number {
        const index = this.contentPrioritization.order.indexOf(contentType);
        if (index === -1) return 1;
        return this.contentPrioritization.order.length - index;
    }

    /**
     * Clear content for the current and all remaining lower-priority content types
     * @param components Components to clear
     * @param currentContentType The current content type being processed
     */
    private clearRemainingContentByType(
        components: TokenComponents,
        currentContentType: ContentType
    ): void {
        const currentIndex = this.contentPrioritization.order.indexOf(currentContentType);
        if (currentIndex === -1) return;

        // Clear current and all remaining content types
        for (let i = currentIndex; i < this.contentPrioritization.order.length; i++) {
            const contentType = this.contentPrioritization.order[i];
            switch (contentType) {
                case 'diff':
                    components.diffText = '';
                    break;
                case 'embedding':
                    components.embeddingContext = '';
                    break;
                case 'lsp-reference':
                    components.lspReferenceContext = '';
                    break;
                case 'lsp-definition':
                    components.lspDefinitionContext = '';
                    break;
            }
        }
    }

    /**
     * Ensure components have separated context fields, converting from legacy format if needed
     * @param components Components to normalize
     * @returns Components with separated context fields populated
     */
    private ensureSeparatedContextFields(components: TokenComponents): TokenComponents {
        const normalized: TokenComponents = { ...components };

        // If we have contextSnippets, use them to populate separated fields
        if (components.contextSnippets && components.contextSnippets.length > 0) {
            const separated = this.separateContextByType(components.contextSnippets);
            normalized.embeddingContext = separated.embeddingContext;
            normalized.lspReferenceContext = separated.lspReferenceContext;
            normalized.lspDefinitionContext = separated.lspDefinitionContext;
        }
        // Otherwise ensure all fields are defined as empty strings
        else {
            normalized.embeddingContext = normalized.embeddingContext || '';
            normalized.lspReferenceContext = normalized.lspReferenceContext || '';
            normalized.lspDefinitionContext = normalized.lspDefinitionContext || '';
        }

        return normalized;
    }

    /**
     * Separate context snippets by type for waterfall truncation
     * @param snippets Original context snippets
     * @returns Separated context strings by type
     */
    private separateContextByType(snippets: ContextSnippet[]): {
        embeddingContext: string;
        lspReferenceContext: string;
        lspDefinitionContext: string;
    } {
        const embeddingSnippets = snippets.filter(s => s.type === 'embedding');
        const lspReferenceSnippets = snippets.filter(s => s.type === 'lsp-reference');
        const lspDefinitionSnippets = snippets.filter(s => s.type === 'lsp-definition');

        return {
            embeddingContext: this.formatContextSnippetsToString(embeddingSnippets, false),
            lspReferenceContext: this.formatContextSnippetsToString(lspReferenceSnippets, false),
            lspDefinitionContext: this.formatContextSnippetsToString(lspDefinitionSnippets, false)
        };
    }

    /**
     * Recombine separated context fields into a single context string
     * @param components Components with separated context fields
     * @returns Combined context string
     */
    private recombineContextFields(components: TokenComponents): string {
        const contextParts = [];
        if (components.embeddingContext && components.embeddingContext.trim()) {
            contextParts.push(components.embeddingContext.trim());
        }
        if (components.lspReferenceContext && components.lspReferenceContext.trim()) {
            contextParts.push(components.lspReferenceContext.trim());
        }
        if (components.lspDefinitionContext && components.lspDefinitionContext.trim()) {
            contextParts.push(components.lspDefinitionContext.trim());
        }
        return contextParts.join('\n\n');
    }

    /**
     * Calculate tokens for fixed (non-truncatable) components
     * @param components Token components to analyze
     * @returns Token count for fixed components
     */
    private async calculateFixedTokens(components: TokenComponents): Promise<number> {
        await this.updateModelInfo();
        if (!this.currentModel) return 0;

        let fixedTokens = 0;

        // System prompt is fixed
        if (components.systemPrompt) {
            fixedTokens += await this.currentModel.countTokens(components.systemPrompt);
        }

        // User and assistant messages are fixed
        if (components.userMessages) {
            for (const message of components.userMessages) {
                fixedTokens += await this.currentModel.countTokens(message);
            }
        }
        if (components.assistantMessages) {
            for (const message of components.assistantMessages) {
                fixedTokens += await this.currentModel.countTokens(message);
            }
        }

        // Response prefill is fixed
        if (components.responsePrefill) {
            fixedTokens += await this.currentModel.countTokens(components.responsePrefill);
        }

        // Diff structure tokens (if specified instead of diffText)
        if (components.diffStructureTokens && !components.diffText) {
            fixedTokens += components.diffStructureTokens;
        }

        // Message overhead and formatting overhead are fixed
        const messageCount = (components.systemPrompt ? 1 : 0) +
            (components.userMessages?.length || 0) +
            (components.assistantMessages?.length || 0) +
            (components.responsePrefill ? 1 : 0);
        fixedTokens += messageCount * TokenManagerService.TOKEN_OVERHEAD_PER_MESSAGE;
        fixedTokens += TokenManagerService.FORMATTING_OVERHEAD;

        return fixedTokens;
    }

    /**
     * Calculate total tokens for given components
     * @param components Token components to calculate
     * @returns Total token count
     */
    private async calculateComponentTokens(components: TokenComponents): Promise<number> {
        await this.updateModelInfo();
        if (!this.currentModel) return 0;

        let totalTokens = 0;

        if (components.systemPrompt) {
            totalTokens += await this.currentModel.countTokens(components.systemPrompt);
        }
        if (components.diffText) {
            totalTokens += await this.currentModel.countTokens(components.diffText);
        }
        // Calculate context tokens from separated fields
        if (components.embeddingContext) {
            totalTokens += await this.currentModel.countTokens(components.embeddingContext);
        }
        if (components.lspReferenceContext) {
            totalTokens += await this.currentModel.countTokens(components.lspReferenceContext);
        }
        if (components.lspDefinitionContext) {
            totalTokens += await this.currentModel.countTokens(components.lspDefinitionContext);
        }
        // Calculate message content and overhead separately
        let messageCount = 0;
        if (components.userMessages) {
            for (const message of components.userMessages) {
                totalTokens += await this.currentModel.countTokens(message);
                messageCount++;
            }
        }
        if (components.assistantMessages) {
            for (const message of components.assistantMessages) {
                totalTokens += await this.currentModel.countTokens(message);
                messageCount++;
            }
        }
        if (components.responsePrefill) {
            totalTokens += await this.currentModel.countTokens(components.responsePrefill);
            messageCount++;
        }

        // Add system prompt to message count if present
        if (components.systemPrompt) {
            messageCount++;
        }

        // Add message overhead
        totalTokens += messageCount * TokenManagerService.TOKEN_OVERHEAD_PER_MESSAGE;
        if (components.diffStructureTokens) {
            totalTokens += components.diffStructureTokens;
        }

        return totalTokens + TokenManagerService.FORMATTING_OVERHEAD;
    }

    /**
     * Truncate content proportionally from the end
     * @param content Content to truncate
     * @param tokensToRemove Number of tokens to remove
     * @returns Truncated content and truncation status
     */
    private async truncateContent(content: string, tokensToRemove: number): Promise<{ content: string, wasTruncated: boolean }> {
        await this.updateModelInfo();
        if (!this.currentModel || tokensToRemove <= 0) {
            return { content, wasTruncated: false };
        }

        const currentTokens = await this.currentModel.countTokens(content);
        const targetTokens = currentTokens - tokensToRemove;

        // Calculate tokens needed for truncation message
        const truncationMessageTokens = await this.currentModel.countTokens(TokenManagerService.TRUNCATION_MESSAGES.PARTIAL);
        const availableTokensForContent = targetTokens - truncationMessageTokens;

        if (availableTokensForContent <= 0) {
            // Not enough space even for truncation message
            return { content: '', wasTruncated: true };
        }

        const charsPerToken = TokenManagerService.CHARS_PER_TOKEN_ESTIMATE;
        const targetChars = Math.floor(availableTokensForContent * charsPerToken);

        if (targetChars <= 0) {
            return { content: '', wasTruncated: true };
        }

        let truncatedContent = content.substring(0, targetChars);

        // Ensure we don't break in the middle of a line
        const lastNewline = truncatedContent.lastIndexOf('\n');
        if (lastNewline > -1) {
            truncatedContent = truncatedContent.substring(0, lastNewline);
        }

        truncatedContent += TokenManagerService.TRUNCATION_MESSAGES.PARTIAL;

        // Verify final result fits within target
        const finalTokens = await this.currentModel.countTokens(truncatedContent);
        if (finalTokens > targetTokens) {
            // Still too large, try with smaller content
            const adjustedChars = Math.max(0, targetChars - Math.ceil((finalTokens - targetTokens) * charsPerToken));
            if (adjustedChars <= 0) {
                return { content: '', wasTruncated: true };
            }

            truncatedContent = content.substring(0, adjustedChars);
            const lastNewline2 = truncatedContent.lastIndexOf('\n');
            if (lastNewline2 > -1) {
                truncatedContent = truncatedContent.substring(0, lastNewline2);
            }
            truncatedContent += TokenManagerService.TRUNCATION_MESSAGES.PARTIAL;
        }

        return { content: truncatedContent, wasTruncated: true };
    }

    /**
     * Optimizes a list of context snippets to fit within available token allocation
     * by prioritizing based on relevance.
     * @param snippets A list of ContextSnippet objects.
     * @param availableTokens Maximum tokens that can be allocated to the context.
     * @returns An object containing the array of optimized snippets and a boolean indicating if truncation occurred.
     */
    public async optimizeContext(
        snippets: ContextSnippet[],
        availableTokens: number
    ): Promise<{ optimizedSnippets: ContextSnippet[], wasTruncated: boolean }> {
        await this.updateModelInfo();
        if (!this.currentModel) {
            Log.error("Language model not available for token counting in optimizeContext.");
            return { optimizedSnippets: [], wasTruncated: true };
        }

        // First deduplicate the snippets to remove duplicates
        const deduplicatedSnippets = this.deduplicateContext(snippets);

        if (deduplicatedSnippets.length === 0) {
            return { optimizedSnippets: [], wasTruncated: false };
        }

        // Sort snippets using prioritization configuration
        const sortedSnippets = this.prioritizeSnippets(deduplicatedSnippets);

        return await this.selectSnippetsWithinTokenLimit(sortedSnippets, availableTokens);
    }

    /**
     * Prioritize snippets based on configured prioritization order
     * @param snippets Snippets to prioritize
     * @returns Prioritized snippets
     */
    private prioritizeSnippets(snippets: ContextSnippet[]): ContextSnippet[] {
        return [...snippets].sort((a, b) => {
            const typePriority = (type: ContextSnippet['type']): number => {
                // Map context snippet types directly to prioritization order
                // Note: ContentType includes 'diff' but ContextSnippet['type'] is only ContextSnippetType
                const index = this.contentPrioritization.order.indexOf(type as ContentType);
                return index === -1 ? 0 : this.contentPrioritization.order.length - index;
            };

            const priorityA = typePriority(a.type);
            const priorityB = typePriority(b.type);

            if (priorityA !== priorityB) {
                return priorityB - priorityA; // Higher priority first
            }
            return b.relevanceScore - a.relevanceScore; // Higher score first
        });
    }

    /**
     * Select snippets that fit within token limit
     * @param sortedSnippets Pre-sorted snippets by priority
     * @param availableTokens Available token limit
     * @returns Selected snippets and truncation status
     */
    private async selectSnippetsWithinTokenLimit(
        sortedSnippets: ContextSnippet[],
        availableTokens: number
    ): Promise<{ optimizedSnippets: ContextSnippet[], wasTruncated: boolean }> {
        const selectedSnippets: ContextSnippet[] = [];
        let currentTokens = 0;
        let wasTruncated = false;

        for (const snippet of sortedSnippets) {
            if (!this.currentModel) {
                break;
            }
            const snippetTokens = await this.currentModel.countTokens(snippet.content);
            // Add a small buffer for newlines between snippets
            const tokensWithBuffer = snippetTokens + (selectedSnippets.length > 0 ? await this.currentModel.countTokens('\n\n') : 0);


            if (currentTokens + tokensWithBuffer <= availableTokens) {
                selectedSnippets.push(snippet);
                currentTokens += tokensWithBuffer;
            } else {
                wasTruncated = true;
                // Attempt to partially include the current snippet if it's large and some space remains
                const remainingTokensForPartial = availableTokens - currentTokens;
                if (!this.currentModel) {
                    break;
                }
                const partialTruncMsgTokens = await this.currentModel.countTokens(TokenManagerService.TRUNCATION_MESSAGES.PARTIAL);
                const MIN_CONTENT_TOKENS_FOR_PARTIAL_ATTEMPT = TokenManagerService.MIN_CONTENT_TOKENS_FOR_PARTIAL;
                const safetyBufferForPartialCalc = TokenManagerService.SAFETY_BUFFER_FOR_PARTIAL;

                // Attempt partial truncation if:
                // 1. There's enough space for the truncation message and some minimal content.
                // 2. The current snippet is larger than the remaining space.
                if (remainingTokensForPartial > (partialTruncMsgTokens + MIN_CONTENT_TOKENS_FOR_PARTIAL_ATTEMPT) &&
                    snippetTokens > remainingTokensForPartial) {
                    try {
                        // const modelFamily = this.modelDetails?.family || 'unknown';
                        // let charsPerTokenEstimate = 3.5; // General estimate
                        // if (modelFamily.toLowerCase().includes('claude')) charsPerTokenEstimate = 4.5;
                        // else if (modelFamily.toLowerCase().includes('gemini')) charsPerTokenEstimate = 4.0;
                        const charsPerTokenEstimate = TokenManagerService.CHARS_PER_TOKEN_ESTIMATE;

                        // Target tokens for the content part of the partial snippet
                        const targetContentTokens = remainingTokensForPartial - partialTruncMsgTokens - safetyBufferForPartialCalc;

                        if (targetContentTokens > 0) {
                            // Estimate max characters for the content part
                            const maxChars = Math.max(0, Math.floor(targetContentTokens * charsPerTokenEstimate)); // No further multiplier

                            if (maxChars > 0) {
                                let partialContent = snippet.content.substring(0, maxChars);
                                // The aggressive newline stripping below was causing issues with the markdown test.
                                // The subsequent code block closing logic should handle partial lines near code blocks.
                                // const lastNewline = partialContent.lastIndexOf('\n');
                                // if (lastNewline > -1) { // Ensure lastNewline is found
                                //     partialContent = partialContent.substring(0, lastNewline);
                                // }

                                // Ensure markdown code blocks are properly closed
                                const codeBlockStartRegex = /```[\w]*\n/g;
                                const codeBlockEnd = '\n```';
                                let lastCodeBlockStart = -1;
                                let match;
                                while ((match = codeBlockStartRegex.exec(snippet.content)) !== null) {
                                    if (match.index < partialContent.length) {
                                        lastCodeBlockStart = match.index;
                                    } else {
                                        break;
                                    }
                                }

                                if (lastCodeBlockStart !== -1) {
                                    const lastCodeBlockEndInPartial = partialContent.lastIndexOf(codeBlockEnd);
                                    // If a code block was opened and not closed within the partial content
                                    if (lastCodeBlockStart > (lastCodeBlockEndInPartial === -1 ? -1 : lastCodeBlockEndInPartial)) {
                                        // Check if the original snippet had a closing tag after the partial content cut-off
                                        const originalClosingTagIndex = snippet.content.indexOf(codeBlockEnd, lastCodeBlockStart);
                                        if (originalClosingTagIndex === -1 || originalClosingTagIndex > partialContent.length) {
                                            partialContent += codeBlockEnd;
                                        }
                                    }
                                }
                                partialContent += TokenManagerService.TRUNCATION_MESSAGES.PARTIAL;

                                if (!this.currentModel) {
                                    break;
                                }
                                const partialSnippetTokens = await this.currentModel.countTokens(partialContent);
                                if (currentTokens + partialSnippetTokens <= availableTokens) {
                                    selectedSnippets.push({ ...snippet, content: partialContent, id: `${snippet.id}-partial` });
                                    currentTokens += partialSnippetTokens;
                                }
                            }
                        }
                    } catch (e) {
                        Log.warn("Error during partial snippet truncation:", e);
                    }
                }
                break; // Stop adding more snippets if the current one (even partially) doesn't fit or wasn't attempted for partial.
            }
        }

        // If no snippets fit at all (not even partially from the main loop),
        // and there's enough space for the main truncation message plus some minimal content,
        // try to add a "tiny" piece of the most relevant snippet.
        const MIN_CONTENT_TOKENS_FOR_TINY_ATTEMPT = TokenManagerService.MIN_CONTENT_TOKENS_FOR_PARTIAL;
        // For tiny content, we still use PARTIAL_TRUNCATION_MESSAGE as it's shorter and indicates partial nature.
        if (!this.currentModel) {
            return { optimizedSnippets: selectedSnippets, wasTruncated };
        }
        const partialMsgTokensForTiny = await this.currentModel.countTokens(TokenManagerService.TRUNCATION_MESSAGES.PARTIAL);
        const safetyBufferForTinyCalc = TokenManagerService.SAFETY_BUFFER_FOR_PARTIAL;

        // If no snippets fit (not even partially from main loop), and there's enough space for
        // the partial truncation message, some minimal content, and a safety buffer,
        // try to add a "tiny" piece of the most relevant snippet.
        if (sortedSnippets.length > 0 && selectedSnippets.length === 0 &&
            availableTokens > (partialMsgTokensForTiny + MIN_CONTENT_TOKENS_FOR_TINY_ATTEMPT + safetyBufferForTinyCalc)) {
            const mostRelevantSnippet = sortedSnippets[0];

            // Calculate available characters for the tiny content part
            // Aim to use space left after accounting for the partial message and safety buffer
            const targetTinyContentTokens = availableTokens - partialMsgTokensForTiny - safetyBufferForTinyCalc;
            const charsPerTokenEstimateForTiny = TokenManagerService.CHARS_PER_TOKEN_ESTIMATE;

            if (targetTinyContentTokens > 0) {
                const maxTinyChars = Math.max(0, Math.floor(targetTinyContentTokens * charsPerTokenEstimateForTiny));

                if (maxTinyChars > 0) {
                    let tinyContent = mostRelevantSnippet.content.substring(0, maxTinyChars);
                    // Similar to partial content, removing aggressive newline stripping here.
                    // The code block closing logic will handle it.
                    // const lastNewline = tinyContent.lastIndexOf('\n');
                    // if (lastNewline > 0) tinyContent = tinyContent.substring(0, lastNewline);

                    const codeBlockStart = '```';
                    const codeBlockEnd = '```';
                    if (tinyContent.includes(codeBlockStart) && !tinyContent.endsWith(codeBlockEnd)) {
                        if (tinyContent.lastIndexOf(codeBlockStart) > tinyContent.lastIndexOf(codeBlockEnd)) {
                            tinyContent += `\n${codeBlockEnd}`;
                        }
                    }
                    tinyContent += TokenManagerService.TRUNCATION_MESSAGES.PARTIAL;
                    if (!this.currentModel) {
                        return { optimizedSnippets: selectedSnippets, wasTruncated };
                    }
                    const tinySnippetTokens = await this.currentModel.countTokens(tinyContent);

                    if (tinySnippetTokens <= availableTokens) {
                        selectedSnippets.push({ ...mostRelevantSnippet, content: tinyContent, id: mostRelevantSnippet.id + "-tiny" });
                        wasTruncated = true;
                    }
                }
                // This Log.info and return should be outside the 'if (targetTinyContentTokens > 0)' block
                // and also outside the 'if (maxTinyChars > 0)' block to ensure the function always returns.
            } // End of 'if (targetTinyContentTokens > 0)'
        } // End of 'if (sortedSnippets.length > 0 && selectedSnippets.length === 0 ...)' for tiny snippet logic

        Log.info(`Context optimization: ${selectedSnippets.length} of ${sortedSnippets.length} snippets selected. Tokens used: ${currentTokens} / ${availableTokens}. Truncated: ${wasTruncated}`);
        return { optimizedSnippets: selectedSnippets, wasTruncated };
    }


    /**
     * Ensures that markdown code blocks are properly closed in truncated content
     * @param partialContent The truncated content
     * @param originalContent The original full content for reference
     * @returns Content with properly closed code blocks
     */
    private ensureCodeBlocksClosed(partialContent: string, originalContent: string): string {
        const codeBlockStartRegex = /```[\w]*\n/g;
        const codeBlockEnd = '\n```';
        let lastCodeBlockStart = -1;
        let match;

        while ((match = codeBlockStartRegex.exec(originalContent)) !== null) {
            if (match.index < partialContent.length) {
                lastCodeBlockStart = match.index;
            } else {
                break;
            }
        }

        if (lastCodeBlockStart !== -1) {
            const lastCodeBlockEndInPartial = partialContent.lastIndexOf(codeBlockEnd);
            // If a code block was opened and not closed within the partial content
            if (lastCodeBlockStart > (lastCodeBlockEndInPartial === -1 ? -1 : lastCodeBlockEndInPartial)) {
                // Check if the original snippet had a closing tag after the partial content cut-off
                const originalClosingTagIndex = originalContent.indexOf(codeBlockEnd, lastCodeBlockStart);
                if (originalClosingTagIndex === -1 || originalClosingTagIndex > partialContent.length) {
                    partialContent += codeBlockEnd;
                }
            }
        }

        return partialContent;
    }

    /**
    * Formats a list of context snippets into a single markdown string.
    * @param snippets The list of ContextSnippet objects to format.
    * @param wasTruncated Whether to add a truncation message at the end.
    * @returns A formatted markdown string.
    */
    public formatContextSnippetsToString(snippets: ContextSnippet[], wasTruncated: boolean = false): string {
        const lspDefinitions = snippets.filter(s => s.type === 'lsp-definition');
        const lspReferences = snippets.filter(s => s.type === 'lsp-reference');
        const embeddings = snippets.filter(s => s.type === 'embedding');

        const parts: string[] = [];

        // Display in priority order: Embeddings > References > Definitions
        if (embeddings.length > 0) {
            parts.push("## Semantically Similar Code (Embeddings)");
            // Embeddings content is already formatted markdown from ContextProvider
            embeddings.forEach(s => parts.push(s.content));
        }

        if (lspReferences.length > 0) {
            parts.push(embeddings.length > 0 ? "\n## References Found (LSP)" : "## References Found (LSP)");
            lspReferences.forEach(s => parts.push(s.content));
        }

        if (lspDefinitions.length > 0) {
            parts.push((embeddings.length > 0 || lspReferences.length > 0) ? "\n## Definitions Found (LSP)" : "## Definitions Found (LSP)");
            lspDefinitions.forEach(s => parts.push(s.content));
        }

        let result = parts.join('\n\n').trim();

        if (wasTruncated && snippets.length < 1 && result.length === 0) { // If all snippets were too large
            result += TokenManagerService.TRUNCATION_MESSAGES.CONTEXT.replace("Some information might be missing", "All context snippets were too large to fit");
        } else if (wasTruncated) {
            result += TokenManagerService.TRUNCATION_MESSAGES.CONTEXT;
        }

        if (result.length === 0 && !wasTruncated && snippets.length === 0) {
            return "No relevant context snippets were selected or found.";
        }

        return result;
    }

    /**
     * Removes duplicate context snippets using SHA-256 hashing.
     * @param snippets List of context snippets to deduplicate
     * @returns Array of unique context snippets
     */
    private deduplicateContext(snippets: ContextSnippet[]): ContextSnippet[] {
        if (snippets.length === 0) {
            return [];
        }

        const seen = new Set<string>();
        const deduplicatedSnippets: ContextSnippet[] = [];

        for (const snippet of snippets) {
            // Create hash based on content only (not id or other metadata)
            const hash = crypto.createHash('sha256').update(snippet.content.trim()).digest('hex');

            if (!seen.has(hash)) {
                seen.add(hash);
                deduplicatedSnippets.push(snippet);
            } else {
                Log.info(`Duplicate context snippet filtered out: ${snippet.id}`);
            }
        }

        const removedCount = snippets.length - deduplicatedSnippets.length;
        if (removedCount > 0) {
            Log.info(`Context deduplication: removed ${removedCount} duplicate snippets out of ${snippets.length} total`);
        }

        return deduplicatedSnippets;
    }


    /**
     * Get the current model's token limit
     * @returns Maximum input tokens for current model
     */
    public async getModelTokenLimit(): Promise<number> {
        await this.updateModelInfo();
        return this.modelDetails?.maxInputTokens || 8000;
    }

    /**
     * Calculate tokens for a given text using current model
     * @param text Text to calculate tokens for
     * @returns Token count
     */
    public async calculateTokens(text: string): Promise<number> {
        await this.updateModelInfo();
        return await this.currentModel!.countTokens(text);
    }

    /**
     * Calculate total tokens for complete message array that will be sent to model
     * @param systemPrompt System prompt content
     * @param userPrompt User prompt content
     * @param responsePrefill Response prefill content
     * @returns Total token count including message overhead
     */
    public async calculateCompleteMessageTokens(
        systemPrompt: string,
        userPrompt: string,
        responsePrefill?: string
    ): Promise<number> {
        await this.updateModelInfo();

        let totalTokens = 0;

        // System message tokens + overhead
        totalTokens += await this.currentModel!.countTokens(systemPrompt) + TokenManagerService.TOKEN_OVERHEAD_PER_MESSAGE;

        // User message tokens + overhead
        totalTokens += await this.currentModel!.countTokens(userPrompt) + TokenManagerService.TOKEN_OVERHEAD_PER_MESSAGE;

        // Response prefill tokens + overhead (if provided)
        if (responsePrefill) {
            totalTokens += await this.currentModel!.countTokens(responsePrefill) + TokenManagerService.TOKEN_OVERHEAD_PER_MESSAGE;
        }

        return totalTokens;
    }

    /**
     * Update model information from the model manager
     */
    private async updateModelInfo(): Promise<void> {
        if (!this.currentModel) {
            try {
                // Get current model
                this.currentModel = await this.modelManager.getCurrentModel();

                // Get all models to find details for the current one
                const models = await this.modelManager.listAvailableModels();
                const currentModelId = this.currentModel.id;

                // Find the matching model details
                const modelDetail = models.find(m => m.id === currentModelId);

                if (modelDetail) {
                    this.modelDetails = {
                        family: modelDetail.family,
                        maxInputTokens: modelDetail.maxInputTokens
                    };
                } else {
                    // Fallback if we can't find details
                    Log.warn(`Could not find model details for ${currentModelId}, using defaults`);
                    this.modelDetails = {
                        family: 'unknown',
                        maxInputTokens: 8000
                    };
                }
            } catch (error) {
                Log.error('Error getting model info:', error);
                this.modelDetails = {
                    family: 'unknown',
                    maxInputTokens: 8000
                };
            }
        }
    }

    /**
     * Get system prompt for a given analysis mode
     * @param mode Analysis mode
     * @returns System prompt text
     */
    public getSystemPromptForMode(mode: AnalysisMode): string {
        return this.promptGenerator.getSystemPrompt(mode);
    }

    /**
     * Get response prefill to guide output format
     * @returns Response prefill text
     */
    public getResponsePrefill(): string {
        return this.promptGenerator.getResponsePrefill();
    }

    public dispose(): void {
        this.currentModel = null;
        this.modelDetails = null;
    }
}