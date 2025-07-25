import * as vscode from 'vscode';
import { ContextProvider } from './contextProvider';
import { TokenManagerService, ContentPrioritization, TokenComponents } from './tokenManagerService';
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

            // Calculate user prompt structure tokens (using prompt generator)
            const userPromptStructureTokens = await this.calculateUserPromptStructureTokens(diffText, parsedDiff);

            // For initial token calculation, treat all context as embedding context
            const tokenComponents = {
                systemPrompt,
                diffStructureTokens: userPromptStructureTokens, // Use calculated user prompt structure tokens
                embeddingContext: preliminaryContextStringForAllSnippets, // Full potential context for optimizeContext to choose from
                lspReferenceContext: '',
                lspDefinitionContext: '',
                responsePrefill, // Include response prefill in token calculation
            };

            const allocation = await this.tokenManager.calculateTokenAllocation(tokenComponents, mode);

            Log.info(`Token allocation (pre-optimization): ${JSON.stringify({
                systemPrompt: allocation.systemPromptTokens,
                userPromptStructure: allocation.diffTextTokens, // This now reflects user prompt structure tokens
                contextPotential: allocation.contextTokens, // Based on all potential snippets
                availableForLLM: allocation.totalAvailableTokens,
                totalRequiredPotential: allocation.totalRequiredTokens,
                budgetForContextSnippets: allocation.contextAllocationTokens,
                fitsPotential: allocation.fitsWithinLimit
            })}`);

            if (token?.isCancellationRequested) throw new Error('Operation cancelled by token');

            // Optimize the context snippets (includes deduplication internally)
            const { optimizedSnippets, wasTruncated } = await this.tokenManager.optimizeContext(
                allContextSnippets,
                allocation.contextAllocationTokens
            );
            Log.info(`Context optimized: ${optimizedSnippets.length} snippets selected. Truncated: ${wasTruncated}`);

            // This string is for returning to the UI/caller, representing the context that was considered.
            let finalOptimizedContextStringForReturn = this.tokenManager.formatContextSnippetsForDisplay(optimizedSnippets, wasTruncated);

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
                //vscode.LanguageModelChatMessage.Assistant(responsePrefill)
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

                // Apply waterfall truncation to ensure we fit within limits
                const truncationComponents = {
                    systemPrompt,
                    diffText: diffText, // Use original diff text for truncation
                    contextSnippets: optimizedSnippets, // Pass original snippets for type-aware truncation
                    responsePrefill
                };

                const { truncatedComponents, wasTruncated: componentsTruncated } = await this.tokenManager.performProportionalTruncation(
                    truncationComponents,
                    allocation.totalAvailableTokens
                );

                if (componentsTruncated) {
                    Log.info('Applied waterfall truncation to fit within token limits');

                    // Combine the separate context fields for display
                    const combinedTruncatedContext = this.combineContextFields(truncatedComponents);

                    // Re-generate user prompt with truncated context
                    const truncatedUserPromptContent = this.promptGenerator.generateUserPrompt(
                        truncatedComponents.diffText || diffText,
                        parsedDiff,
                        combinedTruncatedContext,
                        combinedTruncatedContext.length > 0
                    );

                    // Update messages with truncated content
                    messages[1] = vscode.LanguageModelChatMessage.User(truncatedUserPromptContent);

                    // Update return context to reflect truncation
                    finalOptimizedContextStringForReturn = combinedTruncatedContext;

                    // Verify final tokens after truncation
                    const finalTruncatedTokens = await this.tokenManager.calculateCompleteMessageTokens(
                        truncatedComponents.systemPrompt || systemPrompt,
                        truncatedUserPromptContent,
                        truncatedComponents.responsePrefill || responsePrefill
                    );

                    Log.info(`After waterfall truncation: ${finalTruncatedTokens} / ${allocation.totalAvailableTokens} tokens`);
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
     * Prepares and optimizes context for analysis within token limits
     * @param allContextSnippets All available context snippets
     * @param mode Analysis mode
     * @param diffText Original diff text
     * @param parsedDiff Parsed diff structure
     * @returns Optimized context components and allocation details
     */
    private async prepareOptimizedContext(
        allContextSnippets: ContextSnippet[],
        mode: AnalysisMode,
        diffText: string,
        parsedDiff: DiffHunk[]
    ): Promise<{
        optimizedSnippets: ContextSnippet[];
        optimizedContextString: string;
        allocation: any;
        wasTruncated: boolean;
    }> {
        const systemPrompt = this.tokenManager.getSystemPromptForMode(mode);
        const responsePrefill = this.tokenManager.getResponsePrefill();

        // Format all initially retrieved snippets for token budget calculation
        const preliminaryContextString = this.tokenManager.formatContextSnippetsToString(allContextSnippets, false);

        // Calculate user prompt structure tokens
        const userPromptStructureTokens = await this.calculateUserPromptStructureTokens(diffText, parsedDiff);

        // Prepare token components for calculation
        const tokenComponents = {
            systemPrompt,
            diffStructureTokens: userPromptStructureTokens,
            embeddingContext: preliminaryContextString,
            lspReferenceContext: '',
            lspDefinitionContext: '',
            responsePrefill,
        };

        const allocation = await this.tokenManager.calculateTokenAllocation(tokenComponents, mode);

        Log.info(`Token allocation (pre-optimization): ${JSON.stringify({
            systemPrompt: allocation.systemPromptTokens,
            userPromptStructure: allocation.diffTextTokens,
            contextPotential: allocation.contextTokens,
            availableForLLM: allocation.totalAvailableTokens,
            totalRequiredPotential: allocation.totalRequiredTokens,
            budgetForContextSnippets: allocation.contextAllocationTokens,
            fitsPotential: allocation.fitsWithinLimit
        })}`);

        // Optimize context snippets within token budget
        const { optimizedSnippets, wasTruncated } = await this.tokenManager.optimizeContext(
            allContextSnippets,
            allocation.contextAllocationTokens
        );

        Log.info(`Context optimized: ${optimizedSnippets.length} snippets selected. Truncated: ${wasTruncated}`);

        const optimizedContextString = this.tokenManager.formatContextSnippetsForDisplay(optimizedSnippets, wasTruncated);

        return {
            optimizedSnippets,
            optimizedContextString,
            allocation,
            wasTruncated
        };
    }

    /**
     * Validates final token usage and applies waterfall truncation if needed
     * @param systemPrompt System prompt content
     * @param userPromptContent User prompt content  
     * @param responsePrefill Response prefill content
     * @param allocation Token allocation details
     * @param optimizedSnippets Optimized context snippets
     * @param diffText Original diff text
     * @param parsedDiff Parsed diff structure
     * @returns Final components and truncation status
     */
    private async validateAndTruncateIfNeeded(
        systemPrompt: string,
        userPromptContent: string,
        responsePrefill: string,
        allocation: any,
        optimizedSnippets: ContextSnippet[],
        diffText: string,
        parsedDiff: DiffHunk[]
    ): Promise<{
        finalUserPrompt: string;
        finalContextString: string;
        messages: vscode.LanguageModelChatMessage[];
    }> {
        // Validate final token usage
        const finalPromptTokens = await this.tokenManager.calculateCompleteMessageTokens(
            systemPrompt,
            userPromptContent,
            responsePrefill
        );

        Log.info(`Final message tokens: ${finalPromptTokens} / ${allocation.totalAvailableTokens} (includes all message overhead)`);

        let finalUserPrompt = userPromptContent;
        let finalContextString = this.tokenManager.formatContextSnippetsForDisplay(optimizedSnippets, false);

        if (finalPromptTokens > allocation.totalAvailableTokens) {
            Log.warn(`Final message exceeded token limit: ${finalPromptTokens} > ${allocation.totalAvailableTokens}. Applying waterfall truncation.`);

            // Apply waterfall truncation
            const truncationComponents = {
                systemPrompt,
                diffText: diffText,
                contextSnippets: optimizedSnippets,
                responsePrefill
            };

            const { truncatedComponents, wasTruncated: componentsTruncated } = await this.tokenManager.performProportionalTruncation(
                truncationComponents,
                allocation.totalAvailableTokens
            );

            if (componentsTruncated) {
                Log.info('Applied waterfall truncation to fit within token limits');

                // Combine truncated context fields for display
                finalContextString = this.combineContextFields(truncatedComponents);

                // Re-generate user prompt with truncated context
                finalUserPrompt = this.promptGenerator.generateUserPrompt(
                    truncatedComponents.diffText || diffText,
                    parsedDiff,
                    finalContextString,
                    finalContextString.length > 0
                );

                // Verify final tokens after truncation
                const finalTruncatedTokens = await this.tokenManager.calculateCompleteMessageTokens(
                    truncatedComponents.systemPrompt || systemPrompt,
                    finalUserPrompt,
                    truncatedComponents.responsePrefill || responsePrefill
                );

                Log.info(`After waterfall truncation: ${finalTruncatedTokens} / ${allocation.totalAvailableTokens} tokens`);
            }
        }

        const messages = [
            vscode.LanguageModelChatMessage.Assistant(systemPrompt),
            vscode.LanguageModelChatMessage.User(finalUserPrompt),
        ];

        return { finalUserPrompt, finalContextString, messages };
    }

    private async calculateUserPromptStructureTokens(diffText: string, parsedDiff: DiffHunk[]): Promise<number> {
        // Use the PromptGenerator to calculate structure tokens
        const structureInfo = this.promptGenerator.calculatePromptStructureTokens(
            diffText,
            parsedDiff,
            "[CONTEXT_PLACEHOLDER]"
        );

        // Return the total estimated tokens for the prompt structure
        const totalStructureTokens = structureInfo.examplesTokens +
            structureInfo.fileContentTokens +
            structureInfo.instructionsTokens +
            structureInfo.contextPlaceholderTokens;

        return totalStructureTokens;
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