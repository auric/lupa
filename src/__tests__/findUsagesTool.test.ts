import * as vscode from 'vscode';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FindUsagesTool } from '../tools/findUsagesTool';

// Mock vscode
vi.mock('vscode', async () => {
    const actualVscode = await vi.importActual('vscode');
    return {
        ...actualVscode,
        workspace: {
            workspaceFiles: [],
            openTextDocument: vi.fn(),
            asRelativePath: vi.fn((uri) => `relative/path/file.ts`),
            workspaceFolders: [{
                uri: { fsPath: '/test/workspace' }
            }]
        },
        commands: {
            executeCommand: vi.fn()
        },
        Position: vi.fn().mockImplementation((line, character) => ({ line, character })),
        Range: vi.fn().mockImplementation((start, end) => ({ start, end, contains: vi.fn(() => true) })),
        Uri: {
            parse: vi.fn((path) => ({ toString: () => path, fsPath: path })),
            joinPath: vi.fn((base, relative) => ({
                toString: () => `${base.fsPath}/${relative}`,
                fsPath: `${base.fsPath}/${relative}`
            }))
        }
    };
});

describe('FindUsagesTool', () => {
    let findUsagesTool: FindUsagesTool;

    beforeEach(() => {
        findUsagesTool = new FindUsagesTool();
        vi.clearAllMocks();

        // Ensure workspace folders are properly set up for all tests
        (vscode.workspace as any).workspaceFolders = [{
            uri: { fsPath: '/test/workspace' }
        }];
    });

    describe('Tool Configuration', () => {
        it('should have correct name and description', () => {
            expect(findUsagesTool.name).toBe('find_usages');
            expect(findUsagesTool.description).toContain('Find all places where a symbol is used');
        });

        it('should have valid schema with all required fields', () => {
            const schema = findUsagesTool.schema;

            // Test required fields
            const validInput = { symbol_name: 'MyClass', file_path: 'src/test.ts' };
            expect(schema.safeParse(validInput).success).toBe(true);

            // Test with all optional fields
            const fullInput = {
                symbol_name: 'MyClass',
                file_path: 'src/test.ts',
                should_include_declaration: true,
                context_line_count: 3
            };
            expect(schema.safeParse(fullInput).success).toBe(true);

            // Test validation failures
            expect(schema.safeParse({ symbol_name: '' }).success).toBe(false);
            expect(schema.safeParse({ file_path: '' }).success).toBe(false);
            expect(schema.safeParse({ symbol_name: 'test', file_path: 'test.ts', context_line_count: 15 }).success).toBe(false);
        });

        it('should generate correct VS Code tool configuration', () => {
            const vscodeTool = findUsagesTool.getVSCodeTool();

            expect(vscodeTool.name).toBe('find_usages');
            expect(vscodeTool.description).toContain('Find all places where a symbol is used');
            expect(vscodeTool.inputSchema).toBeDefined();
        });
    });

    describe('execute method', () => {
        beforeEach(() => {
            // Set up default mocks
            (vscode.workspace.openTextDocument as any).mockResolvedValue({
                getText: () => 'class MyClass {\n  method() {}\n}',
                uri: { toString: () => 'file:///test.ts' }
            });
        });

        it('should validate and sanitize input parameters', async () => {
            const result = await findUsagesTool.execute({
                symbol_name: '  MyClass  ',
                file_path: '  src/test.ts  '
            });

            expect(result).toBeDefined();
            expect(result.success).toBeDefined();
        });

        it('should handle empty symbol name', async () => {
            const result = await findUsagesTool.execute({
                symbol_name: '',
                file_path: 'src/test.ts'
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain('Symbol name cannot be empty');
        });

        it('should handle empty file path', async () => {
            const result = await findUsagesTool.execute({
                symbol_name: 'MyClass',
                file_path: ''
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain('File path cannot be empty');
        });

        it('should handle missing workspace folder', async () => {
            (vscode.workspace as any).workspaceFolders = null;

            const result = await findUsagesTool.execute({
                symbol_name: 'MyClass',
                file_path: 'src/test.ts'
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain('No workspace folder is open');
        });

        it('should handle file not found error', async () => {
            (vscode.workspace.openTextDocument as any).mockRejectedValue(new Error('File not found'));

            const result = await findUsagesTool.execute({
                symbol_name: 'MyClass',
                file_path: 'nonexistent.ts'
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain('Could not open file');
            expect(result.error).toContain('File not found');
        });

        it('should handle symbol not found in document', async () => {
            (vscode.workspace.openTextDocument as any).mockResolvedValue({
                getText: () => 'const someOtherCode = true;',
                uri: { toString: () => 'file:///test.ts' }
            });

            const result = await findUsagesTool.execute({
                symbol_name: 'NonExistentSymbol',
                file_path: 'src/test.ts'
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain('No usages found for symbol');
        });

        it('should find and format symbol usages with context', async () => {
            const mockDocument = {
                getText: () => 'class MyClass {\n  method() {}\n}\nconst instance = new MyClass();',
                uri: { toString: () => 'file:///test.ts' }
            };

            const mockReferences = [
                {
                    uri: { toString: () => 'file:///test.ts' },
                    range: {
                        start: { line: 3, character: 21 },
                        end: { line: 3, character: 28 }
                    }
                }
            ];

            (vscode.workspace.openTextDocument as any)
                .mockResolvedValueOnce(mockDocument)  // Initial document open
                .mockResolvedValueOnce(mockDocument); // Reference document open

            (vscode.commands.executeCommand as any).mockImplementation((command: string) => {
                if (command === 'vscode.executeDefinitionProvider') {
                    return Promise.resolve([{
                        uri: { toString: () => 'file:///test.ts' },
                        range: { contains: () => true }
                    }]);
                }
                if (command === 'vscode.executeReferenceProvider') {
                    return Promise.resolve(mockReferences);
                }
                return Promise.resolve([]);
            });

            const result = await findUsagesTool.execute({
                symbol_name: 'MyClass',
                file_path: 'src/test.ts',
                context_line_count: 1
            });

            expect(result.success).toBe(true);
            expect(result.data).toBeDefined();
            expect(result.data).toContain('=== relative/path/file.ts ===');
            expect(result.data).toContain('3: }');
            expect(result.data).not.toContain('"location"');
        });

        it('should handle reference provider errors gracefully', async () => {
            (vscode.workspace.openTextDocument as any).mockResolvedValue({
                getText: () => 'class MyClass {}',
                uri: { toString: () => 'file:///test.ts' }
            });

            (vscode.commands.executeCommand as any).mockImplementation((command: string) => {
                if (command === 'vscode.executeReferenceProvider') {
                    throw new Error('Reference provider failed');
                }
                return Promise.resolve([]);
            });

            const result = await findUsagesTool.execute({
                symbol_name: 'MyClass',
                file_path: 'src/test.ts'
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain('Error executing reference provider');
        });

        it('should deduplicate references correctly', async () => {
            const mockDocument = {
                getText: () => 'class MyClass {}',
                uri: { toString: () => 'file:///test.ts' }
            };

            const duplicateReferences = [
                {
                    uri: { toString: () => 'file:///test.ts' },
                    range: {
                        start: { line: 0, character: 6 },
                        end: { line: 0, character: 13 }
                    }
                },
                {
                    uri: { toString: () => 'file:///test.ts' },
                    range: {
                        start: { line: 0, character: 6 },
                        end: { line: 0, character: 13 }
                    }
                }
            ];

            (vscode.workspace.openTextDocument as any)
                .mockResolvedValue(mockDocument);

            (vscode.commands.executeCommand as any).mockImplementation((command: string) => {
                if (command === 'vscode.executeReferenceProvider') {
                    return Promise.resolve(duplicateReferences);
                }
                return Promise.resolve([]);
            });

            const result = await findUsagesTool.execute({
                symbol_name: 'MyClass',
                file_path: 'src/test.ts'
            });

            // Should deduplicate and return success with data
            expect(result.success).toBe(true);
            expect(result.data).toBeDefined();
        });

        it('should handle includeDeclaration parameter', async () => {
            const mockDocument = {
                getText: () => 'class MyClass {}',
                uri: { toString: () => 'file:///test.ts' }
            };

            (vscode.workspace.openTextDocument as any).mockResolvedValue(mockDocument);

            let capturedIncludeDeclaration: boolean | undefined;
            (vscode.commands.executeCommand as any).mockImplementation((command: string, uri: any, position: any, context: any) => {
                if (command === 'vscode.executeReferenceProvider') {
                    capturedIncludeDeclaration = context?.includeDeclaration;
                    return Promise.resolve([]);
                }
                return Promise.resolve([]);
            });

            await findUsagesTool.execute({
                symbol_name: 'MyClass',
                file_path: 'src/test.ts',
                should_include_declaration: true
            });

            expect(capturedIncludeDeclaration).toBe(true);
        });

        it('should handle document reading errors for references', async () => {
            const mockInitialDocument = {
                getText: () => 'class MyClass {}',
                uri: { toString: () => 'file:///test.ts' }
            };

            const mockReferences = [
                {
                    uri: { toString: () => 'file:///error.ts' },
                    range: {
                        start: { line: 0, character: 0 },
                        end: { line: 0, character: 7 }
                    }
                }
            ];

            (vscode.workspace.openTextDocument as any)
                .mockResolvedValueOnce(mockInitialDocument)
                .mockRejectedValueOnce(new Error('Cannot read reference file'));

            (vscode.commands.executeCommand as any).mockImplementation((command: string) => {
                if (command === 'vscode.executeReferenceProvider') {
                    return Promise.resolve(mockReferences);
                }
                return Promise.resolve([]);
            });

            const result = await findUsagesTool.execute({
                symbol_name: 'MyClass',
                file_path: 'src/test.ts'
            });

            expect(result.success).toBe(true);
            expect(result.data).toBeDefined();
            expect(result.data).toContain('Error: Could not read file content');
        });

        it('should respect contextLines parameter', async () => {
            const mockDocument = {
                getText: () => 'line1\nline2\nclass MyClass {}\nline4\nline5',
                uri: { toString: () => 'file:///test.ts' }
            };

            const mockReferences = [
                {
                    uri: { toString: () => 'file:///test.ts' },
                    range: {
                        start: { line: 2, character: 6 },
                        end: { line: 2, character: 13 }
                    }
                }
            ];

            (vscode.workspace.openTextDocument as any)
                .mockResolvedValue(mockDocument);

            (vscode.commands.executeCommand as any).mockImplementation((command: string) => {
                if (command === 'vscode.executeReferenceProvider') {
                    return Promise.resolve(mockReferences);
                }
                return Promise.resolve([]);
            });

            const result = await findUsagesTool.execute({
                symbol_name: 'MyClass',
                file_path: 'src/test.ts',
                context_line_count: 1
            });

            expect(result.success).toBe(true);
            expect(result.data).toContain('=== relative/path/file.ts ===');
            // Should include line before and after the reference line
            expect(result.data).toContain('2: line2');
            expect(result.data).toContain('line4');
        });
    });

    describe('error handling', () => {
        it('should handle general execution errors', async () => {
            // Mock a general error by making Uri.joinPath throw
            const originalJoinPath = vscode.Uri.joinPath;
            (vscode.Uri as any).joinPath = vi.fn().mockImplementation(() => {
                throw new Error('Unexpected error in Uri.joinPath');
            });

            const result = await findUsagesTool.execute({
                symbol_name: 'MyClass',
                file_path: 'src/test.ts'
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain('Error finding symbol usages');

            // Restore original function
            (vscode.Uri as any).joinPath = originalJoinPath;
        });
    });

    describe('findSymbolPosition word boundary', () => {
        it('should not match partial words - "get" should not match "targetValue"', async () => {
            (vscode.workspace.openTextDocument as any).mockResolvedValue({
                getText: () => 'const targetValue = 42;\nfunction getter() {}\nconst widget = true;',
                uri: { toString: () => 'file:///test.ts' }
            });

            const result = await findUsagesTool.execute({
                symbol_name: 'get',
                file_path: 'src/test.ts'
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain('No usages found for symbol');
        });

        it('should match exact word - "User" should match standalone "User" but not "UserService"', async () => {
            const mockDocument = {
                getText: () => 'class UserService {}\nconst user: User = new User();',
                uri: { toString: () => 'file:///test.ts' }
            };

            const mockReferences = [
                {
                    uri: { toString: () => 'file:///test.ts' },
                    range: {
                        start: { line: 1, character: 12 },
                        end: { line: 1, character: 16 }
                    }
                }
            ];

            (vscode.workspace.openTextDocument as any).mockResolvedValue(mockDocument);

            (vscode.commands.executeCommand as any).mockImplementation((command: string) => {
                if (command === 'vscode.executeDefinitionProvider') {
                    return Promise.resolve([{
                        uri: { toString: () => 'file:///test.ts' },
                        range: { contains: () => true }
                    }]);
                }
                if (command === 'vscode.executeReferenceProvider') {
                    return Promise.resolve(mockReferences);
                }
                return Promise.resolve([]);
            });

            const result = await findUsagesTool.execute({
                symbol_name: 'User',
                file_path: 'src/test.ts'
            });

            expect(result.success).toBe(true);
            expect(result.data).toBeDefined();
            expect(result.data).not.toContain('No usages found');
        });

        it('should handle special regex characters - "$scope" should work correctly', async () => {
            const mockDocument = {
                getText: () => 'const scope = 1;\nconst $scope = angular.scope;\n$scope.apply();',
                uri: { toString: () => 'file:///test.ts' }
            };

            const mockReferences = [
                {
                    uri: { toString: () => 'file:///test.ts' },
                    range: {
                        start: { line: 1, character: 6 },
                        end: { line: 1, character: 12 }
                    }
                }
            ];

            (vscode.workspace.openTextDocument as any).mockResolvedValue(mockDocument);

            (vscode.commands.executeCommand as any).mockImplementation((command: string) => {
                if (command === 'vscode.executeDefinitionProvider') {
                    return Promise.resolve([{
                        uri: { toString: () => 'file:///test.ts' },
                        range: { contains: () => true }
                    }]);
                }
                if (command === 'vscode.executeReferenceProvider') {
                    return Promise.resolve(mockReferences);
                }
                return Promise.resolve([]);
            });

            const result = await findUsagesTool.execute({
                symbol_name: '$scope',
                file_path: 'src/test.ts'
            });

            expect(result.success).toBe(true);
            expect(result.data).toBeDefined();
            expect(result.data).not.toContain('No usages found');
        });

        it('should not match "User" as part of "superUser"', async () => {
            (vscode.workspace.openTextDocument as any).mockResolvedValue({
                getText: () => 'const superUser = true;\nconst userManager = null;',
                uri: { toString: () => 'file:///test.ts' }
            });

            const result = await findUsagesTool.execute({
                symbol_name: 'User',
                file_path: 'src/test.ts'
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain('No usages found for symbol');
        });

        it('should not match "id" in words like "width" or "hidden"', async () => {
            (vscode.workspace.openTextDocument as any).mockResolvedValue({
                getText: () => 'const width = 100;\nconst hidden = false;\nconst valid = true;',
                uri: { toString: () => 'file:///test.ts' }
            });

            const result = await findUsagesTool.execute({
                symbol_name: 'id',
                file_path: 'src/test.ts'
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain('No usages found for symbol');
        });
    });
});