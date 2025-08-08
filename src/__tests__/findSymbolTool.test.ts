import * as vscode from 'vscode';
import { describe, it, expect, vi, beforeEach } from 'vitest';
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
    let mockGitOperationsManager: GitOperationsManager;
    let mockSymbolExtractor: SymbolExtractor;

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

            // Test with all optional fields
            const fullInput = {
                name_path: 'MyClass',
                relative_path: 'src/test.ts',
                include_body: false
            };
            expect(schema.safeParse(fullInput).success).toBe(true);

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

            expect(result).toHaveLength(1);
            expect(result[0]).toContain('"file_path"');
            expect(result[0]).toContain('MyClass');
            expect(result[0]).toContain('"body"');
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

            expect(result).toHaveLength(2);
            // Verify orchestration completed successfully
            expect(result.every(r => r.includes('"file_path"'))).toBe(true);
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

            expect(resultFalse).toHaveLength(1);
            expect(resultFalse[0]).toContain('"file_path"');
            expect(resultFalse[0]).not.toContain('"body"');

            // Test include_body: true
            const resultTrue = await findSymbolTool.execute({
                name_path: 'MyClass',
                include_body: true
            });

            expect(resultTrue).toHaveLength(1);
            expect(resultTrue[0]).toContain('"file_path"');
            expect(resultTrue[0]).toContain('"body"');
        });
    });

    describe('Error Handling Integration', () => {
        it('should handle input validation errors', async () => {
            const result = await findSymbolTool.execute({ name_path: '   ' });
            expect(result).toHaveLength(1);
            expect(result[0]).toContain('Error: Symbol name cannot be empty');
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
            expect(result).toHaveLength(1);
            expect(result[0]).toContain("Symbol 'NonExistentSymbol' not found");
        });

        it('should handle VS Code API failures gracefully', async () => {
            // Mock workspace symbol provider to throw an error
            vi.mocked(vscode.commands.executeCommand).mockRejectedValue(new Error('API failed'));

            const result = await findSymbolTool.execute({ name_path: 'MyClass' });
            expect(result).toHaveLength(1);
            expect(result[0]).toContain("Symbol 'MyClass' not found");
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

            expect(result).toHaveLength(1);
            expect(result[0]).toContain("Symbol 'MyClass' not found");
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
            expect(result).toHaveLength(1);
            expect(result[0]).toContain("Symbol 'test' not found");
        });
    });
});