import * as vscode from 'vscode';
import { EmbeddingDatabaseAdapter } from './embeddingDatabaseAdapter';
import { TreeStructureAnalyzerResource, SymbolInfo as AnalyzerSymbolInfo } from './treeStructureAnalyzer'; // Import SymbolInfo as AnalyzerSymbolInfo
import {
    getLanguageForExtension
} from '../types/types';
import {
    AnalysisMode
} from '../types/modelTypes';
import {
    type ContextSnippet,
    type DiffHunk,
    type DiffHunkLine,
    type HybridContextResult
} from '../types/contextTypes';
import {
    SimilaritySearchOptions,
    SimilaritySearchResult
} from '../types/embeddingTypes';
import { CopilotModelManager } from '../models/copilotModelManager';
import * as path from 'path';

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
        this.modelManager = modelManager;
    }

    /**
     * Generates a unique string identifier for a diff hunk.
     * @param filePath The path of the file the hunk belongs to.
     * @param hunkData An object containing hunk information, typically `newStart` line.
     * @returns A string identifier for the hunk.
     */
    private getHunkIdentifier(filePath: string, hunkData: { newStart: number }): string {
        return `${filePath}:L${hunkData.newStart}`;
    }

    /**
     * Extract meaningful code chunks and identify symbols from PR diff.
     * @param diff PR diff content.
     * @param parsedDiff Parsed diff data.
     * @param gitRepoRoot The root path of the git repository.
     * @returns An object containing extracted embedding query strings and identified symbols.
     */
    private async extractMeaningfulChunksAndSymbols(diff: string, parsedDiff: DiffHunk[], gitRepoRoot: string): Promise<{ embeddingQueries: string[]; symbols: DiffSymbolInfo[] }> {
        const embeddingQueriesSet = new Set<string>();
        const identifiedSymbols: DiffSymbolInfo[] = [];
        const resource = await TreeStructureAnalyzerResource.create();
        const analyzer = resource.instance;

        for (const fileDiff of parsedDiff) {
            const filePath = fileDiff.filePath;
            const absoluteFilePath = path.join(gitRepoRoot, filePath);
            const langInfo = analyzer.getFileLanguage(filePath);

            let fullFileContent: string | undefined = undefined;
            const addedLinesForSymbolSnippets: { fileLine: number, text: string }[] = [];

            if (langInfo) {
                try {
                    const fileUri = vscode.Uri.file(absoluteFilePath);
                    const fileStat = await vscode.workspace.fs.stat(fileUri);
                    if (fileStat.type === vscode.FileType.File) {
                        const contentBytes = await vscode.workspace.fs.readFile(fileUri);
                        fullFileContent = Buffer.from(contentBytes).toString('utf8');
                    }
                } catch (error) {
                    const newFilePattern = new RegExp(`^diff --git a\\/dev\\/null b\\/${filePath.replace(/\\/g, '\\\\/')}`, 'm');
                    if (newFilePattern.test(diff)) {
                        fullFileContent = fileDiff.hunks
                            .flatMap(hunk => hunk.lines)
                            .filter(line => line.startsWith('+'))
                            .map(line => line.substring(1))
                            .join('\n');
                    } else {
                        console.warn(`Could not read file content for ${filePath}:`, error);
                    }
                }
            }

            const lineRangesForSymbolExtraction: { startLine: number; endLine: number }[] = [];

            // First pass: collect all added lines and their file line numbers, and identify line ranges for symbol extraction
            for (const hunk of fileDiff.hunks) {
                let currentNewLineInFile = hunk.newStart - 1; // 0-based file line number
                let rangeStartLine: number | null = null;

                for (const line of hunk.lines) {
                    const isAdded = line.startsWith('+');
                    const isRemoved = line.startsWith('-');

                    if (isAdded) {
                        addedLinesForSymbolSnippets.push({ fileLine: currentNewLineInFile, text: line.substring(1) });
                        if (rangeStartLine === null) rangeStartLine = currentNewLineInFile;
                    } else {
                        if (rangeStartLine !== null) {
                            lineRangesForSymbolExtraction.push({ startLine: rangeStartLine, endLine: currentNewLineInFile - 1 });
                            rangeStartLine = null;
                        }
                    }
                    if (!isRemoved) currentNewLineInFile++;
                }
                if (rangeStartLine !== null) { // Hunk ends with added lines
                    lineRangesForSymbolExtraction.push({ startLine: rangeStartLine, endLine: currentNewLineInFile - 1 });
                }
            }

            // Identify symbols within the collected added line ranges
            if (langInfo && fullFileContent !== undefined && lineRangesForSymbolExtraction.length > 0) {
                try {
                    const symbolsInRanges = await analyzer.findSymbolsInRanges(
                        fullFileContent, langInfo.language, lineRangesForSymbolExtraction, langInfo.variant
                    );
                    symbolsInRanges.forEach(symbol => identifiedSymbols.push({ ...symbol, filePath }));
                } catch (error) {
                    console.error(`Error finding symbols in ranges for ${filePath}:`, error);
                }
            }

            // Add identified symbol names to queries
            const symbolsInThisFile = identifiedSymbols.filter(s => s.filePath === filePath);
            for (const symbol of symbolsInThisFile) {
                embeddingQueriesSet.add(symbol.symbolName);
            }

            // Process hunks for small added blocks and symbol-centered snippets
            for (const hunk of fileDiff.hunks) {
                let currentAddedBlockLines: string[] = [];
                let currentHunkAddedLinesWithFileNumbers: { fileLine: number, text: string }[] = [];
                let currentFileLineForHunkProcessing = hunk.newStart - 1; // 0-based

                for (const line of hunk.lines) {
                    const isAdded = line.startsWith('+');
                    const isRemoved = line.startsWith('-');

                    if (isAdded) {
                        const lineContent = line.substring(1);
                        currentAddedBlockLines.push(lineContent);
                        currentHunkAddedLinesWithFileNumbers.push({ fileLine: currentFileLineForHunkProcessing, text: lineContent });
                    } else {
                        if (currentAddedBlockLines.length > 0) {
                            const blockText = currentAddedBlockLines.join('\n');
                            if (currentAddedBlockLines.length < 15 && blockText.trim().length > 0) {
                                embeddingQueriesSet.add(blockText);
                            }
                            currentAddedBlockLines = [];
                        }
                    }
                    if (!isRemoved) {
                        currentFileLineForHunkProcessing++;
                    }
                }
                if (currentAddedBlockLines.length > 0) { // Process block at end of hunk
                    const blockText = currentAddedBlockLines.join('\n');
                    if (currentAddedBlockLines.length < 15 && blockText.trim().length > 0) {
                        embeddingQueriesSet.add(blockText);
                    }
                }

                // Add short code snippets around identifiers on '+' lines within this hunk
                for (const symbol of symbolsInThisFile) {
                    const symbolFileLine = symbol.position.line; // 0-based
                    // Check if symbol's line is within this hunk's added lines
                    const symbolLineInHunkAdded = currentHunkAddedLinesWithFileNumbers.find(l => l.fileLine === symbolFileLine);

                    if (symbolLineInHunkAdded && symbolLineInHunkAdded.text.includes(symbol.symbolName)) {
                        const lineIndexInHunkAdded = currentHunkAddedLinesWithFileNumbers.findIndex(l => l.fileLine === symbolFileLine);
                        if (lineIndexInHunkAdded !== -1) {
                            const snippetStart = Math.max(0, lineIndexInHunkAdded - 2);
                            const snippetEnd = Math.min(currentHunkAddedLinesWithFileNumbers.length, lineIndexInHunkAdded + 3);
                            const snippetLines = currentHunkAddedLinesWithFileNumbers.slice(snippetStart, snippetEnd).map(l => l.text);
                            if (snippetLines.length > 0) {
                                const snippetText = snippetLines.join('\n');
                                if (snippetText.trim().length > 0) {
                                    embeddingQueriesSet.add(snippetText);
                                }
                            }
                        }
                    }
                }
            }
        }
        resource.dispose();

        const finalEmbeddingQueries = [...embeddingQueriesSet].filter(q => q.trim().length > 0);

        // Fallback logic
        if (finalEmbeddingQueries.length === 0 && diff.trim().length > 0) {
            let allAddedLinesFromDiff = "";
            for (const fileDiff of parsedDiff) {
                for (const hunk of fileDiff.hunks) {
                    for (const line of hunk.lines) {
                        if (line.startsWith('+')) {
                            allAddedLinesFromDiff += line.substring(1) + '\n';
                        }
                    }
                }
            }
            if (allAddedLinesFromDiff.trim().length > 0) {
                finalEmbeddingQueries.push(allAddedLinesFromDiff.trim());
            }
        }

        console.log(`Extracted ${finalEmbeddingQueries.length} embedding queries and ${identifiedSymbols.length} symbols from diff.`); // Existing log
        return { embeddingQueries: finalEmbeddingQueries, symbols: identifiedSymbols };
    }

    private parseDiff(diff: string): DiffHunk[] {
        const files: DiffHunk[] = [];
        const lines = diff.split('\n');
        let currentFile: DiffHunk | null = null;
        let currentHunk: DiffHunkLine | null = null;

        for (const line of lines) {
            const fileMatch = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
            if (fileMatch) {
                currentFile = { filePath: fileMatch[2], hunks: [] };
                files.push(currentFile);
                currentHunk = null;
                continue;
            }

            if (currentFile) {
                const hunkHeaderMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
                if (hunkHeaderMatch) {
                    const oldStart = parseInt(hunkHeaderMatch[1], 10);
                    const oldLines = hunkHeaderMatch[2] ? parseInt(hunkHeaderMatch[2], 10) : 1; // Group 2 is optional for oldLines
                    const newStart = parseInt(hunkHeaderMatch[3], 10); // Group 3 is newStart
                    const newLines = hunkHeaderMatch[4] ? parseInt(hunkHeaderMatch[4], 10) : 1; // Group 4 is optional for newLines

                    currentHunk = {
                        oldStart: oldStart, oldLines: oldLines,
                        newStart: newStart, newLines: newLines,
                        lines: [],
                        hunkId: this.getHunkIdentifier(currentFile.filePath, { newStart: newStart })
                    };
                    currentFile.hunks.push(currentHunk);
                } else if (currentHunk && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))) {
                    currentHunk.lines.push(line);
                }
            }
        }
        return files;
    }

    /**
     * Get relevant code context for a diff, now returns an array of ContextSnippet objects.
     * @param diff The PR diff
     * @param gitRootPath The root path of the git repository
     * @param options Optional search options
     * @param analysisMode Analysis mode that determines relevance strategy
     * @param _systemPrompt Optional system prompt (now handled by AnalysisProvider/TokenManager)
     * @param progressCallback Optional callback for progress updates
     * @param token Optional cancellation token
     * @returns A promise resolving to a HybridContextResult object.
     */
    async getContextForDiff(
        diff: string,
        gitRootPath: string,
        options?: SimilaritySearchOptions,
        analysisMode: AnalysisMode = AnalysisMode.Comprehensive,
        _systemPrompt?: string, // No longer used here for optimization logic
        progressCallback?: (processed: number, total: number) => void,
        token?: vscode.CancellationToken
    ): Promise<HybridContextResult> {
        console.log(`Finding relevant context for PR diff (mode: ${analysisMode})`);
        const allContextSnippets: ContextSnippet[] = [];
        const parsedDiffFileHunks = this.parseDiff(diff); // Now includes hunkId

        try {
            if (token?.isCancellationRequested) {
                throw new Error('Operation cancelled');
            }

            const { embeddingQueries, symbols } = await this.extractMeaningfulChunksAndSymbols(diff, parsedDiffFileHunks, gitRootPath);
            if (token?.isCancellationRequested) {
                throw new Error('Operation cancelled: After embedding query/symbol extraction');
            }

            // --- LSP Context Retrieval ---
            const lspContextPromises: Promise<void>[] = [];
            if (symbols.length > 0) {
                console.log(`Attempting LSP lookup for ${symbols.length} symbols.`);
                for (const symbol of symbols) {
                    if (token?.isCancellationRequested) break;
                    const absoluteSymbolPath = path.join(gitRootPath, symbol.filePath);

                    let symbolHunkIdentifier: string | undefined;
                    const fileDiffData = parsedDiffFileHunks.find(f => f.filePath === symbol.filePath);
                    if (fileDiffData) {
                        for (const hunk of fileDiffData.hunks) {
                            const hunkEndLine = hunk.newStart + hunk.newLines - 1;
                            if (symbol.position.line >= (hunk.newStart - 1) && symbol.position.line <= hunkEndLine) {
                                symbolHunkIdentifier = hunk.hunkId; // Use pre-calculated hunkId
                                break;
                            }
                        }
                    }

                    const position = new vscode.Position(symbol.position.line, symbol.position.character);
                    lspContextPromises.push(
                        this.findSymbolDefinition(absoluteSymbolPath, position, token)
                            .then(async (defLocations) => {
                                if (token?.isCancellationRequested || !defLocations) return;
                                const snippets = await this.getSnippetsForLocations(defLocations, 3, token, "Definition");
                                snippets.forEach(s => allContextSnippets.push({
                                    id: `lsp-def-${symbol.filePath}-${symbol.position.line}-${this.quickHash(s)}`,
                                    type: 'lsp-definition', content: s, relevanceScore: 1.0, // Highest priority for LSP definitions
                                    filePath: symbol.filePath, startLine: symbol.position.line,
                                    associatedHunkIdentifiers: symbolHunkIdentifier ? [symbolHunkIdentifier] : undefined
                                }));
                            }).catch(err => console.warn(`Error finding definition for ${symbol.symbolName} in ${symbol.filePath}:`, err))
                    );
                    lspContextPromises.push(
                        this.findSymbolReferences(absoluteSymbolPath, position, false, token)
                            .then(async (refLocations) => {
                                if (token?.isCancellationRequested || !refLocations) return;
                                const snippets = await this.getSnippetsForLocations(refLocations, 2, token, "Reference");
                                snippets.forEach(s => allContextSnippets.push({
                                    id: `lsp-ref-${symbol.filePath}-${symbol.position.line}-${this.quickHash(s)}`,
                                    type: 'lsp-reference', content: s, relevanceScore: 0.9, // High priority for LSP references
                                    filePath: symbol.filePath, startLine: symbol.position.line,
                                    associatedHunkIdentifiers: symbolHunkIdentifier ? [symbolHunkIdentifier] : undefined
                                }));
                            }).catch(err => console.warn(`Error finding references for ${symbol.symbolName} in ${symbol.filePath}:`, err))
                    );
                }
                await Promise.allSettled(lspContextPromises);
                console.log(`LSP: Added ${allContextSnippets.filter(s => s.type.startsWith('lsp-')).length} snippets.`);
            } else {
                console.log('No symbols identified for LSP lookup.');
            }
            if (token?.isCancellationRequested) throw new Error('Operation cancelled: After LSP context retrieval');

            // --- Embedding-based Context Retrieval ---
            const searchOptions = this.getSearchOptionsForMode(analysisMode, options);
            let embeddingResults: SimilaritySearchResult[] = [];
            if (embeddingQueries.length > 0) {
                embeddingResults = await this.embeddingDatabaseAdapter.findRelevantCodeContextForChunks(
                    embeddingQueries, searchOptions,
                    progressCallback || ((p, t) => console.log(`Generating embeddings for queries: ${p} of ${t}`)),
                    token
                );
            } else {
                console.log('No embedding queries extracted for embedding search.');
            }
            if (token?.isCancellationRequested) throw new Error('Operation cancelled: After embedding search');

            const rankedEmbeddingResults = this.rankAndFilterResults(embeddingResults, analysisMode);
            console.log(`Found ${rankedEmbeddingResults.length} relevant code snippets via embeddings after ranking.`);

            rankedEmbeddingResults.forEach(embResult => {
                const scoreDisplay = (embResult.score * 100).toFixed(1);
                const fileHeader = `### File: \`${embResult.filePath}\` (Relevance: ${scoreDisplay}%)`;
                const formattedContent = `${fileHeader}\n\`\`\`\n${embResult.content}\n\`\`\``;

                let embHunkIdentifiers: string[] = [];
                const fileDiffData = parsedDiffFileHunks.find(f => f.filePath === embResult.filePath);
                if (fileDiffData) {
                    // Associate with all hunks in the file for embeddings, or refine if query source is known
                    embHunkIdentifiers = fileDiffData.hunks.map(hunk => hunk.hunkId).filter(id => !!id) as string[];
                }

                allContextSnippets.push({
                    id: `emb-${embResult.fileId}-${embResult.chunkId || this.quickHash(embResult.content)}`,
                    type: 'embedding',
                    content: formattedContent,
                    relevanceScore: embResult.score, // Relevance based on embedding similarity score
                    filePath: embResult.filePath,
                    startLine: embResult.startOffset,
                    associatedHunkIdentifiers: embHunkIdentifiers.length > 0 ? embHunkIdentifiers : undefined
                });
            });


            if (allContextSnippets.length === 0) {
                console.log('No relevant context found from LSP or embeddings. Attempting fallback.');
                const fallbackSnippets = await this.getFallbackContextSnippets(diff, token);
                allContextSnippets.push(...fallbackSnippets);
                if (allContextSnippets.length === 0) {
                    console.log('Fallback also yielded no context.');
                    allContextSnippets.push({
                        id: 'no-context-found',
                        type: 'embedding',
                        content: 'No relevant context could be found in the codebase. Analysis will be based solely on the changes in the PR.',
                        relevanceScore: 0 // Lowest priority for no-context placeholder
                    });
                }
            }

            console.log(`Returning ${allContextSnippets.length} context snippets and parsed diff to AnalysisProvider.`);
            return { snippets: allContextSnippets, parsedDiff: parsedDiffFileHunks };

        } catch (error) {
            if (token?.isCancellationRequested) throw new Error('Operation cancelled');
            console.error('Error getting context for diff:', error);
            return {
                snippets: [{
                    id: 'error-context',
                    type: 'embedding',
                    content: 'Error retrieving context: ' + (error instanceof Error ? error.message : String(error)),
                    relevanceScore: 0 // Lowest priority for error context
                }],
                parsedDiff: parsedDiffFileHunks // Return parsed diff even on error
            };
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
     * Get fallback context snippets when no relevant context is found
     */
    private async getFallbackContextSnippets(diff: string, token?: vscode.CancellationToken): Promise<ContextSnippet[]> {
        const fallbackSnippets: ContextSnippet[] = [];
        try {
            console.log('Using fallback strategies to find context snippets');

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
                    allResults.forEach(embResult => {
                        const scoreDisplay = (embResult.score * 100).toFixed(1);
                        const fileHeader = `### File: \`${embResult.filePath}\` (Fallback Relevance: ${scoreDisplay}%)`;
                        const formattedContent = `${fileHeader}\n\`\`\`\n${embResult.content}\n\`\`\``;
                        fallbackSnippets.push({
                            id: `fallback-emb-${embResult.fileId}-${embResult.chunkId || this.quickHash(embResult.content)}`,
                            type: 'embedding',
                            content: formattedContent,
                            relevanceScore: embResult.score * 0.5, // Lower priority for fallback embeddings, scaled by original score
                            filePath: embResult.filePath,
                            startLine: embResult.startOffset
                        });
                    });
                    return fallbackSnippets;
                }
            }

            // Strategy 2: If still nothing, return a placeholder snippet
            fallbackSnippets.push({
                id: 'no-fallback-context',
                type: 'embedding',
                content: 'No directly relevant context could be found in the codebase via primary or fallback methods. Analysis will be based solely on the changes in the PR.',
                relevanceScore: 0 // Lowest priority for no-fallback placeholder
            });
            return fallbackSnippets;

        } catch (error) {
            console.error('Error getting fallback context snippets:', error);
            fallbackSnippets.push({
                id: 'error-fallback-context',
                type: 'embedding',
                content: 'Error retrieving fallback context: ' + (error instanceof Error ? error.message : String(error)),
                relevanceScore: 0 // Lowest priority for error in fallback
            });
            return fallbackSnippets;
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