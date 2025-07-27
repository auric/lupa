import * as vscode from 'vscode';
import { ContextProvider } from './contextProvider';
import { TokenManagerService } from './tokenManagerService';
import type { ContentPrioritization, TokenComponents } from '../types/contextTypes';
import { CopilotModelManager } from '../models/copilotModelManager';
import { AnalysisMode } from '../types/modelTypes';
import type {
    ContextSnippet,
    DiffHunk,
    HybridContextResult
} from '../types/contextTypes';
import { Log } from './loggingService';
import { PromptGenerator } from './promptGenerator';

/**
 * AnalysisProvider handles the core analysis logic using language models
 */
export class AnalysisProvider implements vscode.Disposable {
    /**
     * Create a new AnalysisProvider
     * @param contextProvider Provider for relevant code context
     * @param modelManager Manager for language models
     * @param tokenManager Token manager for handling token allocation and optimization
     * @param promptGenerator Generator for structured prompts
     */
    constructor(
        private readonly contextProvider: ContextProvider,
        private readonly modelManager: CopilotModelManager,
        private readonly tokenManager: TokenManagerService,
        private readonly promptGenerator: PromptGenerator
    ) {
        // Configure content prioritization order in TokenManagerService
        this.tokenManager.setContentPrioritization({
            order: ['diff', 'embedding', 'lsp-reference', 'lsp-definition']
        });
    }

    /**
     * Analyze PR using language models
     * @param diffText The diff text to analyze
     * @param gitRootPath The root path of the Git repository.
     * @param mode The analysis mode
     * @param progressCallback Optional callback for progress updates
     * @param token Optional cancellation token
     */
    public async analyzePullRequest(
        diffText: string,
        gitRootPath: string,
        mode: AnalysisMode,
        progressCallback?: (message: string, increment?: number) => void,
        token?: vscode.CancellationToken
    ): Promise<{
        analysis: string;
        context: string; // This will be the final optimized context string
    }> {
        try {
            if (token?.isCancellationRequested) throw new Error('Operation cancelled');
            progressCallback?.('Retrieving relevant code context...', 5);

            const hybridContextResult: HybridContextResult = await this.contextProvider.getContextForDiff(
                diffText,
                gitRootPath,
                undefined, // options
                mode,
                (processed: number, total: number) => {
                    if (progressCallback) {
                        const percentage = Math.round((processed / total) * 100);
                        if (percentage % 10 === 0 || percentage === 100) {
                            progressCallback(`Generating embeddings: ${processed} of ${total} (${percentage}%)`, 0.2);
                        } else {
                            progressCallback(`Generating embeddings: ${processed} of ${total} (${percentage}%)`);
                        }
                    }
                },
                token
            );

            if (token?.isCancellationRequested) throw new Error('Operation cancelled');
            progressCallback?.('Context retrieved. Analyzing with language model...', 5);

            const { analysis, optimizedContext } = await this.analyzeWithLanguageModel(
                diffText,
                hybridContextResult.parsedDiff,
                hybridContextResult.snippets,
                mode,
                token
            );

            if (token?.isCancellationRequested) throw new Error('Operation cancelled');
            progressCallback?.('Analysis complete', 20);

            return {
                analysis,
                context: optimizedContext // Return the optimized context string
            };
        } catch (error) {
            if (token?.isCancellationRequested) throw new Error('Operation cancelled');
            throw new Error(`Failed to analyze PR: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Analyzes PR using language models with optimized context and token management
     * @param diffText Original diff text for analysis
     * @param parsedDiff Structured diff information
     * @param allContextSnippets Context snippets to optimize and include
     * @param mode Analysis mode determining prompt structure
     * @param token Optional cancellation token
     * @returns Analysis result and optimized context string
     */
    private async analyzeWithLanguageModel(
        diffText: string, // Original full diff text, might not be directly used in prompt if interleaved
        parsedDiff: DiffHunk[],
        allContextSnippets: ContextSnippet[],
        mode: AnalysisMode,
        token?: vscode.CancellationToken
    ): Promise<{ analysis: string; optimizedContext: string }> {
        try {
            const model = await this.modelManager.getCurrentModel();
            const systemPrompt = this.tokenManager.getSystemPromptForMode(mode);
            const responsePrefill = this.tokenManager.getResponsePrefill();

            // Format all initially retrieved snippets into a preliminary string for token budget calculation
            const preliminaryContextStringForAllSnippets = this.tokenManager.formatContextSnippetsToString(allContextSnippets, false);

            // No longer need to calculate separate structure tokens - using diffText directly

            // For initial token calculation, treat all context as embedding context
            const tokenComponents = {
                systemPrompt,
                diffText: diffText, // Use actual diff text for token calculation
                contextSnippets: undefined,
                embeddingContext: preliminaryContextStringForAllSnippets, // Full potential context for optimizeContext to choose from
                lspReferenceContext: '',
                lspDefinitionContext: '',
                userMessages: undefined,
                assistantMessages: undefined,
                responsePrefill, // Include response prefill in token calculation
            };

            const allocation = await this.tokenManager.calculateTokenAllocation(tokenComponents, mode);

            // Calculate derived values
            const totalRequiredTokens = allocation.systemPromptTokens + allocation.diffTextTokens + 
                allocation.contextTokens + allocation.userMessagesTokens + allocation.assistantMessagesTokens + 
                allocation.responsePrefillTokens + allocation.messageOverheadTokens + allocation.otherTokens;
            const nonContextTokens = allocation.systemPromptTokens + allocation.diffTextTokens + 
                allocation.userMessagesTokens + allocation.assistantMessagesTokens + 
                allocation.responsePrefillTokens + allocation.messageOverheadTokens + allocation.otherTokens;
            const contextAllocationTokens = Math.max(0, allocation.totalAvailableTokens - nonContextTokens);
            const fitsWithinLimit = totalRequiredTokens <= allocation.totalAvailableTokens;

            Log.info(`Token allocation (pre-optimization): ${JSON.stringify({
                systemPrompt: allocation.systemPromptTokens,
                userPromptStructure: allocation.diffTextTokens, // This now reflects user prompt structure tokens
                contextPotential: allocation.contextTokens, // Based on all potential snippets
                availableForLLM: allocation.totalAvailableTokens,
                totalRequiredPotential: totalRequiredTokens,
                budgetForContextSnippets: contextAllocationTokens,
                fitsPotential: fitsWithinLimit
            })}`);

            if (token?.isCancellationRequested) throw new Error('Operation cancelled by token');

            // Optimize the context snippets (includes deduplication internally)
            const { optimizedSnippets, wasTruncated } = await this.tokenManager.optimizeContext(
                allContextSnippets,
                contextAllocationTokens
            );
            Log.info(`Context optimized: ${optimizedSnippets.length} snippets selected. Truncated: ${wasTruncated}`);

            // This string is for returning to the UI/caller, representing the context that was considered.
            let finalOptimizedContextStringForReturn = this.tokenManager.formatContextSnippetsToString(optimizedSnippets, wasTruncated);

            if (token?.isCancellationRequested) throw new Error('Operation cancelled by token');

            // Generate final user prompt using PromptGenerator
            const finalUserPromptContent = this.promptGenerator.generateUserPrompt(
                diffText,
                parsedDiff,
                finalOptimizedContextStringForReturn,
                optimizedSnippets.length > 0
            );

            const messages = [
                vscode.LanguageModelChatMessage.Assistant(systemPrompt),
                vscode.LanguageModelChatMessage.User(finalUserPromptContent),
                vscode.LanguageModelChatMessage.Assistant(responsePrefill)
            ];

            // Final validation - calculate actual tokens that will be sent to model
            const finalPromptTokens = await this.tokenManager.calculateCompleteMessageTokens(
                systemPrompt,
                finalUserPromptContent,
                responsePrefill
            );

            Log.info(`Final message tokens: ${finalPromptTokens} / ${allocation.totalAvailableTokens} (includes all message overhead)`);

            if (finalPromptTokens > allocation.totalAvailableTokens) {
                Log.warn(`Final message exceeded token limit: ${finalPromptTokens} > ${allocation.totalAvailableTokens}. Applying waterfall truncation.`);

                const truncationResult = await this.applyWaterfallTruncation(
                    systemPrompt,
                    diffText,
                    parsedDiff,
                    optimizedSnippets,
                    responsePrefill,
                    allocation.totalAvailableTokens
                );

                if (truncationResult.wasTruncated) {
                    // Update messages and return values with truncated content
                    messages[1] = vscode.LanguageModelChatMessage.User(truncationResult.userPromptContent);
                    finalOptimizedContextStringForReturn = truncationResult.contextString;

                    Log.info(`After waterfall truncation: ${truncationResult.finalTokens} / ${allocation.totalAvailableTokens} tokens`);
                }
            }

            const requestTokenSource = new vscode.CancellationTokenSource();
            if (token) {
                token.onCancellationRequested(() => requestTokenSource.cancel());
            }

            const response = await model.sendRequest(messages, {}, requestTokenSource.token);

            let responseText = '';
            for await (const chunk of response.text) {
                if (requestTokenSource.token.isCancellationRequested) throw new Error('Operation cancelled during model response streaming');
                responseText += chunk;
            }

            return { analysis: responseText, optimizedContext: finalOptimizedContextStringForReturn };
        } catch (error) {
            if (error instanceof Error && error.message.includes('Operation cancelled')) throw error;
            throw new Error(`Language model analysis failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }




    /**
     * Apply waterfall truncation with modular error handling
     * @param systemPrompt System prompt content
     * @param diffText Original diff text
     * @param parsedDiff Parsed diff structure
     * @param optimizedSnippets Context snippets to include
     * @param responsePrefill Response prefill content
     * @param targetTokens Target token limit
     * @returns Truncation result with updated content
     */
    private async applyWaterfallTruncation(
        systemPrompt: string,
        diffText: string,
        parsedDiff: DiffHunk[],
        optimizedSnippets: ContextSnippet[],
        responsePrefill: string,
        targetTokens: number
    ): Promise<{
        wasTruncated: boolean;
        userPromptContent: string;
        contextString: string;
        finalTokens: number;
    }> {
        // Prepare truncation components with proper type separation
        const truncationComponents = this.prepareTruncationComponents(
            systemPrompt,
            diffText,
            optimizedSnippets,
            responsePrefill
        );

        // Perform the actual truncation
        const { components: truncatedComponents, wasTruncated } = await this.tokenManager.performProportionalTruncation(
            truncationComponents,
            targetTokens
        );

        if (!wasTruncated) {
            return {
                wasTruncated: false,
                userPromptContent: '',
                contextString: '',
                finalTokens: 0
            };
        }

        // Generate new content from truncated components
        return await this.generateContentFromTruncatedComponents(
            truncatedComponents,
            diffText,
            parsedDiff,
            systemPrompt,
            responsePrefill,
            targetTokens
        );
    }

    /**
     * Prepare components for truncation with proper type separation
     * @param systemPrompt System prompt content
     * @param diffText Original diff text
     * @param optimizedSnippets Context snippets
     * @param responsePrefill Response prefill content
     * @returns Prepared token components
     */
    private prepareTruncationComponents(
        systemPrompt: string,
        diffText: string,
        optimizedSnippets: ContextSnippet[],
        responsePrefill: string
    ): TokenComponents {
        return {
            systemPrompt,
            diffText: diffText, // Use original diff text for truncation
            contextSnippets: optimizedSnippets, // Pass original snippets for type-aware truncation
            embeddingContext: undefined,
            lspReferenceContext: undefined,
            lspDefinitionContext: undefined,
            userMessages: undefined,
            assistantMessages: undefined,
            responsePrefill
        };
    }

    /**
     * Generate new content from truncated components
     * @param truncatedComponents Truncated token components
     * @param originalDiffText Original diff text (fallback)
     * @param parsedDiff Parsed diff structure
     * @param originalSystemPrompt Original system prompt (fallback)
     * @param originalResponsePrefill Original response prefill (fallback)
     * @param targetTokens Target token limit for verification
     * @returns Generated content and token count
     */
    private async generateContentFromTruncatedComponents(
        truncatedComponents: TokenComponents,
        originalDiffText: string,
        parsedDiff: DiffHunk[],
        originalSystemPrompt: string,
        originalResponsePrefill: string,
        targetTokens: number
    ): Promise<{
        wasTruncated: boolean;
        userPromptContent: string;
        contextString: string;
        finalTokens: number;
    }> {
        Log.info('Applied waterfall truncation to fit within token limits');

        // Combine the separate context fields for display
        const combinedTruncatedContext = this.combineContextFields(truncatedComponents);

        // Re-generate user prompt with truncated context
        const truncatedUserPromptContent = this.promptGenerator.generateUserPrompt(
            truncatedComponents.diffText || originalDiffText,
            parsedDiff,
            combinedTruncatedContext,
            combinedTruncatedContext.length > 0
        );

        // Verify final tokens after truncation
        const finalTruncatedTokens = await this.tokenManager.calculateCompleteMessageTokens(
            truncatedComponents.systemPrompt || originalSystemPrompt,
            truncatedUserPromptContent,
            truncatedComponents.responsePrefill || originalResponsePrefill
        );

        return {
            wasTruncated: true,
            userPromptContent: truncatedUserPromptContent,
            contextString: combinedTruncatedContext,
            finalTokens: finalTruncatedTokens
        };
    }

    /**
     * Combine separate context fields into a single string for display
     * @param components Components with separate context fields
     * @returns Combined context string
     */
    private combineContextFields(components: TokenComponents): string {
        const contextParts: string[] = [];

        if (components.embeddingContext && components.embeddingContext.length > 0) {
            contextParts.push(components.embeddingContext);
        }

        if (components.lspReferenceContext && components.lspReferenceContext.length > 0) {
            contextParts.push(components.lspReferenceContext);
        }

        if (components.lspDefinitionContext && components.lspDefinitionContext.length > 0) {
            contextParts.push(components.lspDefinitionContext);
        }

        return contextParts.join('\n\n');
    }

    /**
     * Dispose of resources
     */
    public dispose(): void {
        // No resources to dispose
    }
}