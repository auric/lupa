import * as vscode from 'vscode';
import { describe, it, expect, vi, beforeEach, Mocked } from 'vitest';
import { FindSymbolTool } from '../tools/findSymbolTool';
import { GitOperationsManager } from '../services/gitOperationsManager';
import { SymbolExtractor } from '../utils/symbolExtractor';

// Mock the readGitignore function
vi.mock('../utils/gitUtils', () => ({
    readGitignore: vi.fn().mockResolvedValue('node_modules/\n*.log')
}));

// Mock vscode
vi.mock('vscode', async () => {
    const actualVscode = await vi.importActual('vscode');
    return {
        ...actualVscode,
        workspace: {
            textDocuments: [],
            openTextDocument: vi.fn(),
            asRelativePath: vi.fn((uri) => `relative/path/file.ts`),
            fs: {
                readDirectory: vi.fn(),
                stat: vi.fn(),
                readFile: vi.fn()
            }
        },
        commands: {
            executeCommand: vi.fn()
        },
        Position: vi.fn().mockImplementation((line, character) => ({ line, character })),
        Range: vi.fn().mockImplementation((start, end) => ({ start, end })),
        Uri: {
            parse: vi.fn((path) => ({ toString: () => path, fsPath: path })),
            file: vi.fn((path) => ({ toString: () => path, fsPath: path }))
        },
        FileType: {
            File: 1,
            Directory: 2
        },
        SymbolKind: {
            Class: 5,
            Function: 12,
            Interface: 11,
            Method: 6,
            Variable: 13
        }
    };
});

vi.mock('../services/gitOperationsManager');
vi.mock('../utils/symbolExtractor');

describe('FindSymbolTool (Integration Tests)', () => {
    let findSymbolTool: FindSymbolTool;
    let mockGitOperationsManager: Mocked<GitOperationsManager>;
    let mockSymbolExtractor: Mocked<SymbolExtractor>;

    beforeEach(() => {
        // Mock GitOperationsManager
        mockGitOperationsManager = {
            getRepository: vi.fn().mockReturnValue({
                rootUri: { fsPath: '/mock/repo/root' }
            })
        } as any;

        // Mock SymbolExtractor
        mockSymbolExtractor = {
            getGitRelativePathFromUri: vi.fn((uri) => 'test.ts'),
            getDirectorySymbols: vi.fn(),
            getTextDocument: vi.fn(),
            getGitRootPath: vi.fn(() => '/mock/repo/root'),
            getPathStat: vi.fn(),
            extractSymbolsWithContext: vi.fn()
        } as any;

        findSymbolTool = new FindSymbolTool(mockGitOperationsManager, mockSymbolExtractor);
        vi.clearAllMocks();
    });

    describe('Tool Configuration', () => {
        it('should have valid schema with all required fields', () => {
            const schema = findSymbolTool.schema;

            // Test required field
            const validInput = { name_path: 'MyClass' };
            expect(schema.safeParse(validInput).success).toBe(true);

            // Test with all optional fields including new hierarchical parameters
            const fullInput = {
                name_path: 'MyClass/method',
                relative_path: 'src/test.ts',
                include_body: false,
                include_children: true,
                include_kinds: ['class', 'method'],
                exclude_kinds: ['variable']
            };
            expect(schema.safeParse(fullInput).success).toBe(true);

            // Test hierarchical path patterns
            expect(schema.safeParse({ name_path: '/MyClass/method' }).success).toBe(true);
            expect(schema.safeParse({ name_path: 'MyClass/method' }).success).toBe(true);
            expect(schema.safeParse({ name_path: 'method' }).success).toBe(true);

            // Test validation (empty string rejection)
            expect(schema.safeParse({ name_path: '' }).success).toBe(false);
        });

        it('should create valid VS Code tool definition', () => {
            const vscodeTools = findSymbolTool.getVSCodeTool();
            expect(vscodeTools.name).toBe('find_symbol');
            expect(vscodeTools.description).toContain('Finds code symbols (classes, functions, methods, variables, etc.) by exact name within the codebase.');
            expect(vscodeTools.inputSchema).toBeDefined();
        });
    });

    describe('Integration Workflow', () => {
        it('should orchestrate complete symbol finding workflow', async () => {
            const mockFileUri = { toString: () => 'file:///mock/repo/root/test.ts', fsPath: '/mock/repo/root/test.ts' };
            const mockFileContent = 'class MyClass {\n  constructor() {}\n}';

            const mockDocument = {
                getText: vi.fn().mockReturnValue(mockFileContent),
                uri: mockFileUri,
                lineCount: 3
            };

            // Mock workspace symbol provider response
            const mockWorkspaceSymbol = {
                name: 'MyClass',
                kind: vscode.SymbolKind.Class,
                location: {
                    uri: mockFileUri,
                    range: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } }
                }
            };

            // Mock document symbol provider response with proper range methods
            const mockDocumentSymbol = {
                name: 'MyClass',
                kind: vscode.SymbolKind.Class,
                range: {
                    start: { line: 0, character: 6 },
                    end: { line: 0, character: 13 },
                    contains: vi.fn().mockReturnValue(true)
                },
                selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } },
                children: []
            };

            // Mock openTextDocument to return the document
            vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(mockDocument as any);

            // Mock VS Code commands for workspace and document symbols
            vi.mocked(vscode.commands.executeCommand).mockImplementation((command, ...args) => {
                if (command === 'vscode.executeWorkspaceSymbolProvider') {
                    return Promise.resolve([mockWorkspaceSymbol]);
                }
                if (command === 'vscode.executeDocumentSymbolProvider') {
                    return Promise.resolve([mockDocumentSymbol]);
                }
                return Promise.resolve([]);
            });

            const result = await findSymbolTool.execute({
                name_path: 'MyClass',
                include_body: true
            });

            expect(typeof result).toBe('string');
            const parsedResult = JSON.parse(result);
            expect(Array.isArray(parsedResult)).toBe(true);
            expect(parsedResult).toHaveLength(1);
            expect(parsedResult[0]).toHaveProperty('file_path');
            expect(parsedResult[0].symbol_name).toBe('MyClass');
            expect(parsedResult[0]).toHaveProperty('body');
            expect(parsedResult[0].body).toContain('1: class MyClass {');
            // Integration test: verify complete workflow when symbols are found
        });

        it('should handle multiple definitions workflow', async () => {
            const mockFileUri = { toString: () => 'file:///mock/repo/root/test.ts', fsPath: '/mock/repo/root/test.ts' };
            const mockFileContent = 'function test() {}\nclass test {}';

            const mockDocument = {
                getText: vi.fn().mockReturnValue(mockFileContent),
                uri: mockFileUri,
                lineCount: 2
            };

            // Mock multiple workspace symbols with the same name
            const mockWorkspaceSymbols = [
                {
                    name: 'test',
                    kind: vscode.SymbolKind.Function,
                    location: {
                        uri: mockFileUri,
                        range: { start: { line: 0, character: 9 }, end: { line: 0, character: 13 } }
                    }
                },
                {
                    name: 'test',
                    kind: vscode.SymbolKind.Class,
                    location: {
                        uri: mockFileUri,
                        range: { start: { line: 1, character: 6 }, end: { line: 1, character: 10 } }
                    }
                }
            ];

            // Mock document symbols with proper range methods
            const mockDocumentSymbols = [
                {
                    name: 'test',
                    kind: vscode.SymbolKind.Function,
                    range: {
                        start: { line: 0, character: 9 },
                        end: { line: 0, character: 13 },
                        contains: vi.fn().mockReturnValue(true)
                    },
                    selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 13 } },
                    children: []
                },
                {
                    name: 'test',
                    kind: vscode.SymbolKind.Class,
                    range: {
                        start: { line: 1, character: 6 },
                        end: { line: 1, character: 10 },
                        contains: vi.fn().mockReturnValue(true)
                    },
                    selectionRange: { start: { line: 1, character: 6 }, end: { line: 1, character: 10 } },
                    children: []
                }
            ];

            // Mock openTextDocument to return the document
            vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(mockDocument as any);

            // Mock VS Code commands
            vi.mocked(vscode.commands.executeCommand).mockImplementation((command, ...args) => {
                if (command === 'vscode.executeWorkspaceSymbolProvider') {
                    return Promise.resolve(mockWorkspaceSymbols);
                }
                if (command === 'vscode.executeDocumentSymbolProvider') {
                    return Promise.resolve(mockDocumentSymbols);
                }
                return Promise.resolve([]);
            });

            const result = await findSymbolTool.execute({ name_path: 'test' });

            expect(typeof result).toBe('string');
            const parsedResult = JSON.parse(result);
            expect(Array.isArray(parsedResult)).toBe(true);
            expect(parsedResult).toHaveLength(2);
            // Verify orchestration completed successfully
            expect(parsedResult.every(r => r.hasOwnProperty('file_path'))).toBe(true);
        });

        it('should respect includeFullBody parameter in workflow', async () => {
            const mockFileUri = { toString: () => 'file:///mock/repo/root/test.ts', fsPath: '/mock/repo/root/test.ts' };
            const mockFileContent = 'class MyClass {}';

            const mockDocument = {
                getText: vi.fn().mockReturnValue(mockFileContent),
                uri: mockFileUri,
                lineCount: 1
            };

            // Mock workspace symbol
            const mockWorkspaceSymbol = {
                name: 'MyClass',
                kind: vscode.SymbolKind.Class,
                location: {
                    uri: mockFileUri,
                    range: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } }
                }
            };

            // Mock document symbol with proper range methods
            const mockDocumentSymbol = {
                name: 'MyClass',
                kind: vscode.SymbolKind.Class,
                range: {
                    start: { line: 0, character: 6 },
                    end: { line: 0, character: 13 },
                    contains: vi.fn().mockReturnValue(true)
                },
                selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } },
                children: []
            };

            // Mock openTextDocument to return the document
            vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(mockDocument as any);

            // Mock VS Code commands
            vi.mocked(vscode.commands.executeCommand).mockImplementation((command, ...args) => {
                if (command === 'vscode.executeWorkspaceSymbolProvider') {
                    return Promise.resolve([mockWorkspaceSymbol]);
                }
                if (command === 'vscode.executeDocumentSymbolProvider') {
                    return Promise.resolve([mockDocumentSymbol]);
                }
                return Promise.resolve([]);
            });

            // Test include_body: false
            const resultFalse = await findSymbolTool.execute({
                name_path: 'MyClass',
                include_body: false
            });

            expect(typeof resultFalse).toBe('string');
            const parsedFalse = JSON.parse(resultFalse);
            expect(parsedFalse).toHaveLength(1);
            expect(parsedFalse[0]).toHaveProperty('file_path');
            expect(parsedFalse[0]).not.toHaveProperty('body');

            // Test include_body: true
            const resultTrue = await findSymbolTool.execute({
                name_path: 'MyClass',
                include_body: true
            });

            expect(typeof resultTrue).toBe('string');
            const parsedTrue = JSON.parse(resultTrue);
            expect(parsedTrue).toHaveLength(1);
            expect(parsedTrue[0]).toHaveProperty('file_path');
            expect(parsedTrue[0]).toHaveProperty('body');
            expect(parsedTrue[0].body).toContain('1: class MyClass {}');
        });
    });

    describe('Error Handling Integration', () => {
        it('should handle input validation errors', async () => {
            const result = await findSymbolTool.execute({ name_path: '   ' });
            expect(typeof result).toBe('string');
            expect(result).toContain('Error: Symbol name cannot be empty');
        });

        it('should handle symbol not found workflow', async () => {
            // Mock workspace symbol provider to return empty results
            vi.mocked(vscode.commands.executeCommand).mockImplementation((command, ...args) => {
                if (command === 'vscode.executeWorkspaceSymbolProvider') {
                    return Promise.resolve([]);
                }
                return Promise.resolve([]);
            });

            const result = await findSymbolTool.execute({ name_path: 'NonExistentSymbol' });
            expect(typeof result).toBe('string');
            expect(result).toContain("Symbol 'NonExistentSymbol' not found");
        });

        it('should handle VS Code API failures gracefully', async () => {
            // Mock workspace symbol provider to throw an error
            vi.mocked(vscode.commands.executeCommand).mockRejectedValue(new Error('API failed'));

            const result = await findSymbolTool.execute({ name_path: 'MyClass' });
            expect(typeof result).toBe('string');
            expect(result).toContain("Symbol 'MyClass' not found");
        });

        it('should handle file reading errors in workflow', async () => {
            // Mock workspace symbol provider to succeed but document opening to fail
            const mockWorkspaceSymbol = {
                name: 'MyClass',
                kind: vscode.SymbolKind.Class,
                location: {
                    uri: { toString: () => 'file:///mock/repo/root/test.ts', fsPath: '/mock/repo/root/test.ts' },
                    range: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } }
                }
            };

            // Mock openTextDocument to always fail
            vi.mocked(vscode.workspace.openTextDocument).mockRejectedValue(new Error('File not readable'));

            // Mock VS Code commands
            vi.mocked(vscode.commands.executeCommand).mockImplementation((command, ...args) => {
                if (command === 'vscode.executeWorkspaceSymbolProvider') {
                    return Promise.resolve([mockWorkspaceSymbol]);
                }
                if (command === 'vscode.executeDocumentSymbolProvider') {
                    return Promise.resolve([]);
                }
                return Promise.resolve([]);
            });

            const result = await findSymbolTool.execute({ name_path: 'MyClass' });

            expect(typeof result).toBe('string');
            expect(result).toContain("Symbol 'MyClass' not found");
            // Integration test: verify error handled gracefully when file can't be read
        });

        it('should handle unexpected workflow errors', async () => {
            // Mock SymbolExtractor to throw an error
            mockSymbolExtractor.getGitRelativePathFromUri.mockImplementation(() => {
                throw new Error('Unexpected error in symbol extraction');
            });

            // Mock workspace symbol provider to return a symbol
            const mockWorkspaceSymbol = {
                name: 'test',
                kind: vscode.SymbolKind.Class,
                location: {
                    uri: { toString: () => 'file:///mock/repo/root/test.ts', fsPath: '/mock/repo/root/test.ts' },
                    range: { start: { line: 0, character: 6 }, end: { line: 0, character: 10 } }
                }
            };

            vi.mocked(vscode.commands.executeCommand).mockImplementation((command, ...args) => {
                if (command === 'vscode.executeWorkspaceSymbolProvider') {
                    return Promise.resolve([mockWorkspaceSymbol]);
                }
                return Promise.resolve([]);
            });

            vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue({
                getText: vi.fn().mockReturnValue('class test {}'),
                uri: mockWorkspaceSymbol.location.uri,
                lineCount: 1
            } as any);

            const result = await findSymbolTool.execute({ name_path: 'test' });
            expect(typeof result).toBe('string');
            expect(result).toContain("Symbol 'test' not found");
        });
    });

    describe('Hierarchical Path Matching', () => {
        it('should handle absolute path matching ("/MyClass/method")', async () => {
            const mockFileUri = { toString: () => 'file:///mock/repo/root/test.ts', fsPath: '/mock/repo/root/test.ts' };
            const mockFileContent = 'class MyClass {\n  method() {}\n}';

            const mockDocument = {
                getText: vi.fn().mockReturnValue(mockFileContent),
                uri: mockFileUri,
                lineCount: 3
            };

            // Create nested document symbol structure
            const mockDocumentSymbol = {
                name: 'MyClass',
                kind: vscode.SymbolKind.Class,
                range: {
                    start: { line: 0, character: 6 },
                    end: { line: 2, character: 1 },
                    contains: vi.fn().mockReturnValue(true)
                },
                selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } },
                children: [{
                    name: 'method',
                    kind: vscode.SymbolKind.Method,
                    range: {
                        start: { line: 1, character: 2 },
                        end: { line: 1, character: 12 },
                        contains: vi.fn().mockReturnValue(true)
                    },
                    selectionRange: { start: { line: 1, character: 2 }, end: { line: 1, character: 8 } },
                    children: []
                }]
            };

            vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(mockDocument as any);
            vi.mocked(vscode.commands.executeCommand).mockImplementation((command, ...args) => {
                if (command === 'vscode.executeWorkspaceSymbolProvider') {
                    return Promise.resolve([{
                        name: 'method',
                        kind: vscode.SymbolKind.Method,
                        location: {
                            uri: mockFileUri,
                            range: { start: { line: 1, character: 2 }, end: { line: 1, character: 8 } }
                        }
                    }]);
                }
                if (command === 'vscode.executeDocumentSymbolProvider') {
                    return Promise.resolve([mockDocumentSymbol]);
                }
                return Promise.resolve([]);
            });

            const result = await findSymbolTool.execute({ name_path: '/MyClass/method' });

            expect(typeof result).toBe('string');
            const parsedResult = JSON.parse(result);
            expect(parsedResult).toHaveLength(1);
            expect(parsedResult[0].name_path).toBe('MyClass/method');
            expect(parsedResult[0].symbol_name).toBe('method');
        });

        it('should handle relative path matching ("MyClass/method")', async () => {
            const mockFileUri = { toString: () => 'file:///mock/repo/root/test.ts', fsPath: '/mock/repo/root/test.ts' };
            const mockFileContent = 'namespace App {\n  class MyClass {\n    method() {}\n  }\n}';

            const mockDocument = {
                getText: vi.fn().mockReturnValue(mockFileContent),
                uri: mockFileUri,
                lineCount: 5
            };

            // Create deeply nested structure
            const mockDocumentSymbol = {
                name: 'App',
                kind: vscode.SymbolKind.Module,
                range: {
                    start: { line: 0, character: 10 },
                    end: { line: 4, character: 1 },
                    contains: vi.fn().mockReturnValue(true)
                },
                selectionRange: { start: { line: 0, character: 10 }, end: { line: 0, character: 13 } },
                children: [{
                    name: 'MyClass',
                    kind: vscode.SymbolKind.Class,
                    range: {
                        start: { line: 1, character: 8 },
                        end: { line: 3, character: 3 },
                        contains: vi.fn().mockReturnValue(true)
                    },
                    selectionRange: { start: { line: 1, character: 8 }, end: { line: 1, character: 15 } },
                    children: [{
                        name: 'method',
                        kind: vscode.SymbolKind.Method,
                        range: {
                            start: { line: 2, character: 4 },
                            end: { line: 2, character: 14 },
                            contains: vi.fn().mockReturnValue(true)
                        },
                        selectionRange: { start: { line: 2, character: 4 }, end: { line: 2, character: 10 } },
                        children: []
                    }]
                }]
            };

            vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(mockDocument as any);
            vi.mocked(vscode.commands.executeCommand).mockImplementation((command, ...args) => {
                if (command === 'vscode.executeWorkspaceSymbolProvider') {
                    return Promise.resolve([{
                        name: 'method',
                        kind: vscode.SymbolKind.Method,
                        location: {
                            uri: mockFileUri,
                            range: { start: { line: 2, character: 4 }, end: { line: 2, character: 10 } }
                        }
                    }]);
                }
                if (command === 'vscode.executeDocumentSymbolProvider') {
                    return Promise.resolve([mockDocumentSymbol]);
                }
                return Promise.resolve([]);
            });

            const result = await findSymbolTool.execute({ name_path: 'MyClass/method' });

            expect(typeof result).toBe('string');
            const parsedResult = JSON.parse(result);
            expect(parsedResult).toHaveLength(1);
            expect(parsedResult[0].name_path).toBe('App/MyClass/method');
            expect(parsedResult[0].symbol_name).toBe('method');
        });

        it('should handle include_children parameter', async () => {
            const mockFileUri = { toString: () => 'file:///mock/repo/root/test.ts', fsPath: '/mock/repo/root/test.ts' };
            const mockFileContent = 'class MyClass {\n  method1() {}\n  method2() {}\n}';

            const mockDocument = {
                getText: vi.fn().mockReturnValue(mockFileContent),
                uri: mockFileUri,
                lineCount: 4
            };

            const mockDocumentSymbol = {
                name: 'MyClass',
                kind: vscode.SymbolKind.Class,
                range: {
                    start: { line: 0, character: 6 },
                    end: { line: 3, character: 1 },
                    contains: vi.fn().mockReturnValue(true)
                },
                selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } },
                children: [
                    {
                        name: 'method1',
                        kind: vscode.SymbolKind.Method,
                        range: {
                            start: { line: 1, character: 2 },
                            end: { line: 1, character: 13 },
                            contains: vi.fn().mockReturnValue(false)
                        },
                        selectionRange: { start: { line: 1, character: 2 }, end: { line: 1, character: 9 } },
                        children: []
                    },
                    {
                        name: 'method2',
                        kind: vscode.SymbolKind.Method,
                        range: {
                            start: { line: 2, character: 2 },
                            end: { line: 2, character: 13 },
                            contains: vi.fn().mockReturnValue(false)
                        },
                        selectionRange: { start: { line: 2, character: 2 }, end: { line: 2, character: 9 } },
                        children: []
                    }
                ]
            };

            vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(mockDocument as any);
            vi.mocked(vscode.commands.executeCommand).mockImplementation((command, ...args) => {
                if (command === 'vscode.executeWorkspaceSymbolProvider') {
                    return Promise.resolve([{
                        name: 'MyClass',
                        kind: vscode.SymbolKind.Class,
                        location: {
                            uri: mockFileUri,
                            range: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } }
                        }
                    }]);
                }
                if (command === 'vscode.executeDocumentSymbolProvider') {
                    return Promise.resolve([mockDocumentSymbol]);
                }
                return Promise.resolve([]);
            });

            const result = await findSymbolTool.execute({ 
                name_path: 'MyClass',
                include_children: true
            });

            expect(typeof result).toBe('string');
            const parsedResult = JSON.parse(result);
            expect(parsedResult).toHaveLength(3); // MyClass + method1 + method2
            expect(parsedResult[0].symbol_name).toBe('MyClass');
            expect(parsedResult[1].symbol_name).toBe('method1');
            expect(parsedResult[2].symbol_name).toBe('method2');
            expect(parsedResult[1].name_path).toBe('MyClass/method1');
            expect(parsedResult[2].name_path).toBe('MyClass/method2');
        });
    });
});