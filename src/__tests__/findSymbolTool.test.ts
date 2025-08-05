import * as vscode from 'vscode';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FindSymbolTool } from '../tools/findSymbolTool';
import { GitOperationsManager } from '../services/gitOperationsManager';

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
        }
    };
});

describe('FindSymbolTool (Integration Tests)', () => {
    let findSymbolTool: FindSymbolTool;
    let mockGitOperationsManager: GitOperationsManager;

    beforeEach(() => {
        // Mock GitOperationsManager
        mockGitOperationsManager = {
            getRepository: vi.fn().mockReturnValue({
                rootUri: { fsPath: '/mock/repo/root' }
            })
        } as any;
        
        findSymbolTool = new FindSymbolTool(mockGitOperationsManager);
        vi.clearAllMocks();
    });

    describe('Tool Configuration', () => {
        it('should have correct name and description', () => {
            expect(findSymbolTool.name).toBe('find_symbol');
            expect(findSymbolTool.description).toContain('Find the definition of a code symbol');
        });

        it('should have valid schema with all required fields', () => {
            const schema = findSymbolTool.schema;

            // Test required field
            const validInput = { symbolName: 'MyClass' };
            expect(schema.safeParse(validInput).success).toBe(true);

            // Test with all optional fields
            const fullInput = {
                symbolName: 'MyClass',
                searchPath: 'src/test.ts',
                shouldIncludeFullBody: false
            };
            expect(schema.safeParse(fullInput).success).toBe(true);

            // Test validation (empty string rejection)
            expect(schema.safeParse({ symbolName: '' }).success).toBe(false);
        });

        it('should create valid VS Code tool definition', () => {
            const vscodeTools = findSymbolTool.getVSCodeTool();
            expect(vscodeTools.name).toBe('find_symbol');
            expect(vscodeTools.description).toContain('Find the definition');
            expect(vscodeTools.inputSchema).toBeDefined();
        });
    });

    describe('Integration Workflow', () => {
        it('should orchestrate complete symbol finding workflow', async () => {
            const mockFileUri = { toString: () => 'file:///project/test.ts', fsPath: '/project/test.ts' };
            const mockFileContent = 'class MyClass {\n  constructor() {}\n}';

            const mockDocument = {
                getText: vi.fn().mockReturnValue(mockFileContent),
                uri: mockFileUri,
                lineCount: 3
            };

            const mockDefinition = {
                uri: mockFileUri,
                range: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } }
            };

            // Mock GitOperationsManager for repository access
            mockGitOperationsManager.getRepository.mockReturnValue({
                rootUri: { fsPath: '/project' }
            });

            // Mock file system to return files
            vi.mocked(vscode.workspace.fs.readDirectory).mockResolvedValue([
                ['test.ts', vscode.FileType.File]
            ] as [string, vscode.FileType][]);

            // Mock fs.stat to return directory type for the root and file type for the test file
            vi.mocked(vscode.workspace.fs.stat).mockImplementation((uri) => {
                if (uri.fsPath === '/project/.') {
                    return Promise.resolve({ type: vscode.FileType.Directory } as any);
                }
                return Promise.resolve({ type: vscode.FileType.File } as any);
            });

            // Mock openTextDocument to return the document with the content that contains MyClass
            vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(mockDocument as any);

            // Mock VS Code definition provider to return definitions when called
            vi.mocked(vscode.commands.executeCommand).mockImplementation((command, uri, position) => {
                if (command === 'vscode.executeDefinitionProvider') {
                    // Return definition only if we're looking at the right position
                    return Promise.resolve([mockDefinition]);
                }
                return Promise.resolve([]);
            });

            const result = await findSymbolTool.execute({
                symbolName: 'MyClass',
                shouldIncludeFullBody: true
            });

            expect(result).toHaveLength(1);
            expect(result[0]).toContain('"file"');
            expect(result[0]).toContain('MyClass');
            expect(result[0]).toContain('"body"');
            // Integration test: verify complete workflow when symbols are found
        });

        it('should handle multiple definitions workflow', async () => {
            const mockFileUri = { toString: () => 'file:///project/test.ts', fsPath: '/project/test.ts' };
            const mockFileContent = 'function test() {}\nclass test {}';

            const mockDocument = {
                getText: vi.fn().mockReturnValue(mockFileContent),
                uri: mockFileUri,
                lineCount: 2
            };

            const mockDefinitions = [
                { uri: mockFileUri, range: { start: { line: 0, character: 9 }, end: { line: 0, character: 13 } } },
                { uri: mockFileUri, range: { start: { line: 1, character: 6 }, end: { line: 1, character: 10 } } }
            ];

            // Mock GitOperationsManager for repository access
            mockGitOperationsManager.getRepository.mockReturnValue({
                rootUri: { fsPath: '/project' }
            });

            // Mock file system to return files
            vi.mocked(vscode.workspace.fs.readDirectory).mockResolvedValue([
                ['test.ts', vscode.FileType.File]
            ] as [string, vscode.FileType][]);

            // Mock fs.stat to return directory type for the root and file type for the test file
            vi.mocked(vscode.workspace.fs.stat).mockImplementation((uri) => {
                if (uri.fsPath === '/project/.') {
                    return Promise.resolve({ type: vscode.FileType.Directory } as any);
                }
                return Promise.resolve({ type: vscode.FileType.File } as any);
            });

            // Mock openTextDocument to return the document with the content that contains test
            vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(mockDocument as any);

            // Mock VS Code definition provider to return multiple definitions
            vi.mocked(vscode.commands.executeCommand).mockImplementation((command, uri, position) => {
                if (command === 'vscode.executeDefinitionProvider') {
                    return Promise.resolve(mockDefinitions);
                }
                return Promise.resolve([]);
            });

            const result = await findSymbolTool.execute({ symbolName: 'test' });

            expect(result).toHaveLength(2);
            // Verify orchestration completed successfully
            expect(result.every(r => r.includes('"file"'))).toBe(true);
        });

        it('should respect includeFullBody parameter in workflow', async () => {
            const mockFileUri = { toString: () => 'file:///project/test.ts', fsPath: '/project/test.ts' };
            const mockFileContent = 'class MyClass {}';

            const mockDocument = {
                getText: vi.fn().mockReturnValue(mockFileContent),
                uri: mockFileUri,
                lineCount: 1
            };

            const mockDefinition = {
                uri: mockFileUri,
                range: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } }
            };

            // Mock GitOperationsManager for repository access
            mockGitOperationsManager.getRepository.mockReturnValue({
                rootUri: { fsPath: '/project' }
            });

            // Mock file system to return files
            vi.mocked(vscode.workspace.fs.readDirectory).mockResolvedValue([
                ['test.ts', vscode.FileType.File]
            ] as [string, vscode.FileType][]);

            // Mock fs.stat to return directory type for the root and file type for the test file
            vi.mocked(vscode.workspace.fs.stat).mockImplementation((uri) => {
                if (uri.fsPath === '/project/.') {
                    return Promise.resolve({ type: vscode.FileType.Directory } as any);
                }
                return Promise.resolve({ type: vscode.FileType.File } as any);
            });

            // Mock openTextDocument to return the document with the content that contains MyClass
            vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(mockDocument as any);

            // Mock VS Code definition provider to return definitions when called
            vi.mocked(vscode.commands.executeCommand).mockImplementation((command, uri, position) => {
                if (command === 'vscode.executeDefinitionProvider') {
                    return Promise.resolve([mockDefinition]);
                }
                return Promise.resolve([]);
            });

            // Test shouldIncludeFullBody: false
            const resultFalse = await findSymbolTool.execute({
                symbolName: 'MyClass',
                shouldIncludeFullBody: false
            });

            expect(resultFalse[0]).toContain('"file"');
            expect(resultFalse[0]).not.toContain('"body"');

            // Test shouldIncludeFullBody: true (default)
            const resultTrue = await findSymbolTool.execute({
                symbolName: 'MyClass',
                shouldIncludeFullBody: true
            });

            expect(resultTrue[0]).toContain('"file"');
            expect(resultTrue[0]).toContain('"body"');
        });
    });

    describe('Error Handling Integration', () => {
        it('should handle input validation errors', async () => {
            const result = await findSymbolTool.execute({ symbolName: '   ' });
            expect(result).toEqual(['Error: Symbol name cannot be empty']);
        });

        it('should handle symbol not found workflow', async () => {
            // Mock GitOperationsManager for repository access
            mockGitOperationsManager.getRepository.mockReturnValue({
                rootUri: { fsPath: '/project' }
            });

            // Mock file system to return no files
            vi.mocked(vscode.workspace.fs.readDirectory).mockResolvedValue([]);

            const result = await findSymbolTool.execute({ symbolName: 'NonExistentSymbol' });
            expect(result).toEqual(["Symbol 'NonExistentSymbol' not found"]);
        });

        it('should handle VS Code API failures gracefully', async () => {
            // Mock GitOperationsManager for repository access
            mockGitOperationsManager.getRepository.mockReturnValue({
                rootUri: { fsPath: '/project' }
            });

            // Mock file system to return files
            vi.mocked(vscode.workspace.fs.readDirectory).mockResolvedValue([
                ['test.ts', vscode.FileType.File]
            ] as [string, vscode.FileType][]);

            vi.mocked(vscode.commands.executeCommand).mockRejectedValue(new Error('API failed'));

            const result = await findSymbolTool.execute({ symbolName: 'MyClass' });
            expect(result).toEqual(["Symbol 'MyClass' not found"]);
        });

        it('should handle file reading errors in workflow', async () => {
            const mockFileUri = { toString: () => 'file:///project/test.ts', fsPath: '/project/test.ts' };
            const mockFileContent = 'class MyClass {}';

            const mockDefinition = {
                uri: mockFileUri,
                range: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } }
            };

            // Mock GitOperationsManager for repository access
            mockGitOperationsManager.getRepository.mockReturnValue({
                rootUri: { fsPath: '/project' }
            });

            // Mock file system to return files
            vi.mocked(vscode.workspace.fs.readDirectory).mockResolvedValue([
                ['test.ts', vscode.FileType.File]
            ] as [string, vscode.FileType][]);

            // Mock fs.stat to return directory type for the root and file type for the test file
            vi.mocked(vscode.workspace.fs.stat).mockImplementation((uri) => {
                if (uri.fsPath === '/project/.') {
                    return Promise.resolve({ type: vscode.FileType.Directory } as any);
                }
                return Promise.resolve({ type: vscode.FileType.File } as any);
            });

            // First openTextDocument call succeeds (to find the symbol in the file)
            // Second openTextDocument call fails (when trying to read for formatting)
            let callCount = 0;
            vi.mocked(vscode.workspace.openTextDocument).mockImplementation(() => {
                callCount++;
                if (callCount === 1) {
                    return Promise.resolve({
                        getText: vi.fn().mockReturnValue(mockFileContent),
                        uri: mockFileUri,
                        lineCount: 1
                    } as any);
                } else {
                    return Promise.reject(new Error('File not readable'));
                }
            });

            // Mock VS Code definition provider to return definitions when called
            vi.mocked(vscode.commands.executeCommand).mockImplementation((command, uri, position) => {
                if (command === 'vscode.executeDefinitionProvider') {
                    return Promise.resolve([mockDefinition]);
                }
                return Promise.resolve([]);
            });

            const result = await findSymbolTool.execute({ symbolName: 'MyClass' });

            expect(result).toHaveLength(1);
            expect(result[0]).toContain('Could not read file content');
            // Integration test: verify error handled, not error message format details
        });

        it('should handle unexpected workflow errors', async () => {
            // Mock GitOperationsManager to return null (no repository)
            mockGitOperationsManager.getRepository.mockReturnValue(null);

            const result = await findSymbolTool.execute({ symbolName: 'test' });
            expect(result[0]).toContain('Error: Git repository not found');
        });
    });
});