import * as vscode from 'vscode';
import { EmbeddingDatabaseAdapter } from './embeddingDatabaseAdapter';
import { SimilaritySearchOptions, SUPPORTED_LANGUAGES } from '../models/types';

/**
 * ContextProvider is responsible for retrieving relevant code context
 * for PR analysis based on the changes in the PR
 */
export class ContextProvider implements vscode.Disposable {
    private static instance: ContextProvider | null = null;

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
     * Get relevant code context for a diff
     * @param diff The PR diff
     * @param options Optional search options
     * @returns The formatted context
     */
    async getContextForDiff(
        diff: string,
        options?: SimilaritySearchOptions
    ): Promise<string> {
        console.log('Finding relevant context for PR diff');

        try {
            // Set reasonable defaults if not provided
            const searchOptions = {
                limit: options?.limit || 10,
                minScore: options?.minScore || 0.65,
                fileFilter: options?.fileFilter,
                languageFilter: options?.languageFilter
            };

            // Query the database for similar code
            const similarResults = await this.embeddingDatabaseAdapter.findRelevantCodeContext(
                diff,
                searchOptions
            );

            if (similarResults.length === 0) {
                console.log('No relevant context found');
                return 'No relevant context found in the codebase.';
            }

            console.log(`Found ${similarResults.length} relevant code snippets`);

            // Format the results
            const formattedContext = this.formatContextResults(similarResults);
            return formattedContext;
        } catch (error) {
            console.error('Error getting context for diff:', error);
            return 'Error retrieving context: ' + (error instanceof Error ? error.message : String(error));
        }
    }

    /**
     * Get relevant code context for a list of file paths
     * This is useful when you already know which files have changed
     * @param files Array of file paths
     * @returns Formatted context
     */
    async getContextForFiles(files: string[]): Promise<string> {
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

            // Join file paths to create a search query
            const searchQuery = files.join('\n');

            return await this.getContextForDiff(searchQuery, options);
        } catch (error) {
            console.error('Error getting context for files:', error);
            return 'Error retrieving context: ' + (error instanceof Error ? error.message : String(error));
        }
    }

    /**
     * Format similar code results into a readable context block
     * @param results Array of similarity search results
     * @returns Formatted context string
     */
    private formatContextResults(
        results: Array<{
            filePath: string;
            content: string;
            score: number;
        }>
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
     * @returns Complete context for analysis
     */
    async getPRContext(
        prDescription: string,
        diff: string,
        changedFiles: string[]
    ): Promise<string> {
        // First, get context based on the diff itself
        const diffContext = await this.getContextForDiff(diff);

        // Get additional context based on changed files
        const filesContext = await this.getContextForFiles(changedFiles);

        // Combine contexts, removing duplicates
        return [
            '## PR Description',
            prDescription || 'No description provided.',
            '',
            '## PR Changes',
            `This PR changes ${changedFiles.length} files.`,
            '',
            diffContext,
            '',
            '## Additional Context',
            filesContext
        ].join('\n');
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