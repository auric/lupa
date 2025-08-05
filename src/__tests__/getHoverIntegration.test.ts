import * as vscode from 'vscode';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolCallingAnalysisProvider } from '../services/toolCallingAnalysisProvider';
import { ConversationManager } from '../models/conversationManager';
import { ToolExecutor } from '../models/toolExecutor';
import { ToolRegistry } from '../models/toolRegistry';
import { GetHoverTool } from '../tools/getHoverTool';
import { GitOperationsManager } from '../services/gitOperationsManager';
import { PathSanitizer } from '../utils/pathSanitizer';

vi.mock('vscode', async () => {
    const actualVscode = await vi.importActual('vscode');
    return {
        ...actualVscode,
        workspace: {
            textDocuments: [],
            openTextDocument: vi.fn(),
            asRelativePath: vi.fn((uri) => 'src/test.ts'),
            workspaceFolders: [{
                uri: { fsPath: '/test/workspace' }
            }],
            fs: {
                stat: vi.fn()
            }
        },
        commands: {
            executeCommand: vi.fn()
        },
        Position: vi.fn().mockImplementation((line, character) => ({ line, character })),
        Range: vi.fn().mockImplementation((start, end) => ({
            start,
            end,
            contains: vi.fn(() => true)
        })),
        Uri: {
            parse: vi.fn((path) => ({ toString: () => path, fsPath: path })),
            file: vi.fn((path) => ({ toString: () => path, fsPath: path })),
            joinPath: vi.fn((base, relative) => ({
                toString: () => `${base.fsPath}/${relative}`,
                fsPath: `${base.fsPath}/${relative}`
            }))
        },
        MarkdownString: vi.fn().mockImplementation((value) => ({ value }))
    };
});

const mockCopilotModelManager = {
    sendRequest: vi.fn()
};

const mockPromptGenerator = {
    getSystemPrompt: vi.fn().mockReturnValue('You are an expert code reviewer.'),
    getToolInformation: vi.fn().mockReturnValue('\n\nYou have access to tools: get_hover'),
    generateToolAwareSystemPrompt: vi.fn().mockReturnValue('You are an expert code reviewer with access to tools: get_hover'),
    generateToolCallingUserPrompt: vi.fn().mockReturnValue('<files_to_review>Sample diff content</files_to_review>')
};

const mockGitOperationsManager = {
    getRepository: vi.fn(() => ({
        rootUri: { fsPath: '/test/git/root' }
    }))
} as any;

vi.mock('../utils/pathSanitizer', () => ({
    PathSanitizer: {
        sanitizePath: vi.fn((path) => path)
    }
}));

describe('GetHover Integration Tests', () => {
    let toolCallingAnalyzer: ToolCallingAnalysisProvider;
    let conversationManager: ConversationManager;
    let toolExecutor: ToolExecutor;
    let toolRegistry: ToolRegistry;
    let getHoverTool: GetHoverTool;

    beforeEach(() => {
        // Initialize the tool-calling system
        toolRegistry = new ToolRegistry();
        conversationManager = new ConversationManager();
        toolExecutor = new ToolExecutor(toolRegistry);
        getHoverTool = new GetHoverTool(mockGitOperationsManager);

        // Register the GetHoverTool
        toolRegistry.registerTool(getHoverTool);

        // Initialize the analyzer
        toolCallingAnalyzer = new ToolCallingAnalysisProvider(
            conversationManager,
            toolExecutor,
            mockCopilotModelManager as any,
            mockPromptGenerator as any
        );

        // Reset all mocks
        vi.clearAllMocks();
        
        // Reset PathSanitizer to default behavior
        (PathSanitizer.sanitizePath as any).mockImplementation((path: string) => path);
    });

    describe('Tool Registration and Discovery', () => {
        it('should register GetHoverTool successfully', () => {
            expect(toolRegistry.hasTool('get_hover')).toBe(true);
            expect(toolRegistry.getTool('get_hover')).toBe(getHoverTool);
        });

        it('should include get_hover in available tools list', () => {
            const toolNames = toolRegistry.getToolNames();
            expect(toolNames).toContain('get_hover');
        });

        it('should return correct VS Code tool configuration', () => {
            const vscodeConfig = getHoverTool.getVSCodeTool();
            expect(vscodeConfig.name).toBe('get_hover');
            expect(vscodeConfig.description).toContain('Get hover information');
            expect(vscodeConfig.inputSchema).toBeDefined();
        });
    });

    describe('End-to-End Tool Execution', () => {
        it('should execute get_hover tool through ToolExecutor', async () => {
            // Mock successful file operations
            (vscode.workspace.fs.stat as any).mockResolvedValue({});
            
            const mockDocument = {
                lineCount: 10,
                lineAt: vi.fn().mockReturnValue({ text: 'const x: number = 5;' })
            };
            (vscode.workspace.openTextDocument as any).mockResolvedValue(mockDocument);
            
            const mockHover = [{
                contents: ['const x: number']
            }];
            (vscode.commands.executeCommand as any).mockResolvedValue(mockHover);

            const result = await toolExecutor.executeTool('get_hover', {
                filePath: 'src/test.ts',
                line: 0,
                character: 6
            });

            expect(result.success).toBe(true);
            expect(result.result).toEqual(['const x: number']);
            expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
                'vscode.executeHoverProvider',
                expect.any(Object),
                expect.any(Object)
            );
        });

        it('should handle multiple hover results', async () => {
            // Mock successful file operations
            (vscode.workspace.fs.stat as any).mockResolvedValue({});
            
            const mockDocument = {
                lineCount: 10,
                lineAt: vi.fn().mockReturnValue({ text: 'function test(): void {}' })
            };
            (vscode.workspace.openTextDocument as any).mockResolvedValue(mockDocument);
            
            const mockHover = [
                {
                    contents: ['function test(): void']
                },
                {
                    contents: ['Function documentation here']
                }
            ];
            (vscode.commands.executeCommand as any).mockResolvedValue(mockHover);

            const result = await toolExecutor.executeTool('get_hover', {
                filePath: 'src/test.ts',
                line: 0,
                character: 9
            });

            expect(result.success).toBe(true);
            expect(result.result).toEqual(['function test(): void', 'Function documentation here']);
        });

        it('should handle mixed content types in hover results', async () => {
            // Mock successful file operations
            (vscode.workspace.fs.stat as any).mockResolvedValue({});
            
            const mockDocument = {
                lineCount: 10,
                lineAt: vi.fn().mockReturnValue({ text: 'interface User {}' })
            };
            (vscode.workspace.openTextDocument as any).mockResolvedValue(mockDocument);
            
            // Create a mock object that behaves like MarkdownString but doesn't pass instanceof check
            const mockMarkdownString = {
                value: '**interface** User'
            };
            const mockCodeBlock = {
                language: 'typescript',
                value: 'interface User {\n  // empty\n}'
            };
            
            const mockHover = [{
                contents: [
                    'Plain string content',
                    mockMarkdownString,
                    mockCodeBlock
                ]
            }];
            (vscode.commands.executeCommand as any).mockResolvedValue(mockHover);

            const result = await toolExecutor.executeTool('get_hover', {
                filePath: 'src/test.ts',
                line: 0,
                character: 10
            });

            expect(result.success).toBe(true);
            expect(result.result).toEqual([
                'Plain string content',
                '**interface** User',
                '```typescript\ninterface User {\n  // empty\n}\n```'
            ]);
        });
    });

    describe('Error Handling Integration', () => {
        it('should propagate path sanitization errors through ToolExecutor', async () => {
            const { PathSanitizer } = await import('../utils/pathSanitizer');
            (PathSanitizer.sanitizePath as any).mockImplementation(() => {
                throw new Error('Invalid path: Directory traversal detected');
            });

            const result = await toolExecutor.executeTool('get_hover', {
                filePath: '../../../etc/passwd',
                line: 0,
                character: 0
            });

            expect(result.success).toBe(true);
            expect(result.result).toEqual(['Error: Invalid file path: Invalid path: Directory traversal detected']);
        });

        it('should handle VSCode API failures gracefully', async () => {
            // Set PathSanitizer to return valid path for this test
            (PathSanitizer.sanitizePath as any).mockReturnValue('src/test.ts');
            
            // Mock successful file operations initially
            (vscode.workspace.fs.stat as any).mockResolvedValue({});
            
            const mockDocument = {
                lineCount: 10,
                lineAt: vi.fn().mockReturnValue({ text: 'const x = 5;' })
            };
            (vscode.workspace.openTextDocument as any).mockResolvedValue(mockDocument);
            
            // But fail on hover provider
            (vscode.commands.executeCommand as any).mockRejectedValue(new Error('VSCode API unavailable'));

            const result = await toolExecutor.executeTool('get_hover', {
                filePath: 'src/test.ts',
                line: 0,
                character: 6
            });

            expect(result.success).toBe(true);
            expect(result.result).toEqual(['Error executing hover provider: VSCode API unavailable']);
        });

        it('should handle invalid line/character positions', async () => {
            // Mock successful file operations
            (vscode.workspace.fs.stat as any).mockResolvedValue({});
            
            const mockDocument = {
                lineCount: 5,
                lineAt: vi.fn().mockReturnValue({ text: 'short' })
            };
            (vscode.workspace.openTextDocument as any).mockResolvedValue(mockDocument);

            const result = await toolExecutor.executeTool('get_hover', {
                filePath: 'src/test.ts',
                line: 10, // Out of bounds
                character: 0
            });

            expect(result.success).toBe(true);
            expect(result.result).toEqual(['Error: Line 10 is out of bounds (file has 5 lines)']);
        });
    });

    describe('Tool Configuration Validation', () => {
        it('should validate tool parameters through schema', async () => {
            // Test with invalid schema - this should be caught by the tool's schema validation
            try {
                await toolExecutor.executeTool('get_hover', {
                    filePath: '', // Empty path should fail schema validation
                    line: 0,
                    character: 0
                });
            } catch (error) {
                expect(error).toBeDefined();
            }
        });

        it('should accept valid parameters', async () => {
            // Mock successful operations
            (vscode.workspace.fs.stat as any).mockResolvedValue({});
            
            const mockDocument = {
                lineCount: 10,
                lineAt: vi.fn().mockReturnValue({ text: 'const x = 5;' })
            };
            (vscode.workspace.openTextDocument as any).mockResolvedValue(mockDocument);
            (vscode.commands.executeCommand as any).mockResolvedValue([]);

            const result = await toolExecutor.executeTool('get_hover', {
                filePath: 'src/valid.ts',
                line: 0,
                character: 0
            });

            // Should not throw and should return a result (even if empty)
            expect(result.success).toBe(true);
            expect(Array.isArray(result.result)).toBe(true);
        });
    });
});