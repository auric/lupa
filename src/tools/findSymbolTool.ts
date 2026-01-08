import * as z from 'zod';
import * as path from 'path';
import * as vscode from 'vscode';
import { BaseTool } from './baseTool';
import { SymbolRangeExpander } from './symbolRangeExpander';
import { DefinitionFormatter } from './definitionFormatter';
import { GitOperationsManager } from '../services/gitOperationsManager';
import { PathSanitizer } from '../utils/pathSanitizer';
import { SymbolExtractor } from '../utils/symbolExtractor';
import { SymbolMatcher, type SymbolMatch } from '../utils/symbolMatcher';
import { SymbolFormatter } from '../utils/symbolFormatter';
import { OutputFormatter } from '../utils/outputFormatter';
import { readGitignore } from '../utils/gitUtils';
import {
    withCancellableTimeout,
    isTimeoutError,
    isCancellationError,
} from '../utils/asyncUtils';
import { Log } from '../services/loggingService';
import { ToolResult, toolSuccess, toolError } from '../types/toolResultTypes';
import { ExecutionContext } from '../types/executionContext';
import ignore from 'ignore';

// Timeout constants
const SYMBOL_SEARCH_TIMEOUT = 5000; // 5 seconds total
const FILE_PROCESSING_TIMEOUT = 500; // 500ms per file

// Symbol formatting functions now handled by SymbolFormatter utility

/**
 * Enhanced tool that finds symbols by name within the codebase with C++ class context support.
 * Uses VS Code's workspace and document symbol providers for efficient symbol discovery.
 * Now leverages utility classes for improved matching, formatting, and reduced code duplication.
 */
export class FindSymbolTool extends BaseTool {
    name = 'find_symbol';
    description = `Find code symbol definitions (functions, classes, methods, variables, etc.) with complete source code.

USE THIS when you see an unfamiliar function/class/variable in the diff.
ALWAYS set include_body: true when you need the implementation.
PREFER THIS over read_file for code—extracts complete definitions regardless of length.

Supports hierarchical paths: "MyClass/method" finds method inside MyClass.
Use relative_path to scope searches: "src/services" or "src/auth/login.ts".`;

    private readonly rangeExpander = new SymbolRangeExpander();
    private readonly formatter = new DefinitionFormatter();

    constructor(
        private readonly gitOperationsManager: GitOperationsManager,
        private readonly symbolExtractor: SymbolExtractor
    ) {
        super();
    }

    schema = z.object({
        name_path: z
            .string()
            .min(1, 'Name path cannot be empty')
            .describe(
                'Symbol identifier path (NOT full signature). Use only the name without parameters, return types, or templates. ' +
                    'Examples: "MyClass" (not "MyClass<T>"), "calculate" (not "calculate(int, string)"), "Shutdown" (not "Shutdown(const FString&)"). ' +
                    'Hierarchical paths: "MyClass/method" or "MyClass.method" finds method inside MyClass.'
            ),
        relative_path: z
            .string()
            .default('.')
            .optional()
            .describe(
                'Search scope: "." for entire workspace, or specific path like "src/components" or "src/file.ts"'
            ),
        include_body: z
            .boolean()
            .default(false)
            .optional()
            .describe(
                'Include symbol source code. Warning: significantly increases response size.'
            ),
        include_children: z
            .boolean()
            .default(false)
            .optional()
            .describe(
                'Include all child symbols of matched symbols. ' +
                    'Example: "MyClass" with include_children=true returns class + all its methods/properties.'
            ),
        include_kinds: z
            .array(z.string())
            .optional()
            .describe(
                'Include only these symbol types: "class", "function", "method", "variable", "constant", "interface", "enum", "property", "field", "constructor"'
            ),
        exclude_kinds: z
            .array(z.string())
            .optional()
            .describe(
                'Exclude these symbol types. Takes precedence over include_kinds.'
            ),
    });

    async execute(
        args: z.infer<typeof this.schema>,
        context?: ExecutionContext
    ): Promise<ToolResult> {
        const validationResult = this.schema.safeParse(args);
        if (!validationResult.success) {
            return toolError(
                validationResult.error.issues.map((e) => e.message).join(', ')
            );
        }

        try {
            const {
                name_path: namePath,
                relative_path: relativePath,
                include_body: includeBody,
                include_children: includeChildren,
                include_kinds: includeKindsStrings,
                exclude_kinds: excludeKindsStrings,
            } = validationResult.data;

            const includeKinds = includeKindsStrings
                ?.map((kind) => SymbolFormatter.convertKindStringToNumber(kind))
                .filter((k) => k !== undefined) as number[] | undefined;
            const excludeKinds = excludeKindsStrings
                ?.map((kind) => SymbolFormatter.convertKindStringToNumber(kind))
                .filter((k) => k !== undefined) as number[] | undefined;

            const pathSegments = this.parseNamePath(namePath);
            if (pathSegments.length === 0) {
                return toolError('Symbol name cannot be empty');
            }

            const token = context?.cancellationToken;
            let symbols: SymbolMatch[] = [];

            if (relativePath && relativePath !== '.') {
                // Path B: Specific path search with time-controlled processing
                symbols = await this.findSymbolsInPath(
                    pathSegments,
                    relativePath,
                    includeKinds,
                    excludeKinds,
                    token
                );
            } else {
                // Path A: Workspace search using VS Code's optimized indexing
                symbols = await this.findSymbolsInWorkspace(
                    pathSegments,
                    includeKinds,
                    excludeKinds,
                    token
                );
            }

            if (symbols.length === 0) {
                return toolError(`Symbol '${namePath}' not found`);
            }

            const formattedResults = await this.formatSymbolResults(
                symbols,
                includeBody ?? false,
                includeChildren ?? false,
                includeKinds,
                excludeKinds,
                token
            );

            return toolSuccess(formattedResults);
        } catch (error) {
            if (isCancellationError(error)) {
                throw error;
            }

            return toolError(
                error instanceof Error ? error.message : String(error)
            );
        }
    }

    /**
     * Parse hierarchical symbol path into segments.
     * Prefers "/" as separator when present; falls back to "." if no slashes found.
     * This preserves dots in symbol names (e.g., "MyClass/file.spec" → ["MyClass", "file.spec"]).
     */
    private parseNamePath(namePath: string): string[] {
        const cleaned = namePath.trim();
        if (!cleaned) {
            return [];
        }

        let segments: string[];
        if (cleaned.includes('/')) {
            segments = cleaned.split('/').filter((s) => s.length > 0);
        } else if (cleaned.includes('.')) {
            segments = cleaned.split('.').filter((s) => s.length > 0);
        } else {
            segments = [cleaned];
        }

        return segments;
    }

    /**
     * Get file path relative to git repository root (now using SymbolExtractor)
     */
    private getGitRelativePath(uri: vscode.Uri): string {
        return this.symbolExtractor.getGitRelativePathFromUri(uri);
    }

    /**
     * Filter workspace symbols by gitignore patterns
     * @param symbols - Workspace symbols to filter
     * @param ignorePatterns - Gitignore patterns
     * @returns Filtered symbols that should not be ignored
     */
    private filterSymbolsByGitignore(
        symbols: vscode.SymbolInformation[],
        ignorePatterns: ReturnType<typeof ignore>
    ): vscode.SymbolInformation[] {
        return symbols.filter((symbol) => {
            const gitRelativePath = this.getGitRelativePath(
                symbol.location.uri
            );

            if (ignore.isPathValid(gitRelativePath)) {
                try {
                    if (ignorePatterns.ignores(gitRelativePath)) {
                        Log.debug(
                            `[FindSymbolTool] Ignoring symbol ${symbol.name} in ${gitRelativePath} due to gitignore`
                        );
                        return false;
                    }
                } catch (error) {
                    Log.warn(
                        `Failed to check gitignore for path "${gitRelativePath}":`,
                        error
                    );
                }
            } else {
                Log.warn(
                    `Invalid path format for gitignore check: "${gitRelativePath}"`
                );
            }

            return true;
        });
    }

    /**
     * Find symbols in workspace using workspace symbol provider with gitignore filtering
     */
    private async findSymbolsInWorkspace(
        pathSegments: string[],
        includeKinds?: number[],
        excludeKinds?: number[],
        token?: vscode.CancellationToken
    ): Promise<SymbolMatch[]> {
        try {
            const targetSymbolName = pathSegments[pathSegments.length - 1];

            const repository = this.gitOperationsManager.getRepository();
            const gitignoreContent = await readGitignore(repository);
            const ig = ignore().add(gitignoreContent);

            if (gitignoreContent.trim()) {
                Log.debug(
                    `[FindSymbolTool] Loaded gitignore patterns:`,
                    gitignoreContent
                        .split('\n')
                        .filter((line) => line.trim() && !line.startsWith('#'))
                );
            }

            let workspaceSymbols: vscode.SymbolInformation[] = [];
            try {
                const symbolsPromise = Promise.resolve(
                    vscode.commands.executeCommand<vscode.SymbolInformation[]>(
                        'vscode.executeWorkspaceSymbolProvider',
                        targetSymbolName
                    )
                );
                workspaceSymbols =
                    (await withCancellableTimeout(
                        symbolsPromise,
                        SYMBOL_SEARCH_TIMEOUT,
                        'Workspace symbol search',
                        token
                    )) || [];
            } catch (error) {
                if (isCancellationError(error)) {
                    Log.debug('Workspace symbol search cancelled');
                    throw error; // Re-throw cancellation to stop tool execution
                }
                Log.warn('Workspace symbol search failed:', error);
                return [];
            }

            if (workspaceSymbols.length === 0) {
                return [];
            }

            const filteredSymbols = this.filterSymbolsByGitignore(
                workspaceSymbols,
                ig
            );
            Log.debug(
                `[FindSymbolTool] Filtered ${workspaceSymbols.length} symbols to ${filteredSymbols.length} after gitignore`
            );

            const matches: SymbolMatch[] = [];

            for (const symbol of filteredSymbols.slice(0, 50)) {
                if (excludeKinds?.includes(symbol.kind)) {
                    continue;
                }
                if (includeKinds && !includeKinds.includes(symbol.kind)) {
                    continue;
                }

                try {
                    const processSymbolPromise = this.processWorkspaceSymbol(
                        symbol,
                        pathSegments
                    );
                    const match = await withCancellableTimeout(
                        processSymbolPromise,
                        FILE_PROCESSING_TIMEOUT,
                        'Symbol processing',
                        token
                    );
                    if (match) {
                        matches.push(match);
                    }
                } catch (error) {
                    if (isCancellationError(error)) {
                        throw error;
                    }

                    // Log timeout errors specifically (indicates slow language server)
                    if (isTimeoutError(error)) {
                        Log.debug(
                            `Skipping symbol ${symbol.name} - processing timed out`
                        );
                    }
                    continue;
                }
            }

            return matches;
        } catch (error) {
            if (isCancellationError(error)) {
                throw error;
            }

            Log.warn('Workspace symbol search completely failed:', error);
            return [];
        }
    }

    /**
     * Process individual workspace symbol using direct containerName matching
     * No DocumentSymbol fetching needed - uses SymbolInformation properties directly
     */
    private async processWorkspaceSymbol(
        symbol: vscode.SymbolInformation,
        pathSegments: string[]
    ): Promise<SymbolMatch | null> {
        try {
            // Use direct containerName + name matching (no DocumentSymbol fetching!)
            if (!SymbolMatcher.matchesWorkspaceSymbol(symbol, pathSegments)) {
                return null;
            }

            const cleanSymbolName = SymbolMatcher.cleanSymbolName(symbol.name);
            let namePath: string;

            if (symbol.containerName) {
                const containerParts = SymbolMatcher.parseContainerName(
                    symbol.containerName
                );
                namePath = [...containerParts, cleanSymbolName].join('/');
            } else {
                namePath = cleanSymbolName;
            }

            let document: vscode.TextDocument | undefined;
            try {
                document = await vscode.workspace.openTextDocument(
                    symbol.location.uri
                );
            } catch (error) {
                Log.debug(
                    `Failed to open document for symbol ${symbol.name}:`,
                    error
                );
            }

            return {
                symbol,
                document,
                namePath,
                filePath: this.getGitRelativePath(symbol.location.uri),
            };
        } catch (error) {
            Log.debug(
                `Error processing workspace symbol ${symbol.name}:`,
                error
            );
            return null;
        }
    }

    /**
     * Find symbols in a specific file or directory path (Path B - time-controlled)
     */
    private async findSymbolsInPath(
        pathSegments: string[],
        relativePath: string,
        includeKinds?: number[],
        excludeKinds?: number[],
        token?: vscode.CancellationToken
    ): Promise<SymbolMatch[]> {
        const gitRootDirectory = this.symbolExtractor.getGitRootPath();
        if (!gitRootDirectory) {
            return [];
        }

        if (pathSegments.length === 0) {
            Log.warn(`Empty pathSegments array provided for findSymbolsInPath`);
            return [];
        }

        const sanitizedPath = PathSanitizer.sanitizePath(relativePath);
        const targetPath = path.join(gitRootDirectory, sanitizedPath);
        const symbolName = pathSegments[pathSegments.length - 1]!;
        const startTime = Date.now();

        try {
            const stat = await this.symbolExtractor.getPathStat(targetPath);
            if (!stat) {
                return [];
            }

            if (stat.type === vscode.FileType.File) {
                // Single file - check with text pre-filtering
                const fileUri = vscode.Uri.file(targetPath);
                return await this.findSymbolsInFileWithPreFilter(
                    fileUri,
                    pathSegments,
                    symbolName,
                    includeKinds,
                    excludeKinds,
                    token
                );
            } else if (stat.type === vscode.FileType.Directory) {
                // Directory - search with time control using SymbolExtractor
                const {
                    results: directoryResults,
                    truncated: dirTruncated,
                    timedOutFiles,
                } = await this.symbolExtractor.getDirectorySymbols(
                    targetPath,
                    sanitizedPath,
                    { timeoutMs: SYMBOL_SEARCH_TIMEOUT, token }
                );
                const allMatches: SymbolMatch[] = [];

                if (dirTruncated || timedOutFiles > 0) {
                    Log.debug(
                        `Symbol search in ${relativePath} was truncated: ` +
                            `dirTruncated=${dirTruncated}, timedOutFiles=${timedOutFiles}`
                    );
                }

                for (const { filePath, symbols } of directoryResults) {
                    // Time-based execution control (secondary safety check)
                    if (Date.now() - startTime > SYMBOL_SEARCH_TIMEOUT) {
                        Log.warn(
                            `Symbol search in ${relativePath} stopped after ${SYMBOL_SEARCH_TIMEOUT}ms timeout`
                        );
                        break;
                    }

                    // Process symbols using enhanced matching with C++ support
                    const fullFilePath = path.join(gitRootDirectory, filePath);
                    const fileUri = vscode.Uri.file(fullFilePath);
                    const document =
                        await this.symbolExtractor.getTextDocument(fileUri);

                    const firstSymbol = symbols[0];
                    if (
                        symbols.length > 0 &&
                        firstSymbol &&
                        this.isDocumentSymbol(firstSymbol)
                    ) {
                        // Use simple recursive document symbol search
                        const documentMatches =
                            this.findInDocumentSymbolsRecursive(
                                symbols as vscode.DocumentSymbol[],
                                pathSegments,
                                []
                            );

                        for (const match of documentMatches) {
                            if (excludeKinds?.includes(match.symbol.kind)) {
                                continue;
                            }
                            if (
                                includeKinds &&
                                !includeKinds.includes(match.symbol.kind)
                            ) {
                                continue;
                            }

                            allMatches.push({
                                symbol: match.symbol,
                                document,
                                namePath: match.namePath,
                                filePath,
                            });
                        }
                    }
                }

                return allMatches;
            }
        } catch (error) {
            if (isCancellationError(error)) {
                throw error;
            }
            // Log error for debugging (could be file access, timeout, or LSP issue)
            if (isTimeoutError(error)) {
                Log.debug(
                    `Symbol search in ${relativePath} timed out - returning empty results`
                );
            } else {
                Log.debug(`Symbol search in ${relativePath} failed:`, error);
            }
            return [];
        }

        return [];
    }

    /**
     * Find symbols within a single file with text pre-filtering
     */
    private async findSymbolsInFileWithPreFilter(
        fileUri: vscode.Uri,
        pathSegments: string[],
        symbolName: string,
        includeKinds?: number[],
        excludeKinds?: number[],
        token?: vscode.CancellationToken
    ): Promise<SymbolMatch[]> {
        try {
            // Quick text pre-check before expensive symbol analysis
            const fileContent = await vscode.workspace.fs.readFile(fileUri);
            const text = fileContent.toString();

            if (!text.includes(symbolName)) {
                return []; // Skip files that don't contain the symbol name
            }

            const document = await vscode.workspace.openTextDocument(fileUri);
            const documentSymbols = await withCancellableTimeout(
                Promise.resolve(
                    vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                        'vscode.executeDocumentSymbolProvider',
                        fileUri
                    )
                ),
                FILE_PROCESSING_TIMEOUT,
                `Document symbols for ${fileUri.fsPath}`,
                token
            );

            if (!documentSymbols || documentSymbols.length === 0) {
                return [];
            }

            // Use simple recursive document symbol search
            const documentMatches = this.findInDocumentSymbolsRecursive(
                documentSymbols,
                pathSegments,
                []
            );

            const matches: SymbolMatch[] = [];
            const filePath = this.getGitRelativePath(fileUri);

            // Apply kind filtering and convert to SymbolMatch format
            for (const match of documentMatches) {
                // Apply kind filtering
                if (excludeKinds?.includes(match.symbol.kind)) {
                    continue;
                }
                if (includeKinds && !includeKinds.includes(match.symbol.kind)) {
                    continue;
                }

                matches.push({
                    symbol: match.symbol,
                    document,
                    namePath: match.namePath,
                    filePath,
                });
            }

            return matches;
        } catch (error) {
            if (isCancellationError(error)) {
                throw error;
            }
            // Log issues finding symbols in file (could be file access, parsing, or LSP error)
            Log.debug(
                `Failed to find symbols in ${fileUri.fsPath}:`,
                error instanceof Error ? error.message : String(error)
            );
            return [];
        }
    }

    /**
     * Simple recursive function to find matching symbols with path building
     * @param symbols - DocumentSymbols to search
     * @param pathSegments - Target path segments
     * @param currentPath - Current path being built
     * @returns Array of matching symbols with their paths
     */
    private findInDocumentSymbolsRecursive(
        symbols: vscode.DocumentSymbol[],
        pathSegments: string[],
        currentPath: string[]
    ): { symbol: vscode.DocumentSymbol; namePath: string }[] {
        const matches: { symbol: vscode.DocumentSymbol; namePath: string }[] =
            [];

        for (const symbol of symbols) {
            // Build path using detail property for container context (C++ implementations)
            const cleanName = SymbolMatcher.cleanSymbolName(symbol.name);

            // Use detail as container name only at top level (not during recursion)
            // This handles C++ implementations where detail contains class name,
            // but excludes generic descriptors like "declaration" from header files
            const isUsefulDetail =
                currentPath.length === 0 &&
                symbol.detail &&
                symbol.detail !== 'declaration';

            const fullPath = isUsefulDetail
                ? [...currentPath, symbol.detail, cleanName]
                : [...currentPath, cleanName];

            // Simple array comparison for path matching
            if (this.pathMatchesPattern(fullPath, pathSegments)) {
                matches.push({
                    symbol,
                    namePath: fullPath.join('/'),
                });
            }

            // Recursively search children
            if (symbol.children && symbol.children.length > 0) {
                const childMatches = this.findInDocumentSymbolsRecursive(
                    symbol.children,
                    pathSegments,
                    fullPath
                );
                matches.push(...childMatches);
            }
        }

        return matches;
    }

    /**
     * Check if a built path matches the target pattern
     * @param fullPath - Complete path built during traversal
     * @param pathSegments - Target path segments to match
     * @returns True if the path matches the pattern
     */
    private pathMatchesPattern(
        fullPath: string[],
        pathSegments: string[]
    ): boolean {
        if (pathSegments.length === 0) {
            return false;
        }

        if (pathSegments.length === 1) {
            const targetName = pathSegments[0]!;
            const lastName = fullPath[fullPath.length - 1] ?? '';
            return SymbolMatcher.isExactSymbolMatch(lastName, targetName);
        }

        return SymbolMatcher.arrayContainsSequence(fullPath, pathSegments);
    }

    /**
     * Format symbol results for output as plain string (consistent with read_file format)
     */
    private async formatSymbolResults(
        symbols: SymbolMatch[],
        includeBody: boolean,
        includeChildren: boolean,
        includeKinds: number[] | undefined,
        excludeKinds: number[] | undefined,
        token?: vscode.CancellationToken
    ): Promise<string> {
        const formattedBlocks: string[] = [];

        for (const match of symbols) {
            const symbolKind = SymbolFormatter.getSymbolKindName(
                match.symbol.kind
            );

            let bodyLines: string[] | undefined;
            let startLine = 1;
            if (includeBody && match.document) {
                try {
                    const symbolRange = this.getSymbolRange(match.symbol);
                    let finalRange: vscode.Range;

                    if (this.isSymbolInformation(match.symbol)) {
                        finalRange =
                            await this.rangeExpander.getFullSymbolRange(
                                match.document,
                                symbolRange,
                                token
                            );
                    } else {
                        finalRange = symbolRange;
                    }

                    const rawBody = match.document.getText(finalRange);
                    bodyLines = rawBody.split('\n');
                    startLine = finalRange.start.line + 1;
                } catch (error) {
                    Log.debug(
                        `Failed to extract body for symbol ${match.symbol.name}:`,
                        error
                    );
                }
            }

            const block = OutputFormatter.formatSymbolContent({
                filePath: match.filePath,
                symbolName: match.symbol.name,
                symbolKind,
                namePath: match.namePath,
                bodyLines,
                startLine,
            });
            formattedBlocks.push(block);

            if (includeChildren && match.document) {
                let childrenToProcess: vscode.DocumentSymbol[] = [];

                if (
                    this.isDocumentSymbol(match.symbol) &&
                    match.symbol.children
                ) {
                    childrenToProcess = match.symbol.children;
                } else if (this.isSymbolInformation(match.symbol)) {
                    const symbolRange = this.getSymbolRange(match.symbol);
                    const documentSymbol =
                        await this.fetchDocumentSymbolForRange(
                            match.document,
                            symbolRange
                        );
                    if (documentSymbol && documentSymbol.children) {
                        childrenToProcess = documentSymbol.children;
                    }
                }

                if (childrenToProcess.length > 0) {
                    const childSymbols = this.collectChildrenSymbols(
                        childrenToProcess,
                        match.namePath,
                        match.document,
                        match.filePath,
                        includeKinds,
                        excludeKinds
                    );

                    for (const childSymbol of childSymbols) {
                        const childKind = SymbolFormatter.getSymbolKindName(
                            childSymbol.symbol.kind
                        );

                        let childBodyLines: string[] | undefined;
                        let childStartLine = 1;
                        if (includeBody) {
                            try {
                                const childSymbolRange = this.getSymbolRange(
                                    childSymbol.symbol
                                );
                                const rawChildBody =
                                    match.document.getText(childSymbolRange);
                                childBodyLines = rawChildBody.split('\n');
                                childStartLine =
                                    childSymbolRange.start.line + 1;
                            } catch (error) {
                                Log.debug(
                                    `Failed to extract body for child symbol ${childSymbol.symbol.name}:`,
                                    error
                                );
                            }
                        }

                        const childBlock = OutputFormatter.formatSymbolContent({
                            filePath: childSymbol.filePath,
                            symbolName: childSymbol.symbol.name,
                            symbolKind: childKind,
                            namePath: childSymbol.namePath,
                            bodyLines: childBodyLines,
                            startLine: childStartLine,
                        });
                        formattedBlocks.push(childBlock);
                    }
                }
            }
        }

        return formattedBlocks.join('\n\n');
    }

    /**
     * Recursively collect all child symbols with filtering
     */
    private collectChildrenSymbols(
        children: vscode.DocumentSymbol[],
        parentPath: string,
        document: vscode.TextDocument,
        filePath: string,
        includeKinds: number[] | undefined,
        excludeKinds: number[] | undefined
    ): SymbolMatch[] {
        const childSymbols: SymbolMatch[] = [];

        for (const child of children) {
            if (excludeKinds?.includes(child.kind)) {
                continue;
            }
            if (includeKinds && !includeKinds.includes(child.kind)) {
                continue;
            }

            // Use clean name for path building
            const cleanChildName = SymbolMatcher.cleanSymbolName(child.name);
            const childPath = `${parentPath}/${cleanChildName}`;

            childSymbols.push({
                symbol: child,
                document,
                namePath: childPath,
                filePath,
            });

            if (child.children && child.children.length > 0) {
                const grandChildren = this.collectChildrenSymbols(
                    child.children,
                    childPath,
                    document,
                    filePath,
                    includeKinds,
                    excludeKinds
                );
                childSymbols.push(...grandChildren);
            }
        }

        return childSymbols;
    }

    /**
     * Format body text with line numbers in the format 'lineNumber: codeLine'
     */
    private formatBodyWithLineNumbers(
        body: string,
        startLineNumber: number
    ): string {
        const lines = body.split('\n');
        const formattedLines = lines.map((line, index) => {
            const lineNumber = startLineNumber + index;
            return `${lineNumber}: ${line}`;
        });

        return formattedLines.join('\n');
    }

    /**
     * Type guard to check if a symbol is a DocumentSymbol
     */
    private isDocumentSymbol(
        symbol: vscode.DocumentSymbol | vscode.SymbolInformation
    ): symbol is vscode.DocumentSymbol {
        return 'range' in symbol && 'children' in symbol;
    }

    /**
     * Type guard to check if a symbol is a SymbolInformation
     */
    private isSymbolInformation(
        symbol: vscode.DocumentSymbol | vscode.SymbolInformation
    ): symbol is vscode.SymbolInformation {
        return 'location' in symbol;
    }

    /**
     * Get the range from either DocumentSymbol or SymbolInformation
     */
    private getSymbolRange(
        symbol: vscode.DocumentSymbol | vscode.SymbolInformation
    ): vscode.Range {
        if (this.isDocumentSymbol(symbol)) {
            return symbol.range;
        } else {
            return symbol.location.range;
        }
    }

    /**
     * Fetch DocumentSymbol for a given range from document symbols
     * Used when we need to get body or children from a SymbolInformation
     */
    private async fetchDocumentSymbolForRange(
        document: vscode.TextDocument,
        targetRange: vscode.Range
    ): Promise<vscode.DocumentSymbol | undefined> {
        try {
            const documentSymbols = await vscode.commands.executeCommand<
                vscode.DocumentSymbol[]
            >('vscode.executeDocumentSymbolProvider', document.uri);

            if (!documentSymbols || documentSymbols.length === 0) {
                return undefined;
            }

            return this.findMatchingDocumentSymbol(
                documentSymbols,
                targetRange
            );
        } catch (error) {
            Log.debug(`Failed to fetch document symbols for range:`, error);
            return undefined;
        }
    }

    /**
     * Find DocumentSymbol that matches the target range
     * Searches recursively through the document symbol tree
     * Prioritizes the most specific (smallest) symbol that contains the target
     */
    private findMatchingDocumentSymbol(
        documentSymbols: vscode.DocumentSymbol[],
        targetRange: vscode.Range
    ): vscode.DocumentSymbol | undefined {
        let bestMatch: vscode.DocumentSymbol | undefined;
        let bestMatchSize = Number.MAX_VALUE;

        for (const symbol of documentSymbols) {
            // Check if this symbol contains the target range
            const symbolContainsTarget =
                symbol.range.contains(targetRange) ||
                this.rangesOverlap(symbol.selectionRange, targetRange);

            if (symbolContainsTarget) {
                // Calculate symbol size (smaller is more specific)
                const symbolSize =
                    (symbol.range.end.line - symbol.range.start.line) * 1000 +
                    (symbol.range.end.character - symbol.range.start.character);

                // Check children first for more specific matches
                if (symbol.children && symbol.children.length > 0) {
                    const childMatch = this.findMatchingDocumentSymbol(
                        symbol.children,
                        targetRange
                    );
                    if (childMatch) {
                        return childMatch; // Child match is always more specific than parent
                    }
                }

                // This symbol matches and no child was more specific
                if (symbolSize < bestMatchSize) {
                    bestMatch = symbol;
                    bestMatchSize = symbolSize;
                }
            }
        }

        return bestMatch;
    }

    /**
     * Check if two ranges overlap (used for finding matching DocumentSymbol)
     */
    private rangesOverlap(range1: vscode.Range, range2: vscode.Range): boolean {
        // Check if ranges overlap by comparing positions
        return !(
            range1.end.isBefore(range2.start) ||
            range2.end.isBefore(range1.start)
        );
    }
}
