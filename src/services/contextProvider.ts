import * as vscode from 'vscode';
import { EmbeddingDatabaseAdapter } from './embeddingDatabaseAdapter';
import { TreeStructureAnalyzerResource, SymbolInfo as AnalyzerSymbolInfo } from './treeStructureAnalyzer'; // Import SymbolInfo as AnalyzerSymbolInfo
import {
    SUPPORTED_LANGUAGES, getLanguageForExtension // Import getLanguageForExtension
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
import * as path from 'path'; // Import path

/**
 * Represents symbol information found within a diff, including file path.
 */
export interface DiffSymbolInfo extends AnalyzerSymbolInfo {
    filePath: string;
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
     * Extract meaningful code chunks and identify symbols from PR diff.
     * @param diff PR diff content.
     * @param gitRepoRoot The root path of the workspace.
     * @returns An object containing extracted code chunks and identified symbols.
     */
    private async extractMeaningfulChunksAndSymbols(diff: string, gitRepoRoot: string): Promise<{ chunks: string[]; symbols: DiffSymbolInfo[] }> {
        const chunks: string[] = [];
        const identifiedSymbols: DiffSymbolInfo[] = [];
        const resource = await TreeStructureAnalyzerResource.create();
        const analyzer = resource.instance;

        const parsedDiff = this.parseDiff(diff);

        for (const fileDiff of parsedDiff) {
            const filePath = fileDiff.filePath;
            const absoluteFilePath = path.join(gitRepoRoot, filePath); // Assume relative path
            const langInfo = analyzer.getFileLanguage(filePath);

            let fullFileContent: string | undefined = undefined;
            let isNewFile = false;

            // Try to read the full file content for symbol analysis
            if (langInfo) {
                try {
                    const fileUri = vscode.Uri.file(absoluteFilePath);
                    const fileStat = await vscode.workspace.fs.stat(fileUri);
                    if (fileStat.type === vscode.FileType.File) {
                        const contentBytes = await vscode.workspace.fs.readFile(fileUri);
                        fullFileContent = Buffer.from(contentBytes).toString('utf8');
                    }
                } catch (error) {
                    // File might not exist (e.g., it's a new file in the diff)
                    // Check if the diff indicates a new file
                    const newFilePattern = new RegExp(`^diff --git a\\/dev\\/null b\\/${filePath.replace(/\\/g, '\\\\/')}`, 'm');
                    if (newFilePattern.test(diff)) {
                        isNewFile = true;
                        // Construct content from added lines only
                        fullFileContent = fileDiff.hunks
                            .flatMap(hunk => hunk.lines)
                            .filter(line => line.startsWith('+'))
                            .map(line => line.substring(1))
                            .join('\n');
                        console.log(`Identified ${filePath} as a new file.`);
                    } else {
                        console.warn(`Could not read file content for ${filePath}:`, error);
                    }
                }
            }

            const addedLinesContent: string[] = [];
            const lineRanges: { startLine: number; endLine: number }[] = [];

            for (const hunk of fileDiff.hunks) {
                let currentNewLineNumber = hunk.newStart; // 1-based
                let rangeStartLine: number | null = null;

                for (const line of hunk.lines) {
                    const currentLineIsAdded = line.startsWith('+');
                    const currentLineIsRemoved = line.startsWith('-');

                    if (currentLineIsAdded) {
                        addedLinesContent.push(line.substring(1));
                        if (rangeStartLine === null) {
                            rangeStartLine = currentNewLineNumber - 1; // Convert to 0-based for analyzer
                        }
                    } else {
                        // Line is context or removed, end the current range if active
                        if (rangeStartLine !== null) {
                            lineRanges.push({ startLine: rangeStartLine, endLine: currentNewLineNumber - 2 }); // End line is inclusive, previous line
                            rangeStartLine = null;
                        }
                    }

                    // Increment line number for added or context lines
                    if (!currentLineIsRemoved) {
                        currentNewLineNumber++;
                    }
                }
                // End the last range if the hunk ends with added lines
                if (rangeStartLine !== null) {
                    lineRanges.push({ startLine: rangeStartLine, endLine: currentNewLineNumber - 2 }); // End line is inclusive, previous line
                }
            }

            // --- Symbol Identification ---
            if (langInfo && fullFileContent !== undefined && lineRanges.length > 0) {
                try {
                    console.log(`Analyzing symbols in ${filePath} for ranges:`, lineRanges);
                    const symbolsInRanges = await analyzer.findSymbolsInRanges(
                        fullFileContent,
                        langInfo.language,
                        lineRanges,
                        langInfo.variant
                    );
                    console.log(`Found ${symbolsInRanges.length} symbols in changed ranges for ${filePath}`);
                    symbolsInRanges.forEach(symbol => {
                        identifiedSymbols.push({ ...symbol, filePath });
                    });
                } catch (error) {
                    console.error(`Error finding symbols in ranges for ${filePath}:`, error);
                }
            }

            // --- Chunk Extraction (Simplified - keeping existing logic for now) ---
            const newContentCombined = addedLinesContent.join('\\n');
            if (newContentCombined.trim().length > 0) {
                if (langInfo) {
                    try {
                        // Use the combined added lines for structure analysis for chunks
                        const functions = await analyzer.findFunctions(newContentCombined, langInfo.language, langInfo.variant);
                        const classes = await analyzer.findClasses(newContentCombined, langInfo.language, langInfo.variant);

                        if (functions.length > 0 || classes.length > 0) {
                            functions.forEach(f => chunks.push(f.text));
                            classes.forEach(c => chunks.push(c.text));
                        } else {
                            chunks.push(newContentCombined); // Add combined content if no structures found
                        }
                    } catch (error) {
                        console.warn(`Error analyzing structure for chunks in ${filePath}:`, error);
                        chunks.push(newContentCombined); // Fallback
                    }
                } else {
                    chunks.push(newContentCombined); // Unsupported language
                }
            }
            // Always add file path for context
            chunks.push(filePath);
        }

        resource.dispose();

        // Deduplicate chunks
        const uniqueChunks = [...new Set(chunks)];

        // If no chunks extracted, use the whole diff as a fallback chunk
        if (uniqueChunks.length === 0 && diff.trim().length > 0) {
            uniqueChunks.push(diff);
        }


        console.log(`Extracted ${uniqueChunks.length} chunks and ${identifiedSymbols.length} symbols from diff.`);
        return { chunks: uniqueChunks, symbols: identifiedSymbols };
    }

    /**
     * Parses a diff string to extract file paths, hunks, and line number mappings.
     * @param diff The diff string.
     * @returns An array of objects, each representing a file in the diff.
     */
    private parseDiff(diff: string): { filePath: string; hunks: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }[] }[] {
        const files: { filePath: string; hunks: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }[] }[] = [];
        const fileRegex = /^diff --git a\/(.+) b\/(.+)$/gm;
        const hunkHeaderRegex = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/;
        const lines = diff.split('\n'); // Fix: Split by actual newline character
        let currentFile: { filePath: string; hunks: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }[] } | null = null;
        let currentHunk: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] } | null = null;

        for (const line of lines) {
            const fileMatch = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
            if (fileMatch) {
                currentFile = { filePath: fileMatch[2], hunks: [] };
                files.push(currentFile);
                currentHunk = null; // Reset hunk when a new file starts
                continue; // Ensure continue is on a new line
            }

            if (currentFile) {
                const hunkHeaderMatch = hunkHeaderRegex.exec(line);
                if (hunkHeaderMatch) {
                    const newHunk = { // Assign to a new variable first
                        oldStart: parseInt(hunkHeaderMatch[1], 10),
                        oldLines: parseInt(hunkHeaderMatch[2], 10),
                        newStart: parseInt(hunkHeaderMatch[3], 10),
                        newLines: parseInt(hunkHeaderMatch[4], 10),
                        lines: []
                    };
                    currentHunk = newHunk; // Assign to currentHunk
                    currentFile.hunks.push(currentHunk);
                } else if (currentHunk && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))) {
                    // Only add context, added, or removed lines to the hunk lines
                    currentHunk.lines.push(line);
                }
            }
        }
        return files;
    }

    /**
     * Get relevant code context for a diff
     * @param diff The PR diff
     * @param gitRootPath The root path of the git repository
     * @param options Optional search options
     * @param analysisMode Analysis mode that determines relevance strategy
     * @param systemPrompt Optional system prompt
     * @param progressCallback Optional callback for progress updates
     * @param token Optional cancellation token
     * @returns The formatted context
     */
    async getContextForDiff(
        diff: string,
        gitRootPath: string,
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

            // Extract meaningful chunks and symbols from the diff
            const { chunks, symbols } = await this.extractMeaningfulChunksAndSymbols(diff, gitRootPath);

            if (token?.isCancellationRequested) {
                throw new Error('Operation cancelled: After chunk and symbol extraction');
            }

            // --- LSP Context Retrieval ---
            let lspDefinitionSnippets: string[] = [];
            let lspReferenceSnippets: string[] = [];
            const lspContextPromises: Promise<void>[] = [];

            if (symbols.length > 0) {
                console.log(`Attempting LSP lookup for ${symbols.length} symbols.`);
                for (const symbol of symbols) {
                    if (token?.isCancellationRequested) break;

                    const absoluteSymbolPath = path.join(gitRootPath, symbol.filePath);

                    // Definitions
                    lspContextPromises.push(
                        this.findSymbolDefinition(absoluteSymbolPath, symbol.position, token)
                            .then(async (defLocations) => {
                                if (token?.isCancellationRequested) return;
                                if (defLocations && defLocations.length > 0) {
                                    const snippets = await this.getSnippetsForLocations(defLocations, 3, token, "Definition");
                                    lspDefinitionSnippets.push(...snippets);
                                }
                            }).catch(err => console.warn(`Error finding definition for ${symbol.symbolName} in ${symbol.filePath}:`, err))
                    );

                    // References
                    lspContextPromises.push(
                        this.findSymbolReferences(absoluteSymbolPath, symbol.position, false, token)
                            .then(async (refLocations) => {
                                if (token?.isCancellationRequested) return;
                                if (refLocations && refLocations.length > 0) {
                                    const snippets = await this.getSnippetsForLocations(refLocations, 2, token, "Reference");
                                    lspReferenceSnippets.push(...snippets);
                                }
                            }).catch(err => console.warn(`Error finding references for ${symbol.symbolName} in ${symbol.filePath}:`, err))
                    );
                }
                await Promise.allSettled(lspContextPromises);
                console.log(`LSP: Found ${lspDefinitionSnippets.length} definition snippets and ${lspReferenceSnippets.length} reference snippets.`);
            } else {
                console.log('No symbols identified for LSP lookup.');
            }


            if (token?.isCancellationRequested) {
                throw new Error('Operation cancelled: After LSP context retrieval');
            }

            // --- Embedding-based Context Retrieval ---
            const searchOptions = this.getSearchOptionsForMode(analysisMode, options);
            let embeddingResults: SimilaritySearchResult[] = [];
            if (chunks.length > 0) {
                embeddingResults = await this.embeddingDatabaseAdapter.findRelevantCodeContextForChunks(
                    chunks,
                    searchOptions,
                    progressCallback || ((processed, total) => {
                        console.log(`Generating embeddings: ${processed} of ${total}`);
                    }),
                    token
                );
            } else {
                console.log('No chunks extracted for embedding search.');
            }


            if (token?.isCancellationRequested) {
                throw new Error('Operation cancelled: After embedding search');
            }

            const rankedEmbeddingResults = this.rankAndFilterResults(embeddingResults, analysisMode);
            console.log(`Found ${rankedEmbeddingResults.length} relevant code snippets via embeddings after ranking.`);

            // --- Combine Context ---
            let combinedContextParts: string[] = [];

            if (lspDefinitionSnippets.length > 0) {
                combinedContextParts.push("## Definitions Found (LSP)\n");
                combinedContextParts.push(...lspDefinitionSnippets);
            }
            if (lspReferenceSnippets.length > 0) {
                combinedContextParts.push("\n## References Found (LSP)\n");
                combinedContextParts.push(...lspReferenceSnippets);
            }
            if (rankedEmbeddingResults.length > 0) {
                combinedContextParts.push("\n" + this.formatContextResults(rankedEmbeddingResults)); // formatContextResults already adds "## Related Code Context"
            }

            const initialFormattedContext = combinedContextParts.join('\n\n').trim();

            if (!initialFormattedContext && rankedEmbeddingResults.length === 0 && lspDefinitionSnippets.length === 0 && lspReferenceSnippets.length === 0) {
                console.log('No relevant context found from LSP or embeddings.');
                return await this.getFallbackContext(diff, token);
            }

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
                context: initialFormattedContext // Use combined context once LSP is added
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
            // --- TODO: Update optimizeContext to handle structured context and relevance scores (Improvement Plan Item #3) ---
            const optimizedContext = await this.tokenManager.optimizeContext(
                initialFormattedContext,
                allocation.contextAllocationTokens
            );

            // Assess the quality of the context
            const qualityScore = this.assessContextQuality(rankedEmbeddingResults); // TODO: Update to assess combined context
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
     * Find the definition(s) of a symbol at a given position in a file using LSP.
     * @param filePath The absolute path to the file.
     * @param position The position of the symbol in the file.
     * @param token Optional cancellation token.
     * @returns A promise that resolves to an array of locations, or undefined if not found or cancelled.
     */
    public async findSymbolDefinition(
        filePath: string,
        position: vscode.Position,
        token?: vscode.CancellationToken
    ): Promise<vscode.Location[] | undefined> {
        // Early exit if cancellation is already requested
        if (token?.isCancellationRequested) {
            console.log('Symbol definition lookup cancelled before execution.');
            return undefined;
        }

        try {
            const uri = vscode.Uri.file(filePath);
            console.log(`Finding definition for symbol at ${filePath}:${position.line}:${position.character}`);

            // Use a CancellationTokenSource to manage cancellation for the command execution
            const cts = new vscode.CancellationTokenSource();
            if (token) {
                token.onCancellationRequested(() => cts.cancel());
            }

            const locations = await vscode.commands.executeCommand<vscode.Location[]>(
                'vscode.executeDefinitionProvider',
                uri,
                position,
                cts.token // Pass the token from the new source
            );

            if (token?.isCancellationRequested) {
                console.log('Symbol definition lookup cancelled.');
                return undefined;
            }

            if (locations && locations.length > 0) {
                console.log(`Found ${locations.length} definition(s)`);
                return locations;
            } else {
                console.log('No definition found.');
                return undefined;
            }
        } catch (error) {
            console.error(`Error finding symbol definition for ${filePath}:${position.line}:${position.character}:`, error);
            // Don't throw, just return undefined if LSP fails
            return undefined;
        }
    }

    /**
     * Find references to a symbol at a given position in a file using LSP.
     * @param filePath The absolute path to the file.
     * @param position The position of the symbol in the file.
     * @param includeDeclaration Whether to include the declaration in the results.
     * @param token Optional cancellation token.
     * @returns A promise that resolves to an array of locations, or undefined if not found or cancelled.
     */
    public async findSymbolReferences(
        filePath: string,
        position: vscode.Position,
        includeDeclaration: boolean = false,
        token?: vscode.CancellationToken
    ): Promise<vscode.Location[] | undefined> {
        // Early exit if cancellation is already requested
        if (token?.isCancellationRequested) {
            console.log('Symbol reference lookup cancelled before execution.');
            return undefined;
        }

        try {
            const uri = vscode.Uri.file(filePath);
            const context: vscode.ReferenceContext = { includeDeclaration };
            console.log(`Finding references for symbol at ${filePath}:${position.line}:${position.character} (includeDeclaration: ${includeDeclaration})`);

            // Use a CancellationTokenSource to manage cancellation for the command execution
            const cts = new vscode.CancellationTokenSource();
            if (token) {
                token.onCancellationRequested(() => cts.cancel());
            }

            const locations = await vscode.commands.executeCommand<vscode.Location[]>(
                'vscode.executeReferenceProvider',
                uri,
                position,
                context,
                cts.token // Pass the token from the new source
            );

            if (token?.isCancellationRequested) {
                console.log('Symbol reference lookup cancelled.');
                return undefined;
            }

            if (locations && locations.length > 0) {
                console.log(`Found ${locations.length} reference(s)`);
                return locations;
            } else {
                console.log('No references found.');
                return undefined;
            }
        } catch (error) {
            console.error(`Error finding symbol references for ${filePath}:${position.line}:${position.character}:`, error);
            // Don't throw, just return undefined if LSP fails
            return undefined;
        }
    }

    /**
     * Retrieve code snippets for a list of LSP locations.
     * @param locations Array of vscode.Location objects.
     * @param contextLines Number of lines to include before and after the target range.
     * @param token Optional cancellation token.
     * @returns A promise that resolves to an array of formatted markdown snippets.
     */
    public async getSnippetsForLocations(
        locations: vscode.Location[],
        contextLines: number,
        token?: vscode.CancellationToken,
        defaultTitleType: "Definition" | "Reference" | "Context" = "Context"
    ): Promise<string[]> {
        if (!locations || locations.length === 0) {
            return [];
        }

        const snippets: string[] = [];
        const snippetCache = new Map<string, string>();

        for (const location of locations) {
            if (token?.isCancellationRequested) {
                console.log('Snippet retrieval cancelled.');
                break;
            }

            const cacheKey = `${location.uri.toString()}:${location.range.start.line}:${location.range.start.character}-${location.range.end.line}:${location.range.end.character}-${defaultTitleType}`;
            if (snippetCache.has(cacheKey)) {
                const cachedSnippet = snippetCache.get(cacheKey);
                if (cachedSnippet) {
                    snippets.push(cachedSnippet);
                }
                continue;
            }

            try {
                const document = await vscode.workspace.openTextDocument(location.uri);
                const startLine = Math.max(0, location.range.start.line - contextLines);
                const endLine = Math.min(document.lineCount - 1, location.range.end.line + contextLines);

                let snippetContent = '';
                for (let i = startLine; i <= endLine; i++) {
                    if (token?.isCancellationRequested) break;
                    const lineText = document.lineAt(i).text;
                    snippetContent += `${String(i + 1).padStart(4, ' ')}: ${lineText}\n`;
                }

                if (token?.isCancellationRequested) {
                    console.log('Snippet retrieval cancelled during line reading.');
                    break;
                }

                const relativePath = vscode.workspace.asRelativePath(location.uri, false);
                const languageId = getLanguageForExtension(path.extname(relativePath))?.language || document.languageId || 'plaintext';

                const formattedSnippet = `**${defaultTitleType} in \`${relativePath}\` (L${location.range.start.line + 1}):**\n\`\`\`${languageId}\n${snippetContent.trimEnd()}\n\`\`\``;
                snippets.push(formattedSnippet);
                snippetCache.set(cacheKey, formattedSnippet);

            } catch (error) {
                console.error(`Error reading snippet for ${location.uri.fsPath}:`, error);
            }
        }
        return snippets;
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