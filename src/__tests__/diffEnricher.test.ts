import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import * as path from 'path';
import { DiffEnricher } from '../services/diffEnricher';
import type { SymbolExtractor } from '../utils/symbolExtractor';
import type { GitOperationsManager } from '../services/gitOperationsManager';
import type { DiffHunk } from '../types/contextTypes';
import { createMockCancellationTokenSource } from './testUtils/mockFactories';

function createMockDocumentSymbol(
    name: string,
    kind: number,
    startLine: number,
    endLine: number
): vscode.DocumentSymbol {
    const range = new vscode.Range(
        new vscode.Position(startLine, 0),
        new vscode.Position(endLine, 0)
    );
    return {
        name,
        kind,
        range,
        selectionRange: range,
        detail: '',
        children: [],
    } as unknown as vscode.DocumentSymbol;
}

function createTestDiffHunk(
    filePath: string,
    overrides: Partial<DiffHunk> = {}
): DiffHunk {
    return {
        filePath,
        hunks: [
            {
                oldStart: 1,
                oldLines: 10,
                newStart: 1,
                newLines: 15,
                parsedLines: [],
                hunkId: 'h1',
                hunkHeader: '',
            },
        ],
        isNewFile: false,
        isDeletedFile: false,
        originalHeader: '',
        ...overrides,
    };
}

describe('DiffEnricher', () => {
    let enricher: DiffEnricher;
    let mockSymbolExtractor: SymbolExtractor;
    let mockGitOps: GitOperationsManager;
    let token: vscode.CancellationToken;
    let executeCommandSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        mockSymbolExtractor = {
            getFileSymbols: vi.fn().mockResolvedValue([]),
            getDirectorySymbols: vi.fn(),
            dispose: vi.fn(),
        } as unknown as SymbolExtractor;

        mockGitOps = {
            getRepository: vi.fn().mockReturnValue({
                rootUri: vscode.Uri.file('/repo'),
            }),
        } as unknown as GitOperationsManager;

        token = createMockCancellationTokenSource().token;

        executeCommandSpy = vi.spyOn(vscode.commands, 'executeCommand');
        executeCommandSpy.mockImplementation(
            async (command: string, ..._args: any[]) => {
                if (command === 'vscode.executeHoverProvider') {
                    return [
                        { contents: [{ value: '(property) foo: string' }] },
                    ];
                }
                if (command === 'vscode.executeReferenceProvider') {
                    return [];
                }
                return undefined;
            }
        );

        enricher = new DiffEnricher(mockSymbolExtractor, mockGitOps);
    });

    it('returns empty brief for empty diff', async () => {
        const result = await enricher.enrich([], token);

        expect(result.enrichedSymbols).toHaveLength(0);
        expect(result.timeoutCount).toBe(0);
    });

    it('returns empty brief when no symbols overlap changed ranges', async () => {
        // Symbol at lines 50-60, but hunk changes lines 1-15
        vi.mocked(mockSymbolExtractor.getFileSymbols).mockResolvedValue([
            createMockDocumentSymbol(
                'farAwayFn',
                vscode.SymbolKind.Function,
                50,
                60
            ),
        ]);

        const diff = [createTestDiffHunk('src/foo.ts')];
        const result = await enricher.enrich(diff, token);

        expect(result.enrichedSymbols).toHaveLength(0);
    });

    it('returns enriched symbols for symbols in changed ranges', async () => {
        // Symbol at lines 5-10 overlaps hunk newStart=1, newLines=15 (lines 1-15)
        vi.mocked(mockSymbolExtractor.getFileSymbols).mockResolvedValue([
            createMockDocumentSymbol(
                'myFunction',
                vscode.SymbolKind.Function,
                5,
                10
            ),
        ]);

        const diff = [createTestDiffHunk('src/foo.ts')];
        const result = await enricher.enrich(diff, token);

        expect(result.enrichedSymbols).toHaveLength(1);
        expect(result.enrichedSymbols[0]!.name).toBe('myFunction');
        expect(result.enrichedSymbols[0]!.kind).toBe('function');
        expect(result.enrichedSymbols[0]!.file).toBe('src/foo.ts');
    });

    it('skips deleted files', async () => {
        const diff = [
            createTestDiffHunk('src/deleted.ts', { isDeletedFile: true }),
        ];
        const result = await enricher.enrich(diff, token);

        expect(result.enrichedSymbols).toHaveLength(0);
        expect(mockSymbolExtractor.getFileSymbols).not.toHaveBeenCalled();
    });

    it('returns empty brief when git repo not available', async () => {
        vi.mocked(mockGitOps.getRepository).mockReturnValue(undefined as any);

        const diff = [createTestDiffHunk('src/foo.ts')];
        const result = await enricher.enrich(diff, token);

        expect(result.enrichedSymbols).toHaveLength(0);
    });

    it('handles getFileSymbols error gracefully — continues', async () => {
        vi.mocked(mockSymbolExtractor.getFileSymbols)
            .mockRejectedValueOnce(new Error('timeout'))
            .mockResolvedValueOnce([
                createMockDocumentSymbol(
                    'goodFn',
                    vscode.SymbolKind.Function,
                    5,
                    10
                ),
            ]);

        const diff = [
            createTestDiffHunk('src/broken.ts'),
            createTestDiffHunk('src/good.ts'),
        ];
        const result = await enricher.enrich(diff, token);

        expect(result.enrichedSymbols).toHaveLength(1);
        expect(result.enrichedSymbols[0]!.name).toBe('goodFn');
    });

    it('caps at MAX_SYMBOLS (50) sorted by reference count', async () => {
        // Create 60 symbols with varying reference counts
        const symbols = Array.from({ length: 60 }, (_, i) =>
            createMockDocumentSymbol(
                `sym${i}`,
                vscode.SymbolKind.Function,
                i,
                i + 1
            )
        );
        vi.mocked(mockSymbolExtractor.getFileSymbols).mockResolvedValue(
            symbols
        );

        // Return varying reference counts per symbol
        let callIndex = 0;
        executeCommandSpy.mockImplementation(
            async (command: string, ..._args: any[]) => {
                if (command === 'vscode.executeHoverProvider') {
                    return [{ contents: [{ value: 'some type' }] }];
                }
                if (command === 'vscode.executeReferenceProvider') {
                    const count = callIndex++;
                    // Return `count` mock Location objects
                    return Array.from(
                        { length: count },
                        () =>
                            new vscode.Location(
                                vscode.Uri.file('/repo/other.ts'),
                                new vscode.Range(
                                    new vscode.Position(0, 0),
                                    new vscode.Position(0, 0)
                                )
                            )
                    );
                }
                return undefined;
            }
        );

        // hunk must cover all 60 symbol lines (0-60)
        const diff = [
            createTestDiffHunk('src/big.ts', {
                hunks: [
                    {
                        oldStart: 1,
                        oldLines: 60,
                        newStart: 1,
                        newLines: 65,
                        parsedLines: [],
                        hunkId: 'h1',
                        hunkHeader: '',
                    },
                ],
            }),
        ];
        const result = await enricher.enrich(diff, token);

        expect(result.enrichedSymbols.length).toBeLessThanOrEqual(50);

        // Verify sorted by totalReferences descending
        for (let i = 1; i < result.enrichedSymbols.length; i++) {
            expect(
                result.enrichedSymbols[i - 1]!.totalReferences
            ).toBeGreaterThanOrEqual(
                result.enrichedSymbols[i]!.totalReferences
            );
        }
    });

    it('sets timeoutCount when enrichment errors occur', async () => {
        // Create a symbol whose range getter throws during enrichSymbol
        // but also provide a normal symbol so we can verify partial results
        const throwingSymbol = createMockDocumentSymbol(
            'badFn',
            vscode.SymbolKind.Function,
            5,
            10
        );
        // Override range to throw during enrichSymbol phase
        // discoverChangedSymbols uses the original range, but enrichSymbol re-accesses it
        const originalRange = throwingSymbol.range;
        let accessCount = 0;
        Object.defineProperty(throwingSymbol, 'range', {
            get() {
                accessCount++;
                // First access is in symbolOverlapsChanges (allow it)
                // Second access is in enrichSymbol (throw)
                if (accessCount > 1) {
                    throw new Error('simulated enrichment failure');
                }
                return originalRange;
            },
            configurable: true,
        });

        vi.mocked(mockSymbolExtractor.getFileSymbols).mockResolvedValue([
            throwingSymbol,
        ]);

        const diff = [createTestDiffHunk('src/foo.ts')];
        const result = await enricher.enrich(diff, token);

        expect(result.timeoutCount).toBeGreaterThanOrEqual(1);
    });

    it('counts total, external, and test file references', async () => {
        vi.mocked(mockSymbolExtractor.getFileSymbols).mockResolvedValue([
            createMockDocumentSymbol(
                'myFunc',
                vscode.SymbolKind.Function,
                5,
                10
            ),
        ]);

        // Use path.join to match platform path separators (DiffEnricher uses path.join internally)
        const sameFilePath = path.join('/repo', 'src/foo.ts');
        const externalFilePath = path.join('/repo', 'src/bar.ts');
        const testFilePath = path.join('/repo', 'src/__tests__/foo.test.ts');

        executeCommandSpy.mockImplementation(
            async (command: string, ..._args: any[]) => {
                if (command === 'vscode.executeHoverProvider') {
                    return [
                        {
                            contents: [
                                { value: 'export function myFunc(): void' },
                            ],
                        },
                    ];
                }
                if (command === 'vscode.executeReferenceProvider') {
                    return [
                        // Same file ref
                        new vscode.Location(
                            vscode.Uri.file(sameFilePath),
                            new vscode.Range(
                                new vscode.Position(0, 0),
                                new vscode.Position(0, 5)
                            )
                        ),
                        // External ref
                        new vscode.Location(
                            vscode.Uri.file(externalFilePath),
                            new vscode.Range(
                                new vscode.Position(0, 0),
                                new vscode.Position(0, 5)
                            )
                        ),
                        // Test file ref
                        new vscode.Location(
                            vscode.Uri.file(testFilePath),
                            new vscode.Range(
                                new vscode.Position(0, 0),
                                new vscode.Position(0, 5)
                            )
                        ),
                    ];
                }
                return undefined;
            }
        );

        const diff = [createTestDiffHunk('src/foo.ts')];
        const result = await enricher.enrich(diff, token);

        expect(result.enrichedSymbols).toHaveLength(1);
        const sym = result.enrichedSymbols[0]!;
        expect(sym.totalReferences).toBe(3);
        expect(sym.externalCallers).toBe(2); // bar.ts + test file (different from source)
        expect(sym.testFileReferences).toBe(1);
        expect(sym.isExported).toBe(true);
    });
});
