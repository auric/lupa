import * as vscode from 'vscode';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolCallingAnalysisProvider } from '../services/toolCallingAnalysisProvider';
import { ConversationManager } from '../models/conversationManager';
import { ToolExecutor } from '../models/toolExecutor';
import { ToolRegistry } from '../models/toolRegistry';
import { ListDirTool } from '../tools/listDirTool';
import { GitOperationsManager } from '../services/gitOperationsManager';
import { WorkspaceSettingsService } from '../services/workspaceSettingsService';
import { SubagentSessionManager } from '../services/subagentSessionManager';
import { createMockWorkspaceSettings, createMockCancellationTokenSource } from './testUtils/mockFactories';

vi.mock('vscode', async (importOriginal) => {
    const vscodeMock = await importOriginal<typeof vscode>();
    return {
        ...vscodeMock,
        workspace: {
            ...vscodeMock.workspace,
            workspaceFolders: [
                {
                    uri: {
                        fsPath: '/test/workspace'
                    }
                }
            ],
            fs: {
                readDirectory: vi.fn(),
                readFile: vi.fn()
            }
        },
        Uri: {
            ...vscodeMock.Uri,
            file: vi.fn((filePath) => ({ fsPath: filePath, toString: () => filePath }))
        }
    };
});

const mockModel = {
    countTokens: vi.fn(() => Promise.resolve(100)),
    maxInputTokens: 8000
};

const mockCopilotModelManager = {
    getCurrentModel: vi.fn(() => Promise.resolve(mockModel)),
    sendRequest: vi.fn()
};

const mockPromptGenerator = {
    getSystemPrompt: vi.fn().mockReturnValue('You are an expert code reviewer.'),
    getToolInformation: vi.fn().mockReturnValue('\n\nYou have access to tools: list_directory'),
    generateToolAwareSystemPrompt: vi.fn().mockReturnValue('You are an expert code reviewer with access to tools: list_directory'),
    generateToolCallingUserPrompt: vi.fn().mockReturnValue('<files_to_review>Sample diff content</files_to_review>')
};

describe('ListDirTool Integration Tests', () => {
    let toolCallingAnalyzer: ToolCallingAnalysisProvider;
    let conversationManager: ConversationManager;
    let toolExecutor: ToolExecutor;
    let toolRegistry: ToolRegistry;
    let mockWorkspaceSettings: WorkspaceSettingsService;
    let listDirTool: ListDirTool;
    let mockReadDirectory: ReturnType<typeof vi.fn>;
    let mockGetRepository: ReturnType<typeof vi.fn>;
    let mockGitOperationsManager: GitOperationsManager;
    let subagentSessionManager: SubagentSessionManager;
    let tokenSource: vscode.CancellationTokenSource;

    beforeEach(() => {
        // Initialize the tool-calling system
        toolRegistry = new ToolRegistry();
        mockWorkspaceSettings = createMockWorkspaceSettings();
        toolExecutor = new ToolExecutor(toolRegistry, mockWorkspaceSettings);
        conversationManager = new ConversationManager();

        mockGetRepository = vi.fn().mockReturnValue({
            rootUri: {
                fsPath: '/test/git-repo'
            }
        });

        mockGitOperationsManager = {
            getRepository: mockGetRepository
        } as any;

        // Initialize tools
        listDirTool = new ListDirTool(mockGitOperationsManager);
        toolRegistry.registerTool(listDirTool);

        subagentSessionManager = new SubagentSessionManager(mockWorkspaceSettings);

        // Initialize orchestrator
        toolCallingAnalyzer = new ToolCallingAnalysisProvider(
            conversationManager,
            toolExecutor,
            mockCopilotModelManager as any,
            mockPromptGenerator as any,
            mockWorkspaceSettings,
            subagentSessionManager
        );

        mockReadDirectory = vscode.workspace.fs.readDirectory as ReturnType<typeof vi.fn>;

        // Clear all mocks
        vi.clearAllMocks();

        // Re-setup the essential mocks after clearing
        mockGetRepository.mockReturnValue({
            rootUri: {
                fsPath: '/test/git-repo'
            }
        });
        // Use shared CancellationTokenSource mock from mockFactories
        vi.mocked(vscode.CancellationTokenSource).mockImplementation(function (this: any) {
            const mock = createMockCancellationTokenSource();
            this.token = mock.token;
            this.cancel = mock.cancel;
            this.dispose = mock.dispose;
        });
        tokenSource = new vscode.CancellationTokenSource();
    });

    describe('End-to-End List Directory Workflow', () => {
        it('should handle list directory tool call workflow', async () => {
            // Mock directory structure
            const mockEntries: [string, vscode.FileType][] = [
                ['src', vscode.FileType.Directory],
                ['package.json', vscode.FileType.File],
                ['README.md', vscode.FileType.File],
                ['node_modules', vscode.FileType.Directory], // Should be ignored
                ['.git', vscode.FileType.Directory] // Should be ignored
            ];

            mockReadDirectory.mockResolvedValue(mockEntries);

            // Mock LLM requesting to list directory
            mockCopilotModelManager.sendRequest
                .mockResolvedValueOnce({
                    content: '',
                    toolCalls: [{
                        id: 'call_123',
                        function: {
                            name: 'list_directory',
                            arguments: '{"relative_path": ".", "recursive": false}'
                        }
                    }]
                })
                .mockResolvedValueOnce({
                    content: 'Based on the directory listing, I can see the project structure contains a src directory, package.json, and README.md.',
                    toolCalls: null
                });

            const diff = 'diff --git a/src/index.js b/src/index.js\n+console.log("hello");';
            const result = await toolCallingAnalyzer.analyze(diff, tokenSource.token);

            expect(result.analysis).toContain('Based on the directory listing');
            expect(result.analysis).toContain('project structure');
            expect(mockCopilotModelManager.sendRequest).toHaveBeenCalledTimes(2);

            // Verify tool was called with correct arguments
            expect(toolExecutor.executeTools).toHaveBeenCalled();

            // Verify conversation history includes tool call and response
            const history = conversationManager.getHistory();
            expect(history.length).toBeGreaterThan(2);

            // Check that the tool response is in the history
            const toolResponseMessage = history.find(msg =>
                msg.role === 'tool' &&
                msg.content &&
                typeof msg.content === 'string' &&
                msg.content.includes('src/')
            );
            expect(toolResponseMessage).toBeDefined();
        });

        it('should handle recursive directory listing tool call', async () => {
            // Mock nested directory structure
            mockReadDirectory
                .mockResolvedValueOnce([
                    ['src', vscode.FileType.Directory],
                    ['package.json', vscode.FileType.File]
                ])
                .mockResolvedValueOnce([
                    ['components', vscode.FileType.Directory],
                    ['index.js', vscode.FileType.File]
                ])
                .mockResolvedValueOnce([
                    ['Button.jsx', vscode.FileType.File],
                    ['Modal.jsx', vscode.FileType.File]
                ]);

            // Mock LLM requesting recursive directory listing
            mockCopilotModelManager.sendRequest
                .mockResolvedValueOnce({
                    content: '',
                    toolCalls: [{
                        id: 'call_456',
                        function: {
                            name: 'list_directory',
                            arguments: '{"relative_path": ".", "recursive": true}'
                        }
                    }]
                })
                .mockResolvedValueOnce({
                    content: 'The recursive listing shows a well-structured React project with components in src/components/.',
                    toolCalls: null
                });

            const diff = 'diff --git a/src/components/NewComponent.jsx b/src/components/NewComponent.jsx\n+export default NewComponent;';
            const result = await toolCallingAnalyzer.analyze(diff, tokenSource.token);

            expect(result.analysis).toContain('recursive listing');
            expect(result.analysis).toContain('React project');
            expect(mockCopilotModelManager.sendRequest).toHaveBeenCalledTimes(2);
        });

        it('should handle directory listing errors gracefully', async () => {
            // Mock directory read error
            mockReadDirectory.mockRejectedValue(new Error('Permission denied'));

            // Mock LLM requesting directory listing
            mockCopilotModelManager.sendRequest
                .mockResolvedValueOnce({
                    content: '',
                    toolCalls: [{
                        id: 'call_error',
                        function: {
                            name: 'list_directory',
                            arguments: '{"relative_path": "restricted", "recursive": false}'
                        }
                    }]
                })
                .mockResolvedValueOnce({
                    content: 'I encountered an error accessing the directory. I\'ll proceed with the analysis based on the diff alone.',
                    toolCalls: null
                });

            const diff = 'diff --git a/test.js b/test.js\n+console.log("test");';
            const result = await toolCallingAnalyzer.analyze(diff, tokenSource.token);

            expect(result.analysis).toContain('error accessing the directory');
            expect(mockCopilotModelManager.sendRequest).toHaveBeenCalledTimes(2);

            // Verify error was passed to LLM
            const history = conversationManager.getHistory();
            const errorMessage = history.find(msg =>
                msg.role === 'tool' &&
                msg.content &&
                typeof msg.content === 'string' &&
                msg.content.includes('Error listing directory')
            );
            expect(errorMessage).toBeDefined();
        });

        it('should handle directory traversal prevention', async () => {
            // Mock LLM attempting directory traversal
            mockCopilotModelManager.sendRequest
                .mockResolvedValueOnce({
                    content: '',
                    toolCalls: [{
                        id: 'call_traversal',
                        function: {
                            name: 'list_directory',
                            arguments: '{"relative_path": "../../../etc", "recursive": false}'
                        }
                    }]
                })
                .mockResolvedValueOnce({
                    content: 'I cannot access directories outside the project workspace for security reasons.',
                    toolCalls: null
                });

            const diff = 'diff --git a/config.js b/config.js\n+const config = {};';
            const result = await toolCallingAnalyzer.analyze(diff, tokenSource.token);

            expect(result.analysis).toContain('cannot access directories outside');
            expect(mockCopilotModelManager.sendRequest).toHaveBeenCalledTimes(2);

            // Verify security error was passed to LLM
            const history = conversationManager.getHistory();
            const securityMessage = history.find(msg =>
                msg.role === 'tool' &&
                msg.content &&
                typeof msg.content === 'string' &&
                msg.content.includes('Directory traversal detected')
            );
            expect(securityMessage).toBeDefined();
        });

        it('should handle multiple tool calls including list directory', async () => {
            // Mock directory structure
            mockReadDirectory.mockResolvedValue([
                ['src', vscode.FileType.Directory],
                ['test', vscode.FileType.Directory],
                ['package.json', vscode.FileType.File]
            ]);

            // Mock LLM making multiple tool calls
            mockCopilotModelManager.sendRequest
                .mockResolvedValueOnce({
                    content: '',
                    toolCalls: [
                        {
                            id: 'call_list',
                            function: {
                                name: 'list_directory',
                                arguments: '{"relative_path": ".", "recursive": false}'
                            }
                        }
                    ]
                })
                .mockResolvedValueOnce({
                    content: 'Based on the project structure, this appears to be a well-organized codebase with separate src and test directories.',
                    toolCalls: null
                });

            const diff = 'diff --git a/src/utils.js b/src/utils.js\n+export const helper = () => {};';
            const result = await toolCallingAnalyzer.analyze(diff, tokenSource.token);

            expect(result.analysis).toContain('well-organized codebase');
            expect(result.analysis).toContain('src and test directories');
            expect(mockCopilotModelManager.sendRequest).toHaveBeenCalledTimes(2);

            // Verify all tools were executed
            const history = conversationManager.getHistory();
            expect(history.length).toBeGreaterThan(2);
        });
    });

    describe('Tool Registration and Discovery', () => {
        it('should register ListDirTool correctly', () => {
            expect(toolRegistry.hasTool('list_directory')).toBe(true);
            expect(toolRegistry.getTool('list_directory')).toBe(listDirTool);
        });

        it('should provide correct tool information to LLM', () => {
            const tool = toolRegistry.getTool('list_directory');
            expect(tool).toBeDefined();
            expect(tool!.name).toBe('list_directory');
            expect(tool!.description).toContain('List files and directories');

            const vscodeToolDef = tool!.getVSCodeTool();
            expect(vscodeToolDef.inputSchema).toBeDefined();
            expect(vscodeToolDef.inputSchema).toHaveProperty('properties');
            expect((vscodeToolDef.inputSchema as any).properties).toHaveProperty('relative_path');
            expect((vscodeToolDef.inputSchema as any).properties).toHaveProperty('recursive');
        });
    });
});
