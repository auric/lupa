import * as vscode from 'vscode';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FindSymbolTool } from '../tools/FindSymbolTool';

// Mock vscode
vi.mock('vscode', async () => {
    const actualVscode = await vi.importActual('vscode');
    return {
        ...actualVscode,
        workspace: {
            textDocuments: [],
            openTextDocument: vi.fn(),
            asRelativePath: vi.fn((uri) => `relative/path/file.ts`)
        },
        commands: {
            executeCommand: vi.fn()
        },
        Position: vi.fn().mockImplementation((line, character) => ({ line, character })),
        Range: vi.fn().mockImplementation((start, end) => ({ start, end })),
        Uri: {
            parse: vi.fn((path) => ({ toString: () => path, fsPath: path }))
        }
    };
});

describe('FindSymbolTool (Integration Tests)', () => {
    let findSymbolTool: FindSymbolTool;

    beforeEach(() => {
        findSymbolTool = new FindSymbolTool();
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
                relativePath: 'src/test.ts',
                includeFullBody: false
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
            const mockDocument = {
                getText: vi.fn().mockReturnValue('class MyClass {\n  constructor() {}\n}'),
                uri: { toString: () => 'file:///test.ts', fsPath: '/test.ts' }
            };

            const mockDefinition = {
                uri: mockDocument.uri,
                range: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } }
            };

            vi.mocked(vscode.workspace).textDocuments = [mockDocument as any];
            vi.mocked(vscode.commands.executeCommand).mockResolvedValue([mockDefinition]);
            vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue({
                getText: vi.fn().mockReturnValue('class MyClass {\n  constructor() {}\n}'),
                lineCount: 3
            } as any);

            const result = await findSymbolTool.execute({
                symbolName: 'MyClass',
                includeFullBody: true
            });

            expect(result).toHaveLength(1);
            expect(result[0]).toContain('<symbol_definition>');
            expect(result[0]).toContain('MyClass');
            // Integration test: verify workflow completed, not XML formatting details
        });

        it('should handle multiple definitions workflow', async () => {
            const mockDocument = {
                getText: vi.fn().mockReturnValue('function test() {}\nclass test {}'),
                uri: { toString: () => 'file:///test.ts', fsPath: '/test.ts' }
            };

            const mockDefinitions = [
                { uri: mockDocument.uri, range: { start: { line: 0, character: 9 }, end: { line: 0, character: 13 } } },
                { uri: mockDocument.uri, range: { start: { line: 1, character: 6 }, end: { line: 1, character: 10 } } }
            ];

            vi.mocked(vscode.workspace).textDocuments = [mockDocument as any];
            vi.mocked(vscode.commands.executeCommand).mockResolvedValue(mockDefinitions);
            vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue({
                getText: vi.fn().mockReturnValue('function test() {}\nclass test {}'),
                lineCount: 2
            } as any);

            const result = await findSymbolTool.execute({ symbolName: 'test' });

            expect(result).toHaveLength(2);
            // Verify orchestration completed successfully
            expect(result.every(r => r.includes('<symbol_definition>'))).toBe(true);
        });

        it('should respect includeFullBody parameter in workflow', async () => {
            const mockDocument = {
                getText: vi.fn().mockReturnValue('class MyClass {}'),
                uri: { toString: () => 'file:///test.ts', fsPath: '/test.ts' }
            };

            const mockDefinition = {
                uri: mockDocument.uri,
                range: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } }
            };

            vi.mocked(vscode.workspace).textDocuments = [mockDocument as any];
            vi.mocked(vscode.commands.executeCommand).mockResolvedValue([mockDefinition]);
            vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue({
                getText: vi.fn().mockReturnValue('class MyClass {}'),
                lineCount: 1
            } as any);

            // Test includeFullBody: false
            const resultFalse = await findSymbolTool.execute({
                symbolName: 'MyClass',
                includeFullBody: false
            });

            expect(resultFalse[0]).toContain('<full_body>false</full_body>');

            // Test includeFullBody: true (default)
            const resultTrue = await findSymbolTool.execute({
                symbolName: 'MyClass',
                includeFullBody: true
            });

            expect(resultTrue[0]).not.toContain('<full_body>false</full_body>');
        });
    });

    describe('Error Handling Integration', () => {
        it('should handle input validation errors', async () => {
            const result = await findSymbolTool.execute({ symbolName: '   ' });
            expect(result).toEqual(['Error: Symbol name cannot be empty']);
        });

        it('should handle symbol not found workflow', async () => {
            vi.mocked(vscode.workspace).textDocuments = [];
            const result = await findSymbolTool.execute({ symbolName: 'NonExistentSymbol' });
            expect(result).toEqual(["Symbol 'NonExistentSymbol' not found"]);
        });

        it('should handle VS Code API failures gracefully', async () => {
            const mockDocument = {
                getText: vi.fn().mockReturnValue('class MyClass {}'),
                uri: { toString: () => 'file:///test.ts', fsPath: '/test.ts' }
            };

            vi.mocked(vscode.workspace).textDocuments = [mockDocument as any];
            vi.mocked(vscode.commands.executeCommand).mockRejectedValue(new Error('API failed'));

            const result = await findSymbolTool.execute({ symbolName: 'MyClass' });
            expect(result).toEqual(["Symbol 'MyClass' not found"]);
        });

        it('should handle file reading errors in workflow', async () => {
            const mockDocument = {
                getText: vi.fn().mockReturnValue('class MyClass {}'),
                uri: { toString: () => 'file:///test.ts', fsPath: '/test.ts' }
            };

            const mockDefinition = {
                uri: mockDocument.uri,
                range: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } }
            };

            vi.mocked(vscode.workspace).textDocuments = [mockDocument as any];
            vi.mocked(vscode.commands.executeCommand).mockResolvedValue([mockDefinition]);
            vi.mocked(vscode.workspace.openTextDocument).mockRejectedValue(new Error('File not readable'));

            const result = await findSymbolTool.execute({ symbolName: 'MyClass' });

            expect(result).toHaveLength(1);
            expect(result[0]).toContain('<error>');
            // Integration test: verify error handled, not error message format details
        });

        it('should handle unexpected workflow errors', async () => {
            vi.mocked(vscode.workspace).textDocuments = undefined as any;

            const result = await findSymbolTool.execute({ symbolName: 'test' });
            expect(result[0]).toContain('Error finding symbol definition:');
        });
    });
});