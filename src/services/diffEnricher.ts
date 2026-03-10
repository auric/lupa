import * as vscode from 'vscode';
import * as path from 'path';
import type { DiffHunk, DiffHunkLine } from '../types/contextTypes';
import type {
    CodeIntelligenceBrief,
    EnrichedSymbol,
} from '../types/enrichedDiffTypes';
import type { SymbolExtractor } from '../utils/symbolExtractor';
import { SymbolFormatter } from '../utils/symbolFormatter';
import type { GitOperationsManager } from './gitOperationsManager';
import {
    withCancellableTimeout,
    isCancellationError,
} from '../utils/asyncUtils';
import { getErrorMessage } from '../utils/errorUtils';
import { extractHoverText } from '../utils/hoverTextExtractor';
import { Log } from './loggingService';

const ENRICHMENT_TIMEOUT = 15_000;
const PER_SYMBOL_TIMEOUT = 2_000;
const CONCURRENCY_LIMIT = 5;
const MAX_SYMBOLS = 50;

/** File extensions where LSP symbol enrichment (hover, references) is not useful. */
const NON_CODE_EXTENSIONS = new Set([
    '.md',
    '.markdown',
    '.txt',
    '.rst',
    '.json',
    '.jsonc',
    '.json5',
    '.yaml',
    '.yml',
    '.toml',
    '.ini',
    '.cfg',
    '.lock',
    '.csv',
    '.tsv',
    '.svg',
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.ico',
    '.webp',
    '.woff',
    '.woff2',
    '.ttf',
    '.eot',
    '.log',
]);

interface SymbolCandidate {
    symbol: vscode.DocumentSymbol | vscode.SymbolInformation;
    fileUri: vscode.Uri;
    filePath: string;
}

export class DiffEnricher implements vscode.Disposable {
    constructor(
        private readonly symbolExtractor: SymbolExtractor,
        private readonly gitOps: GitOperationsManager
    ) {}

    async enrich(
        parsedDiff: DiffHunk[],
        token: vscode.CancellationToken
    ): Promise<CodeIntelligenceBrief> {
        const startTime = Date.now();
        let timeoutCount = 0;

        try {
            const candidates = await this.discoverChangedSymbols(
                parsedDiff,
                token
            );
            Log.info(
                `DiffEnricher: found ${candidates.length} candidate symbols in ${parsedDiff.length} files`
            );

            if (candidates.length === 0) {
                return {
                    enrichedSymbols: [],
                    generatedAt: Date.now(),
                    timeoutCount: 0,
                };
            }

            const enriched: (EnrichedSymbol | undefined)[] = Array.from<
                EnrichedSymbol | undefined
            >({ length: candidates.length });
            await this.withConcurrency(
                candidates,
                CONCURRENCY_LIMIT,
                async (candidate, index) => {
                    if (token.isCancellationRequested) {
                        throw new vscode.CancellationError();
                    }
                    if (Date.now() - startTime > ENRICHMENT_TIMEOUT) {
                        timeoutCount++;
                        return;
                    }
                    try {
                        enriched[index] = await this.enrichSymbol(
                            candidate,
                            token
                        );
                    } catch (error) {
                        if (isCancellationError(error)) {
                            throw error;
                        }
                        timeoutCount++;
                    }
                }
            );

            const symbols = enriched
                .filter((s): s is EnrichedSymbol => s !== undefined)
                .sort((a, b) => b.totalReferences - a.totalReferences)
                .slice(0, MAX_SYMBOLS);

            Log.info(
                `DiffEnricher: enriched ${symbols.length} symbols (${timeoutCount} timeouts) in ${Date.now() - startTime}ms`
            );

            return {
                enrichedSymbols: symbols,
                generatedAt: Date.now(),
                timeoutCount,
            };
        } catch (error) {
            if (isCancellationError(error)) {
                throw error;
            }
            Log.warn(`DiffEnricher failed: ${getErrorMessage(error)}`);
            return {
                enrichedSymbols: [],
                generatedAt: Date.now(),
                timeoutCount,
            };
        }
    }

    private async discoverChangedSymbols(
        parsedDiff: DiffHunk[],
        token: vscode.CancellationToken
    ): Promise<SymbolCandidate[]> {
        const repo = this.gitOps.getRepository();
        if (!repo) {
            return [];
        }
        const rootPath = repo.rootUri.fsPath;
        const candidates: SymbolCandidate[] = [];

        for (const file of parsedDiff) {
            if (file.isDeletedFile) {
                continue;
            }
            const ext = path.extname(file.filePath).toLowerCase();
            if (NON_CODE_EXTENSIONS.has(ext)) {
                continue;
            }
            if (token.isCancellationRequested) {
                throw new vscode.CancellationError();
            }

            const fileUri = vscode.Uri.file(path.join(rootPath, file.filePath));
            try {
                const symbols = await this.symbolExtractor.getFileSymbols(
                    fileUri,
                    token
                );
                const flat = this.flattenSymbols(symbols);
                const changedRanges = this.getChangedLineRanges(file.hunks);

                for (const sym of flat) {
                    if (this.symbolOverlapsChanges(sym, changedRanges)) {
                        candidates.push({
                            symbol: sym,
                            fileUri,
                            filePath: file.filePath,
                        });
                    }
                }
            } catch (error) {
                if (isCancellationError(error)) {
                    throw error;
                }
                Log.debug(
                    `DiffEnricher: skipping ${file.filePath}: ${getErrorMessage(error)}`
                );
            }
        }

        return candidates;
    }

    private async enrichSymbol(
        candidate: SymbolCandidate,
        token: vscode.CancellationToken
    ): Promise<EnrichedSymbol | undefined> {
        const { symbol, fileUri, filePath } = candidate;

        const range =
            'range' in symbol && !('location' in symbol)
                ? (symbol as vscode.DocumentSymbol).range
                : 'location' in symbol
                  ? (symbol as vscode.SymbolInformation).location.range
                  : undefined;
        if (!range) {
            return undefined;
        }

        const position = range.start;
        const name = symbol.name;
        const kind = SymbolFormatter.getSymbolKindName(symbol.kind);

        let typeSignature: string | undefined;
        let isExported = false;
        let totalReferences = 0;
        let externalCallers = 0;
        let testFileReferences = 0;

        try {
            const hovers = await withCancellableTimeout(
                Promise.resolve(
                    vscode.commands.executeCommand<vscode.Hover[]>(
                        'vscode.executeHoverProvider',
                        fileUri,
                        position
                    )
                ),
                PER_SYMBOL_TIMEOUT,
                `Hover for ${name}`,
                token
            );
            if (hovers && hovers.length > 0) {
                const text = this.extractHoverText(hovers);
                typeSignature = text.split('\n')[0]?.substring(0, 200);
                isExported = text.includes('export');
            }
        } catch (error) {
            if (isCancellationError(error)) {
                throw error;
            }
        }

        try {
            const refs = await withCancellableTimeout(
                Promise.resolve(
                    vscode.commands.executeCommand<vscode.Location[]>(
                        'vscode.executeReferenceProvider',
                        fileUri,
                        position,
                        { includeDeclaration: false }
                    )
                ),
                PER_SYMBOL_TIMEOUT,
                `References for ${name}`,
                token
            );
            if (refs) {
                totalReferences = refs.length;
                for (const ref of refs) {
                    const refPath = ref.uri.fsPath;
                    if (refPath !== fileUri.fsPath) {
                        externalCallers++;
                    }
                    if (this.isTestFile(refPath)) {
                        testFileReferences++;
                    }
                }
            }
        } catch (error) {
            if (isCancellationError(error)) {
                throw error;
            }
        }

        return {
            name,
            file: filePath,
            line: range.start.line + 1,
            kind,
            typeSignature,
            totalReferences,
            externalCallers,
            testFileReferences,
            isExported,
        };
    }

    private getChangedLineRanges(
        hunks: DiffHunkLine[]
    ): Array<{ start: number; end: number }> {
        return hunks.map((hunk) => ({
            start: hunk.newStart,
            end: hunk.newStart + hunk.newLines - 1,
        }));
    }

    private symbolOverlapsChanges(
        symbol: vscode.DocumentSymbol | vscode.SymbolInformation,
        changedRanges: Array<{ start: number; end: number }>
    ): boolean {
        const range =
            'range' in symbol && !('location' in symbol)
                ? (symbol as vscode.DocumentSymbol).range
                : 'location' in symbol
                  ? (symbol as vscode.SymbolInformation).location.range
                  : undefined;
        if (!range) {
            return false;
        }

        const symStart = range.start.line + 1;
        const symEnd = range.end.line + 1;

        return changedRanges.some(
            (cr) => symStart <= cr.end && symEnd >= cr.start
        );
    }

    private flattenSymbols(
        symbols: (vscode.DocumentSymbol | vscode.SymbolInformation)[]
    ): (vscode.DocumentSymbol | vscode.SymbolInformation)[] {
        const result: (vscode.DocumentSymbol | vscode.SymbolInformation)[] = [];
        for (const sym of symbols) {
            result.push(sym);
            if ('children' in sym && sym.children) {
                result.push(...this.flattenSymbols(sym.children));
            }
        }
        return result;
    }

    private extractHoverText(hovers: vscode.Hover[]): string {
        return extractHoverText(hovers);
    }

    private isTestFile(filePath: string): boolean {
        const normalized = filePath.toLowerCase().replace(/\\/g, '/');
        const segments = normalized.split('/');
        const fileName = segments[segments.length - 1] ?? '';

        // Directory-based: common test directories across languages
        const testDirs = new Set([
            'test',
            'tests',
            'testing',
            '__tests__',
            '__test__',
            'spec',
            'specs',
        ]);
        if (segments.some((s) => testDirs.has(s))) {
            return true;
        }

        // File name patterns across languages:
        // Go: _test.go, JS/TS: *.test.* / *.spec.*, Python: test_* / *_test.py,
        // Java/C#: *Test.java / *Tests.cs, Ruby: *_spec.rb / *_test.rb
        return (
            /[._-](test|spec|tests)s?\b/.test(fileName) ||
            fileName.startsWith('test_')
        );
    }

    private async withConcurrency<T>(
        items: T[],
        limit: number,
        fn: (item: T, index: number) => Promise<void>
    ): Promise<void> {
        let index = 0;
        async function worker() {
            while (index < items.length) {
                const current = index++;
                await fn(items[current]!, current);
            }
        }
        await Promise.all(
            Array.from({ length: Math.min(limit, items.length) }, () =>
                worker()
            )
        );
    }

    dispose(): void {
        // No state to clean up
    }
}
