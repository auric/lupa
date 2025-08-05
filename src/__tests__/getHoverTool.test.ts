import * as vscode from 'vscode';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GetHoverTool } from '../tools/getHoverTool';
import { GitOperationsManager } from '../services/gitOperationsManager';
import { PathSanitizer } from '../utils/pathSanitizer';

// Mock vscode
vi.mock('vscode', async () => {
    const actualVscode = await vi.importActual('vscode');
    return {
        ...actualVscode,
        workspace: {
            fs: {
                stat: vi.fn()
            },
            openTextDocument: vi.fn()
        },
        commands: {
            executeCommand: vi.fn()
        },
        Position: vi.fn().mockImplementation((line, character) => ({ line, character })),
        Uri: {
            file: vi.fn((filePath) => ({ fsPath: filePath, toString: () => filePath }))
        },
        MarkdownString: vi.fn().mockImplementation((value) => ({ value }))
    };
});

// Mock GitOperationsManager
vi.mock('../services/gitOperationsManager');

// Mock PathSanitizer
vi.mock('../utils/pathSanitizer', () => ({
    PathSanitizer: {
        sanitizePath: vi.fn()
    }
}));

describe('GetHoverTool', () => {
    let getHoverTool: GetHoverTool;
    let mockGitOperationsManager: GitOperationsManager;

    beforeEach(() => {
        mockGitOperationsManager = {
            getRepository: vi.fn(() => ({
                rootUri: { fsPath: '/test/git/root' }
            }))
        } as any;

        getHoverTool = new GetHoverTool(mockGitOperationsManager);
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.resetAllMocks();
    });

    describe('Tool Configuration', () => {
        it('should have correct name and description', () => {
            expect(getHoverTool.name).toBe('get_hover');
            expect(getHoverTool.description).toContain('Get hover information');
        });

        it('should have valid schema with all required fields', () => {
            const schema = getHoverTool.schema;

            // Test valid input
            const validInput = { filePath: 'src/test.ts', line: 5, character: 10 };
            expect(schema.safeParse(validInput).success).toBe(true);

            // Test missing required fields
            expect(schema.safeParse({ line: 5, character: 10 }).success).toBe(false);
            expect(schema.safeParse({ filePath: 'src/test.ts', character: 10 }).success).toBe(false);
            expect(schema.safeParse({ filePath: 'src/test.ts', line: 5 }).success).toBe(false);

            // Test invalid types
            expect(schema.safeParse({ filePath: 'src/test.ts', line: 'invalid', character: 10 }).success).toBe(false);
            expect(schema.safeParse({ filePath: 'src/test.ts', line: 5, character: 'invalid' }).success).toBe(false);

            // Test negative numbers
            expect(schema.safeParse({ filePath: 'src/test.ts', line: -1, character: 10 }).success).toBe(false);
            expect(schema.safeParse({ filePath: 'src/test.ts', line: 5, character: -1 }).success).toBe(false);

            // Test empty path
            expect(schema.safeParse({ filePath: '', line: 5, character: 10 }).success).toBe(false);
        });

        it('should return VS Code tool configuration', () => {
            const vscodeConfig = getHoverTool.getVSCodeTool();
            expect(vscodeConfig.name).toBe('get_hover');
            expect(vscodeConfig.description).toContain('Get hover information');
            expect(vscodeConfig.inputSchema).toBeDefined();
        });
    });

    describe('execute', () => {
        it('should return error when git repository not found', async () => {
            (mockGitOperationsManager.getRepository as any).mockReturnValue(null);

            const result = await getHoverTool.execute({
                filePath: 'src/test.ts',
                line: 5,
                character: 10
            });

            expect(result).toEqual(['Error: Git repository not found']);
        });

        it('should return error when path sanitization fails', async () => {
            (PathSanitizer.sanitizePath as any).mockImplementation(() => {
                throw new Error('Invalid path: Directory traversal detected');
            });

            const result = await getHoverTool.execute({
                filePath: '../../../etc/passwd',
                line: 5,
                character: 10
            });

            expect(result).toEqual(['Error: Invalid file path: Invalid path: Directory traversal detected']);
        });

        it('should return error when file does not exist', async () => {
            (PathSanitizer.sanitizePath as any).mockReturnValue('src/test.ts');
            (vscode.workspace.fs.stat as any).mockRejectedValue(new Error('File not found'));

            const result = await getHoverTool.execute({
                filePath: 'src/test.ts',
                line: 5,
                character: 10
            });

            expect(result).toEqual(['Error: File not found: src/test.ts']);
        });

        it('should return error when document cannot be opened', async () => {
            (PathSanitizer.sanitizePath as any).mockReturnValue('src/test.ts');
            (vscode.workspace.fs.stat as any).mockResolvedValue({});
            (vscode.workspace.openTextDocument as any).mockRejectedValue(new Error('Cannot open document'));

            const result = await getHoverTool.execute({
                filePath: 'src/test.ts',
                line: 5,
                character: 10
            });

            expect(result).toEqual(['Error: Could not open file: Cannot open document']);
        });

        it('should return error when line is out of bounds', async () => {
            (PathSanitizer.sanitizePath as any).mockReturnValue('src/test.ts');
            (vscode.workspace.fs.stat as any).mockResolvedValue({});
            
            const mockDocument = {
                lineCount: 10
            };
            (vscode.workspace.openTextDocument as any).mockResolvedValue(mockDocument);

            const result = await getHoverTool.execute({
                filePath: 'src/test.ts',
                line: 15,
                character: 10
            });

            expect(result).toEqual(['Error: Line 15 is out of bounds (file has 10 lines)']);
        });

        it('should return error when character is out of bounds', async () => {
            (PathSanitizer.sanitizePath as any).mockReturnValue('src/test.ts');
            (vscode.workspace.fs.stat as any).mockResolvedValue({});
            
            const mockDocument = {
                lineCount: 10,
                lineAt: vi.fn().mockReturnValue({ text: 'const x = 5;' })
            };
            (vscode.workspace.openTextDocument as any).mockResolvedValue(mockDocument);

            const result = await getHoverTool.execute({
                filePath: 'src/test.ts',
                line: 5,
                character: 50
            });

            expect(result).toEqual(['Error: Character position 50 is out of bounds (line has 12 characters)']);
        });

        it('should return no hover info when executeCommand returns empty results', async () => {
            (PathSanitizer.sanitizePath as any).mockReturnValue('src/test.ts');
            (vscode.workspace.fs.stat as any).mockResolvedValue({});
            
            const mockDocument = {
                lineCount: 10,
                lineAt: vi.fn().mockReturnValue({ text: 'const x = 5;' })
            };
            (vscode.workspace.openTextDocument as any).mockResolvedValue(mockDocument);
            (vscode.commands.executeCommand as any).mockResolvedValue([]);

            const result = await getHoverTool.execute({
                filePath: 'src/test.ts',
                line: 5,
                character: 10
            });

            expect(result).toEqual(['No hover information available for position 5:10 in src/test.ts']);
        });

        it('should format string hover content correctly', async () => {
            (PathSanitizer.sanitizePath as any).mockReturnValue('src/test.ts');
            (vscode.workspace.fs.stat as any).mockResolvedValue({});
            
            const mockDocument = {
                lineCount: 10,
                lineAt: vi.fn().mockReturnValue({ text: 'const x = 5;' })
            };
            (vscode.workspace.openTextDocument as any).mockResolvedValue(mockDocument);
            
            const mockHover = [{
                contents: ['const x: number']
            }];
            (vscode.commands.executeCommand as any).mockResolvedValue(mockHover);

            const result = await getHoverTool.execute({
                filePath: 'src/test.ts',
                line: 5,
                character: 6
            });

            expect(result).toEqual(['const x: number']);
        });

        it('should format MarkdownString hover content correctly', async () => {
            (PathSanitizer.sanitizePath as any).mockReturnValue('src/test.ts');
            (vscode.workspace.fs.stat as any).mockResolvedValue({});
            
            const mockDocument = {
                lineCount: 10,
                lineAt: vi.fn().mockReturnValue({ text: 'function test() {}' })
            };
            (vscode.workspace.openTextDocument as any).mockResolvedValue(mockDocument);
            
            // Create a proper MarkdownString mock that will be detected by instanceof
            const mockMarkdownString = new (vscode.MarkdownString as any)();
            mockMarkdownString.value = '**function** test(): void';
            const mockHover = [{
                contents: [mockMarkdownString]
            }];
            (vscode.commands.executeCommand as any).mockResolvedValue(mockHover);

            const result = await getHoverTool.execute({
                filePath: 'src/test.ts',
                line: 0,
                character: 9
            });

            expect(result).toEqual(['**function** test(): void']);
        });

        it('should format code block hover content correctly', async () => {
            (PathSanitizer.sanitizePath as any).mockReturnValue('src/test.ts');
            (vscode.workspace.fs.stat as any).mockResolvedValue({});
            
            const mockDocument = {
                lineCount: 10,
                lineAt: vi.fn().mockReturnValue({ text: 'const x = 5;' })
            };
            (vscode.workspace.openTextDocument as any).mockResolvedValue(mockDocument);
            
            const mockCodeBlock = {
                language: 'typescript',
                value: 'const x: number'
            };
            const mockHover = [{
                contents: [mockCodeBlock]
            }];
            (vscode.commands.executeCommand as any).mockResolvedValue(mockHover);

            const result = await getHoverTool.execute({
                filePath: 'src/test.ts',
                line: 0,
                character: 6
            });

            expect(result).toEqual(['```typescript\nconst x: number\n```']);
        });

        it('should handle hover provider execution errors', async () => {
            (PathSanitizer.sanitizePath as any).mockReturnValue('src/test.ts');
            (vscode.workspace.fs.stat as any).mockResolvedValue({});
            
            const mockDocument = {
                lineCount: 10,
                lineAt: vi.fn().mockReturnValue({ text: 'const x = 5;' })
            };
            (vscode.workspace.openTextDocument as any).mockResolvedValue(mockDocument);
            (vscode.commands.executeCommand as any).mockRejectedValue(new Error('Hover provider failed'));

            const result = await getHoverTool.execute({
                filePath: 'src/test.ts',
                line: 5,
                character: 6
            });

            expect(result).toEqual(['Error executing hover provider: Hover provider failed']);
        });

        it('should return message when hover has no content', async () => {
            (PathSanitizer.sanitizePath as any).mockReturnValue('src/test.ts');
            (vscode.workspace.fs.stat as any).mockResolvedValue({});
            
            const mockDocument = {
                lineCount: 10,
                lineAt: vi.fn().mockReturnValue({ text: 'const x = 5;' })
            };
            (vscode.workspace.openTextDocument as any).mockResolvedValue(mockDocument);
            
            const mockHover = [{
                contents: []
            }];
            (vscode.commands.executeCommand as any).mockResolvedValue(mockHover);

            const result = await getHoverTool.execute({
                filePath: 'src/test.ts',
                line: 5,
                character: 6
            });

            expect(result).toEqual(['No hover content available for position 5:6 in src/test.ts']);
        });
    });
});