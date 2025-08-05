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
            expect(findUsagesTool.description).toContain('Find all usages/references');
        });

        it('should have valid schema with all required fields', () => {
            const schema = findUsagesTool.schema;

            // Test required fields
            const validInput = { symbolName: 'MyClass', filePath: 'src/test.ts' };
            expect(schema.safeParse(validInput).success).toBe(true);

            // Test with all optional fields
            const fullInput = {
                symbolName: 'MyClass',
                filePath: 'src/test.ts',
                shouldIncludeDeclaration: true,
                contextLineCount: 3
            };
            expect(schema.safeParse(fullInput).success).toBe(true);

            // Test validation failures
            expect(schema.safeParse({ symbolName: '' }).success).toBe(false);
            expect(schema.safeParse({ filePath: '' }).success).toBe(false);
            expect(schema.safeParse({ symbolName: 'test', filePath: 'test.ts', contextLineCount: 15 }).success).toBe(false);
        });

        it('should generate correct VS Code tool configuration', () => {
            const vscodeTool = findUsagesTool.getVSCodeTool();
            
            expect(vscodeTool.name).toBe('find_usages');
            expect(vscodeTool.description).toContain('Find all usages/references');
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
                symbolName: '  MyClass  ',
                filePath: '  src/test.ts  '
            });

            expect(result).toBeDefined();
            expect(Array.isArray(result)).toBe(true);
        });

        it('should handle empty symbol name', async () => {
            const result = await findUsagesTool.execute({
                symbolName: '',
                filePath: 'src/test.ts'
            });

            expect(result).toEqual(['Error: Symbol name cannot be empty']);
        });

        it('should handle empty file path', async () => {
            const result = await findUsagesTool.execute({
                symbolName: 'MyClass',
                filePath: ''
            });

            expect(result).toEqual(['Error: File path cannot be empty']);
        });

        it('should handle missing workspace folder', async () => {
            (vscode.workspace as any).workspaceFolders = null;

            const result = await findUsagesTool.execute({
                symbolName: 'MyClass',
                filePath: 'src/test.ts'
            });

            expect(result).toEqual(['Error: No workspace folder is open']);
        });

        it('should handle file not found error', async () => {
            (vscode.workspace.openTextDocument as any).mockRejectedValue(new Error('File not found'));

            const result = await findUsagesTool.execute({
                symbolName: 'MyClass',
                filePath: 'nonexistent.ts'
            });

            expect(result[0]).toContain('Error: Could not open file');
            expect(result[0]).toContain('File not found');
        });

        it('should handle symbol not found in document', async () => {
            (vscode.workspace.openTextDocument as any).mockResolvedValue({
                getText: () => 'const someOtherCode = true;',
                uri: { toString: () => 'file:///test.ts' }
            });

            const result = await findUsagesTool.execute({
                symbolName: 'NonExistentSymbol',
                filePath: 'src/test.ts'
            });

            expect(result[0]).toContain('No usages found for symbol');
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

            (vscode.commands.executeCommand as any).mockImplementation((command) => {
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
                symbolName: 'MyClass',
                filePath: 'src/test.ts',
                contextLineCount: 1
            });

            expect(result).toBeDefined();
            expect(result.length).toBeGreaterThan(0);
            // Check for JSON format instead of XML
            expect(result[0]).toContain('"file"');
            expect(result[0]).toContain('"location"');
            expect(result[0]).toContain('"context"');
        });

        it('should handle reference provider errors gracefully', async () => {
            (vscode.workspace.openTextDocument as any).mockResolvedValue({
                getText: () => 'class MyClass {}',
                uri: { toString: () => 'file:///test.ts' }
            });

            (vscode.commands.executeCommand as any).mockImplementation((command) => {
                if (command === 'vscode.executeReferenceProvider') {
                    throw new Error('Reference provider failed');
                }
                return Promise.resolve([]);
            });

            const result = await findUsagesTool.execute({
                symbolName: 'MyClass',
                filePath: 'src/test.ts'
            });

            expect(result[0]).toContain('Error executing reference provider');
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

            (vscode.commands.executeCommand as any).mockImplementation((command) => {
                if (command === 'vscode.executeReferenceProvider') {
                    return Promise.resolve(duplicateReferences);
                }
                return Promise.resolve([]);
            });

            const result = await findUsagesTool.execute({
                symbolName: 'MyClass',
                filePath: 'src/test.ts'
            });

            expect(result.length).toBe(1); // Should deduplicate to single result
        });

        it('should handle includeDeclaration parameter', async () => {
            const mockDocument = {
                getText: () => 'class MyClass {}',
                uri: { toString: () => 'file:///test.ts' }
            };

            (vscode.workspace.openTextDocument as any).mockResolvedValue(mockDocument);

            let capturedIncludeDeclaration: boolean | undefined;
            (vscode.commands.executeCommand as any).mockImplementation((command, uri, position, context) => {
                if (command === 'vscode.executeReferenceProvider') {
                    capturedIncludeDeclaration = context?.includeDeclaration;
                    return Promise.resolve([]);
                }
                return Promise.resolve([]);
            });

            await findUsagesTool.execute({
                symbolName: 'MyClass',
                filePath: 'src/test.ts',
                shouldIncludeDeclaration: true
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

            (vscode.commands.executeCommand as any).mockImplementation((command) => {
                if (command === 'vscode.executeReferenceProvider') {
                    return Promise.resolve(mockReferences);
                }
                return Promise.resolve([]);
            });

            const result = await findUsagesTool.execute({
                symbolName: 'MyClass',
                filePath: 'src/test.ts'
            });

            expect(result).toBeDefined();
            expect(result[0]).toContain('"error": "Could not read file content');
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

            (vscode.commands.executeCommand as any).mockImplementation((command) => {
                if (command === 'vscode.executeReferenceProvider') {
                    return Promise.resolve(mockReferences);
                }
                return Promise.resolve([]);
            });

            const result = await findUsagesTool.execute({
                symbolName: 'MyClass',
                filePath: 'src/test.ts',
                contextLineCount: 1
            });

            expect(result[0]).toContain('"context"');
            // Should include line before and after the reference line
            expect(result[0]).toContain('line2');
            expect(result[0]).toContain('line4');
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
                symbolName: 'MyClass',
                filePath: 'src/test.ts'
            });

            expect(result[0]).toContain('Error finding symbol usages');
            
            // Restore original function
            (vscode.Uri as any).joinPath = originalJoinPath;
        });
    });
});