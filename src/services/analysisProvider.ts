import * as vscode from 'vscode';
import { ContextProvider } from './contextProvider';
import { TokenManagerService } from './tokenManagerService';
import { CopilotModelManager } from '../models/copilotModelManager';
import { AnalysisMode } from '../types/modelTypes';
import { ContextSnippet, DiffHunk, HybridContextResult } from '../types/contextTypes'; // Import ContextSnippet

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

            const hybridContextResult: HybridContextResult = await this.contextProvider.getContextForDiff(
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
     * Analyze PR using language models, now taking ContextSnippet[]
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

            // Format all initially retrieved snippets into a preliminary string for token budget calculation
            const preliminaryContextStringForAllSnippets = this.tokenManager.formatContextSnippetsToString(allContextSnippets, false);

            const tokenComponents = {
                systemPrompt,
                // For allocation, we use the original diffText and the *potential* full context string
                // The actual prompt will be constructed differently (interleaved)
                diffText: diffText, // Full diff for budgeting
                context: preliminaryContextStringForAllSnippets
            };

            const allocation = await this.tokenManager.calculateTokenAllocation(tokenComponents, mode);

            console.log(`Token allocation (pre-optimization): ${JSON.stringify({
                systemPrompt: allocation.systemPromptTokens,
                diff: allocation.diffTextTokens, // Based on full diff
                context: allocation.contextTokens, // Based on all potential snippets
                available: allocation.totalAvailableTokens,
                total: allocation.totalRequiredTokens,
                contextAllocation: allocation.contextAllocationTokens,
                fits: allocation.fitsWithinLimit
            })}`);

            if (token?.isCancellationRequested) throw new Error('Operation cancelled by token');

            // Optimize the context snippets based on the allocated budget
            const { optimizedSnippets, wasTruncated } = await this.tokenManager.optimizeContext(
                allContextSnippets,
                allocation.contextAllocationTokens
            );
            console.log(`Context optimized: ${optimizedSnippets.length} snippets selected. Truncated: ${wasTruncated}`);

            // This string is for returning to the UI/caller, representing the context that was considered.
            const finalOptimizedContextStringForReturn = this.tokenManager.formatContextSnippetsToString(optimizedSnippets, wasTruncated);

            if (token?.isCancellationRequested) throw new Error('Operation cancelled by token');

            // Construct the interleaved prompt
            let interleavedPromptContent = "Analyze the following pull request changes. For each hunk of changes, relevant context snippets are provided if available.\n\n";
            const MAX_SNIPPETS_PER_HUNK = 3; // Configurable: Max context snippets to show per hunk

            for (const fileDiff of parsedDiff) {
                interleavedPromptContent += `File: ${fileDiff.filePath}\n`;
                for (const hunk of fileDiff.hunks) {
                    // Append hunk header and lines
                    const hunkHeaderMatch = diffText.match(new RegExp(`^@@ .*${hunk.oldStart},${hunk.oldLines} \\+${hunk.newStart},${hunk.newLines} @@.*`, "m"));
                    if (hunkHeaderMatch) {
                        interleavedPromptContent += `${hunkHeaderMatch[0]}\n`;
                    } else {
                        // Fallback if regex fails, though it should ideally match
                        interleavedPromptContent += `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n`;
                    }
                    interleavedPromptContent += hunk.lines.join('\n') + '\n';

                    // Find and append relevant context snippets for this hunk
                    const relevantSnippetsForHunk = optimizedSnippets
                        .filter(snippet => snippet.associatedHunkIdentifiers?.includes(hunk.hunkId || ''))
                        .sort((a, b) => b.relevanceScore - a.relevanceScore) // Sort by relevance
                        .slice(0, MAX_SNIPPETS_PER_HUNK); // Take top N

                    if (relevantSnippetsForHunk.length > 0) {
                        interleavedPromptContent += "\n--- Relevant Context for this Hunk ---\n";
                        for (const snippet of relevantSnippetsForHunk) {
                            interleavedPromptContent += `${snippet.content}\n\n`; // Snippet content is already formatted
                        }
                        interleavedPromptContent += "--- End Context for this Hunk ---\n\n";
                    }
                }
            }

            const messages = [
                vscode.LanguageModelChatMessage.User(systemPrompt + '\n' + interleavedPromptContent)
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

            return { analysis: responseText, optimizedContext: finalOptimizedContextStringForReturn };
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