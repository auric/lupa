import * as vscode from 'vscode';
import type {
    TokenComponents,
    ContentType,
    ContentPrioritization,
    TruncatedTokenComponents,
    TruncationResult,
    ContextSnippet
} from '../types/contextTypes';
import { CopilotModelManager } from './copilotModelManager';
import { TokenConstants } from './tokenConstants';
import { Log } from '../services/loggingService';

/**
 * Handles waterfall truncation algorithms for token optimization
 * Implements priority-based truncation strategies
 */
export class WaterfallTruncator {
    private currentModel: vscode.LanguageModelChat | null = null;

    constructor(
        private readonly modelManager: CopilotModelManager,
        private contentPrioritization: ContentPrioritization = {
            order: ['diff', 'embedding', 'lsp-reference', 'lsp-definition']
        }
    ) { }

    /**
     * Set the content prioritization order
     * @param prioritization Content prioritization configuration
     */
    setContentPrioritization(prioritization: ContentPrioritization): void {
        this.contentPrioritization = prioritization;
    }

    /**
     * Get current content prioritization order
     * @returns Current content prioritization configuration
     */
    getContentPrioritization(): ContentPrioritization {
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
    async performProportionalTruncation(
        components: TokenComponents,
        targetTokens: number
    ): Promise<TruncatedTokenComponents> {
        await this.updateModelInfo();

        // Ensure we have separated context fields
        const normalizedComponents = this.ensureSeparatedContextFields(components);

        const currentTokens = await this.calculateComponentTokens(normalizedComponents);
        if (currentTokens <= targetTokens) {
            return { components: normalizedComponents, wasTruncated: false };
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
            return { components: truncatedComponents, wasTruncated: true };
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
        const totalContextTokens = embeddingTokens + lspRefTokens + lspDefTokens;
        const totalContentTokens = diffTokens + totalContextTokens;

        if (totalContentTokens <= availableTokensForContent) {
            // Everything fits - no truncation needed
            return { components: truncatedComponents, wasTruncated: false };
        }

        // Apply waterfall allocation based on priority order
        const waterfallResult = await this.applyWaterfallAllocation(
            truncatedComponents,
            availableTokensForContent,
            { diff: diffTokens, embedding: embeddingTokens, 'lsp-reference': lspRefTokens, 'lsp-definition': lspDefTokens }
        );
        wasTruncated = waterfallResult.wasTruncated;

        // Return the truncated components with separate context fields
        return { components: truncatedComponents, wasTruncated };
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
    ): Promise<TruncationResult> {
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
    ): Promise<TruncationResult> {
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
     * Truncate content proportionally from the end
     * @param content Content to truncate
     * @param tokensToRemove Number of tokens to remove
     * @returns Truncated content and truncation status
     */
    private async truncateContent(content: string, tokensToRemove: number): Promise<TruncationResult> {
        await this.updateModelInfo();
        if (!this.currentModel || tokensToRemove <= 0) {
            return { content, wasTruncated: false };
        }

        const currentTokens = await this.currentModel.countTokens(content);
        const targetTokens = currentTokens - tokensToRemove;

        // Calculate tokens needed for truncation message
        const truncationMessageTokens = await this.currentModel.countTokens(TokenConstants.TRUNCATION_MESSAGES.PARTIAL);
        const availableTokensForContent = targetTokens - truncationMessageTokens;

        if (availableTokensForContent <= 0) {
            // Not enough space even for truncation message
            return { content: '', wasTruncated: true };
        }

        const charsPerToken = TokenConstants.CHARS_PER_TOKEN_ESTIMATE;
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

        truncatedContent += TokenConstants.TRUNCATION_MESSAGES.PARTIAL;

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
            truncatedContent += TokenConstants.TRUNCATION_MESSAGES.PARTIAL;
        }

        return { content: truncatedContent, wasTruncated: true };
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
     * Formats a list of context snippets into a single markdown string.
     * @param snippets The list of ContextSnippet objects to format.
     * @param wasTruncated Whether to add a truncation message at the end.
     * @returns A formatted markdown string.
     */
    private formatContextSnippetsToString(snippets: ContextSnippet[], wasTruncated: boolean = false): string {
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
            result += TokenConstants.TRUNCATION_MESSAGES.CONTEXT.replace("Some information might be missing", "All context snippets were too large to fit");
        } else if (wasTruncated) {
            result += TokenConstants.TRUNCATION_MESSAGES.CONTEXT;
        }

        if (result.length === 0 && !wasTruncated && snippets.length === 0) {
            return "No relevant context snippets were selected or found.";
        }

        return result;
    }

    // Helper methods that are duplicated across classes - could be extracted to utility
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
        if (components.embeddingContext) {
            totalTokens += await this.currentModel.countTokens(components.embeddingContext);
        }
        if (components.lspReferenceContext) {
            totalTokens += await this.currentModel.countTokens(components.lspReferenceContext);
        }
        if (components.lspDefinitionContext) {
            totalTokens += await this.currentModel.countTokens(components.lspDefinitionContext);
        }

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

        if (components.systemPrompt) {
            messageCount++;
        }

        totalTokens += messageCount * TokenConstants.TOKEN_OVERHEAD_PER_MESSAGE;
        if (components.diffStructureTokens) {
            totalTokens += components.diffStructureTokens;
        }

        return totalTokens + TokenConstants.FORMATTING_OVERHEAD;
    }

    private async calculateFixedTokens(components: TokenComponents): Promise<number> {
        await this.updateModelInfo();
        if (!this.currentModel) return 0;

        let fixedTokens = 0;

        if (components.systemPrompt) {
            fixedTokens += await this.currentModel.countTokens(components.systemPrompt);
        }

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

        if (components.responsePrefill) {
            fixedTokens += await this.currentModel.countTokens(components.responsePrefill);
        }

        if (components.diffStructureTokens && !components.diffText) {
            fixedTokens += components.diffStructureTokens;
        }

        const messageCount = (components.systemPrompt ? 1 : 0) +
            (components.userMessages?.length || 0) +
            (components.assistantMessages?.length || 0) +
            (components.responsePrefill ? 1 : 0);
        fixedTokens += messageCount * TokenConstants.TOKEN_OVERHEAD_PER_MESSAGE;
        fixedTokens += TokenConstants.FORMATTING_OVERHEAD;

        return fixedTokens;
    }

    private async updateModelInfo(): Promise<void> {
        if (!this.currentModel) {
            this.currentModel = await this.modelManager.getCurrentModel();
        }
    }

    dispose(): void {
        this.currentModel = null;
    }
}
