import * as vscode from 'vscode';
import { describe, it, expect, vi, beforeEach, Mocked } from 'vitest';
import { FindSymbolTool } from '../tools/findSymbolTool';
import { GitOperationsManager } from '../services/gitOperationsManager';
import { SymbolExtractor } from '../utils/symbolExtractor';
import { createMockRange } from './testUtils/mockFactories';

// Mock the readGitignore function
vi.mock('../utils/gitUtils', () => ({
    readGitignore: vi.fn().mockResolvedValue('node_modules/\n*.log'),
}));

vi.mock('vscode', async (importOriginal) => {
    const vscodeMock = await importOriginal<typeof vscode>();
    return {
        ...vscodeMock,
        workspace: {
            ...vscodeMock.workspace,
            textDocuments: [],
            openTextDocument: vi.fn(),
            asRelativePath: vi.fn(() => `relative/path/file.ts`),
            fs: {
                readDirectory: vi.fn(),
                stat: vi.fn(),
                readFile: vi.fn(),
            },
        },
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
                rootUri: { fsPath: '/mock/repo/root' },
            }),
        } as any;

        // Mock SymbolExtractor
        mockSymbolExtractor = {
            getGitRelativePathFromUri: vi.fn((_uri) => 'test.ts'),
            getDirectorySymbols: vi.fn(),
            getTextDocument: vi.fn(),
            getGitRootPath: vi.fn(() => '/mock/repo/root'),
            getPathStat: vi.fn(),
            extractSymbolsWithContext: vi.fn(),
        } as any;

        findSymbolTool = new FindSymbolTool(
            mockGitOperationsManager,
            mockSymbolExtractor
        );
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
                exclude_kinds: ['variable'],
            };
            expect(schema.safeParse(fullInput).success).toBe(true);

            // Test hierarchical path patterns
            expect(
                schema.safeParse({ name_path: '/MyClass/method' }).success
            ).toBe(true);
            expect(
                schema.safeParse({ name_path: 'MyClass/method' }).success
            ).toBe(true);
            expect(schema.safeParse({ name_path: 'method' }).success).toBe(
                true
            );

            // Test dot separator (LLM sometimes uses . instead of /)
            expect(
                schema.safeParse({ name_path: 'MyClass.method' }).success
            ).toBe(true);
            expect(
                schema.safeParse({
                    name_path:
                        'ChatParticipantService.handleExplorationRequest',
                }).success
            ).toBe(true);

            // Test mixed: when / is present, dots should be preserved in symbol names
            // This allows "MyClass/file.spec" to work correctly
            expect(
                schema.safeParse({ name_path: 'MyClass/file.spec' }).success
            ).toBe(true);

            // Test leading dot edge case (e.g., ".method" -> ["method"])
            expect(schema.safeParse({ name_path: '.method' }).success).toBe(
                true
            );

            // Test validation (empty string rejection)
            expect(schema.safeParse({ name_path: '' }).success).toBe(false);
        });

        it('should create valid VS Code tool definition', () => {
            const vscodeTools = findSymbolTool.getVSCodeTool();
            expect(vscodeTools.name).toBe('find_symbol');
            expect(vscodeTools.description).toContain(
                'Find code symbol definitions'
            );
            expect(vscodeTools.inputSchema).toBeDefined();
        });
    });

    describe('Integration Workflow', () => {
        it('should orchestrate complete symbol finding workflow', async () => {
            const mockFileUri = {
                toString: () => 'file:///mock/repo/root/test.ts',
                fsPath: '/mock/repo/root/test.ts',
            };
            const mockFileContent = 'class MyClass {\n  constructor() {}\n}';

            const mockDocument = {
                getText: vi.fn().mockReturnValue(mockFileContent),
                uri: mockFileUri,
                lineCount: 3,
            };

            // Mock workspace symbol provider response
            const mockWorkspaceSymbol = {
                name: 'MyClass',
                kind: vscode.SymbolKind.Class,
                location: {
                    uri: mockFileUri,
                    range: {
                        start: { line: 0, character: 6 },
                        end: { line: 0, character: 13 },
                    },
                },
            };

            // Mock document symbol provider response with proper range methods
            const mockDocumentSymbol = {
                name: 'MyClass',
                kind: vscode.SymbolKind.Class,
                range: {
                    start: { line: 0, character: 6 },
                    end: { line: 0, character: 13 },
                    contains: vi.fn().mockReturnValue(true),
                },
                selectionRange: {
                    start: { line: 0, character: 6 },
                    end: { line: 0, character: 13 },
                },
                children: [],
            };

            // Mock openTextDocument to return the document
            vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(
                mockDocument as any
            );

            // Mock VS Code commands for workspace and document symbols
            vi.mocked(vscode.commands.executeCommand).mockImplementation(
                (command, ..._args) => {
                    if (command === 'vscode.executeWorkspaceSymbolProvider') {
                        return Promise.resolve([mockWorkspaceSymbol]);
                    }
                    if (command === 'vscode.executeDocumentSymbolProvider') {
                        return Promise.resolve([mockDocumentSymbol]);
                    }
                    return Promise.resolve([]);
                }
            );

            const result = await findSymbolTool.execute({
                name_path: 'MyClass',
                include_body: true,
            });

            expect(result.success).toBe(true);
            expect(result.data).toContain('=== test.ts [MyClass - class] ===');
            expect(result.data).toContain('Name Path: MyClass');
            expect(result.data).toContain('1: class MyClass {');
            // Integration test: verify complete workflow when symbols are found
        });

        it('should handle multiple definitions workflow', async () => {
            const mockFileUri = {
                toString: () => 'file:///mock/repo/root/test.ts',
                fsPath: '/mock/repo/root/test.ts',
            };
            const mockFileContent = 'function test() {}\nclass test {}';

            const mockDocument = {
                getText: vi.fn().mockReturnValue(mockFileContent),
                uri: mockFileUri,
                lineCount: 2,
            };

            // Mock multiple workspace symbols with the same name
            const mockWorkspaceSymbols = [
                {
                    name: 'test',
                    kind: vscode.SymbolKind.Function,
                    location: {
                        uri: mockFileUri,
                        range: {
                            start: { line: 0, character: 9 },
                            end: { line: 0, character: 13 },
                        },
                    },
                },
                {
                    name: 'test',
                    kind: vscode.SymbolKind.Class,
                    location: {
                        uri: mockFileUri,
                        range: {
                            start: { line: 1, character: 6 },
                            end: { line: 1, character: 10 },
                        },
                    },
                },
            ];

            // Mock document symbols with proper range methods
            const mockDocumentSymbols = [
                {
                    name: 'test',
                    kind: vscode.SymbolKind.Function,
                    range: {
                        start: { line: 0, character: 9 },
                        end: { line: 0, character: 13 },
                        contains: vi.fn().mockReturnValue(true),
                    },
                    selectionRange: {
                        start: { line: 0, character: 9 },
                        end: { line: 0, character: 13 },
                    },
                    children: [],
                },
                {
                    name: 'test',
                    kind: vscode.SymbolKind.Class,
                    range: {
                        start: { line: 1, character: 6 },
                        end: { line: 1, character: 10 },
                        contains: vi.fn().mockReturnValue(true),
                    },
                    selectionRange: {
                        start: { line: 1, character: 6 },
                        end: { line: 1, character: 10 },
                    },
                    children: [],
                },
            ];

            // Mock openTextDocument to return the document
            vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(
                mockDocument as any
            );

            // Mock VS Code commands
            vi.mocked(vscode.commands.executeCommand).mockImplementation(
                (command, ..._args) => {
                    if (command === 'vscode.executeWorkspaceSymbolProvider') {
                        return Promise.resolve(mockWorkspaceSymbols);
                    }
                    if (command === 'vscode.executeDocumentSymbolProvider') {
                        return Promise.resolve(mockDocumentSymbols);
                    }
                    return Promise.resolve([]);
                }
            );

            const result = await findSymbolTool.execute({ name_path: 'test' });

            expect(result.success).toBe(true);
            expect(result.data).toContain('=== test.ts [test -');
            // Verify orchestration completed successfully - should contain both symbols
            expect(result.data).toContain('function]');
            expect(result.data).toContain('class]');
        });

        it('should respect includeFullBody parameter in workflow', async () => {
            const mockFileUri = {
                toString: () => 'file:///mock/repo/root/test.ts',
                fsPath: '/mock/repo/root/test.ts',
            };
            const mockFileContent = 'class MyClass {}';

            const mockDocument = {
                getText: vi.fn().mockReturnValue(mockFileContent),
                uri: mockFileUri,
                lineCount: 1,
            };

            // Mock workspace symbol
            const mockWorkspaceSymbol = {
                name: 'MyClass',
                kind: vscode.SymbolKind.Class,
                location: {
                    uri: mockFileUri,
                    range: {
                        start: { line: 0, character: 6 },
                        end: { line: 0, character: 13 },
                    },
                },
            };

            // Mock document symbol with proper range methods
            const mockDocumentSymbol = {
                name: 'MyClass',
                kind: vscode.SymbolKind.Class,
                range: {
                    start: { line: 0, character: 6 },
                    end: { line: 0, character: 13 },
                    contains: vi.fn().mockReturnValue(true),
                },
                selectionRange: {
                    start: { line: 0, character: 6 },
                    end: { line: 0, character: 13 },
                },
                children: [],
            };

            // Mock openTextDocument to return the document
            vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(
                mockDocument as any
            );

            // Mock VS Code commands
            vi.mocked(vscode.commands.executeCommand).mockImplementation(
                (command, ..._args) => {
                    if (command === 'vscode.executeWorkspaceSymbolProvider') {
                        return Promise.resolve([mockWorkspaceSymbol]);
                    }
                    if (command === 'vscode.executeDocumentSymbolProvider') {
                        return Promise.resolve([mockDocumentSymbol]);
                    }
                    return Promise.resolve([]);
                }
            );

            // Test include_body: false
            const resultFalse = await findSymbolTool.execute({
                name_path: 'MyClass',
                include_body: false,
            });

            expect(resultFalse.success).toBe(true);
            expect(resultFalse.data).toContain(
                '=== test.ts [MyClass - class] ==='
            );
            expect(resultFalse.data).toContain('Name Path: MyClass');
            expect(resultFalse.data).not.toContain('1: class MyClass {}');

            // Test include_body: true
            const resultTrue = await findSymbolTool.execute({
                name_path: 'MyClass',
                include_body: true,
            });

            expect(resultTrue.success).toBe(true);
            expect(resultTrue.data).toContain(
                '=== test.ts [MyClass - class] ==='
            );
            expect(resultTrue.data).toContain('Name Path: MyClass');
            expect(resultTrue.data).toContain('1: class MyClass {}');
        });
    });

    describe('Error Handling Integration', () => {
        it('should handle input validation errors', async () => {
            const result = await findSymbolTool.execute({ name_path: '   ' });
            expect(result.success).toBe(false);
            expect(result.error).toContain('Symbol name cannot be empty');
        });

        it('should handle symbol not found workflow', async () => {
            // Mock workspace symbol provider to return empty results
            vi.mocked(vscode.commands.executeCommand).mockImplementation(
                (command, ..._args) => {
                    if (command === 'vscode.executeWorkspaceSymbolProvider') {
                        return Promise.resolve([]);
                    }
                    return Promise.resolve([]);
                }
            );

            const result = await findSymbolTool.execute({
                name_path: 'NonExistentSymbol',
            });
            expect(result.success).toBe(false);
            expect(result.error).toContain(
                "Symbol 'NonExistentSymbol' not found"
            );
        });

        it('should handle VS Code API failures gracefully', async () => {
            // Mock workspace symbol provider to throw an error
            vi.mocked(vscode.commands.executeCommand).mockRejectedValue(
                new Error('API failed')
            );

            const result = await findSymbolTool.execute({
                name_path: 'MyClass',
            });
            expect(result.success).toBe(false);
            expect(result.error).toContain("Symbol 'MyClass' not found");
        });

        it('should handle file reading errors in workflow', async () => {
            // Mock workspace symbol provider to succeed but document opening to fail
            const mockWorkspaceSymbol = {
                name: 'MyClass',
                kind: vscode.SymbolKind.Class,
                location: {
                    uri: {
                        toString: () => 'file:///mock/repo/root/test.ts',
                        fsPath: '/mock/repo/root/test.ts',
                    },
                    range: {
                        start: { line: 0, character: 6 },
                        end: { line: 0, character: 13 },
                    },
                },
            };

            // Mock openTextDocument to always fail
            vi.mocked(vscode.workspace.openTextDocument).mockRejectedValue(
                new Error('File not readable')
            );

            // Mock VS Code commands
            vi.mocked(vscode.commands.executeCommand).mockImplementation(
                (command, ..._args) => {
                    if (command === 'vscode.executeWorkspaceSymbolProvider') {
                        return Promise.resolve([mockWorkspaceSymbol]);
                    }
                    if (command === 'vscode.executeDocumentSymbolProvider') {
                        return Promise.resolve([]);
                    }
                    return Promise.resolve([]);
                }
            );

            const result = await findSymbolTool.execute({
                name_path: 'MyClass',
            });

            expect(result.success).toBe(true);
            expect(result.data).toContain('=== test.ts [MyClass - class] ===');
            expect(result.data).toContain('Name Path: MyClass');
            // Integration test: verify error handled gracefully when file can't be read
        });

        it('should handle unexpected workflow errors', async () => {
            // Mock SymbolExtractor to throw an error
            mockSymbolExtractor.getGitRelativePathFromUri.mockImplementation(
                () => {
                    throw new Error('Unexpected error in symbol extraction');
                }
            );

            // Mock workspace symbol provider to return a symbol
            const mockWorkspaceSymbol = {
                name: 'test',
                kind: vscode.SymbolKind.Class,
                location: {
                    uri: {
                        toString: () => 'file:///mock/repo/root/test.ts',
                        fsPath: '/mock/repo/root/test.ts',
                    },
                    range: {
                        start: { line: 0, character: 6 },
                        end: { line: 0, character: 10 },
                    },
                },
            };

            vi.mocked(vscode.commands.executeCommand).mockImplementation(
                (command, ..._args) => {
                    if (command === 'vscode.executeWorkspaceSymbolProvider') {
                        return Promise.resolve([mockWorkspaceSymbol]);
                    }
                    return Promise.resolve([]);
                }
            );

            vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue({
                getText: vi.fn().mockReturnValue('class test {}'),
                uri: mockWorkspaceSymbol.location.uri,
                lineCount: 1,
            } as any);

            const result = await findSymbolTool.execute({ name_path: 'test' });
            expect(result.success).toBe(false);
            expect(result.error).toContain("Symbol 'test' not found");
        });

        // Note: CancellationError propagation is tested at the ToolExecutor level.
        // Tools no longer explicitly handle CancellationError - they let it bubble up naturally,
        // and ToolExecutor rethrows it to cancel the analysis.

        it('should surface truncation info in results for directory search', async () => {
            const mockFileUri = {
                toString: () => 'file:///mock/repo/root/src/test.ts',
                fsPath: '/mock/repo/root/src/test.ts',
            };

            const mockDocumentSymbol = {
                name: 'MyClass',
                detail: '',
                kind: vscode.SymbolKind.Class,
                range: {
                    start: { line: 0, character: 0 },
                    end: { line: 2, character: 1 },
                },
                selectionRange: {
                    start: { line: 0, character: 6 },
                    end: { line: 0, character: 13 },
                },
                children: [],
            };

            mockSymbolExtractor.getGitRootPath.mockReturnValue(
                '/mock/repo/root'
            );
            mockSymbolExtractor.getGitRelativePathFromUri.mockReturnValue(
                'src/test.ts'
            );
            mockSymbolExtractor.getPathStat.mockResolvedValue({
                type: vscode.FileType.Directory,
                ctime: 0,
                mtime: 0,
                size: 0,
            });
            // Return truncated: true to simulate file limit
            mockSymbolExtractor.getDirectorySymbols.mockResolvedValue({
                results: [
                    {
                        filePath: 'src/test.ts',
                        symbols: [mockDocumentSymbol as any],
                    },
                ],
                truncated: true,
                timedOutFiles: 0,
            });
            mockSymbolExtractor.getTextDocument.mockResolvedValue({
                getText: vi.fn().mockReturnValue('class MyClass {\n}'),
                uri: mockFileUri,
                lineCount: 2,
            } as any);

            const result = await findSymbolTool.execute({
                name_path: 'MyClass',
                relative_path: 'src',
            });

            expect(result.success).toBe(true);
            expect(result.data).toContain(
                '[Note: Results may be incomplete due to file limit'
            );
        });

        it('should surface timeout info in results for directory search', async () => {
            const mockFileUri = {
                toString: () => 'file:///mock/repo/root/src/test.ts',
                fsPath: '/mock/repo/root/src/test.ts',
            };

            const mockDocumentSymbol = {
                name: 'MyClass',
                detail: '',
                kind: vscode.SymbolKind.Class,
                range: {
                    start: { line: 0, character: 0 },
                    end: { line: 2, character: 1 },
                },
                selectionRange: {
                    start: { line: 0, character: 6 },
                    end: { line: 0, character: 13 },
                },
                children: [],
            };

            mockSymbolExtractor.getGitRootPath.mockReturnValue(
                '/mock/repo/root'
            );
            mockSymbolExtractor.getGitRelativePathFromUri.mockReturnValue(
                'src/test.ts'
            );
            mockSymbolExtractor.getPathStat.mockResolvedValue({
                type: vscode.FileType.Directory,
                ctime: 0,
                mtime: 0,
                size: 0,
            });
            // Return timedOutFiles > 0 to simulate timeout
            mockSymbolExtractor.getDirectorySymbols.mockResolvedValue({
                results: [
                    {
                        filePath: 'src/test.ts',
                        symbols: [mockDocumentSymbol as any],
                    },
                ],
                truncated: false,
                timedOutFiles: 3,
            });
            mockSymbolExtractor.getTextDocument.mockResolvedValue({
                getText: vi.fn().mockReturnValue('class MyClass {\n}'),
                uri: mockFileUri,
                lineCount: 2,
            } as any);

            const result = await findSymbolTool.execute({
                name_path: 'MyClass',
                relative_path: 'src',
            });

            expect(result.success).toBe(true);
            expect(result.data).toContain(
                '[Note: Results may be incomplete due to timeout'
            );
        });
    });

    describe('Type Discrimination Corner Cases', () => {
        it('should handle SymbolInformation body extraction using SymbolRangeExpander', async () => {
            const mockFileUri = {
                toString: () => 'file:///mock/repo/root/test.cpp',
                fsPath: '/mock/repo/root/test.cpp',
            };
            const mockFileContent =
                'void FWGCApiModuleImpl::Shutdown() {\n  // implementation\n}';

            const mockDocument = {
                getText: vi.fn().mockReturnValue(mockFileContent),
                uri: mockFileUri,
                lineCount: 3,
            };

            // Mock SymbolInformation (from workspace search) - has location.range, not direct range
            const mockSymbolInformation = {
                name: 'Shutdown()',
                kind: vscode.SymbolKind.Method,
                containerName: 'FWGCApiModuleImpl',
                location: {
                    uri: mockFileUri,
                    range: {
                        start: { line: 0, character: 25 },
                        end: { line: 0, character: 33 },
                    }, // incomplete range
                },
            };

            // Mock DocumentSymbol for range expansion
            const mockDocumentSymbol = {
                name: 'Shutdown()',
                kind: vscode.SymbolKind.Method,
                range: {
                    start: { line: 0, character: 5 },
                    end: { line: 2, character: 1 }, // complete range
                    contains: vi.fn().mockReturnValue(true),
                },
                selectionRange: {
                    start: { line: 0, character: 25 },
                    end: { line: 0, character: 33 },
                },
                children: [],
            };

            vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(
                mockDocument as any
            );
            vi.mocked(vscode.commands.executeCommand).mockImplementation(
                (command, ..._args) => {
                    if (command === 'vscode.executeWorkspaceSymbolProvider') {
                        return Promise.resolve([mockSymbolInformation]);
                    }
                    if (command === 'vscode.executeDocumentSymbolProvider') {
                        // Return DocumentSymbol for range expansion
                        return Promise.resolve([mockDocumentSymbol]);
                    }
                    return Promise.resolve([]);
                }
            );

            const result = await findSymbolTool.execute({
                name_path: 'Shutdown',
                include_body: true,
            });

            expect(result.success).toBe(true);
            expect(result.data).toContain(
                '=== test.ts [Shutdown() - method] ==='
            );
            // Should use expanded range from SymbolRangeExpander for SymbolInformation
            expect(result.data).toContain(
                '1: void FWGCApiModuleImpl::Shutdown() {'
            );
            expect(result.data).toContain('3: }');
        });

        it('should handle DocumentSymbol body extraction using direct range', async () => {
            const mockFileUri = {
                toString: () => 'file:///mock/repo/root/test.ts',
                fsPath: '/mock/repo/root/test.ts',
            };
            const mockFileContent =
                'class MyClass {\n  method() {\n    return true;\n  }\n}';

            const mockDocument = {
                getText: vi.fn().mockReturnValue(mockFileContent),
                uri: mockFileUri,
                lineCount: 5,
            };

            // Mock DocumentSymbol from file search - has direct range property
            const mockDocumentSymbol = {
                name: 'MyClass',
                kind: vscode.SymbolKind.Class,
                range: {
                    start: { line: 0, character: 6 },
                    end: { line: 4, character: 1 }, // complete range already
                    contains: vi.fn().mockReturnValue(true),
                },
                selectionRange: {
                    start: { line: 0, character: 6 },
                    end: { line: 0, character: 13 },
                },
                children: [
                    {
                        name: 'method()',
                        kind: vscode.SymbolKind.Method,
                        range: {
                            start: { line: 1, character: 2 },
                            end: { line: 3, character: 3 },
                            contains: vi.fn().mockReturnValue(true),
                        },
                        selectionRange: {
                            start: { line: 1, character: 2 },
                            end: { line: 1, character: 8 },
                        },
                        children: [],
                    },
                ],
            };

            // Mock file stat to indicate it's a file
            mockSymbolExtractor.getPathStat.mockResolvedValue({
                type: vscode.FileType.File,
            } as any);
            mockSymbolExtractor.getTextDocument.mockResolvedValue(
                mockDocument as any
            );

            vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(
                Buffer.from(mockFileContent)
            );
            vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(
                mockDocument as any
            );
            vi.mocked(vscode.commands.executeCommand).mockImplementation(
                (command, ..._args) => {
                    if (command === 'vscode.executeDocumentSymbolProvider') {
                        return Promise.resolve([mockDocumentSymbol]);
                    }
                    return Promise.resolve([]);
                }
            );

            const result = await findSymbolTool.execute({
                name_path: 'MyClass',
                relative_path: 'test.ts',
                include_body: true,
            });

            expect(result.success).toBe(true);
            expect(result.data).toContain('=== test.ts [MyClass - class] ===');
            // Should use direct range for DocumentSymbol (no expansion needed)
            expect(result.data).toContain('1: class MyClass {');
            expect(result.data).toContain('5: }');
        });

        it('should fetch DocumentSymbol for SymbolInformation children access', async () => {
            const mockFileUri = {
                toString: () => 'file:///mock/repo/root/test.ts',
                fsPath: '/mock/repo/root/test.ts',
            };
            const mockFileContent =
                'class MyClass {\n  method1() {}\n  method2() {}\n}';

            const mockDocument = {
                getText: vi.fn().mockReturnValue(mockFileContent),
                uri: mockFileUri,
                lineCount: 4,
            };

            // Mock SymbolInformation (has no children property)
            const mockSymbolInformation = {
                name: 'MyClass',
                kind: vscode.SymbolKind.Class,
                location: {
                    uri: mockFileUri,
                    range: createMockRange(0, 6, 0, 13),
                },
            };

            // Mock DocumentSymbol with children (fetched for children access)
            const mockDocumentSymbol = {
                name: 'MyClass',
                kind: vscode.SymbolKind.Class,
                range: createMockRange(0, 6, 3, 1),
                selectionRange: createMockRange(0, 6, 0, 13),
                children: [
                    {
                        name: 'method1()',
                        kind: vscode.SymbolKind.Method,
                        range: createMockRange(1, 2, 1, 13),
                        selectionRange: createMockRange(1, 2, 1, 9),
                        children: [],
                    },
                    {
                        name: 'method2()',
                        kind: vscode.SymbolKind.Method,
                        range: createMockRange(2, 2, 2, 13),
                        selectionRange: createMockRange(2, 2, 2, 9),
                        children: [],
                    },
                ],
            };

            vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(
                mockDocument as any
            );
            vi.mocked(vscode.commands.executeCommand).mockImplementation(
                (command, ..._args) => {
                    if (command === 'vscode.executeWorkspaceSymbolProvider') {
                        return Promise.resolve([mockSymbolInformation]);
                    }
                    if (command === 'vscode.executeDocumentSymbolProvider') {
                        return Promise.resolve([mockDocumentSymbol]);
                    }
                    return Promise.resolve([]);
                }
            );

            const result = await findSymbolTool.execute({
                name_path: 'MyClass',
                include_children: true,
            });

            expect(result.success).toBe(true);
            expect(result.data).toContain('=== test.ts [MyClass - class] ===');
            expect(result.data).toContain('Name Path: MyClass');
            // Test verifies that DocumentSymbol is fetched for SymbolInformation (even if children aren't included in this specific test scenario)
        });
    });

    describe('C++ Detail Property Corner Cases', () => {
        it('should handle C++ implementation files using detail property for container context', async () => {
            const mockFileUri = {
                toString: () => 'file:///mock/repo/root/impl.cpp',
                fsPath: '/mock/repo/root/impl.cpp',
            };
            const mockFileContent =
                'void FWGCApiModuleImpl::Shutdown() {\n  // implementation\n}';

            const mockDocument = {
                getText: vi.fn().mockReturnValue(mockFileContent),
                uri: mockFileUri,
                lineCount: 3,
            };

            // Mock DocumentSymbol from .cpp file where detail contains class name
            const mockDocumentSymbol = {
                name: 'Shutdown()',
                kind: vscode.SymbolKind.Method,
                detail: 'FWGCApiModuleImpl', // C++ implementation detail
                range: {
                    start: { line: 0, character: 5 },
                    end: { line: 2, character: 1 },
                    contains: vi.fn().mockReturnValue(true),
                },
                selectionRange: {
                    start: { line: 0, character: 25 },
                    end: { line: 0, character: 33 },
                },
                children: [],
            };

            // Mock file stat to indicate it's a file
            mockSymbolExtractor.getPathStat.mockResolvedValue({
                type: vscode.FileType.File,
            } as any);
            mockSymbolExtractor.getTextDocument.mockResolvedValue(
                mockDocument as any
            );

            vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(
                Buffer.from(mockFileContent)
            );
            vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(
                mockDocument as any
            );
            vi.mocked(vscode.commands.executeCommand).mockImplementation(
                (command, ..._args) => {
                    if (command === 'vscode.executeDocumentSymbolProvider') {
                        return Promise.resolve([mockDocumentSymbol]);
                    }
                    return Promise.resolve([]);
                }
            );

            const result = await findSymbolTool.execute({
                name_path: 'FWGCApiModuleImpl/Shutdown',
                relative_path: 'impl.cpp',
            });

            expect(result.success).toBe(true);
            expect(result.data).toContain(
                'Name Path: FWGCApiModuleImpl/Shutdown'
            );
            expect(result.data).toContain('[Shutdown() - method]');
            // Should use detail property as container context at top level
        });

        it('should handle C++ header files ignoring detail="declaration"', async () => {
            const mockFileUri = {
                toString: () => 'file:///mock/repo/root/header.h',
                fsPath: '/mock/repo/root/header.h',
            };
            const mockFileContent =
                'class FWGCApiModuleImpl {\n  void Shutdown();\n};';

            const mockDocument = {
                getText: vi.fn().mockReturnValue(mockFileContent),
                uri: mockFileUri,
                lineCount: 3,
            };

            // Mock DocumentSymbol from .h file where detail contains "declaration"
            const mockClassSymbol = {
                name: 'FWGCApiModuleImpl',
                kind: vscode.SymbolKind.Class,
                detail: 'declaration', // Header file detail
                range: {
                    start: { line: 0, character: 6 },
                    end: { line: 2, character: 2 },
                    contains: vi.fn().mockReturnValue(true),
                },
                selectionRange: {
                    start: { line: 0, character: 6 },
                    end: { line: 0, character: 23 },
                },
                children: [
                    {
                        name: 'Shutdown()',
                        kind: vscode.SymbolKind.Method,
                        detail: 'declaration', // Nested detail should be ignored
                        range: {
                            start: { line: 1, character: 2 },
                            end: { line: 1, character: 16 },
                            contains: vi.fn().mockReturnValue(true),
                        },
                        selectionRange: {
                            start: { line: 1, character: 7 },
                            end: { line: 1, character: 15 },
                        },
                        children: [],
                    },
                ],
            };

            // Mock file stat to indicate it's a file
            mockSymbolExtractor.getPathStat.mockResolvedValue({
                type: vscode.FileType.File,
            } as any);
            mockSymbolExtractor.getTextDocument.mockResolvedValue(
                mockDocument as any
            );

            vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(
                Buffer.from(mockFileContent)
            );
            vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(
                mockDocument as any
            );
            vi.mocked(vscode.commands.executeCommand).mockImplementation(
                (command, ..._args) => {
                    if (command === 'vscode.executeDocumentSymbolProvider') {
                        return Promise.resolve([mockClassSymbol]);
                    }
                    return Promise.resolve([]);
                }
            );

            const result = await findSymbolTool.execute({
                name_path: 'FWGCApiModuleImpl/Shutdown',
                relative_path: 'header.h',
            });

            expect(result.success).toBe(true);
            expect(result.data).toContain(
                'Name Path: FWGCApiModuleImpl/Shutdown'
            );
            expect(result.data).toContain('[Shutdown() - method]');
            // Should ignore detail="declaration" and use proper hierarchy
        });

        it('should use useful detail property for C++ container context', async () => {
            const mockFileUri = {
                toString: () => 'file:///mock/repo/root/mixed.cpp',
                fsPath: '/mock/repo/root/mixed.cpp',
            };
            const mockFileContent = 'void Service::init() {}';

            const mockDocument = {
                getText: vi.fn().mockReturnValue(mockFileContent),
                uri: mockFileUri,
                lineCount: 1,
            };

            // Mock flat structure typical of .cpp files
            const mockMethodSymbol = {
                name: 'init()',
                kind: vscode.SymbolKind.Method,
                detail: 'Service', // Useful detail - actual container name
                range: {
                    start: { line: 0, character: 5 },
                    end: { line: 0, character: 23 },
                    contains: vi.fn().mockReturnValue(true),
                },
                selectionRange: {
                    start: { line: 0, character: 13 },
                    end: { line: 0, character: 17 },
                },
                children: [],
            };

            // Mock file stat to indicate it's a file
            mockSymbolExtractor.getPathStat.mockResolvedValue({
                type: vscode.FileType.File,
            } as any);
            mockSymbolExtractor.getTextDocument.mockResolvedValue(
                mockDocument as any
            );

            vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(
                Buffer.from(mockFileContent)
            );
            vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(
                mockDocument as any
            );
            vi.mocked(vscode.commands.executeCommand).mockImplementation(
                (command, ..._args) => {
                    if (command === 'vscode.executeDocumentSymbolProvider') {
                        return Promise.resolve([mockMethodSymbol]);
                    }
                    return Promise.resolve([]);
                }
            );

            const result = await findSymbolTool.execute({
                name_path: 'Service/init',
                relative_path: 'mixed.cpp',
            });

            expect(result.success).toBe(true);
            expect(result.data).toContain('Name Path: Service/init');
            expect(result.data).toContain('[init() - method]');
            // Should use useful detail for container context in flat .cpp files
        });
    });

    describe('Hierarchical Path Matching', () => {
        it('should handle absolute path matching ("/MyClass/method")', async () => {
            const mockFileUri = {
                toString: () => 'file:///mock/repo/root/test.ts',
                fsPath: '/mock/repo/root/test.ts',
            };
            const mockFileContent = 'class MyClass {\n  method() {}\n}';

            const mockDocument = {
                getText: vi.fn().mockReturnValue(mockFileContent),
                uri: mockFileUri,
                lineCount: 3,
            };

            // Create nested document symbol structure
            const mockDocumentSymbol = {
                name: 'MyClass',
                kind: vscode.SymbolKind.Class,
                range: {
                    start: { line: 0, character: 6 },
                    end: { line: 2, character: 1 },
                    contains: vi.fn().mockReturnValue(true),
                },
                selectionRange: {
                    start: { line: 0, character: 6 },
                    end: { line: 0, character: 13 },
                },
                children: [
                    {
                        name: 'method',
                        kind: vscode.SymbolKind.Method,
                        range: {
                            start: { line: 1, character: 2 },
                            end: { line: 1, character: 12 },
                            contains: vi.fn().mockReturnValue(true),
                        },
                        selectionRange: {
                            start: { line: 1, character: 2 },
                            end: { line: 1, character: 8 },
                        },
                        children: [],
                    },
                ],
            };

            vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(
                mockDocument as any
            );
            vi.mocked(vscode.commands.executeCommand).mockImplementation(
                (command, ..._args) => {
                    if (command === 'vscode.executeWorkspaceSymbolProvider') {
                        return Promise.resolve([
                            {
                                name: 'method',
                                containerName: 'MyClass',
                                kind: vscode.SymbolKind.Method,
                                location: {
                                    uri: mockFileUri,
                                    range: {
                                        start: { line: 1, character: 2 },
                                        end: { line: 1, character: 8 },
                                    },
                                },
                            },
                        ]);
                    }
                    if (command === 'vscode.executeDocumentSymbolProvider') {
                        return Promise.resolve([mockDocumentSymbol]);
                    }
                    return Promise.resolve([]);
                }
            );

            const result = await findSymbolTool.execute({
                name_path: '/MyClass/method',
            });

            expect(result.success).toBe(true);
            expect(result.data).toContain('Name Path: MyClass/method');
            expect(result.data).toContain('[method - method]');
        });

        it('should handle relative path matching ("MyClass/method")', async () => {
            const mockFileUri = {
                toString: () => 'file:///mock/repo/root/test.ts',
                fsPath: '/mock/repo/root/test.ts',
            };
            const mockFileContent =
                'namespace App {\n  class MyClass {\n    method() {}\n  }\n}';

            const mockDocument = {
                getText: vi.fn().mockReturnValue(mockFileContent),
                uri: mockFileUri,
                lineCount: 5,
            };

            // Create deeply nested structure
            const mockDocumentSymbol = {
                name: 'App',
                kind: vscode.SymbolKind.Module,
                range: {
                    start: { line: 0, character: 10 },
                    end: { line: 4, character: 1 },
                    contains: vi.fn().mockReturnValue(true),
                },
                selectionRange: {
                    start: { line: 0, character: 10 },
                    end: { line: 0, character: 13 },
                },
                children: [
                    {
                        name: 'MyClass',
                        kind: vscode.SymbolKind.Class,
                        range: {
                            start: { line: 1, character: 8 },
                            end: { line: 3, character: 3 },
                            contains: vi.fn().mockReturnValue(true),
                        },
                        selectionRange: {
                            start: { line: 1, character: 8 },
                            end: { line: 1, character: 15 },
                        },
                        children: [
                            {
                                name: 'method',
                                kind: vscode.SymbolKind.Method,
                                range: {
                                    start: { line: 2, character: 4 },
                                    end: { line: 2, character: 14 },
                                    contains: vi.fn().mockReturnValue(true),
                                },
                                selectionRange: {
                                    start: { line: 2, character: 4 },
                                    end: { line: 2, character: 10 },
                                },
                                children: [],
                            },
                        ],
                    },
                ],
            };

            vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(
                mockDocument as any
            );
            vi.mocked(vscode.commands.executeCommand).mockImplementation(
                (command, ..._args) => {
                    if (command === 'vscode.executeWorkspaceSymbolProvider') {
                        return Promise.resolve([
                            {
                                name: 'method',
                                containerName: 'MyClass',
                                kind: vscode.SymbolKind.Method,
                                location: {
                                    uri: mockFileUri,
                                    range: {
                                        start: { line: 2, character: 4 },
                                        end: { line: 2, character: 10 },
                                    },
                                },
                            },
                        ]);
                    }
                    if (command === 'vscode.executeDocumentSymbolProvider') {
                        return Promise.resolve([mockDocumentSymbol]);
                    }
                    return Promise.resolve([]);
                }
            );

            const result = await findSymbolTool.execute({
                name_path: 'MyClass/method',
            });

            expect(result.success).toBe(true);
            expect(result.data).toContain('Name Path: MyClass/method');
            expect(result.data).toContain('[method - method]');
        });

        it('should handle include_children parameter', async () => {
            const mockFileUri = {
                toString: () => 'file:///mock/repo/root/test.ts',
                fsPath: '/mock/repo/root/test.ts',
            };
            const mockFileContent =
                'class MyClass {\n  method1() {}\n  method2() {}\n}';

            const mockDocument = {
                getText: vi.fn().mockReturnValue(mockFileContent),
                uri: mockFileUri,
                lineCount: 4,
            };

            // Mock SymbolInformation from workspace search
            const mockSymbolInformation = {
                name: 'MyClass',
                kind: vscode.SymbolKind.Class,
                location: {
                    uri: mockFileUri,
                    range: createMockRange(0, 6, 0, 13),
                },
            };

            // Mock DocumentSymbol with children (fetched when include_children is true)
            const mockDocumentSymbol = {
                name: 'MyClass',
                kind: vscode.SymbolKind.Class,
                range: createMockRange(0, 6, 3, 1),
                selectionRange: createMockRange(0, 6, 0, 13),
                children: [
                    {
                        name: 'method1()',
                        kind: vscode.SymbolKind.Method,
                        range: createMockRange(1, 2, 1, 13),
                        selectionRange: createMockRange(1, 2, 1, 9),
                        children: [],
                    },
                    {
                        name: 'method2()',
                        kind: vscode.SymbolKind.Method,
                        range: createMockRange(2, 2, 2, 13),
                        selectionRange: createMockRange(2, 2, 2, 9),
                        children: [],
                    },
                ],
            };

            vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(
                mockDocument as any
            );
            vi.mocked(vscode.commands.executeCommand).mockImplementation(
                (command, ..._args) => {
                    if (command === 'vscode.executeWorkspaceSymbolProvider') {
                        return Promise.resolve([mockSymbolInformation]);
                    }
                    if (command === 'vscode.executeDocumentSymbolProvider') {
                        return Promise.resolve([mockDocumentSymbol]);
                    }
                    return Promise.resolve([]);
                }
            );

            const result = await findSymbolTool.execute({
                name_path: 'MyClass',
                include_children: true,
            });

            expect(result.success).toBe(true);
            expect(result.data).toContain('=== test.ts [MyClass - class] ===');
            expect(result.data).toContain('Name Path: MyClass');
            // Note: This test demonstrates workspace search behavior - children inclusion happens in formatSymbolResults
        });
    });

    describe('Edge Cases from Bug Fixes', () => {
        it('should handle fetchDocumentSymbolForRange with overlapping ranges', async () => {
            const mockFileUri = {
                toString: () => 'file:///mock/repo/root/test.ts',
                fsPath: '/mock/repo/root/test.ts',
            };
            const mockFileContent =
                'class Outer {\n  class Inner {\n    method() {}\n  }\n}';

            const mockDocument = {
                getText: vi.fn().mockReturnValue(mockFileContent),
                uri: mockFileUri,
                lineCount: 5,
            };

            // Mock SymbolInformation pointing to inner method
            const mockSymbolInformation = {
                name: 'method()',
                kind: vscode.SymbolKind.Method,
                containerName: 'Outer.Inner',
                location: {
                    uri: mockFileUri,
                    range: {
                        start: { line: 2, character: 4 },
                        end: { line: 2, character: 10 },
                    },
                },
            };

            // Mock nested DocumentSymbol structure with overlapping ranges
            const mockDocumentSymbols = [
                {
                    name: 'Outer',
                    kind: vscode.SymbolKind.Class,
                    range: {
                        start: { line: 0, character: 6 },
                        end: { line: 4, character: 1 },
                        contains: vi.fn().mockImplementation((_range) => {
                            // Outer contains everything
                            return true;
                        }),
                    },
                    selectionRange: {
                        start: { line: 0, character: 6 },
                        end: { line: 0, character: 11 },
                    },
                    children: [
                        {
                            name: 'Inner',
                            kind: vscode.SymbolKind.Class,
                            range: {
                                start: { line: 1, character: 8 },
                                end: { line: 3, character: 3 },
                                contains: vi
                                    .fn()
                                    .mockImplementation((range) => {
                                        // Inner contains the method range
                                        return (
                                            range.start.line === 2 &&
                                            range.start.character === 4
                                        );
                                    }),
                            },
                            selectionRange: {
                                start: { line: 1, character: 8 },
                                end: { line: 1, character: 13 },
                            },
                            children: [
                                {
                                    name: 'method()',
                                    kind: vscode.SymbolKind.Method,
                                    range: {
                                        start: { line: 2, character: 4 },
                                        end: { line: 2, character: 15 },
                                        contains: vi.fn().mockReturnValue(true),
                                    },
                                    selectionRange: {
                                        start: { line: 2, character: 4 },
                                        end: { line: 2, character: 10 },
                                    },
                                    children: [],
                                },
                            ],
                        },
                    ],
                },
            ];

            vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(
                mockDocument as any
            );
            vi.mocked(vscode.commands.executeCommand).mockImplementation(
                (command, ..._args) => {
                    if (command === 'vscode.executeWorkspaceSymbolProvider') {
                        return Promise.resolve([mockSymbolInformation]);
                    }
                    if (command === 'vscode.executeDocumentSymbolProvider') {
                        return Promise.resolve(mockDocumentSymbols);
                    }
                    return Promise.resolve([]);
                }
            );

            const result = await findSymbolTool.execute({
                name_path: 'method',
                include_body: true,
            });

            expect(result.success).toBe(true);
            expect(result.data).toContain('[method() - method]');
            // Should find the most specific (innermost) DocumentSymbol that matches the range
            expect(result.data).toContain('method() {}');
        });

        it('should handle symbols with empty containerName but present detail property', async () => {
            const mockFileUri = {
                toString: () => 'file:///mock/repo/root/test.cpp',
                fsPath: '/mock/repo/root/test.cpp',
            };
            const mockFileContent = 'static void helper() {}';

            const mockDocument = {
                getText: vi.fn().mockReturnValue(mockFileContent),
                uri: mockFileUri,
                lineCount: 1,
            };

            // Mock SymbolInformation with empty containerName
            const mockSymbolInformation = {
                name: 'helper()',
                kind: vscode.SymbolKind.Function,
                containerName: '', // Empty container
                location: {
                    uri: mockFileUri,
                    range: {
                        start: { line: 0, character: 12 },
                        end: { line: 0, character: 18 },
                    },
                },
            };

            // Mock DocumentSymbol with detail property
            const mockDocumentSymbol = {
                name: 'helper()',
                kind: vscode.SymbolKind.Function,
                detail: 'static function', // Detail present but not a container name
                range: {
                    start: { line: 0, character: 7 },
                    end: { line: 0, character: 24 },
                    contains: vi.fn().mockReturnValue(true),
                },
                selectionRange: {
                    start: { line: 0, character: 12 },
                    end: { line: 0, character: 18 },
                },
                children: [],
            };

            vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(
                mockDocument as any
            );
            vi.mocked(vscode.commands.executeCommand).mockImplementation(
                (command, ..._args) => {
                    if (command === 'vscode.executeWorkspaceSymbolProvider') {
                        return Promise.resolve([mockSymbolInformation]);
                    }
                    if (command === 'vscode.executeDocumentSymbolProvider') {
                        return Promise.resolve([mockDocumentSymbol]);
                    }
                    return Promise.resolve([]);
                }
            );

            const result = await findSymbolTool.execute({
                name_path: 'helper',
            });

            expect(result.success).toBe(true);
            expect(result.data).toContain('Name Path: helper'); // Should not include detail as container when containerName is empty
            expect(result.data).toContain('[helper() - function]');
        });

        it('should handle VS Code object toJSON behavior differences', async () => {
            const mockFileUri = {
                toString: () => 'file:///mock/repo/root/test.cpp',
                fsPath: '/mock/repo/root/test.cpp',
            };
            const mockFileContent = 'void MyClass::method() {}';

            const mockDocument = {
                getText: vi.fn().mockReturnValue(mockFileContent),
                uri: mockFileUri,
                lineCount: 1,
            };

            // Mock DocumentSymbol with custom toJSON behavior (simulating VS Code objects)
            const mockDocumentSymbol = {
                name: 'method()',
                kind: vscode.SymbolKind.Method,
                detail: 'MyClass',
                range: {
                    start: { line: 0, character: 5 },
                    end: { line: 0, character: 25 },
                    contains: vi.fn().mockReturnValue(true),
                },
                selectionRange: {
                    start: { line: 0, character: 14 },
                    end: { line: 0, character: 20 },
                },
                children: [],
                // Mock VS Code's custom toJSON that might hide detail property
                toJSON: vi.fn().mockReturnValue({
                    name: 'method()',
                    kind: vscode.SymbolKind.Method,
                    range: {
                        start: { line: 0, character: 5 },
                        end: { line: 0, character: 25 },
                    },
                    selectionRange: {
                        start: { line: 0, character: 14 },
                        end: { line: 0, character: 20 },
                    },
                    children: [],
                    // Note: detail property intentionally omitted from toJSON output
                }),
            };

            // Mock file stat to indicate it's a file
            mockSymbolExtractor.getPathStat.mockResolvedValue({
                type: vscode.FileType.File,
            } as any);
            mockSymbolExtractor.getTextDocument.mockResolvedValue(
                mockDocument as any
            );

            vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(
                Buffer.from(mockFileContent)
            );
            vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(
                mockDocument as any
            );
            vi.mocked(vscode.commands.executeCommand).mockImplementation(
                (command, ..._args) => {
                    if (command === 'vscode.executeDocumentSymbolProvider') {
                        return Promise.resolve([mockDocumentSymbol]);
                    }
                    return Promise.resolve([]);
                }
            );

            const result = await findSymbolTool.execute({
                name_path: 'MyClass/method',
                relative_path: 'test.cpp',
            });

            expect(result.success).toBe(true);
            expect(result.data).toContain('Name Path: MyClass/method');
            // Should work despite detail property being hidden from JSON.stringify due to custom toJSON
            // Note: toJSON method exists but may not be called in all scenarios
        });
    });
});
