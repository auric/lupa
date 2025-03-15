import * as vscode from 'vscode';
import { EmbeddingDatabaseAdapter } from './embeddingDatabaseAdapter';
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

/**
 * ContextProvider is responsible for retrieving relevant code context
 * for PR analysis based on the changes in the PR
 */
export class ContextProvider implements vscode.Disposable {
    private static instance: ContextProvider | null = null;
    private readonly MAX_CONTENT_LENGTH = 800000; // Characters limit to avoid excessive token use
    private readonly DEFAULT_TOKEN_LIMIT = 16000; // Default token limit for most LLM models

    // Different context sizes based on analysis mode
    private readonly CONTEXT_LIMITS = {
        critical: 12000,
        comprehensive: 16000,
        security: 14000,
        performance: 14000
    };

    /**
     * Get singleton instance of ContextProvider
     */
    public static getInstance(
        embeddingDatabaseAdapter: EmbeddingDatabaseAdapter
    ): ContextProvider {
        if (!this.instance) {
            this.instance = new ContextProvider(embeddingDatabaseAdapter);
        }
        return this.instance;
    }

    /**
     * Private constructor (use getInstance)
     */
    private constructor(
        private readonly embeddingDatabaseAdapter: EmbeddingDatabaseAdapter
    ) { }

    /**
     * Extract meaningful code chunks from PR diff
     * @param diff PR diff content
     * @returns Extracted code chunks for similarity search
     */
    private extractMeaningfulChunks(diff: string): string[] {
        const chunks: string[] = [];

        // Split the diff into files
        const fileRegex = /^diff --git a\/(.+) b\/(.+)[\r\n]+(?:.+[\r\n]+)*?(?:@@.+@@)/gm;
        let fileMatch;
        const matches: { index: number, length: number, filePath: string }[] = [];

        // Find all file sections in the diff
        while ((fileMatch = fileRegex.exec(diff)) !== null) {
            matches.push({
                index: fileMatch.index,
                length: fileMatch[0].length,
                filePath: fileMatch[2] // Using the 'b/' path (new file path)
            });
        }

        // Extract content for each file section
        for (let i = 0; i < matches.length; i++) {
            const start = matches[i].index + matches[i].length;
            const end = i < matches.length - 1 ? matches[i].index : diff.length;
            const fileContent = diff.substring(start, end);

            // Extract added lines (starting with '+' but not '+++')
            const addedLines = fileContent
                .split('\n')
                .filter(line => line.startsWith('+') && !line.startsWith('+++'))
                .map(line => line.substring(1)) // Remove the '+' prefix
                .join('\n');

            if (addedLines.trim().length > 0) {
                chunks.push(addedLines);
            }

            // Also use the file path as a chunk to find related files
            chunks.push(matches[i].filePath);
        }

        // If we couldn't extract meaningful chunks, use the whole diff
        if (chunks.length === 0) {
            chunks.push(diff);
        }

        return chunks;
    }

    /**
     * Get relevant code context for a diff
     * @param diff The PR diff
     * @param options Optional search options
     * @param analysisMode Analysis mode that determines relevance strategy
     * @returns The formatted context
     */
    async getContextForDiff(
        diff: string,
        options?: SimilaritySearchOptions,
        analysisMode: AnalysisMode = 'comprehensive'
    ): Promise<string> {
        console.log(`Finding relevant context for PR diff (mode: ${analysisMode})`);

        try {
            // Extract meaningful chunks from the diff for better semantic search
            const chunks = this.extractMeaningfulChunks(diff);

            // Set search options based on analysis mode
            const searchOptions = this.getSearchOptionsForMode(analysisMode, options);

            // Store all results across chunks
            const allResults: SimilaritySearchResult[] = [];

            // Query the database for each chunk
            for (const chunk of chunks) {
                const results = await this.embeddingDatabaseAdapter.findRelevantCodeContext(
                    chunk,
                    searchOptions
                );

                // Add results, avoiding duplicates
                for (const result of results) {
                    if (!allResults.some(r => r.chunkId === result.chunkId)) {
                        allResults.push(result);
                    }
                }
            }

            if (allResults.length === 0) {
                console.log('No relevant context found');
                return await this.getFallbackContext(diff);
            }

            // Rank and filter results based on relevance and analysis mode
            const rankedResults = this.rankAndFilterResults(allResults, analysisMode);

            console.log(`Found ${rankedResults.length} relevant code snippets after ranking`);

            // Check if the total content exceeds token limits and optimize if needed
            const optimizedResults = await this.optimizeForTokenLimit(rankedResults, analysisMode);

            // Format the results
            const formattedContext = this.formatContextResults(optimizedResults);

            // Assess the quality of the context
            const qualityScore = this.assessContextQuality(optimizedResults);
            console.log(`Context quality score: ${qualityScore.toFixed(2)}`);

            return formattedContext;
        } catch (error) {
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
     * Optimize the context to stay within token limits based on the analysis mode
     */
    private async optimizeForTokenLimit(
        results: SimilaritySearchResult[],
        mode: AnalysisMode
    ): Promise<SimilaritySearchResult[]> {
        // Get the token limit for this mode
        const tokenLimit = this.CONTEXT_LIMITS[mode] || this.DEFAULT_TOKEN_LIMIT;

        // Estimate total tokens (this is a simplification - actual tokens depend on the tokenizer)
        // Estimate about 4 chars per token for code on average
        const totalCharacters = results.reduce((sum, result) =>
            sum + result.content.length + result.filePath.length + 50, 0);

        const estimatedTokens = Math.ceil(totalCharacters / 4);

        if (estimatedTokens <= tokenLimit) {
            return results; // Already within limits
        }

        console.log(`Context exceeds estimated token limit (${estimatedTokens} > ${tokenLimit}), optimizing...`);

        // Simple scaling approach
        const scaleFactor = tokenLimit / estimatedTokens;
        const maxResultsToKeep = Math.max(5, Math.floor(results.length * scaleFactor));

        // Keep top results based on score
        const optimizedResults = results.slice(0, maxResultsToKeep);

        // For remaining results, truncate content if necessary
        const contentScaleFactor = maxResultsToKeep === results.length ? scaleFactor : 1;

        return optimizedResults.map(result => {
            if (contentScaleFactor < 1) {
                // Truncate content to fit within limits
                const maxContentLength = Math.floor(result.content.length * contentScaleFactor);
                const truncatedContent = result.content.substring(0, maxContentLength);
                return {
                    ...result,
                    content: truncatedContent.length < result.content.length
                        ? truncatedContent + '\n// ... [content truncated] ...'
                        : truncatedContent
                };
            }
            return result;
        });
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
        analysisMode: AnalysisMode = 'comprehensive'
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
                    languageSet.add(language);
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
    private async getFallbackContext(diff: string): Promise<string> {
        console.log('Using fallback context strategy');

        try {
            // Strategy 1: Use filenames from the diff to find relevant files
            const filePathRegex = /^(?:diff --git a\/|--- a\/|\+\+\+ b\/)(.+?)(?:$|\s)/gm;
            const filePaths = new Set<string>();
            let match;

            while ((match = filePathRegex.exec(diff)) !== null) {
                if (match[1] && !match[1].includes('/dev/null')) {
                    filePaths.add(match[1]);
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

                // Try to find related files
                const allResults: SimilaritySearchResult[] = [];

                for (const query of searchQueries) {
                    const results = await this.embeddingDatabaseAdapter.findRelevantCodeContext(
                        query,
                        { minScore: 0.5, limit: 5 }
                    );

                    for (const result of results) {
                        if (!allResults.some(r => r.chunkId === result.chunkId)) {
                            allResults.push(result);
                        }
                    }
                }

                if (allResults.length > 0) {
                    console.log(`Found ${allResults.length} fallback context items`);
                    return this.formatContextResults(allResults);
                }
            }

            // Strategy 2: If still nothing, return a message about no context
            return 'No directly relevant context could be found in the codebase. Analysis will be based solely on the changes in the PR.';

        } catch (error) {
            console.error('Error getting fallback context:', error);
            return 'No directly relevant context could be found. Analysis will be based solely on the changes in the PR.';
        }
    }

    /**
     * Format similar code results into a readable context block
     * @param results Array of similarity search results
     * @returns Formatted context string
     */
    private formatContextResults(
        results: SimilaritySearchResult[]
    ): string {
        // Format each result with file path, score, and content
        const formattedResults = results.map(result => {
            // Truncate content if too long
            let content = result.content;
            if (content.length > 1000) {
                content = content.substring(0, 997) + '...';
            }

            // Format with markdown for better readability
            return [
                `### File: \`${result.filePath}\` (Relevance: ${(result.score * 100).toFixed(1)}%)`,
                '```',
                content,
                '```',
                '' // Empty line for spacing
            ].join('\n');
        });

        // Combine all formatted results
        return [
            '## Related Code Context',
            ...formattedResults
        ].join('\n\n');
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
        analysisMode: AnalysisMode = 'comprehensive'
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
     * Get context specifically for repository-level analysis
     * Useful for understanding project structure and patterns
     */
    async getRepositoryContext(): Promise<string> {
        try {
            // Find key files that represent the project structure
            const keyFilePatterns = [
                'package.json', 'requirements.txt', 'build.gradle', 'pom.xml',
                'tsconfig.json', 'Cargo.toml', 'CMakeLists.txt', 'Makefile',
                'README.md', '.gitignore'
            ];

            const allResults: SimilaritySearchResult[] = [];

            // Search for each key file pattern
            for (const pattern of keyFilePatterns) {
                const results = await this.embeddingDatabaseAdapter.findRelevantCodeContext(
                    pattern,
                    { minScore: 0.5, limit: 2 }
                );

                for (const result of results) {
                    if (!allResults.some(r => r.filePath === result.filePath)) {
                        allResults.push(result);
                    }
                }
            }

            if (allResults.length === 0) {
                return 'No repository context could be found.';
            }

            return this.formatContextResults(allResults);

        } catch (error) {
            console.error('Error getting repository context:', error);
            return 'Error retrieving repository context: ' +
                (error instanceof Error ? error.message : String(error));
        }
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