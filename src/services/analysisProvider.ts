import * as vscode from 'vscode';
import { ContextProvider } from './contextProvider';
import { TokenManagerService } from './tokenManagerService';
import { CopilotModelManager } from '../models/copilotModelManager';
import { AnalysisMode } from '../types/modelTypes';

/**
 * AnalysisProvider handles the core analysis logic using language models
 */
export class AnalysisProvider implements vscode.Disposable {
    /**
     * Create a new AnalysisProvider
     * @param contextProvider Provider for relevant code context
     * @param modelManager Manager for language models
     */
    constructor(
        private readonly contextProvider: ContextProvider,
        private readonly modelManager: CopilotModelManager
    ) { }

    /**
     * Analyze PR using language models
     * @param diffText The diff text to analyze
     * @param mode The analysis mode
     * @param progressCallback Optional callback for progress updates
     * @param token Optional cancellation token
     */
    public async analyzePullRequest(
        diffText: string, 
        mode: AnalysisMode,
        progressCallback?: (message: string, increment?: number) => void,
        token?: vscode.CancellationToken
    ): Promise<{
        analysis: string;
        context: string;
    }> {
        try {
            // Check for cancellation
            if (token?.isCancellationRequested) {
                throw new Error('Operation cancelled');
            }

            // Report progress: Starting context retrieval - 5%
            if (progressCallback) {
                progressCallback('Retrieving relevant code context...', 5);
            }

            // Find relevant code context for the diff with progress reporting - 50% total
            const context = await this.contextProvider.getContextForDiff(
                diffText,
                undefined,
                mode,
                undefined,
                (processed: number, total: number) => {
                    if (progressCallback) {
                        const percentage = Math.round((processed / total) * 100);
                        // Use a more conservative scaling to ensure progress is accurate
                        // Only report progress if it's a significant change
                        if (percentage % 10 === 0 || percentage === 100) {
                            // Scale to ensure progress never exceeds actual completion
                            // Use a very small increment to avoid jumping ahead
                            const scaledIncrement = 0.2; // Very small increments
                            progressCallback(`Generating embeddings: ${processed} of ${total} (${percentage}%)`, scaledIncrement);
                        } else {
                            // Just update the message without incrementing progress
                            progressCallback(`Generating embeddings: ${processed} of ${total} (${percentage}%)`);
                        }
                    }
                },
                token
            );

            // Check for cancellation
            if (token?.isCancellationRequested) {
                throw new Error('Operation cancelled');
            }

            // Report progress: Starting analysis - 5%
            if (progressCallback) {
                progressCallback('Context retrieved. Analyzing with language model...', 5);
            }

            // Run analysis using language model - this is a significant part of the process
            const analysis = await this.analyzeWithLanguageModel(diffText, context, mode);

            // Check for cancellation
            if (token?.isCancellationRequested) {
                throw new Error('Operation cancelled');
            }

            // Report progress: Analysis complete - 20%
            if (progressCallback) {
                progressCallback('Analysis complete', 20);
            }

            return {
                analysis,
                context
            };
        } catch (error) {
            if (token?.isCancellationRequested) {
                throw new Error('Operation cancelled');
            }
            throw new Error(`Failed to analyze PR: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Analyze PR using language models
     */
    private async analyzeWithLanguageModel(diffText: string, context: string, mode: AnalysisMode): Promise<string> {
        try {
            // Get current model
            const model = await this.modelManager.getCurrentModel();

            // Prepare system prompt
            const systemPrompt = this.getSystemPromptForMode(mode);

            // Create TokenManagerService for optimizing token usage
            const tokenManager = new TokenManagerService(this.modelManager);

            // Calculate token allocation for all components
            const tokenComponents = {
                systemPrompt,
                diffText,
                context
            };

            const allocation = await tokenManager.calculateTokenAllocation(tokenComponents, mode);

            console.log(`Token allocation: ${JSON.stringify({
                systemPrompt: allocation.systemPromptTokens,
                diff: allocation.diffTextTokens,
                context: allocation.contextTokens,
                available: allocation.totalAvailableTokens,
                total: allocation.totalRequiredTokens,
                contextAllocation: allocation.contextAllocationTokens,
                fits: allocation.fitsWithinLimit
            })}`);

            // Check if we need to optimize the context
            let optimizedContext = context;
            if (!allocation.fitsWithinLimit) {
                console.log(`Total tokens (${allocation.totalRequiredTokens}) exceed limit (${allocation.totalAvailableTokens})`);
                console.log(`Context can use up to ${allocation.contextAllocationTokens} tokens`);

                // Optimize the context to fit within the available token allocation
                optimizedContext = await tokenManager.optimizeContext(context, allocation.contextAllocationTokens);
                console.log('Context optimized to fit within token limit');
            }

            // Prepare user message with optimized context
            const userMessage = `Analyze the following pull request changes with the provided context:\n\n${diffText}\n\nContext:\n${optimizedContext}`;

            // Create messages for the model using a standard approach (system message in user content)
            const messages = [
                vscode.LanguageModelChatMessage.User(systemPrompt + '\n' + userMessage)
            ];

            // Send request to model
            const response = await model.sendRequest(
                messages,
                {},
                new vscode.CancellationTokenSource().token
            );

            // Return the response text
            let responseText = '';
            for await (const chunk of response.text) {
                responseText += chunk;
            }

            return responseText;
        } catch (error) {
            throw new Error(`Language model analysis failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Get system prompt for analysis mode
     */
    private getSystemPromptForMode(mode: AnalysisMode): string {
        switch (mode) {
            case AnalysisMode.Critical:
                return `You are a code review assistant focused on identifying critical issues in pull requests.
                        Analyze the code changes for bugs, errors, security vulnerabilities, and performance issues.
                        Focus only on high-impact problems that could lead to application failures, security breaches, or significant performance degradation.`;

            case AnalysisMode.Comprehensive:
                return `You are a thorough code review assistant. Analyze the pull request for all types of issues, including:
                        - Logic errors and bugs
                        - Security vulnerabilities
                        - Performance concerns
                        - Code style and best practices
                        - Architecture and design issues
                        - Testing coverage and quality
                        Provide detailed explanations and suggestions for improvement.`;

            case AnalysisMode.Security:
                return `You are a security-focused code review assistant. Analyze the pull request specifically for security vulnerabilities and risks, including:
                        - Injection vulnerabilities (SQL, NoSQL, command, etc.)
                        - Authentication and authorization issues
                        - Data exposure risks
                        - Insecure dependencies
                        - Cryptographic failures
                        - Security misconfiguration
                        Provide detailed explanations of each security risk and recommendations for remediation.`;

            case AnalysisMode.Performance:
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

    /**
     * Dispose of resources
     */
    public dispose(): void {
        // No resources to dispose
    }
}