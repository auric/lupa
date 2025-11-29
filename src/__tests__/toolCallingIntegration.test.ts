import * as vscode from 'vscode';
import { describe, it, expect, vi, beforeEach, Mocked } from 'vitest';
import { ToolCallingAnalysisProvider } from '../services/toolCallingAnalysisProvider';
import { GitOperationsManager } from '../services/gitOperationsManager';
import { ConversationManager } from '../models/conversationManager';
import { ToolExecutor } from '../models/toolExecutor';
import { ToolRegistry } from '../models/toolRegistry';
import { FindSymbolTool } from '../tools/findSymbolTool';
import { SymbolExtractor } from '../utils/symbolExtractor';
import { WorkspaceSettingsService } from '../services/workspaceSettingsService';
import { ANALYSIS_LIMITS } from '../models/workspaceSettingsSchema';

/**
 * Create a mock WorkspaceSettingsService for testing
 */
function createMockWorkspaceSettings(): WorkspaceSettingsService {
    return {
        getMaxToolCalls: () => ANALYSIS_LIMITS.maxToolCalls.default,
        getMaxIterations: () => ANALYSIS_LIMITS.maxIterations.default,
        getRequestTimeoutSeconds: () => ANALYSIS_LIMITS.requestTimeoutSeconds.default
    } as WorkspaceSettingsService;
}

vi.mock('vscode', async () => {
    const actualVscode = await vi.importActual('vscode');
    return {
        ...actualVscode,
        workspace: {
            textDocuments: [],
            openTextDocument: vi.fn(),
            asRelativePath: vi.fn((uri) => `src/test.ts`)
        },
        commands: {
            executeCommand: vi.fn()
        },
        Position: vi.fn().mockImplementation((line, character) => ({ line, character })),
        Range: vi.fn().mockImplementation((start, end) => ({ start, end })),
        Uri: {
            parse: vi.fn((path) => ({ toString: () => path, fsPath: path }))
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
    getToolInformation: vi.fn().mockReturnValue('\n\nYou have access to tools: find_symbol'),
    generateToolAwareSystemPrompt: vi.fn().mockReturnValue('You are an expert code reviewer with access to tools: find_symbol'),
    generateToolCallingUserPrompt: vi.fn().mockReturnValue('<files_to_review>Sample diff content</files_to_review>')
};

describe('Tool-Calling Integration Tests', () => {
    let toolCallingAnalyzer: ToolCallingAnalysisProvider;
    let conversationManager: ConversationManager;
    let toolExecutor: ToolExecutor;
    let toolRegistry: ToolRegistry;
    let mockWorkspaceSettings: WorkspaceSettingsService;
    let findSymbolTool: FindSymbolTool;
    let tokenSource: vscode.CancellationTokenSource;
    let mockGitOperationsManager: Mocked<GitOperationsManager>;
    let mockSymbolExtractor: Mocked<SymbolExtractor>;

    beforeEach(() => {
        // Initialize the tool-calling system
        toolRegistry = new ToolRegistry();
        mockWorkspaceSettings = createMockWorkspaceSettings();
        toolExecutor = new ToolExecutor(toolRegistry, mockWorkspaceSettings);
        conversationManager = new ConversationManager();

        mockGitOperationsManager = {
            getRepository: vi.fn().mockReturnValue({
                rootUri: { fsPath: '/test/repo' }
            })
        } as any;

        mockSymbolExtractor = {
            getGitRootPath: vi.fn().mockReturnValue('/test/repo'),
            getPathStat: vi.fn(),
            extractSymbolsWithContext: vi.fn(),
            getDirectorySymbols: vi.fn(),
            getTextDocument: vi.fn()
        } as any;
        findSymbolTool = new FindSymbolTool(mockGitOperationsManager, mockSymbolExtractor);
        toolRegistry.registerTool(findSymbolTool);

        // Initialize orchestrator
        toolCallingAnalyzer = new ToolCallingAnalysisProvider(
            conversationManager,
            toolExecutor,
            mockCopilotModelManager as any,
            mockPromptGenerator as any,
            mockWorkspaceSettings
        );

        // Clear all mocks
        vi.clearAllMocks();

        vi.mocked(vscode.CancellationTokenSource).mockImplementation(() => {
            const listeners: Array<(e: any) => any> = [];
            let isCancelled = false;

            const token: vscode.CancellationToken = {
                get isCancellationRequested() { return isCancelled; },
                onCancellationRequested: vi.fn((listener: (e: any) => any) => {
                    listeners.push(listener);
                    return {
                        dispose: vi.fn(() => {
                            const index = listeners.indexOf(listener);
                            if (index !== -1) {
                                listeners.splice(index, 1);
                            }
                        })
                    };
                })
            };

            return {
                token: token,
                cancel: vi.fn(() => {
                    isCancelled = true;
                    // Create a copy of listeners array before iteration
                    [...listeners].forEach(listener => listener(undefined)); // Pass undefined or a specific event if needed
                }),
                dispose: vi.fn()
            } as unknown as vscode.CancellationTokenSource; // Cast to assure TS it's a CancellationTokenSource
        });
        tokenSource = new vscode.CancellationTokenSource();
    });

    describe('End-to-End Tool-Calling Workflow', () => {
        it('should complete full analysis without tool calls', async () => {
            // Mock LLM response without tool calls
            mockCopilotModelManager.sendRequest.mockResolvedValue({
                content: 'This is a straightforward analysis without tool calls.',
                toolCalls: null
            });

            const diff = 'diff --git a/test.js b/test.js\n+console.log("hello");';
            const result = await toolCallingAnalyzer.analyze(diff, tokenSource.token);

            expect(result.analysis).toBe('This is a straightforward analysis without tool calls.');
            expect(mockCopilotModelManager.sendRequest).toHaveBeenCalledTimes(1);

            // Verify conversation history
            const history = conversationManager.getHistory();
            expect(history).toHaveLength(2); // User message + Assistant response
            expect(history[0].role).toBe('user');
            expect(history[1].role).toBe('assistant');
        });

        it('should handle single tool call workflow', async () => {
            // Mock VS Code environment for symbol finding
            const mockDocument = {
                getText: vi.fn().mockReturnValue('class MyClass {\n  constructor() {}\n}'),
                uri: { toString: () => 'file:///test.ts', fsPath: '/test.ts' },
                lineAt: vi.fn().mockReturnValue({ text: 'class MyClass {' })
            };

            const mockDefinition = {
                uri: mockDocument.uri,
                range: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } }
            };

            vi.mocked(vscode.workspace).textDocuments = [mockDocument as any];
            vi.mocked(vscode.commands.executeCommand).mockResolvedValue([mockDefinition]);
            vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue({
                getText: vi.fn().mockReturnValue('class MyClass {\n  constructor() {}\n}'),
                lineAt: vi.fn().mockReturnValue({ text: 'class MyClass {' }),
                lineCount: 3
            } as any);

            // Mock LLM responses
            mockCopilotModelManager.sendRequest
                .mockResolvedValueOnce({
                    content: 'I need to understand the MyClass symbol better.',
                    toolCalls: [
                        {
                            id: 'call_1',
                            function: {
                                name: 'find_symbol',
                                arguments: JSON.stringify({ name_path: 'MyClass' })
                            }
                        }
                    ]
                })
                .mockResolvedValueOnce({
                    content: 'Based on the symbol definition, this is a class with a constructor.',
                    toolCalls: null
                });

            const diff = 'diff --git a/test.js b/test.js\n+const obj = new MyClass();';
            const result = await toolCallingAnalyzer.analyze(diff, tokenSource.token);

            expect(result.analysis).toContain('Based on the symbol definition');
            expect(mockCopilotModelManager.sendRequest).toHaveBeenCalledTimes(2);

            // Verify conversation flow
            const history = conversationManager.getHistory();
            expect(history).toHaveLength(4); // User + Assistant (with tool call) + Tool response + Final assistant
            expect(history[0].role).toBe('user');
            expect(history[1].role).toBe('assistant');
            expect(history[1].toolCalls).toHaveLength(1);
            expect(history[2].role).toBe('tool');
            expect(history[2].toolCallId).toBe('call_1');
            expect(history[3].role).toBe('assistant');
        });

        it('should handle multiple tool calls in parallel', async () => {
            // Mock VS Code environment
            const mockDocument = {
                getText: vi.fn().mockReturnValue('class MyClass {}\nfunction myFunction() {}'),
                uri: { toString: () => 'file:///test.ts', fsPath: '/test.ts' },
                lineAt: vi.fn().mockReturnValue({ text: 'class MyClass {}' })
            };

            vi.mocked(vscode.workspace).textDocuments = [mockDocument as any];
            vi.mocked(vscode.commands.executeCommand)
                .mockResolvedValueOnce([{ uri: mockDocument.uri, range: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } } }])
                .mockResolvedValueOnce([{ uri: mockDocument.uri, range: { start: { line: 1, character: 9 }, end: { line: 1, character: 19 } } }]);

            vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue({
                getText: vi.fn().mockReturnValue('class MyClass {}\nfunction myFunction() {}'),
                lineAt: vi.fn().mockReturnValue({ text: 'class MyClass {}' }),
                lineCount: 2
            } as any);

            // Mock LLM responses
            mockCopilotModelManager.sendRequest
                .mockResolvedValueOnce({
                    content: 'Let me analyze both symbols.',
                    toolCalls: [
                        {
                            id: 'call_1',
                            function: { name: 'find_symbol', arguments: JSON.stringify({ name_path: 'MyClass' }) }
                        },
                        {
                            id: 'call_2',
                            function: { name: 'find_symbol', arguments: JSON.stringify({ name_path: 'myFunction' }) }
                        }
                    ]
                })
                .mockResolvedValueOnce({
                    content: 'Analysis complete based on both definitions.',
                    toolCalls: null
                });

            const diff = 'diff --git a/test.js b/test.js\n+MyClass and myFunction usage';
            const result = await toolCallingAnalyzer.analyze(diff, tokenSource.token);

            expect(result.analysis).toContain('Analysis complete based on both definitions');
            expect(mockCopilotModelManager.sendRequest).toHaveBeenCalledTimes(2);

            // Verify multiple tool responses in conversation
            const history = conversationManager.getHistory();
            expect(history).toHaveLength(5); // User + Assistant + 2 Tool responses + Final assistant
            expect(history[2].role).toBe('tool');
            expect(history[2].toolCallId).toBe('call_1');
            expect(history[3].role).toBe('tool');
            expect(history[3].toolCallId).toBe('call_2');
        });

        it('should handle tool execution errors gracefully', async () => {
            // Mock LLM response with invalid tool call
            mockCopilotModelManager.sendRequest
                .mockResolvedValueOnce({
                    content: 'Let me find a non-existent symbol.',
                    toolCalls: [
                        {
                            id: 'call_1',
                            function: {
                                name: 'find_symbol',
                                arguments: JSON.stringify({ name_path: 'NonExistentSymbol' })
                            }
                        }
                    ]
                })
                .mockResolvedValueOnce({
                    content: 'I could not find the symbol, but I can still provide analysis.',
                    toolCalls: null
                });

            // Mock empty VS Code environment
            vi.mocked(vscode.workspace).textDocuments = [];

            const diff = 'diff --git a/test.js b/test.js\n+// some change';
            const result = await toolCallingAnalyzer.analyze(diff, tokenSource.token);

            expect(result.analysis).toContain('I could not find the symbol');

            // Verify tool error is captured in conversation
            const history = conversationManager.getHistory();
            const toolMessage = history.find(m => m.role === 'tool');
            expect(toolMessage?.content).toContain('Symbol \'NonExistentSymbol\' not found');
        });

        it('should handle LLM errors during conversation', async () => {
            // Mock LLM error
            mockCopilotModelManager.sendRequest.mockRejectedValue(new Error('LLM service unavailable'));

            const diff = 'diff --git a/test.js b/test.js\n+console.log("test");';
            const result = await toolCallingAnalyzer.analyze(diff, tokenSource.token);

            expect(result.analysis).toContain('Error during analysis');
            expect(result.analysis).toContain('LLM service unavailable');
        });

        it('should prevent infinite loops with max iterations', async () => {
            // Mock LLM that always wants to call tools
            mockCopilotModelManager.sendRequest.mockResolvedValue({
                content: 'Let me call a tool again.',
                toolCalls: [
                    {
                        id: 'call_infinite',
                        function: { name: 'find_symbol', arguments: JSON.stringify({ name_path: 'test' }) }
                    }
                ]
            });

            // Mock empty VS Code environment
            vi.mocked(vscode.workspace).textDocuments = [];

            const diff = 'diff --git a/test.js b/test.js\n+// change';
            const result = await toolCallingAnalyzer.analyze(diff, tokenSource.token);

            expect(result.analysis).toContain('maximum iterations');
            // Uses configured max iterations from WorkspaceSettingsService
            expect(mockCopilotModelManager.sendRequest).toHaveBeenCalledTimes(
                ANALYSIS_LIMITS.maxIterations.default
            );
        });
    });

    describe('System Integration', () => {
        it('should properly initialize all components', () => {
            expect(toolRegistry.getToolNames()).toContain('find_symbol');
            expect(toolExecutor.isToolAvailable('find_symbol')).toBe(true);
            expect(conversationManager.getMessageCount()).toBe(0);
        });

        it('should generate proper system prompt with tools', async () => {
            mockCopilotModelManager.sendRequest.mockResolvedValue({
                content: 'Analysis complete',
                toolCalls: null
            });

            await toolCallingAnalyzer.analyze('test diff', tokenSource.token);

            const sendRequestCall = mockCopilotModelManager.sendRequest.mock.calls[0][0];
            expect(sendRequestCall.messages[0].role).toBe('system');
            expect(sendRequestCall.messages[0].content).toContain('find_symbol');
            expect(sendRequestCall.tools).toHaveLength(1);
            expect(sendRequestCall.tools[0].name).toBe('find_symbol');
        });

        it('should handle malformed tool call arguments', async () => {
            mockCopilotModelManager.sendRequest
                .mockResolvedValueOnce({
                    content: 'Calling tool with bad args.',
                    toolCalls: [
                        {
                            id: 'call_1',
                            function: {
                                name: 'find_symbol',
                                arguments: 'invalid json'
                            }
                        }
                    ]
                })
                .mockResolvedValueOnce({
                    content: 'Handling the error gracefully.',
                    toolCalls: null
                });

            const diff = 'diff --git a/test.js b/test.js\n+// test';
            const result = await toolCallingAnalyzer.analyze(diff, tokenSource.token);

            expect(result.analysis).toContain('Handling the error gracefully');

            // Should still complete despite malformed JSON
            const history = conversationManager.getHistory();
            expect(history.some(m => m.role === 'tool')).toBe(true);
        });
    });

    describe('Resource Management', () => {
        it('should dispose all services properly', () => {
            expect(() => {
                toolCallingAnalyzer.dispose();
                conversationManager.dispose();
                toolExecutor.dispose();
                toolRegistry.dispose();
            }).not.toThrow();
        });
    });
});