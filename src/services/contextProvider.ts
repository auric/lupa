import * as vscode from 'vscode';
import { encoding_for_model as tiktokenCountTokens, TiktokenModel } from 'tiktoken';
import { countTokens as anthropicCountTokens } from '@anthropic-ai/tokenizer';
import { EmbeddingDatabaseAdapter } from './embeddingDatabaseAdapter';
import { TreeStructureAnalyzerPool } from './treeStructureAnalyzer';
import {
    SUPPORTED_LANGUAGES
} from '../types/types';
import {
    AnalysisMode
} from '../types/modelTypes';
import {
    SimilaritySearchOptions,
    SimilaritySearchResult
} from '../types/embeddingTypes';
import { CopilotModelManager } from '../models/copilotModelManager';
import { TokenManagerService } from './tokenManagerService';

/**
 * Token estimation functions for different model families
 */
export class TokenEstimator {
    // OpenAI models use tiktoken (cl100k_base for GPT-4, etc.)
    static estimateOpenAITokens(text: string, modelName: string = 'gpt-4'): number {
        try {
            try {
                const encoding = tiktokenCountTokens(modelName as TiktokenModel);
                const tokens = encoding.encode(text);
                const tokenCount = tokens.length;

                // Free the encoding when done
                if (typeof encoding.free === 'function') {
                    encoding.free();
                }

                return tokenCount;
            } catch (error) {
                console.warn(`Error using tiktoken for ${modelName} token calculation:`, error);
                // Fallback to approximation
            }

            // Character-based approximation for OpenAI models
            return Math.ceil(text.length / 4);
        } catch (error) {
            console.error('Error in OpenAI token estimation:', error);
            // Safe fallback
            return Math.ceil(text.length / 3.5);
        }
    }

    // Anthropic Claude models use their own tokenizer
    static estimateClaudeTokens(text: string): number {
        try {
            try {
                const tokens = anthropicCountTokens(text);
                return tokens;
            } catch (error) {
                console.warn('Error using Anthropic tokenizer:', error);
                // Fallback to approximation
            }

            // Character-based approximation for Claude models
            return Math.ceil(text.length / 5);
        } catch (error) {
            console.error('Error in Claude token estimation:', error);
            // Safe fallback
            return Math.ceil(text.length / 4);
        }
    }

    // Google Gemini models use SentencePiece tokenizer
    static estimateGeminiTokens(text: string): number {
        try {
            // Need API key for this, use fallback
            // Character-based approximation for Gemini models
            return Math.ceil(text.length / 4.5);
        } catch (error) {
            console.error('Error in Gemini token estimation:', error);
            // Safe fallback
            return Math.ceil(text.length / 4);
        }
    }

    // Code is typically more token-dense than natural language
    static estimateCodeTokens(text: string): number {
        return Math.ceil(text.length / 3.5);
    }

    // Fallback estimator when model family is unknown
    static estimateGenericTokens(text: string): number {
        return Math.ceil(text.length / 3.5);
    }

    // Select the appropriate estimator based on model family
    static estimateTokensByModelFamily(text: string, modelFamily: string, modelName: string = ''): number {
        const lowerFamily = modelFamily.toLowerCase();

        if (lowerFamily.includes('gpt') || lowerFamily.includes('openai')) {
            return this.estimateOpenAITokens(text, modelName || 'gpt-4o');
        } else if (lowerFamily.includes('claude') || lowerFamily.includes('anthropic')) {
            return this.estimateClaudeTokens(text);
        } else if (lowerFamily.includes('gemini') || lowerFamily.includes('google')) {
            return this.estimateGeminiTokens(text);
        } else {
            // For unknown models, use the generic estimator
            return this.estimateGenericTokens(text);
        }
    }
}

/**
 * ContextProvider is responsible for retrieving relevant code context
 * for PR analysis based on the changes in the PR
 */
export class ContextProvider implements vscode.Disposable {
    private static instance: ContextProvider | null = null;
    private readonly MAX_CONTENT_LENGTH = 800000; // Characters limit to avoid excessive token use

    private readonly modelManager: CopilotModelManager;
    private readonly tokenManager: TokenManagerService;

    /**
     * Get singleton instance of ContextProvider
     */
    public static getInstance(): ContextProvider {
        if (!this.instance) {
            throw new Error('ContextProvider has not been initialized. Use createSingleton() instead.');
        }
        return this.instance;
    }

    /**
     * Create a singleton instance (alias for getInstance with more clear name)
     */
    public static createSingleton(
        context: vscode.ExtensionContext,
        embeddingDatabaseAdapter: EmbeddingDatabaseAdapter,
        modelManager: CopilotModelManager
    ): ContextProvider {
        if (!this.instance ||
            this.instance.embeddingDatabaseAdapter !== embeddingDatabaseAdapter ||
            this.instance.modelManager !== modelManager) {
            this.instance = new ContextProvider(context, embeddingDatabaseAdapter, modelManager);
        }
        return this.instance;
    }

    /**
     * Private constructor (use getInstance)
     */
    private constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly embeddingDatabaseAdapter: EmbeddingDatabaseAdapter,
        modelManager: CopilotModelManager
    ) {
        // Initialize the model manager if provided, otherwise create a new one
        this.modelManager = modelManager;

        // Initialize the token manager
        this.tokenManager = new TokenManagerService(this.modelManager);
    }

    /**
     * Extract meaningful code chunks from PR diff
     * @param diff PR diff content
     * @returns Extracted code chunks for similarity search
     */
    private async extractMeaningfulChunks(diff: string): Promise<string[]> {
        const chunks: string[] = [];
        const analyzer = await TreeStructureAnalyzerPool.getInstance().getAnalyzer();

        // Split the diff into files
        const fileRegex = /^diff --git a\/(.+) b\/(.+)[\r\n]+(?:.+[\r\n]+)*?(?:@@.+@@)/gm;
        let fileMatch;
        const matches: { index: number, length: number, filePath: string, newContent: string }[] = [];

        // Find all file sections in the diff
        while ((fileMatch = fileRegex.exec(diff)) !== null) {
            const filePath = fileMatch[2]; // Using the 'b/' path (new file path)
            const start = fileMatch.index + fileMatch[0].length;
            const end = diff.indexOf('\ndiff --git', start);
            const fileContent = diff.substring(start, end !== -1 ? end : diff.length);

            // Extract and process added/modified code
            const newContent = fileContent
                .split('\n')
                .filter(line => line.startsWith('+') && !line.startsWith('+++'))
                .map(line => line.substring(1)) // Remove the '+' prefix
                .join('\n');

            if (newContent.trim().length > 0) {
                matches.push({
                    index: fileMatch.index,
                    length: fileMatch[0].length,
                    filePath,
                    newContent
                });
            }
        }

        // Process each file's changes with structure awareness
        for (const match of matches) {
            try {
                // Detect the language from the file extension
                const fileExt = match.filePath.split('.').pop()?.toLowerCase();
                const language = fileExt ? SUPPORTED_LANGUAGES[fileExt]?.language : undefined;

                if (language && match.newContent.trim()) {
                    // Try to analyze the code structure
                    const functions = await analyzer.findFunctions(match.newContent, language);
                    const classes = await analyzer.findClasses(match.newContent, language);

                    // Add complete function/class definitions as chunks
                    for (const func of functions) {
                        if (func.text.trim()) {
                            chunks.push(func.text);
                        }
                    }

                    for (const cls of classes) {
                        if (cls.text.trim()) {
                            chunks.push(cls.text);
                        }
                    }

                    // If no structures found, add the modified code as is
                    if (functions.length === 0 && classes.length === 0) {
                        chunks.push(match.newContent);
                    }
                } else {
                    // For unsupported languages or non-code files, add content as is
                    chunks.push(match.newContent);
                }

                // Always add the file path as a chunk to find related files
                chunks.push(match.filePath);

                // Try to find parent structures (e.g., containing class/namespace)
                if (language) {
                    const hierarchy = await analyzer.getStructureHierarchyAtPosition(
                        match.newContent,
                        language,
                        { row: 0, column: 0 }
                    );

                    // Add parent structures as chunks for better context
                    for (const struct of hierarchy) {
                        if (struct.text.trim() && !chunks.includes(struct.text)) {
                            chunks.push(struct.text);
                        }
                    }
                }
            } catch (error) {
                console.warn(`Error analyzing structure for ${match.filePath}:`, error);
                // Fallback: add the content without structure analysis
                chunks.push(match.newContent);
            }
        }

        // If we couldn't extract any meaningful chunks, use the whole diff
        if (chunks.length === 0) {
            chunks.push(diff);
        }

        // Deduplicate chunks while preserving order
        return [...new Set(chunks)];
    }

    /**
     * Get relevant code context for a diff
     * @param diff The PR diff
     * @param options Optional search options
     * @param analysisMode Analysis mode that determines relevance strategy
     * @param systemPrompt Optional system prompt
     * @param progressCallback Optional callback for progress updates
     * @param token Optional cancellation token
     * @returns The formatted context
     */
    async getContextForDiff(
        diff: string,
        options?: SimilaritySearchOptions,
        analysisMode: AnalysisMode = AnalysisMode.Comprehensive,
        systemPrompt?: string,
        progressCallback?: (processed: number, total: number) => void,
        token?: vscode.CancellationToken
    ): Promise<string> {
        console.log(`Finding relevant context for PR diff (mode: ${analysisMode})`);

        try {
            // Check for cancellation
            if (token?.isCancellationRequested) {
                throw new Error('Operation cancelled');
            }

            // Extract meaningful chunks from the diff for better semantic search
            const chunks = await this.extractMeaningfulChunks(diff);

            // Check for cancellation
            if (token?.isCancellationRequested) {
                throw new Error('Operation cancelled');
            }

            // Set search options based on analysis mode
            const searchOptions = this.getSearchOptionsForMode(analysisMode, options);

            // Find relevant context for all chunks in a single batch with progress reporting
            const allResults = await this.embeddingDatabaseAdapter.findRelevantCodeContextForChunks(
                chunks,
                searchOptions,
                progressCallback || ((processed, total) => {
                    console.log(`Generating embeddings: ${processed} of ${total}`);
                }),
                token
            );

            // Check for cancellation
            if (token?.isCancellationRequested) {
                throw new Error('Operation cancelled');
            }

            if (allResults.length === 0) {
                console.log('No relevant context found');
                return await this.getFallbackContext(diff, token);
            }

            // Rank and filter results based on relevance and analysis mode
            const rankedResults = this.rankAndFilterResults(allResults, analysisMode);

            console.log(`Found ${rankedResults.length} relevant code snippets after ranking`);

            // Format the results first to get the initial context
            const initialFormattedContext = this.formatContextResults(rankedResults);

            // Check for cancellation
            if (token?.isCancellationRequested) {
                throw new Error('Operation cancelled');
            }

            // Use the TokenManagerService to optimize context size taking all components into account
            // If systemPrompt is not provided, get it from the mode
            if (!systemPrompt) {
                // Get the system prompt for the current analysis mode from the token manager
                systemPrompt = await this.tokenManager.getSystemPromptForMode(analysisMode);
            }

            // Calculate token allocation for all components
            const tokenComponents = {
                systemPrompt,
                diffText: diff,
                context: initialFormattedContext
            };

            const allocation = await this.tokenManager.calculateTokenAllocation(tokenComponents, analysisMode);

            // Log token distribution
            console.log(`Token allocation: ${JSON.stringify({
                systemPrompt: allocation.systemPromptTokens,
                diff: allocation.diffTextTokens,
                context: allocation.contextTokens,
                available: allocation.totalAvailableTokens,
                total: allocation.totalRequiredTokens,
                contextAllocation: allocation.contextAllocationTokens,
                fits: allocation.fitsWithinLimit
            })}`);

            // Check for cancellation
            if (token?.isCancellationRequested) {
                throw new Error('Operation cancelled');
            }

            // If everything fits, we can use the full context
            if (allocation.fitsWithinLimit) {
                console.log('All components fit within token limit, using full context');
                return initialFormattedContext;
            }

            // If we need to optimize, use the token manager to do it
            console.log(`Total tokens (${allocation.totalRequiredTokens}) exceed limit (${allocation.totalAvailableTokens})`);
            console.log(`Context can use up to ${allocation.contextAllocationTokens} tokens`);

            // Optimize the context to fit within the available token allocation
            const optimizedContext = await this.tokenManager.optimizeContext(
                initialFormattedContext,
                allocation.contextAllocationTokens
            );

            // Assess the quality of the context
            const qualityScore = this.assessContextQuality(rankedResults);
            console.log(`Context quality score: ${qualityScore.toFixed(2)}`);

            return optimizedContext;
        } catch (error) {
            if (token?.isCancellationRequested) {
                throw new Error('Operation cancelled');
            }
            console.error('Error getting context for diff:', error);
            return 'Error retrieving context: ' + (error instanceof Error ? error.message : String(error));
        }
    }

    /**
     * Get custom search options based on the analysis mode
     */
    private getSearchOptionsForMode(
        mode: AnalysisMode,
        baseOptions?: SimilaritySearchOptions
    ): SimilaritySearchOptions {
        // Default options
        const options: SimilaritySearchOptions = {
            limit: baseOptions?.limit || 20,
            minScore: baseOptions?.minScore || 0.65,
            fileFilter: baseOptions?.fileFilter,
            languageFilter: baseOptions?.languageFilter
        };

        // Customize based on mode
        switch (mode) {
            case 'critical':
                // For critical issues, we need focused, high-quality matches
                options.limit = 15;
                options.minScore = 0.70; // Higher threshold for better precision
                break;

            case 'comprehensive':
                // For comprehensive analysis, we want more breadth
                options.limit = 25;
                options.minScore = 0.65; // Standard threshold
                break;

            case 'security':
                // For security, focus on high quality matches potentially from specific file types
                options.limit = 20;
                options.minScore = 0.68;
                break;

            case 'performance':
                // For performance, focus on deeper context in fewer files
                options.limit = 18;
                options.minScore = 0.68;
                break;
        }

        return options;
    }

    /**
     * Rank and filter results based on relevance and analysis mode
     */
    private rankAndFilterResults(
        results: SimilaritySearchResult[],
        mode: AnalysisMode
    ): SimilaritySearchResult[] {
        // First sort by score
        const sortedResults = [...results].sort((a, b) => b.score - a.score);

        // Filter based on analysis mode
        let filteredResults = sortedResults;

        switch (mode) {
            case 'security':
                // For security analysis, prioritize code with potential security implications
                // This is a simple heuristic - boost the score of files that might contain security-related code
                filteredResults = sortedResults.map(result => {
                    const securityKeywords = [
                        'auth', 'password', 'token', 'secret', 'crypt', 'secure',
                        'permission', 'access', 'validate', 'sanitize', 'escape', 'XSS',
                        'injection', 'CSRF', 'vulnerability', 'CVE'
                    ];

                    // Check if the content or file path contains security keywords
                    const hasSecurityKeyword = securityKeywords.some(keyword =>
                        result.content.toLowerCase().includes(keyword.toLowerCase()) ||
                        result.filePath.toLowerCase().includes(keyword.toLowerCase())
                    );

                    // Boost score for security-related content
                    return {
                        ...result,
                        score: hasSecurityKeyword ? result.score * 1.2 : result.score
                    };
                }).sort((a, b) => b.score - a.score);
                break;

            case 'performance':
                // For performance analysis, prioritize code that might involve performance concerns
                const perfKeywords = [
                    'loop', 'performance', 'optimize', 'cache', 'benchmark',
                    'latency', 'throughput', 'memory', 'cpu', 'time complexity',
                    'expensive', 'slow', 'bottleneck', 'profile'
                ];

                filteredResults = sortedResults.map(result => {
                    const hasPerfKeyword = perfKeywords.some(keyword =>
                        result.content.toLowerCase().includes(keyword.toLowerCase())
                    );

                    return {
                        ...result,
                        score: hasPerfKeyword ? result.score * 1.15 : result.score
                    };
                }).sort((a, b) => b.score - a.score);
                break;
        }

        // Ensure file diversity (don't include too many chunks from the same file)
        const filePathCount = new Map<string, number>();
        const maxPerFile = mode === 'comprehensive' ? 3 : 2;

        const diverseResults = filteredResults.filter(result => {
            const count = filePathCount.get(result.filePath) || 0;
            if (count < maxPerFile) {
                filePathCount.set(result.filePath, count + 1);
                return true;
            }
            return false;
        });

        return diverseResults;
    }

    /**
     * Optimize the context to stay within token limits based on the current model being used
     */
    private async optimizeForTokenLimit(
        results: SimilaritySearchResult[],
        mode: AnalysisMode
    ): Promise<SimilaritySearchResult[]> {
        try {
            // Get information about the current model to determine token calculation strategy
            const currentModel = await this.modelManager.getCurrentModel();
            const modelFamily = currentModel.family || 'unknown';

            // Use the actual model token limit, with a safety margin of 20%
            // This leaves room for the model prompt and other content
            const tokenLimit = currentModel ? Math.floor(currentModel.maxInputTokens * 0.8) : 8000;

            console.log(`Using token limit of ${tokenLimit} for model ${currentModel.name || 'unknown'}`);

            // Calculate total tokens based on the model family
            const calculateTotalTokens = (results: SimilaritySearchResult[]): number => {
                let totalTokens = 0;

                for (const result of results) {
                    // Calculate tokens for both the file path and content
                    const pathTokens = TokenEstimator.estimateTokensByModelFamily(
                        result.filePath,
                        modelFamily,
                        currentModel.name
                    );
                    const contentTokens = TokenEstimator.estimateTokensByModelFamily(
                        result.content,
                        modelFamily,
                        currentModel.name
                    );

                    // Add tokens for markdown formatting (approximately 10 tokens per result)
                    totalTokens += pathTokens + contentTokens + 10;
                }

                return totalTokens;
            };

            // Calculate total tokens
            const estimatedTokens = calculateTotalTokens(results);

            // Check if we're within limits
            if (estimatedTokens <= tokenLimit) {
                return results; // Already within limits
            }

            console.log(`Context exceeds estimated token limit for ${modelFamily} model (${estimatedTokens} > ${tokenLimit}), optimizing...`);

            // Calculate how much we need to reduce content
            const scaleFactor = tokenLimit / estimatedTokens;
            const maxResultsToKeep = Math.max(5, Math.floor(results.length * scaleFactor));

            // Sort by relevance (highest score first) and take the top results
            const optimizedResults = [...results]
                .sort((a, b) => b.score - a.score)
                .slice(0, maxResultsToKeep);

            // Check if we still need to truncate content
            const optimizedTokens = calculateTotalTokens(optimizedResults);
            if (optimizedTokens > tokenLimit) {
                // Further truncation needed
                const contentScaleFactor = tokenLimit / optimizedTokens;

                return optimizedResults.map(result => {
                    // Calculate max allowed tokens for this result's content
                    const currentContentTokens = TokenEstimator.estimateTokensByModelFamily(
                        result.content,
                        modelFamily,
                        currentModel?.name
                    );
                    const allowedContentTokens = Math.floor(currentContentTokens * contentScaleFactor);

                    // Estimate number of characters per token for this model family
                    let charsPerToken = 4; // Default estimate
                    if (modelFamily.toLowerCase().includes('claude')) {
                        charsPerToken = 5;
                    } else if (modelFamily.toLowerCase().includes('gemini')) {
                        charsPerToken = 4.5;
                    }

                    // Calculate max character length
                    const maxContentLength = Math.max(100, allowedContentTokens * charsPerToken);

                    // Truncate if needed
                    if (result.content.length > maxContentLength) {
                        const truncatedContent = result.content.substring(0, maxContentLength);
                        return {
                            ...result,
                            content: truncatedContent + '\n// ... [content truncated to fit token limit] ...'
                        };
                    }
                    return result;
                });
            }

            return optimizedResults;
        } catch (error) {
            console.error('Error optimizing for token limit:', error);

            // Fallback: return top 5 results with truncated content if error occurs
            const topResults = [...results].sort((a, b) => b.score - a.score).slice(0, 5);

            return topResults.map(result => {
                if (result.content.length > 500) {
                    return {
                        ...result,
                        content: result.content.substring(0, 500) + '\n// ... [content truncated] ...'
                    };
                }
                return result;
            });
        }
    }

    /**
     * Get relevant code context for a list of file paths
     * This is useful when you already know which files have changed
     * @param files Array of file paths
     * @param analysisMode Analysis mode for context retrieval strategy
     * @returns Formatted context
     */
    async getContextForFiles(
        files: string[],
        analysisMode: AnalysisMode = AnalysisMode.Comprehensive
    ): Promise<string> {
        try {
            // Extract file extensions to determine languages
            const fileExtensions = files
                .map(file => {
                    const match = file.match(/\.([^./\\]+)$/);
                    return match ? match[1] : null;
                })
                .filter(ext => ext !== null) as string[];

            // Map extensions to languages using the shared definition
            const languageSet = new Set<string>();

            for (const ext of fileExtensions) {
                const language = SUPPORTED_LANGUAGES[ext];
                if (language) {
                    languageSet.add(language.language);
                }
            }

            const languages = Array.from(languageSet);

            // If we have languages, use them as a filter
            let options: SimilaritySearchOptions | undefined;
            if (languages.length > 0) {
                options = {
                    languageFilter: languages
                };
            }

            // Customize options based on analysis mode
            options = this.getSearchOptionsForMode(analysisMode, options);

            // Join file paths to create a search query
            const searchQuery = files.join('\n');

            return await this.getContextForDiff(searchQuery, options, analysisMode);
        } catch (error) {
            console.error('Error getting context for files:', error);
            return 'Error retrieving context: ' + (error instanceof Error ? error.message : String(error));
        }
    }

    /**
     * Assess the quality of the retrieved context
     * @returns A score between 0-1 indicating context quality
     */
    private assessContextQuality(results: SimilaritySearchResult[]): number {
        if (results.length === 0) {
            return 0;
        }

        // Factors that determine quality:
        // 1. Average similarity score
        const avgScore = results.reduce((sum, r) => sum + r.score, 0) / results.length;

        // 2. Coverage (number of unique files)
        const uniqueFiles = new Set(results.map(r => r.filePath)).size;
        const fileCoverage = Math.min(1, uniqueFiles / 10); // Normalize, assuming 10+ files is good coverage

        // 3. Content length (more content generally means more context)
        const totalContentLength = results.reduce((sum, r) => sum + r.content.length, 0);
        const contentCoverage = Math.min(1, totalContentLength / 10000); // Normalize

        // Weight the factors (can be adjusted)
        const weightedScore = (avgScore * 0.5) + (fileCoverage * 0.3) + (contentCoverage * 0.2);

        return weightedScore;
    }

    /**
     * Get fallback context when no relevant context is found
     */
    private async getFallbackContext(diff: string, token?: vscode.CancellationToken): Promise<string> {
        try {
            console.log('Using fallback strategies to find context');

            // Strategy 1: Extract file paths from diff and use them to find related files
            const filePathRegex = /^diff --git a\/(.+) b\/(.+)$/gm;
            const filePaths = new Set<string>();
            let match;

            while ((match = filePathRegex.exec(diff)) !== null) {
                if (match[2]) {
                    filePaths.add(match[2]);
                }
            }

            if (filePaths.size > 0) {
                console.log(`Fallback: Using ${filePaths.size} file paths from diff`);

                // Get parent directories to find related files
                const parentDirs = new Set<string>();
                filePaths.forEach(path => {
                    const lastSlashIndex = path.lastIndexOf('/');
                    if (lastSlashIndex > 0) {
                        parentDirs.add(path.substring(0, lastSlashIndex));
                    }
                });

                const searchQueries = [...filePaths, ...parentDirs];

                // Try to find related files - use batch processing
                const allResults = await this.embeddingDatabaseAdapter.findRelevantCodeContextForChunks(
                    searchQueries,
                    { minScore: 0.5, limit: 5 },
                    (processed, total) => {
                        console.log(`Generating fallback embeddings: ${processed} of ${total}`);
                    },
                    token
                );

                if (allResults.length > 0) {
                    console.log(`Found ${allResults.length} fallback context items`);
                    return this.formatContextResults(allResults);
                }
            }

            // Strategy 2: If still nothing, return a message about no context
            return 'No directly relevant context could be found in the codebase. Analysis will be based solely on the changes in the PR.';

        } catch (error) {
            console.error('Error getting fallback context:', error);
            return 'Error retrieving fallback context: ' + (error instanceof Error ? error.message : String(error));
        }
    }

    /**
     * Get context specifically for repository-level analysis
     * Useful for understanding project structure and patterns
     */
    async getRepositoryContext(): Promise<string> {
        try {
            console.log('Getting repository context');

            // Look for key files that would give insights into the project structure
            const keyFilePatterns = [
                'package.json', 'requirements.txt', 'build.gradle', 'pom.xml',
                'tsconfig.json', 'Cargo.toml', 'CMakeLists.txt', 'Makefile',
                'README.md', '.gitignore'
            ];

            // Use batch processing for all patterns at once
            const allResults = await this.embeddingDatabaseAdapter.findRelevantCodeContextForChunks(
                keyFilePatterns,
                { minScore: 0.5, limit: 2 },
                (processed, total) => {
                    console.log(`Generating repository context embeddings: ${processed} of ${total}`);
                }
            );

            if (allResults.length === 0) {
                return 'No repository context could be found.';
            }

            // Filter out duplicate file paths
            const uniqueResults = allResults.filter((result, index, self) => 
                index === self.findIndex(r => r.filePath === result.filePath)
            );

            return this.formatContextResults(uniqueResults);

        } catch (error) {
            console.error('Error getting repository context:', error);
            return 'Error retrieving repository context: ' +
                (error instanceof Error ? error.message : String(error));
        }
    }

    /**
     * Format similar code results into a readable context block with structure awareness
     * @param results Array of similarity search results
     * @returns Formatted context string
     */
    private formatContextResults(
        results: SimilaritySearchResult[]
    ): string {
        // Group results by file path for better organization
        const fileGroups = new Map<string, SimilaritySearchResult[]>();

        for (const result of results) {
            const filePath = result.filePath;
            if (!fileGroups.has(filePath)) {
                fileGroups.set(filePath, []);
            }
            fileGroups.get(filePath)!.push(result);
        }

        // Format each file with all its relevant chunks
        const formattedFiles: string[] = [];

        // Sort file groups by best score in each group
        const sortedFilePaths = [...fileGroups.entries()]
            .sort((a, b) => {
                const aMaxScore = Math.max(...a[1].map(r => r.score));
                const bMaxScore = Math.max(...b[1].map(r => r.score));
                return bMaxScore - aMaxScore;
            })
            .map(entry => entry[0]);

        for (const filePath of sortedFilePaths) {
            const fileResults = fileGroups.get(filePath)!;

            // Sort chunks within the file by position if they're from the same file
            fileResults.sort((a, b) => a.startOffset - b.startOffset);

            // Calculate the maximum score for this file
            const maxScore = Math.max(...fileResults.map(r => r.score));
            const scoreDisplay = (maxScore * 100).toFixed(1);

            // Format header with file path and best relevance score
            const fileHeader = `### File: \`${filePath}\` (Relevance: ${scoreDisplay}%)`;

            // Analyze if chunks are functions/classes or fragments
            let isStructuredContent = false;
            for (const result of fileResults) {
                // Simple heuristic: If content contains a complete function or class definition
                if (
                    (result.content.includes('function') && result.content.includes('{') && result.content.includes('}')) ||
                    (result.content.includes('class') && result.content.includes('{') && result.content.includes('}'))
                ) {
                    isStructuredContent = true;
                    break;
                }
            }

            // Add structured content indicator if applicable
            const contentDescription = isStructuredContent ?
                ' (Complete structures shown)' : '';

            // Combine all chunks from the file, removing duplicated content
            let combinedContent = '';
            const seenContentHashCodes = new Set<number>();

            for (const result of fileResults) {
                // Simple content hash to avoid including identical code blocks
                const contentHash = this.quickHash(result.content);

                if (!seenContentHashCodes.has(contentHash)) {
                    if (combinedContent) {
                        combinedContent += '\n\n// ...\n\n';
                    }
                    combinedContent += result.content;
                    seenContentHashCodes.add(contentHash);
                }
            }

            // Truncate content if too long, being careful not to break code structures
            if (combinedContent.length > 1500) {
                // Try to find a good break point near the 1500 char mark
                let breakPoint = 1500;
                const safeBreakPoints = [
                    combinedContent.lastIndexOf('}\n', 1500),
                    combinedContent.lastIndexOf(';\n', 1500),
                    combinedContent.lastIndexOf('\n\n', 1500)
                ].filter(point => point > 0);

                if (safeBreakPoints.length > 0) {
                    breakPoint = Math.max(...safeBreakPoints) + 1;
                }

                combinedContent = combinedContent.substring(0, breakPoint) +
                    '\n\n// ... [additional content truncated for brevity] ...';
            }

            // Format with markdown for better readability
            formattedFiles.push([
                `${fileHeader}${contentDescription}`,
                '```',
                combinedContent,
                '```',
                '' // Empty line for spacing
            ].join('\n'));
        }

        // Create a summary of the context provided
        const summary = [
            `## Context Summary`,
            `- ${results.length} relevant code snippets found across ${fileGroups.size} files`,
            `- Includes complete code structures where possible`,
            `- Files sorted by relevance to the changes`,
            ``
        ].join('\n');

        // Combine all formatted results
        return [
            summary,
            '## Related Code Context',
            ...formattedFiles
        ].join('\n\n');
    }

    /**
     * Generate a simple hash for deduplication purposes
     * @param content Content to hash
     * @returns Simple hash value
     */
    private quickHash(content: string): number {
        let hash = 0;
        if (content.length === 0) return hash;

        for (let i = 0; i < content.length; i++) {
            const char = content.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32bit integer
        }

        return hash;
    }

    /**
     * Get summary context for PR analysis
     * @param prDescription PR description
     * @param diff PR diff
     * @param changedFiles List of changed file paths
     * @param analysisMode Analysis mode to determine context retrieval strategy
     * @returns Complete context for analysis
     */
    async getPRContext(
        prDescription: string,
        diff: string,
        changedFiles: string[],
        analysisMode: AnalysisMode = AnalysisMode.Comprehensive
    ): Promise<string> {
        console.log(`Getting PR context for analysis mode: ${analysisMode}`);

        // First, get context based on the diff itself
        const diffContext = await this.getContextForDiff(diff, undefined, analysisMode);

        // Get additional context based on changed files
        const filesContext = await this.getContextForFiles(changedFiles, analysisMode);

        // Combine contexts, removing duplicates
        // We'll include diff and PR description in all cases
        const sections = [
            '## PR Description',
            prDescription || 'No description provided.',
            '',
            '## PR Changes',
            `This PR changes ${changedFiles.length} files.`,
            '',
        ];

        // For different modes, format content differently
        switch (analysisMode) {
            case 'critical':
                // For critical issues, focus on the most relevant context only
                sections.push(diffContext);
                break;

            case 'comprehensive':
                // For comprehensive analysis, include both diff and file contexts
                sections.push(diffContext);
                sections.push('');
                sections.push('## Additional Context');
                sections.push(filesContext);
                break;

            case 'security':
                // For security analysis, prioritize code context
                sections.push(diffContext);
                sections.push('');
                sections.push('## Security-Related Context');
                sections.push(filesContext);
                break;

            case 'performance':
                // For performance analysis, focus on related algorithms and patterns
                sections.push(diffContext);
                sections.push('');
                sections.push('## Performance-Related Context');
                sections.push(filesContext);
                break;
        }

        const combined = sections.join('\n');

        // Check if the context is too large and might exceed token limits
        if (combined.length > this.MAX_CONTENT_LENGTH) {
            console.log('Context is very large, truncating to fit token limits');
            return combined.substring(0, this.MAX_CONTENT_LENGTH) +
                '\n\n[Note: Context was truncated due to length limits]';
        }

        return combined;
    }

    /**
     * Dispose resources
     */
    dispose(): void {
        if (ContextProvider.instance === this) {
            ContextProvider.instance = null;
        }
    }
}