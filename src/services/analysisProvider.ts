import * as vscode from 'vscode';
import { ContextProvider } from './contextProvider';
import { TokenManagerService } from './tokenManagerService';
import { CopilotModelManager } from '../models/copilotModelManager';
import { AnalysisMode } from '../types/modelTypes';
import { ContextSnippet } from '../types/contextTypes'; // Import ContextSnippet

/**
 * AnalysisProvider handles the core analysis logic using language models
 */
export class AnalysisProvider implements vscode.Disposable {
    private tokenManager: TokenManagerService;
    /**
     * Create a new AnalysisProvider
     * @param contextProvider Provider for relevant code context
     * @param modelManager Manager for language models
     */
    constructor(
        private readonly contextProvider: ContextProvider,
        private readonly modelManager: CopilotModelManager
    ) {
        this.tokenManager = new TokenManagerService(this.modelManager);
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

            // ContextProvider.getContextForDiff will now return ContextSnippet[]
            const contextSnippets: ContextSnippet[] = await this.contextProvider.getContextForDiff(
                diffText,
                gitRootPath,
                undefined, // options
                mode,
                undefined, // systemPrompt (will be fetched by tokenManager if needed)
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

            // The 'context' field in the return will be the final, optimized context string
            const { analysis, optimizedContext } = await this.analyzeWithLanguageModel(diffText, contextSnippets, mode, token);

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
     * Analyze PR using language models, now taking ContextSnippet[]
     */
    private async analyzeWithLanguageModel(
        diffText: string,
        contextSnippets: ContextSnippet[],
        mode: AnalysisMode,
        token?: vscode.CancellationToken
    ): Promise<{ analysis: string; optimizedContext: string }> {
        try {
            const model = await this.modelManager.getCurrentModel();
            const systemPrompt = this.tokenManager.getSystemPromptForMode(mode); // Use tokenManager's method

            // Format all snippets into a preliminary string for initial token calculation
            const preliminaryContextString = this.tokenManager.formatContextSnippetsToString(contextSnippets, false);

            const tokenComponents = {
                systemPrompt,
                diffText,
                context: preliminaryContextString // Use the full formatted string for initial calculation
            };

            const allocation = await this.tokenManager.calculateTokenAllocation(tokenComponents, mode);

            console.log(`Token allocation (pre-optimization): ${JSON.stringify({
                systemPrompt: allocation.systemPromptTokens,
                diff: allocation.diffTextTokens,
                context: allocation.contextTokens, // Tokens of preliminaryContextString
                available: allocation.totalAvailableTokens,
                total: allocation.totalRequiredTokens,
                contextAllocation: allocation.contextAllocationTokens,
                fits: allocation.fitsWithinLimit
            })}`);

            if (token?.isCancellationRequested) throw new Error('Operation cancelled by token');

            let finalOptimizedContext: string;
            if (allocation.fitsWithinLimit) {
                finalOptimizedContext = preliminaryContextString;
                console.log('Context fits within limit, using preliminary formatted context.');
            } else {
                console.log(`Total tokens (${allocation.totalRequiredTokens}) exceed limit (${allocation.totalAvailableTokens}). Optimizing context.`);
                console.log(`Context can use up to ${allocation.contextAllocationTokens} tokens.`);
                // Optimize using the structured snippets and the allocated budget
                finalOptimizedContext = await this.tokenManager.optimizeContext(contextSnippets, allocation.contextAllocationTokens);
                console.log('Context optimized.');
            }

            if (token?.isCancellationRequested) throw new Error('Operation cancelled by token');

            const userMessageContent = `Analyze the following pull request changes with the provided context:\n\n${diffText}\n\nContext:\n${finalOptimizedContext}`;
            const messages = [
                vscode.LanguageModelChatMessage.User(systemPrompt + '\n' + userMessageContent)
            ];

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

            return { analysis: responseText, optimizedContext: finalOptimizedContext };
        } catch (error) {
            if (error instanceof Error && error.message.includes('Operation cancelled')) throw error;
            throw new Error(`Language model analysis failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    // getSystemPromptForMode is removed as it's now in TokenManagerService.
    // The actual method that was here has been deleted.

    /**
     * Dispose of resources
     */
    public dispose(): void {
        // No resources to dispose
    }
}