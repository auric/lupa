import * as vscode from 'vscode';
import { ContextProvider } from './contextProvider';
import { TokenManagerService } from './tokenManagerService';
import { CopilotModelManager } from '../models/copilotModelManager';
import { AnalysisMode } from '../types/modelTypes';
import type {
    ContextSnippet,
    DiffHunk,
    HybridContextResult
} from '../types/contextTypes';
import { Log } from './loggingService';

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

            // --- Calculate diffStructureTokens ---
            // Construct the diff part of the prompt with XML structure *without* actual context content to get its token cost
            const instructionsXmlForCalc = "<instructions>\nAnalyze the following pull request changes. Use the provided context to understand the broader codebase and provide comprehensive code review feedback.\n</instructions>\n\n";
            const contextXmlPlaceholderForCalc = "<context>\n[CONTEXT_PLACEHOLDER]\n</context>\n\n";
            
            let fileContentXmlForCalc = "<file_to_review>\n";
            for (const fileDiff of parsedDiff) {
                fileContentXmlForCalc += `File: ${fileDiff.filePath}\n`;
                for (const hunk of fileDiff.hunks) {
                    const hunkHeaderMatch = diffText.match(new RegExp(`^@@ .*${hunk.oldStart},${hunk.oldLines} \\+${hunk.newStart},${hunk.newLines} @@.*`, "m"));
                    if (hunkHeaderMatch) {
                        fileContentXmlForCalc += `${hunkHeaderMatch[0]}\n`;
                    } else {
                        fileContentXmlForCalc += `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n`;
                    }
                    fileContentXmlForCalc += hunk.lines.join('\n') + '\n\n';
                }
            }
            fileContentXmlForCalc += "</file_to_review>\n\n";
            
            const diffStructureForTokenCalc = instructionsXmlForCalc + contextXmlPlaceholderForCalc + fileContentXmlForCalc;
            const calculatedDiffStructureTokens = await this.tokenManager.calculateTokens(diffStructureForTokenCalc);
            // --- End Calculate diffStructureTokens ---

            const tokenComponents = {
                systemPrompt,
                diffStructureTokens: calculatedDiffStructureTokens, // Use the calculated tokens for the interleaved diff structure
                context: preliminaryContextStringForAllSnippets, // Full potential context for optimizeContext to choose from
                // diffText: diffText, // Original diffText can be omitted if diffStructureTokens is always used
            };

            const allocation = await this.tokenManager.calculateTokenAllocation(tokenComponents, mode);

            Log.info(`Token allocation (pre-optimization): ${JSON.stringify({
                systemPrompt: allocation.systemPromptTokens,
                diffStructure: allocation.diffTextTokens, // This now reflects diffStructureTokens
                contextPotential: allocation.contextTokens, // Based on all potential snippets
                availableForLLM: allocation.totalAvailableTokens,
                totalRequiredPotential: allocation.totalRequiredTokens,
                budgetForContextSnippets: allocation.contextAllocationTokens,
                fitsPotential: allocation.fitsWithinLimit
            })}`);

            if (token?.isCancellationRequested) throw new Error('Operation cancelled by token');

            // Optimize the context snippets based on the allocated budget
            const { optimizedSnippets, wasTruncated } = await this.tokenManager.optimizeContext(
                allContextSnippets,
                allocation.contextAllocationTokens
            );
            Log.info(`Context optimized: ${optimizedSnippets.length} snippets selected. Truncated: ${wasTruncated}`);

            // This string is for returning to the UI/caller, representing the context that was considered.
            const finalOptimizedContextStringForReturn = this.tokenManager.formatContextSnippetsForDisplay(optimizedSnippets, wasTruncated);

            if (token?.isCancellationRequested) throw new Error('Operation cancelled by token');

            // Construct the final interleaved prompt using XML structure and optimized snippets
            const contextXml = optimizedSnippets.length > 0 ? `<context>
${finalOptimizedContextStringForReturn}
</context>

` : '';

            let fileContentXml = "<file_to_review>\n";
            for (const fileDiff of parsedDiff) {
                fileContentXml += `File: ${fileDiff.filePath}\n`;
                for (const hunk of fileDiff.hunks) {
                    const hunkHeaderMatch = diffText.match(new RegExp(`^@@ .*${hunk.oldStart},${hunk.oldLines} \\+${hunk.newStart},${hunk.newLines} @@.*`, "m"));
                    if (hunkHeaderMatch) {
                        fileContentXml += `${hunkHeaderMatch[0]}\n`;
                    } else {
                        fileContentXml += `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n`;
                    }
                    fileContentXml += hunk.lines.join('\n') + '\n\n';
                }
            }
            fileContentXml += "</file_to_review>\n\n";

            const instructionsXml = "<instructions>\nAnalyze the following pull request changes. Use the provided context to understand the broader codebase and provide comprehensive code review feedback.\n</instructions>\n\n";
            
            const finalInterleavedPromptContent = `${instructionsXml}${contextXml}${fileContentXml}`.trim();

            const messages = [
                vscode.LanguageModelChatMessage.Assistant(systemPrompt),
                vscode.LanguageModelChatMessage.User(finalInterleavedPromptContent)
            ];

            // Final check (optional, for debugging or very strict scenarios)
            // const finalPromptTokens = await this.tokenManager.calculateTokens(systemPrompt + finalInterleavedPromptContent);
            // Log.info(`Final prompt tokens: ${finalPromptTokens} / ${allocation.totalAvailableTokens}`);
            // if (finalPromptTokens > allocation.totalAvailableTokens) {
            //     Log.warn("Final prompt exceeded token limit despite pre-calculation. This may indicate an issue in token estimation or structural overhead.");
            //     // Potentially truncate finalInterleavedPromptContent further, though this should be rare.
            // }


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