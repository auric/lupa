import * as vscode from 'vscode';
import * as crypto from 'crypto';
import type {
    ContextSnippet,
    ContentType,
    ContentPrioritization,
    OptimizationResult
} from '../types/contextTypes';
import { CopilotModelManager } from './copilotModelManager';
import { TokenConstants } from './tokenConstants';
import { Log } from '../services/loggingService';

/**
 * Handles context snippet optimization, deduplication, and formatting
 * Focuses on selecting and organizing context snippets within token limits
 */
export class ContextOptimizer {
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
     * Formats a list of context snippets into a single markdown string.
     * @param snippets The list of ContextSnippet objects to format.
     * @param wasTruncated Whether to add a truncation message at the end.
     * @returns A formatted markdown string.
     */
    formatContextSnippetsToString(snippets: ContextSnippet[], wasTruncated: boolean = false): string {
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
    ): Promise<OptimizationResult> {
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
                const partialTruncMsgTokens = await this.currentModel.countTokens(TokenConstants.TRUNCATION_MESSAGES.PARTIAL);
                const MIN_CONTENT_TOKENS_FOR_PARTIAL_ATTEMPT = TokenConstants.MIN_CONTENT_TOKENS_FOR_PARTIAL;
                const safetyBufferForPartialCalc = TokenConstants.SAFETY_BUFFER_FOR_PARTIAL;

                // Attempt partial truncation if:
                // 1. There's enough space for the truncation message and some minimal content.
                // 2. The current snippet is larger than the remaining space.
                if (remainingTokensForPartial > (partialTruncMsgTokens + MIN_CONTENT_TOKENS_FOR_PARTIAL_ATTEMPT) &&
                    snippetTokens > remainingTokensForPartial) {
                    try {
                        const charsPerTokenEstimate = TokenConstants.CHARS_PER_TOKEN_ESTIMATE;

                        // Target tokens for the content part of the partial snippet
                        const targetContentTokens = remainingTokensForPartial - partialTruncMsgTokens - safetyBufferForPartialCalc;

                        if (targetContentTokens > 0) {
                            // Estimate max characters for the content part
                            const maxChars = Math.max(0, Math.floor(targetContentTokens * charsPerTokenEstimate));

                            if (maxChars > 0) {
                                let partialContent = snippet.content.substring(0, maxChars);

                                // Ensure markdown code blocks are properly closed
                                partialContent = this.ensureCodeBlocksClosed(partialContent, snippet.content);
                                partialContent += TokenConstants.TRUNCATION_MESSAGES.PARTIAL;

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
        const MIN_CONTENT_TOKENS_FOR_TINY_ATTEMPT = TokenConstants.MIN_CONTENT_TOKENS_FOR_PARTIAL;
        if (!this.currentModel) {
            return { optimizedSnippets: selectedSnippets, wasTruncated };
        }
        const partialMsgTokensForTiny = await this.currentModel.countTokens(TokenConstants.TRUNCATION_MESSAGES.PARTIAL);
        const safetyBufferForTinyCalc = TokenConstants.SAFETY_BUFFER_FOR_PARTIAL;

        // If no snippets fit (not even partially from main loop), and there's enough space for
        // the partial truncation message, some minimal content, and a safety buffer,
        // try to add a "tiny" piece of the most relevant snippet.
        if (sortedSnippets.length > 0 && selectedSnippets.length === 0 &&
            availableTokens > (partialMsgTokensForTiny + MIN_CONTENT_TOKENS_FOR_TINY_ATTEMPT + safetyBufferForTinyCalc)) {
            const mostRelevantSnippet = sortedSnippets[0];

            // Calculate available characters for the tiny content part
            const targetTinyContentTokens = availableTokens - partialMsgTokensForTiny - safetyBufferForTinyCalc;
            const charsPerTokenEstimateForTiny = TokenConstants.CHARS_PER_TOKEN_ESTIMATE;

            if (targetTinyContentTokens > 0) {
                const maxTinyChars = Math.max(0, Math.floor(targetTinyContentTokens * charsPerTokenEstimateForTiny));

                if (maxTinyChars > 0) {
                    let tinyContent = mostRelevantSnippet.content.substring(0, maxTinyChars);

                    // Ensure code blocks are closed
                    const codeBlockStart = '```';
                    const codeBlockEnd = '```';
                    if (tinyContent.includes(codeBlockStart) && !tinyContent.endsWith(codeBlockEnd)) {
                        if (tinyContent.lastIndexOf(codeBlockStart) > tinyContent.lastIndexOf(codeBlockEnd)) {
                            tinyContent += `\n${codeBlockEnd}`;
                        }
                    }
                    tinyContent += TokenConstants.TRUNCATION_MESSAGES.PARTIAL;

                    if (!this.currentModel) {
                        return { optimizedSnippets: selectedSnippets, wasTruncated };
                    }
                    const tinySnippetTokens = await this.currentModel.countTokens(tinyContent);

                    if (tinySnippetTokens <= availableTokens) {
                        selectedSnippets.push({ ...mostRelevantSnippet, content: tinyContent, id: mostRelevantSnippet.id + "-tiny" });
                        wasTruncated = true;
                    }
                }
            }
        }

        Log.info(`Context optimization: ${selectedSnippets.length} of ${sortedSnippets.length} snippets selected. Tokens used: ${currentTokens} / ${availableTokens}. Truncated: ${wasTruncated}`);
        return { optimizedSnippets: selectedSnippets, wasTruncated };
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
     * Update model information from the model manager
     */
    private async updateModelInfo(): Promise<void> {
        if (!this.currentModel) {
            this.currentModel = await this.modelManager.getCurrentModel();
        }
    }

    dispose(): void {
        this.currentModel = null;
    }
}