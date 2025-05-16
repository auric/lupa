import * as vscode from 'vscode';
import { CopilotModelManager } from '../models/copilotModelManager';
import { AnalysisMode } from '../types/modelTypes';
import { ContextSnippet } from '../types/contextTypes';

/**
 * Components of an analysis that consume tokens
 */
export interface TokenComponents {
    systemPrompt?: string;
    diffText?: string;
    context?: string; // This will be the preliminary formatted string of all snippets
    userMessages?: string[];
    assistantMessages?: string[];
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
        const diffTextTokens = components.diffText
            ? await this.currentModel!.countTokens(components.diffText) : 0;
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
        const totalRequiredTokens = systemPromptTokens + diffTextTokens + contextTokens +
            userMessagesTokens + assistantMessagesTokens + otherTokens;

        const nonContextTokens = systemPromptTokens + diffTextTokens +
            userMessagesTokens + assistantMessagesTokens + otherTokens;
        const contextAllocation = Math.max(0, safeMaxTokens - nonContextTokens);

        return {
            totalAvailableTokens: safeMaxTokens,
            totalRequiredTokens,
            systemPromptTokens,
            diffTextTokens,
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
     * @returns A formatted string of the optimized context.
     */
    public async optimizeContext(
        snippets: ContextSnippet[],
        availableTokens: number
    ): Promise<string> {
        await this.updateModelInfo();
        if (!this.currentModel) {
            console.error("Language model not available for token counting in optimizeContext.");
            return this.formatContextSnippetsToString([], true); // Return empty with truncation msg
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
                if (snippet.type === 'embedding' && remainingTokensForPartial > 100 && snippetTokens > remainingTokensForPartial) { // Arbitrary threshold
                    try {
                        const modelFamily = this.modelDetails?.family || 'unknown';
                        let charsPerToken = 4;
                        if (modelFamily.toLowerCase().includes('claude')) charsPerToken = 5;
                        else if (modelFamily.toLowerCase().includes('gemini')) charsPerToken = 4.5;

                        const maxChars = Math.floor(remainingTokensForPartial * charsPerToken * 0.8); // 80% to be safe

                        // Find a good place to break (e.g., end of a line)
                        let partialContent = snippet.content.substring(0, maxChars);
                        const lastNewline = partialContent.lastIndexOf('\n');
                        if (lastNewline > 0) {
                            partialContent = partialContent.substring(0, lastNewline);
                        }

                        // Ensure the partial content ends correctly for markdown code blocks
                        const codeBlockStart = '```';
                        const codeBlockEnd = '```';
                        if (partialContent.includes(codeBlockStart) && !partialContent.endsWith(codeBlockEnd)) {
                            if (partialContent.lastIndexOf(codeBlockStart) > partialContent.lastIndexOf(codeBlockEnd)) {
                                partialContent += `\n${codeBlockEnd}`; // Close the code block
                            }
                        }
                        partialContent += TokenManagerService.PARTIAL_TRUNCATION_MESSAGE;


                        const partialSnippetTokens = await this.currentModel.countTokens(partialContent);
                        if (currentTokens + partialSnippetTokens <= availableTokens) {
                            selectedSnippets.push({ ...snippet, content: partialContent, id: snippet.id + "-partial" });
                            currentTokens += partialSnippetTokens;
                        }
                    } catch (e) {
                        console.warn("Error during partial snippet truncation:", e);
                    }
                }
                break; // Stop adding snippets if the current one doesn't fit
            }
        }

        if (sortedSnippets.length > 0 && selectedSnippets.length === 0 && availableTokens > await this.currentModel.countTokens(TokenManagerService.TRUNCATION_MESSAGE) + 50) {
            // If no snippets fit but there's some space, try to add a very small part of the most relevant one
            const mostRelevantSnippet = sortedSnippets[0];
            let tinyContent = mostRelevantSnippet.content.substring(0, Math.floor(availableTokens * 0.5)); // Very rough estimate
            const lastNewline = tinyContent.lastIndexOf('\n');
            if (lastNewline > 0) tinyContent = tinyContent.substring(0, lastNewline);

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


        console.log(`Context optimization: ${selectedSnippets.length} of ${snippets.length} snippets selected. Tokens used: ${currentTokens} / ${availableTokens}. Truncated: ${wasTruncated}`);
        return this.formatContextSnippetsToString(selectedSnippets, wasTruncated);
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
                    console.warn(`Could not find model details for ${currentModelId}, using defaults`);
                    this.modelDetails = {
                        family: 'unknown',
                        maxInputTokens: 8000
                    };
                }
            } catch (error) {
                console.error('Error getting model info:', error);
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