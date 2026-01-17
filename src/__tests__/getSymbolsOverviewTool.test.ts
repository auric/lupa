import * as vscode from 'vscode';
import { describe, it, expect, vi, beforeEach, Mocked } from 'vitest';
import { GetSymbolsOverviewTool } from '../tools/getSymbolsOverviewTool';
import { GitOperationsManager } from '../services/gitOperationsManager';
import { SymbolExtractor } from '../utils/symbolExtractor';

// Mock vscode
vi.mock('vscode', async () => {
    const actualVscode = await vi.importActual('vscode');
    return {
        ...actualVscode,
        workspace: {
            fs: {
                stat: vi.fn(),
                readDirectory: vi.fn(),
                readFile: vi.fn(),
            },
        },
        commands: {
            executeCommand: vi.fn(),
        },
        Uri: {
            file: vi.fn((path) => ({
                toString: () => path,
                fsPath: path,
                path: path,
            })),
        },
        FileType: {
            File: 1,
            Directory: 2,
        },
        SymbolKind: {
            File: 1,
            Module: 2,
            Namespace: 3,
            Package: 4,
            Class: 5,
            Method: 6,
            Property: 7,
            Field: 8,
            Constructor: 9,
            Enum: 10,
            Interface: 11,
            Function: 12,
            Variable: 13,
            Constant: 14,
            String: 15,
            Number: 16,
            Boolean: 17,
            Array: 18,
            Object: 19,
            Key: 20,
            Null: 21,
            EnumMember: 22,
            Struct: 23,
            Event: 24,
            Operator: 25,
            TypeParameter: 26,
        },
    };
});

// Mock PathSanitizer
vi.mock('../utils/pathSanitizer', () => ({
    PathSanitizer: {
        sanitizePath: vi.fn((path) => path),
    },
}));

// Mock readGitignore
vi.mock('../utils/gitUtils', () => ({
    readGitignore: vi.fn().mockResolvedValue(''),
}));

// Mock ignore library
vi.mock('ignore', () => ({
    default: vi.fn(() => ({
        add: vi.fn().mockReturnThis(),
        checkIgnore: vi.fn().mockReturnValue({ ignored: false }),
    })),
}));

// Mock SymbolExtractor
vi.mock('../utils/symbolExtractor');

describe('GetSymbolsOverviewTool (Unit Tests)', () => {
    let getSymbolsOverviewTool: GetSymbolsOverviewTool;
    let mockGitOperationsManager: Mocked<GitOperationsManager>;
    let mockSymbolExtractor: Mocked<SymbolExtractor>;

    beforeEach(() => {
        mockGitOperationsManager = {
            getRepository: vi.fn().mockReturnValue({
                rootUri: { fsPath: '/test/repo' },
            }),
        } as any;

        // Mock SymbolExtractor with all required methods
        mockSymbolExtractor = {
            getGitRootPath: vi.fn().mockReturnValue('/test/repo'),
            getPathStat: vi.fn(),
            extractSymbolsWithContext: vi.fn(),
            getDirectorySymbols: vi.fn(),
            getTextDocument: vi.fn(),
        } as any;

        getSymbolsOverviewTool = new GetSymbolsOverviewTool(
            mockGitOperationsManager,
            mockSymbolExtractor
        );
        vi.clearAllMocks();
    });

    // Helper to create a DocumentSymbol with minimal required data
    function createSymbol(
        name: string,
        kind: vscode.SymbolKind,
        startLine: number
    ): vscode.DocumentSymbol {
        // Use plain object cast to satisfy typing without relying on VS Code runtime classes
        const position = (line: number, character: number) =>
            ({ line, character }) as any;
        const range = {
            start: position(startLine, 0),
            end: position(startLine + 1, 0),
        } as any;
        return {
            name,
            detail: '',
            kind,
            range,
            selectionRange: range,
            children: [],
        } as any;
    }

    describe('Tool Configuration', () => {
        it('should have correct name and description', () => {
            expect(getSymbolsOverviewTool.name).toBe('get_symbols_overview');
            expect(getSymbolsOverviewTool.description).toContain(
                'Get a configurable overview of symbols'
            );
        });

        it('should have valid schema with required path field', () => {
            const schema = getSymbolsOverviewTool.schema;

            // Test valid input
            const validInput = { path: 'src/test.ts' };
            expect(schema.safeParse(validInput).success).toBe(true);

            // Test empty path
            const emptyInput = { path: '' };
            expect(schema.safeParse(emptyInput).success).toBe(false);

            // Test missing path
            const missingInput = {};
            expect(schema.safeParse(missingInput).success).toBe(false);
        });

        it('should return VS Code tool configuration', () => {
            const vscodeTools = getSymbolsOverviewTool.getVSCodeTool();
            expect(vscodeTools.name).toBe('get_symbols_overview');
            expect(vscodeTools.description).toContain(
                'Get a configurable overview of symbols'
            );
            expect(vscodeTools.inputSchema).toBeDefined();
        });
    });

    describe('execute method', () => {
        it('should handle single file with symbols', async () => {
            // Mock SymbolExtractor methods
            mockSymbolExtractor.getPathStat.mockResolvedValue({
                type: vscode.FileType.File,
                ctime: 0,
                mtime: 0,
                size: 0,
            } as any);

            const mockDocument: any = {
                getText: vi.fn().mockReturnValue('test content'),
            };

            mockSymbolExtractor.extractSymbolsWithContext.mockResolvedValue({
                symbols: [
                    createSymbol('MyClass', vscode.SymbolKind.Class, 0),
                    createSymbol('myFunction', vscode.SymbolKind.Function, 12),
                ],
                document: mockDocument as any,
                relativePath: 'src/test.ts',
            });

            const result = await getSymbolsOverviewTool.execute({
                path: 'src/test.ts',
            });

            expect(result.success).toBe(true);
            expect(result.data).toEqual(
                '=== src/test.ts ===\n1: MyClass (class)\n13: myFunction (function)'
            );
        });

        it('should handle single file with no symbols', async () => {
            // Mock SymbolExtractor methods
            mockSymbolExtractor.getPathStat.mockResolvedValue({
                type: vscode.FileType.File,
                ctime: 0,
                mtime: 0,
                size: 0,
            } as any);

            const mockDocument: any = { getText: vi.fn().mockReturnValue('') };

            mockSymbolExtractor.extractSymbolsWithContext.mockResolvedValue({
                symbols: [],
                document: mockDocument as any,
                relativePath: 'src/empty.ts',
            });

            const result = await getSymbolsOverviewTool.execute({
                path: 'src/empty.ts',
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain('No symbols found');
        });

        it('should handle directory with multiple files', async () => {
            // Mock SymbolExtractor methods
            mockSymbolExtractor.getPathStat.mockResolvedValue({
                type: vscode.FileType.Directory,
                ctime: 0,
                mtime: 0,
                size: 0,
            } as any);

            mockSymbolExtractor.getDirectorySymbols.mockResolvedValue({
                results: [
                    {
                        filePath: 'src/test1.ts',
                        symbols: [
                            createSymbol('Class1', vscode.SymbolKind.Class, 0),
                        ],
                    },
                    {
                        filePath: 'src/test2.js',
                        symbols: [
                            createSymbol(
                                'function1',
                                vscode.SymbolKind.Function,
                                0
                            ),
                        ],
                    },
                ],
                truncated: false,
                timedOutFiles: 0,
            } as any);

            const result = await getSymbolsOverviewTool.execute({
                path: 'src',
            });

            expect(result.success).toBe(true);
            expect(result.data).toEqual(
                '=== src/test1.ts ===\n1: Class1 (class)\n\n=== src/test2.js ===\n1: function1 (function)'
            );
        });

        it('should handle directory with nested structure', async () => {
            // Mock SymbolExtractor methods
            mockSymbolExtractor.getPathStat.mockResolvedValue({
                type: vscode.FileType.Directory,
                ctime: 0,
                mtime: 0,
                size: 0,
            } as any);

            mockSymbolExtractor.getDirectorySymbols.mockResolvedValue({
                results: [
                    {
                        filePath: 'src/services/service1.ts',
                        symbols: [
                            createSymbol(
                                'ServiceClass',
                                vscode.SymbolKind.Class,
                                0
                            ),
                        ],
                    },
                ],
                truncated: false,
                timedOutFiles: 0,
            } as any);

            const result = await getSymbolsOverviewTool.execute({
                path: 'src',
            });

            expect(result.success).toBe(true);
            expect(result.data).toEqual(
                '=== src/services/service1.ts ===\n1: ServiceClass (class)'
            );
        });

        it('should handle SymbolInformation format', async () => {
            // Mock SymbolExtractor methods
            mockSymbolExtractor.getPathStat.mockResolvedValue({
                type: vscode.FileType.File,
                ctime: 0,
                mtime: 0,
                size: 0,
            } as any);

            const mockDocument: any = {
                getText: vi.fn().mockReturnValue('interface MyInterface {}'),
            };

            mockSymbolExtractor.extractSymbolsWithContext.mockResolvedValue({
                symbols: [
                    createSymbol('MyInterface', vscode.SymbolKind.Interface, 0),
                ],
                document: mockDocument as any,
                relativePath: 'src/interface.ts',
            });

            const result = await getSymbolsOverviewTool.execute({
                path: 'src/interface.ts',
            });

            expect(result.success).toBe(true);
            expect(result.data).toEqual(
                '=== src/interface.ts ===\n1: MyInterface (interface)'
            );
        });

        it('should propagate path not found error to ToolExecutor', async () => {
            // Path not found returns toolError (consistent with other tools)
            mockSymbolExtractor.getPathStat.mockResolvedValue(null);

            const result = await getSymbolsOverviewTool.execute({
                path: 'nonexistent/path',
            });

            expect(result.success).toBe(false);
            expect(result.error).toBe("Path 'nonexistent/path' not found");
        });

        it('should return toolError for git repository not found', async () => {
            // Git repository not found returns toolError (consistent with other tools)
            const mockGitOpsWithoutRepo = {
                getRepository: vi.fn().mockReturnValue(null),
            } as any;

            const mockSymbolExtractorWithoutRepo = {
                getGitRootPath: vi.fn().mockReturnValue(null),
                getPathStat: vi.fn(),
                extractSymbolsWithContext: vi.fn(),
                getDirectorySymbols: vi.fn(),
                getTextDocument: vi.fn(),
            } as any;

            const toolWithoutRepo = new GetSymbolsOverviewTool(
                mockGitOpsWithoutRepo,
                mockSymbolExtractorWithoutRepo
            );

            const result = await toolWithoutRepo.execute({
                path: 'src/test.ts',
            });

            expect(result.success).toBe(false);
            expect(result.error).toBe('Git repository not found');
        });

        it('should filter code files correctly', async () => {
            // Mock SymbolExtractor methods
            mockSymbolExtractor.getPathStat.mockResolvedValue({
                type: vscode.FileType.Directory,
                ctime: 0,
                mtime: 0,
                size: 0,
            } as any);

            // Mock directory symbols - SymbolExtractor should already filter code files
            mockSymbolExtractor.getDirectorySymbols.mockResolvedValue({
                results: [
                    {
                        filePath: 'src/component.ts',
                        symbols: [
                            createSymbol(
                                'Component',
                                vscode.SymbolKind.Class,
                                0
                            ),
                        ],
                    },
                    {
                        filePath: 'src/script.js',
                        symbols: [
                            createSymbol(
                                'script',
                                vscode.SymbolKind.Function,
                                0
                            ),
                        ],
                    },
                ],
                truncated: false,
                timedOutFiles: 0,
            } as any);

            const result = await getSymbolsOverviewTool.execute({
                path: 'src',
            });

            expect(result.success).toBe(true);
            expect(result.data).toEqual(
                '=== src/component.ts ===\n1: Component (class)\n\n=== src/script.js ===\n1: script (function)'
            );
        });
    });

    describe('timeout and truncation handling', () => {
        it('should surface truncation info when directory symbols have timedOutFiles', async () => {
            mockSymbolExtractor.getPathStat.mockResolvedValue({
                type: vscode.FileType.Directory,
                ctime: 0,
                mtime: 0,
                size: 0,
            } as any);

            mockSymbolExtractor.getDirectorySymbols.mockResolvedValue({
                results: [
                    {
                        filePath: 'src/test.ts',
                        symbols: [
                            createSymbol('MyClass', vscode.SymbolKind.Class, 0),
                        ],
                    },
                ],
                truncated: false,
                timedOutFiles: 3, // Simulate some files timing out
            } as any);

            const result = await getSymbolsOverviewTool.execute({
                path: 'src',
            });

            expect(result.success).toBe(true);
            // When timedOutFiles > 0, the truncated flag should be set,
            // which appends the output limit message
            expect(result.data).toContain('MyClass');
            expect(result.data).toContain('[Output limited to');
        });

        it('should append truncation message when max_symbols exceeded', async () => {
            mockSymbolExtractor.getPathStat.mockResolvedValue({
                type: vscode.FileType.File,
                ctime: 0,
                mtime: 0,
                size: 0,
            } as any);

            const mockDocument: any = {
                getText: vi.fn().mockReturnValue('test content'),
            };

            // Create many symbols to trigger truncation with low max_symbols
            const manySymbols = Array.from({ length: 10 }, (_, i) =>
                createSymbol(`Symbol${i}`, vscode.SymbolKind.Function, i)
            );

            mockSymbolExtractor.extractSymbolsWithContext.mockResolvedValue({
                symbols: manySymbols,
                document: mockDocument,
                relativePath: 'src/many.ts',
            });

            const result = await getSymbolsOverviewTool.execute({
                path: 'src/many.ts',
                max_symbols: 3, // Low limit to trigger truncation
            });

            expect(result.success).toBe(true);
            expect(result.data).toContain('[Output limited to 3 symbols');
        });

        it('should append truncation message when directory is truncated', async () => {
            mockSymbolExtractor.getPathStat.mockResolvedValue({
                type: vscode.FileType.Directory,
                ctime: 0,
                mtime: 0,
                size: 0,
            } as any);

            mockSymbolExtractor.getDirectorySymbols.mockResolvedValue({
                results: [
                    {
                        filePath: 'src/test.ts',
                        symbols: [
                            createSymbol('MyClass', vscode.SymbolKind.Class, 0),
                        ],
                    },
                ],
                truncated: true, // Directory was truncated due to file limit
                timedOutFiles: 0,
            } as any);

            const result = await getSymbolsOverviewTool.execute({
                path: 'src',
            });

            expect(result.success).toBe(true);
            expect(result.data).toContain('MyClass');
            expect(result.data).toContain('[Output limited to');
        });

        // Note: CancellationError/TimeoutError propagation is tested at the ToolExecutor level.
        // Tools don't explicitly handle these - they bubble up through withCancellableTimeout,
        // and ToolExecutor handles them centrally.
    });

    describe('symbol type mapping', () => {
        it('should map VS Code SymbolKind to human-readable names', async () => {
            // Mock SymbolExtractor methods
            mockSymbolExtractor.getPathStat.mockResolvedValue({
                type: vscode.FileType.File,
                ctime: 0,
                mtime: 0,
                size: 0,
            } as any);

            const mockDocument: any = {
                getText: vi.fn().mockReturnValue('test content'),
            };

            mockSymbolExtractor.extractSymbolsWithContext.mockResolvedValue({
                symbols: [
                    createSymbol('MyClass', vscode.SymbolKind.Class, 0),
                    createSymbol('MyInterface', vscode.SymbolKind.Interface, 6),
                    createSymbol('MyEnum', vscode.SymbolKind.Enum, 9),
                    createSymbol('myFunction', vscode.SymbolKind.Function, 13),
                    createSymbol('myVariable', vscode.SymbolKind.Variable, 16),
                    createSymbol('myConstant', vscode.SymbolKind.Constant, 17),
                ],
                document: mockDocument as any,
                relativePath: 'src/test.ts',
            });

            const result = await getSymbolsOverviewTool.execute({
                path: 'src/test.ts',
            });

            expect(result.success).toBe(true);
            expect(result.data).toEqual(
                '=== src/test.ts ===\n1: MyClass (class)\n7: MyInterface (interface)\n10: MyEnum (enum)\n14: myFunction (function)\n17: myVariable (variable)\n18: myConstant (constant)'
            );
        });
    });
});
