import * as vscode from 'vscode';
import { describe, it, expect, vi, beforeEach } from 'vitest';
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
                readFile: vi.fn()
            }
        },
        commands: {
            executeCommand: vi.fn()
        },
        Uri: {
            file: vi.fn((path) => ({
                toString: () => path,
                fsPath: path,
                path: path
            }))
        },
        FileType: {
            File: 1,
            Directory: 2
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
            TypeParameter: 26
        }
    };
});

// Mock PathSanitizer
vi.mock('../utils/pathSanitizer', () => ({
    PathSanitizer: {
        sanitizePath: vi.fn((path) => path)
    }
}));

// Mock readGitignore
vi.mock('../utils/gitUtils', () => ({
    readGitignore: vi.fn().mockResolvedValue('')
}));

// Mock ignore library
vi.mock('ignore', () => ({
    default: vi.fn(() => ({
        add: vi.fn().mockReturnThis(),
        checkIgnore: vi.fn().mockReturnValue({ ignored: false })
    }))
}));

// Mock SymbolExtractor
vi.mock('../utils/symbolExtractor');

describe('GetSymbolsOverviewTool (Unit Tests)', () => {
    let getSymbolsOverviewTool: GetSymbolsOverviewTool;
    let mockGitOperationsManager: GitOperationsManager;
    let mockSymbolExtractor: SymbolExtractor;

    beforeEach(() => {
        mockGitOperationsManager = {
            getRepository: vi.fn().mockReturnValue({
                rootUri: { fsPath: '/test/repo' }
            })
        } as any;

        // Mock SymbolExtractor with all required methods
        mockSymbolExtractor = {
            getGitRootPath: vi.fn().mockReturnValue('/test/repo'),
            getPathStat: vi.fn(),
            extractSymbolsWithContext: vi.fn(),
            getDirectorySymbols: vi.fn(),
            getTextDocument: vi.fn()
        } as any;

        getSymbolsOverviewTool = new GetSymbolsOverviewTool(mockGitOperationsManager, mockSymbolExtractor);
        vi.clearAllMocks();
    });

    describe('Tool Configuration', () => {
        it('should have correct name and description', () => {
            expect(getSymbolsOverviewTool.name).toBe('get_symbols_overview');
            expect(getSymbolsOverviewTool.description).toContain('Get a configurable overview of symbols');
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
            expect(vscodeTools.description).toContain('Get a configurable overview of symbols');
            expect(vscodeTools.inputSchema).toBeDefined();
        });
    });

    describe('execute method', () => {
        it('should handle single file with symbols', async () => {
            // Mock SymbolExtractor methods
            mockSymbolExtractor.getPathStat.mockResolvedValue({
                type: vscode.FileType.File
            });

            const mockDocument = { getText: vi.fn().mockReturnValue('test content') };
            
            mockSymbolExtractor.extractSymbolsWithContext.mockResolvedValue({
                symbols: [
                    {
                        name: 'MyClass',
                        kind: vscode.SymbolKind.Class,
                        range: { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } },
                        selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } },
                        children: []
                    },
                    {
                        name: 'myFunction',
                        kind: vscode.SymbolKind.Function,
                        range: { start: { line: 12, character: 0 }, end: { line: 15, character: 1 } },
                        selectionRange: { start: { line: 12, character: 9 }, end: { line: 12, character: 19 } },
                        children: []
                    }
                ],
                document: mockDocument
            });

            const result = await getSymbolsOverviewTool.execute({ path: 'src/test.ts' });

            expect(result).toEqual('src/test.ts:\n1: MyClass (class)\n13: myFunction (function)');
        });

        it('should handle single file with no symbols', async () => {
            // Mock SymbolExtractor methods
            mockSymbolExtractor.getPathStat.mockResolvedValue({
                type: vscode.FileType.File
            });

            const mockDocument = { getText: vi.fn().mockReturnValue('') };
            
            mockSymbolExtractor.extractSymbolsWithContext.mockResolvedValue({
                symbols: [],
                document: mockDocument
            });

            const result = await getSymbolsOverviewTool.execute({ path: 'src/empty.ts' });

            expect(result).toEqual('No symbols found');
        });

        it('should handle directory with multiple files', async () => {
            // Mock SymbolExtractor methods
            mockSymbolExtractor.getPathStat.mockResolvedValue({
                type: vscode.FileType.Directory
            });

            mockSymbolExtractor.getDirectorySymbols.mockResolvedValue([
                {
                    filePath: 'src/test1.ts',
                    symbols: [
                        {
                            name: 'Class1',
                            kind: vscode.SymbolKind.Class,
                            range: { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } },
                            selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 12 } },
                            children: []
                        }
                    ]
                },
                {
                    filePath: 'src/test2.js',
                    symbols: [
                        {
                            name: 'function1',
                            kind: vscode.SymbolKind.Function,
                            range: { start: { line: 0, character: 0 }, end: { line: 5, character: 1 } },
                            selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 18 } },
                            children: []
                        }
                    ]
                }
            ]);

            const result = await getSymbolsOverviewTool.execute({ path: 'src' });

            expect(result).toEqual('src/test1.ts:\n1: Class1 (class)\n\nsrc/test2.js:\n1: function1 (function)');
        });

        it('should handle directory with nested structure', async () => {
            // Mock SymbolExtractor methods
            mockSymbolExtractor.getPathStat.mockResolvedValue({
                type: vscode.FileType.Directory
            });

            mockSymbolExtractor.getDirectorySymbols.mockResolvedValue([
                {
                    filePath: 'src/services/service1.ts',
                    symbols: [
                        {
                            name: 'ServiceClass',
                            kind: vscode.SymbolKind.Class,
                            range: { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } },
                            selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 18 } },
                            children: []
                        }
                    ]
                }
            ]);

            const result = await getSymbolsOverviewTool.execute({ path: 'src' });

            expect(result).toEqual('src/services/service1.ts:\n1: ServiceClass (class)');
        });

        it('should handle SymbolInformation format', async () => {
            // Mock SymbolExtractor methods
            mockSymbolExtractor.getPathStat.mockResolvedValue({
                type: vscode.FileType.File
            });

            const mockDocument = { getText: vi.fn().mockReturnValue('interface MyInterface {}') };
            
            mockSymbolExtractor.extractSymbolsWithContext.mockResolvedValue({
                symbols: [
                    {
                        name: 'MyInterface',
                        kind: vscode.SymbolKind.Interface,
                        range: { start: { line: 0, character: 10 }, end: { line: 0, character: 21 } },
                        selectionRange: { start: { line: 0, character: 10 }, end: { line: 0, character: 21 } },
                        children: []
                    }
                ],
                document: mockDocument
            });

            const result = await getSymbolsOverviewTool.execute({ path: 'src/interface.ts' });

            expect(result).toEqual('src/interface.ts:\n1: MyInterface (interface)');
        });

        it('should handle path not found error', async () => {
            vi.mocked(vscode.workspace.fs.stat).mockRejectedValue(new Error('File not found'));

            const result = await getSymbolsOverviewTool.execute({ path: 'nonexistent/path' });

            expect(result).toEqual("Error getting symbols overview: Failed to get symbols overview for 'nonexistent/path': Path 'nonexistent/path' not found");
        });

        it('should handle git repository not found', async () => {
            const mockGitOpsWithoutRepo = {
                getRepository: vi.fn().mockReturnValue(null)
            } as any;

            const mockSymbolExtractorWithoutRepo = {
                getGitRootPath: vi.fn().mockReturnValue(null),
                getPathStat: vi.fn(),
                extractSymbolsWithContext: vi.fn(),
                getDirectorySymbols: vi.fn(),
                getTextDocument: vi.fn()
            } as any;

            const toolWithoutRepo = new GetSymbolsOverviewTool(mockGitOpsWithoutRepo, mockSymbolExtractorWithoutRepo);

            const result = await toolWithoutRepo.execute({ path: 'src/test.ts' });

            expect(result).toEqual("Error getting symbols overview: Failed to get symbols overview for 'src/test.ts': Git repository not found");
        });

        it('should filter code files correctly', async () => {
            // Mock SymbolExtractor methods
            mockSymbolExtractor.getPathStat.mockResolvedValue({
                type: vscode.FileType.Directory
            });

            // Mock directory symbols - SymbolExtractor should already filter code files
            mockSymbolExtractor.getDirectorySymbols.mockResolvedValue([
                {
                    filePath: 'src/component.ts',
                    symbols: [
                        {
                            name: 'Component',
                            kind: vscode.SymbolKind.Class,
                            range: { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } },
                            selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 15 } },
                            children: []
                        }
                    ]
                },
                {
                    filePath: 'src/script.js',
                    symbols: [
                        {
                            name: 'script',
                            kind: vscode.SymbolKind.Function,
                            range: { start: { line: 0, character: 0 }, end: { line: 5, character: 1 } },
                            selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 15 } },
                            children: []
                        }
                    ]
                }
            ]);

            const result = await getSymbolsOverviewTool.execute({ path: 'src' });

            expect(result).toEqual('src/component.ts:\n1: Component (class)\n\nsrc/script.js:\n1: script (function)');
        });
    });

    describe('symbol type mapping', () => {
        it('should map VS Code SymbolKind to human-readable names', async () => {
            // Mock SymbolExtractor methods
            mockSymbolExtractor.getPathStat.mockResolvedValue({
                type: vscode.FileType.File
            });

            const mockDocument = { getText: vi.fn().mockReturnValue('test content') };
            
            mockSymbolExtractor.extractSymbolsWithContext.mockResolvedValue({
                symbols: [
                    {
                        name: 'MyClass',
                        kind: vscode.SymbolKind.Class,
                        range: { start: { line: 0, character: 0 }, end: { line: 5, character: 0 } },
                        selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } },
                        children: []
                    },
                    {
                        name: 'MyInterface',
                        kind: vscode.SymbolKind.Interface,
                        range: { start: { line: 6, character: 0 }, end: { line: 8, character: 0 } },
                        selectionRange: { start: { line: 6, character: 10 }, end: { line: 6, character: 21 } },
                        children: []
                    },
                    {
                        name: 'MyEnum',
                        kind: vscode.SymbolKind.Enum,
                        range: { start: { line: 9, character: 0 }, end: { line: 12, character: 0 } },
                        selectionRange: { start: { line: 9, character: 5 }, end: { line: 9, character: 11 } },
                        children: []
                    },
                    {
                        name: 'myFunction',
                        kind: vscode.SymbolKind.Function,
                        range: { start: { line: 13, character: 0 }, end: { line: 15, character: 0 } },
                        selectionRange: { start: { line: 13, character: 9 }, end: { line: 13, character: 19 } },
                        children: []
                    },
                    {
                        name: 'myVariable',
                        kind: vscode.SymbolKind.Variable,
                        range: { start: { line: 16, character: 0 }, end: { line: 16, character: 20 } },
                        selectionRange: { start: { line: 16, character: 4 }, end: { line: 16, character: 14 } },
                        children: []
                    },
                    {
                        name: 'myConstant',
                        kind: vscode.SymbolKind.Constant,
                        range: { start: { line: 17, character: 0 }, end: { line: 17, character: 25 } },
                        selectionRange: { start: { line: 17, character: 6 }, end: { line: 17, character: 16 } },
                        children: []
                    }
                ],
                document: mockDocument
            });

            const result = await getSymbolsOverviewTool.execute({ path: 'src/test.ts' });

            expect(result).toEqual('src/test.ts:\n1: MyClass (class)\n7: MyInterface (interface)\n10: MyEnum (enum)\n14: myFunction (function)\n17: myVariable (variable)\n18: myConstant (constant)');
        });
    });
});