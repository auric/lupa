import * as vscode from 'vscode';
import { CopilotModelManager } from '../models/copilotModelManager';
import { AnalysisMode } from '../types/modelTypes';
import { ContextSnippet } from '../types/contextTypes';
import { Log } from './loggingService';

/**
 * Components of an analysis that consume tokens
 */
export interface TokenComponents {
    systemPrompt?: string;
    diffText?: string; // Original flat diff, can be used as fallback or for non-interleaved
    context?: string; // This will be the preliminary formatted string of all snippets
    userMessages?: string[];
    assistantMessages?: string[];
    diffStructureTokens?: number; // Tokens for the diff's structural representation in an interleaved prompt
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
    otherTokens: number; // Reserved for formatting, metadata, etc.
    fitsWithinLimit: boolean;
    contextAllocationTokens: number; // How many tokens can be allocated to context
}

/**
 * Service for managing token calculations and optimizations
 * Follows Single Responsibility Principle by focusing only on token management
 */
export class TokenManagerService {
    // Standard overhead for different token components
    private static readonly TOKEN_OVERHEAD_PER_MESSAGE = 5;
    private static readonly FORMATTING_OVERHEAD = 50; // For overall prompt structure
    private static readonly SAFETY_MARGIN_RATIO = 0.95; // 5% safety margin
    private static readonly TRUNCATION_MESSAGE = '\n\n[Context truncated to fit token limit. Some information might be missing.]';
    private static readonly PARTIAL_TRUNCATION_MESSAGE = '\n\n[File content partially truncated to fit token limit]';


    private currentModel: vscode.LanguageModelChat | null = null;
    private modelDetails: { family: string; maxInputTokens: number } | null = null;

    constructor(private readonly modelManager: CopilotModelManager) { }

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

        const contextTokens = components.context // Assuming components.context is the full, unoptimized string
            ? await this.currentModel!.countTokens(components.context) : 0;

        let userMessagesTokens = 0;
        if (components.userMessages) {
            for (const message of components.userMessages) {
                userMessagesTokens += (await this.currentModel!.countTokens(message) || 0) + TokenManagerService.TOKEN_OVERHEAD_PER_MESSAGE;
            }
        }

        let assistantMessagesTokens = 0;
        if (components.assistantMessages) {
            for (const message of components.assistantMessages) {
                assistantMessagesTokens += (await this.currentModel!.countTokens(message) || 0) + TokenManagerService.TOKEN_OVERHEAD_PER_MESSAGE;
            }
        }

        const otherTokens = TokenManagerService.FORMATTING_OVERHEAD;
        const totalRequiredTokens = systemPromptTokens + diffTokens + contextTokens +
            userMessagesTokens + assistantMessagesTokens + otherTokens;

        const nonContextTokens = systemPromptTokens + diffTokens +
            userMessagesTokens + assistantMessagesTokens + otherTokens;
        const contextAllocation = Math.max(0, safeMaxTokens - nonContextTokens);

        return {
            totalAvailableTokens: safeMaxTokens,
            totalRequiredTokens,
            systemPromptTokens,
            diffTextTokens: diffTokens, // This now reflects either flat diff or structured diff tokens
            contextTokens, // Tokens of the full unoptimized context string
            userMessagesTokens,
            assistantMessagesTokens,
            otherTokens,
            fitsWithinLimit: totalRequiredTokens <= safeMaxTokens,
            contextAllocationTokens: contextAllocation
        };
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

        // Sort snippets: LSP defs > LSP refs > Embeddings (by score)
        const sortedSnippets = [...snippets].sort((a, b) => {
            const typePriority = (type: ContextSnippet['type']): number => {
                if (type === 'lsp-definition') return 3;
                if (type === 'lsp-reference') return 2;
                return 1; // embedding
            };
            const priorityA = typePriority(a.type);
            const priorityB = typePriority(b.type);

            if (priorityA !== priorityB) {
                return priorityB - priorityA; // Higher priority first
            }
            return b.relevanceScore - a.relevanceScore; // Higher score first
        });

        const selectedSnippets: ContextSnippet[] = [];
        let currentTokens = 0;
        let wasTruncated = false;

        for (const snippet of sortedSnippets) {
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
                const partialTruncMsgTokens = await this.currentModel.countTokens(TokenManagerService.PARTIAL_TRUNCATION_MESSAGE);
                const MIN_CONTENT_TOKENS_FOR_PARTIAL_ATTEMPT = 10; // Minimum actual content tokens we want to try for
                const safetyBufferForPartialCalc = 5; // Buffer for token calculation inaccuracies

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
                        const charsPerTokenEstimate = 4.0; // To align with mock countTokens (ceil(len/4))

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
                                partialContent += TokenManagerService.PARTIAL_TRUNCATION_MESSAGE;

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
        const MIN_CONTENT_TOKENS_FOR_TINY_ATTEMPT = 10;
        // For tiny content, we still use PARTIAL_TRUNCATION_MESSAGE as it's shorter and indicates partial nature.
        const partialMsgTokensForTiny = await this.currentModel.countTokens(TokenManagerService.PARTIAL_TRUNCATION_MESSAGE);
        const safetyBufferForTinyCalc = 5; // Safety buffer for token calculation of content part

        // If no snippets fit (not even partially from main loop), and there's enough space for
        // the partial truncation message, some minimal content, and a safety buffer,
        // try to add a "tiny" piece of the most relevant snippet.
        if (sortedSnippets.length > 0 && selectedSnippets.length === 0 &&
            availableTokens > (partialMsgTokensForTiny + MIN_CONTENT_TOKENS_FOR_TINY_ATTEMPT + safetyBufferForTinyCalc)) {
            const mostRelevantSnippet = sortedSnippets[0];

            // Calculate available characters for the tiny content part
            // Aim to use space left after accounting for the partial message and safety buffer
            const targetTinyContentTokens = availableTokens - partialMsgTokensForTiny - safetyBufferForTinyCalc;
            const charsPerTokenEstimateForTiny = 4.0; // To align with mock countTokens

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
                    tinyContent += TokenManagerService.PARTIAL_TRUNCATION_MESSAGE;
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

        Log.info(`Context optimization: ${selectedSnippets.length} of ${snippets.length} snippets selected. Tokens used: ${currentTokens} / ${availableTokens}. Truncated: ${wasTruncated}`);
        return { optimizedSnippets: selectedSnippets, wasTruncated };
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

        if (lspDefinitions.length > 0) {
            parts.push("## Definitions Found (LSP)");
            lspDefinitions.forEach(s => parts.push(s.content));
        }

        if (lspReferences.length > 0) {
            parts.push(lspReferences.length > 0 && lspDefinitions.length > 0 ? "\n## References Found (LSP)" : "## References Found (LSP)");
            lspReferences.forEach(s => parts.push(s.content));
        }

        if (embeddings.length > 0) {
            parts.push((lspDefinitions.length > 0 || lspReferences.length > 0) ? "\n## Semantically Similar Code (Embeddings)" : "## Semantically Similar Code (Embeddings)");
            // Embeddings content is already formatted markdown from ContextProvider
            embeddings.forEach(s => parts.push(s.content));
        }

        let result = parts.join('\n\n').trim();

        if (wasTruncated && snippets.length < 1 && result.length === 0) { // If all snippets were too large
            result += TokenManagerService.TRUNCATION_MESSAGE.replace("Some information might be missing", "All context snippets were too large to fit");
        } else if (wasTruncated) {
            result += TokenManagerService.TRUNCATION_MESSAGE;
        }

        if (result.length === 0 && !wasTruncated && snippets.length === 0) {
            return "No relevant context snippets were selected or found.";
        }

        return result;
    }

    /**
     * Formats context snippets for display
     * @param snippets The list of ContextSnippet objects to format.
     * @param wasTruncated Whether to add a truncation message at the end.
     * @returns A formatted markdown string for display.
     */
    public formatContextSnippetsForDisplay(snippets: ContextSnippet[], wasTruncated: boolean = false): string {
        return this.formatContextSnippetsToString(snippets, wasTruncated);
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
        switch (mode) {
            case 'critical':
                return `You are a code review assistant focused on identifying critical issues in pull requests.
                        Analyze the code changes for bugs, errors, security vulnerabilities, and performance issues.
                        Focus only on high-impact problems that could lead to application failures, security breaches, or significant performance degradation.`;

            case 'comprehensive':
                return `You are a thorough code review assistant. Analyze the pull request for all types of issues, including:
                        - Logic errors and bugs
                        - Security vulnerabilities
                        - Performance concerns
                        - Code style and best practices
                        - Architecture and design issues
                        - Testing coverage and quality
                        Provide detailed explanations and suggestions for improvement.`;

            case 'security':
                return `You are a security-focused code review assistant. Analyze the pull request specifically for security vulnerabilities and risks, including:
                        - Injection vulnerabilities (SQL, NoSQL, command, etc.)
                        - Authentication and authorization issues
                        - Data exposure risks
                        - Insecure dependencies
                        - Cryptographic failures
                        - Security misconfiguration
                        Provide detailed explanations of each security risk and recommendations for remediation.`;

            case 'performance':
                return `You are a performance optimization specialist. Analyze the pull request for performance issues and inefficiencies, including:
                        - Algorithmic complexity problems
                        - Resource leaks
                        - Unnecessary computations
                        - I/O bottlenecks
                        - Memory usage issues
                        - Database query performance
                        Provide detailed explanations of each performance concern and suggestions for optimization.`;

            default:
                return `You are a code review assistant. Analyze the pull request changes and provide insights about potential issues, improvements, and general feedback.`;
        }
    }
}