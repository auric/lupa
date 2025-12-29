import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';
import * as vscode from 'vscode';
import { ToolCallingAnalysisProvider } from '../services/toolCallingAnalysisProvider';
import { TokenConstants } from '../models/tokenConstants';
import { SubagentSessionManager } from '../services/subagentSessionManager';
import {
    createMockWorkspaceSettings,
    createMockCancellationTokenSource,
} from './testUtils/mockFactories';

// Mock VS Code
vi.mock('vscode');

// Mock dependencies
vi.mock('../utils/diffUtils', () => ({
    DiffUtils: {
        parseDiff: vi.fn(() => ({ files: [], hunks: [] })),
    },
}));

vi.mock('../services/loggingService', () => ({
    Log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

describe('ToolCallingAnalysisProvider Enhanced Integration', () => {
    let analysisProvider: ToolCallingAnalysisProvider;
    let mockConversationManager: {
        clearHistory: Mock;
        addUserMessage: Mock;
        addAssistantMessage: Mock;
        addToolMessage: Mock;
        getHistory: Mock;
    };
    let mockToolExecutor: {
        getAvailableTools: Mock;
        executeTools: Mock;
        resetToolCallCount: Mock;
        setCurrentPlanManager: Mock;
        getCurrentPlanManager: Mock;
        clearCurrentPlanManager: Mock;
    };
    let mockCopilotModelManager: {
        getCurrentModel: Mock;
        sendRequest: Mock;
    };
    let mockPromptGenerator: {
        generateToolAwareSystemPrompt: Mock;
        generateToolCallingUserPrompt: Mock;
    };
    let mockModel: {
        countTokens: Mock;
        maxInputTokens: number;
    };
    let subagentSessionManager: SubagentSessionManager;
    let tokenSource: vscode.CancellationTokenSource;

    beforeEach(() => {
        // Setup mocks
        mockConversationManager = {
            clearHistory: vi.fn(),
            addUserMessage: vi.fn(),
            addAssistantMessage: vi.fn(),
            addToolMessage: vi.fn(),
            getHistory: vi.fn(() => []),
        };

        mockModel = {
            countTokens: vi.fn(() => Promise.resolve(100)),
            maxInputTokens: 8000,
        };

        mockCopilotModelManager = {
            getCurrentModel: vi.fn(() => Promise.resolve(mockModel)),
            sendRequest: vi.fn(),
        };

        mockToolExecutor = {
            getAvailableTools: vi.fn(() => []),
            executeTools: vi.fn(() => Promise.resolve([])),
            resetToolCallCount: vi.fn(),
            setCurrentPlanManager: vi.fn(),
            getCurrentPlanManager: vi.fn(() => undefined),
            clearCurrentPlanManager: vi.fn(),
        };

        mockPromptGenerator = {
            generateToolAwareSystemPrompt: vi.fn(() => 'System prompt'),
            generateToolCallingUserPrompt: vi.fn(() => 'User message'),
        };

        const mockWorkspaceSettings = createMockWorkspaceSettings();
        subagentSessionManager = new SubagentSessionManager(
            mockWorkspaceSettings
        );
        analysisProvider = new ToolCallingAnalysisProvider(
            mockConversationManager as any,
            mockToolExecutor as any,
            mockCopilotModelManager as any,
            mockPromptGenerator as any,
            mockWorkspaceSettings,
            subagentSessionManager
        );

        vi.mocked(vscode.CancellationTokenSource).mockImplementation(function (
            this: any
        ) {
            const mock = createMockCancellationTokenSource();
            this.token = mock.token;
            this.cancel = mock.cancel;
            this.dispose = mock.dispose;
        });
        tokenSource = new vscode.CancellationTokenSource();
    });

    describe('Token validation and context management', () => {
        it('should handle large conversations by cleaning up old context', async () => {
            const smallDiff =
                'diff --git a/file.ts b/file.ts\nindex abc..def\n--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,3 @@\n-old line\n+new line';

            // Mock conversation history with many messages that exceed token limits
            const longHistory = [
                {
                    role: 'user',
                    content: 'Initial request',
                    toolCalls: undefined,
                    toolCallId: undefined,
                },
                {
                    role: 'assistant',
                    content: 'I will call a tool',
                    toolCalls: [
                        {
                            id: 'call_1',
                            function: { name: 'tool1', arguments: '{}' },
                        },
                    ],
                    toolCallId: undefined,
                },
                {
                    role: 'tool',
                    content: 'A'.repeat(2000),
                    toolCalls: undefined,
                    toolCallId: 'call_1',
                },
                {
                    role: 'assistant',
                    content: 'I will call another tool',
                    toolCalls: [
                        {
                            id: 'call_2',
                            function: { name: 'tool2', arguments: '{}' },
                        },
                    ],
                    toolCallId: undefined,
                },
                {
                    role: 'tool',
                    content: 'B'.repeat(2000),
                    toolCalls: undefined,
                    toolCallId: 'call_2',
                },
            ];

            mockConversationManager.getHistory.mockReturnValue(longHistory);

            // Mock high token counts to trigger context cleanup
            mockModel.countTokens.mockImplementation(async (text: string) => {
                if (text.includes('System')) {
                    return 100;
                }
                if (text === smallDiff) {
                    return 50;
                } // Small diff should have low token count
                if (
                    text.includes('A'.repeat(1000)) ||
                    text.includes('A'.repeat(2000))
                ) {
                    return 2000;
                } // Large tool responses
                if (
                    text.includes('B'.repeat(1000)) ||
                    text.includes('B'.repeat(2000))
                ) {
                    return 2000;
                }
                // High token count to trigger warning threshold but not max
                return 1500; // This should accumulate to exceed warning threshold
            });

            // Mock LLM response without tool calls (final response)
            mockCopilotModelManager.sendRequest.mockResolvedValue({
                content: 'Final analysis based on available context',
                toolCalls: undefined,
            });

            const result = await analysisProvider.analyze(
                smallDiff,
                tokenSource.token
            );

            expect(result.analysis).toBe(
                'Final analysis based on available context'
            );
            expect(mockConversationManager.clearHistory).toHaveBeenCalled();
            // Verify that user message was added (content may vary based on implementation)
            expect(mockConversationManager.addUserMessage).toHaveBeenCalled();
        });

        it('should request final answer when context window is completely full', async () => {
            const smallDiff = 'small diff';

            // Mock very high token counts to trigger final answer request
            mockModel.countTokens.mockImplementation(async (text: string) => {
                if (text.includes('System')) {
                    return 100;
                }
                if (text === smallDiff) {
                    return 50;
                } // Small diff should have low token count
                return 8000; // High token count for messages to exceed max tokens
            });

            mockCopilotModelManager.sendRequest.mockResolvedValue({
                content: 'Final analysis with limited context',
                toolCalls: undefined,
            });

            const result = await analysisProvider.analyze(
                smallDiff,
                tokenSource.token
            );

            expect(result.analysis).toBe('Final analysis with limited context');
            // Verify that user message was added (content may vary based on implementation)
            expect(mockConversationManager.addUserMessage).toHaveBeenCalled();
        });
    });

    describe('Tool response size validation', () => {
        it('should handle tools that return responses exceeding size limits', async () => {
            const smallDiff = 'small diff';

            // Mock a tool that returns oversized response
            const mockReadFileTool = {
                name: 'read_file',
                description: 'Read file content',
                schema: {},
                getVSCodeTool: () => ({
                    name: 'read_file',
                    description: 'Read file',
                    inputSchema: {},
                }),
            };

            mockToolExecutor.getAvailableTools.mockReturnValue([
                mockReadFileTool,
            ]);

            // Mock LLM requesting tool call
            mockCopilotModelManager.sendRequest
                .mockResolvedValueOnce({
                    content: 'I will read the file',
                    toolCalls: [
                        {
                            id: 'call_1',
                            function: {
                                name: 'read_file',
                                arguments: JSON.stringify({
                                    filePath: 'large-file.ts',
                                }),
                            },
                        },
                    ],
                })
                .mockResolvedValueOnce({
                    content: 'Analysis based on error message',
                    toolCalls: undefined,
                });

            // Mock tool execution that fails due to size
            mockToolExecutor.executeTools.mockResolvedValue([
                {
                    name: 'read_file',
                    success: false,
                    error: `${TokenConstants.TOOL_CONTEXT_MESSAGES.RESPONSE_TOO_LARGE} Tool 'read_file' returned 10000 characters, maximum allowed: ${TokenConstants.MAX_TOOL_RESPONSE_CHARS}.`,
                },
            ]);

            const result = await analysisProvider.analyze(
                smallDiff,
                tokenSource.token
            );

            expect(result.analysis).toBe('Analysis based on error message');
            expect(mockConversationManager.addToolMessage).toHaveBeenCalledWith(
                'call_1',
                expect.stringContaining(
                    TokenConstants.TOOL_CONTEXT_MESSAGES.RESPONSE_TOO_LARGE
                )
            );
        });
    });

    describe('Diff size processing and tool availability', () => {
        it('should disable tools when diff is too large', async () => {
            // Mock high token count for the diff
            mockModel.countTokens.mockImplementation(async (text: string) => {
                if (text.includes('System')) {
                    return 100;
                }
                if (text.includes('User message')) {
                    return 5700;
                } // user message is where the diff is included
                return 50;
            });

            mockCopilotModelManager.sendRequest.mockResolvedValue({
                content: 'Analysis of truncated diff without tools',
                toolCalls: undefined,
            });

            const doesntMatterDiff =
                'diff --git a/file.ts b/file.ts\nindex abc..def\n--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,3 @@\n-old line\n+new line';
            const result = await analysisProvider.analyze(
                doesntMatterDiff,
                tokenSource.token
            );

            expect(result.analysis).toBe(
                'Analysis of truncated diff without tools'
            );

            // Should generate system prompt with no tools
            expect(
                mockPromptGenerator.generateToolAwareSystemPrompt
            ).toHaveBeenCalledWith([]);

            // Should add tools disabled message to user prompt
            expect(
                mockPromptGenerator.generateToolCallingUserPrompt
            ).toHaveBeenCalledWith(expect.any(Object));

            expect(mockConversationManager.addUserMessage).toHaveBeenCalledWith(
                expect.stringContaining(
                    TokenConstants.TOOL_CONTEXT_MESSAGES.TOOLS_DISABLED
                )
            );
        });

        it('should keep tools available when diff is reasonably sized', async () => {
            const reasonableDiff =
                'diff --git a/file.ts b/file.ts\nindex abc..def\n--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,3 @@\n-old line\n+new line';

            const mockTools = [
                { name: 'read_file', getVSCodeTool: () => ({}) },
                { name: 'find_symbol', getVSCodeTool: () => ({}) },
            ];

            mockToolExecutor.getAvailableTools.mockReturnValue(mockTools);

            // Mock reasonable token counts
            mockModel.countTokens.mockImplementation(async (text: string) => {
                if (text.includes('System')) {
                    return 100;
                }
                if (text === reasonableDiff) {
                    return 200;
                } // Small diff
                return 50;
            });

            mockCopilotModelManager.sendRequest.mockResolvedValue({
                content: 'Analysis with tools available',
                toolCalls: undefined,
            });

            const result = await analysisProvider.analyze(
                reasonableDiff,
                tokenSource.token
            );

            expect(result.analysis).toBe('Analysis with tools available');

            // Should generate system prompt with tools available
            expect(
                mockPromptGenerator.generateToolAwareSystemPrompt
            ).toHaveBeenCalledWith(mockTools);

            // User message should not contain tools disabled message
            expect(mockConversationManager.addUserMessage).toHaveBeenCalledWith(
                expect.not.stringContaining(
                    TokenConstants.TOOL_CONTEXT_MESSAGES.TOOLS_DISABLED
                )
            );
        });
    });

    describe('Complete workflow integration', () => {
        it('should handle full analysis workflow with tool calls and context management', async () => {
            const diff =
                'diff --git a/src/test.ts b/src/test.ts\nindex abc..def\n--- a/src/test.ts\n+++ b/src/test.ts\n@@ -1,3 +1,3 @@\n-function old() {}\n+function new() {}';

            const mockTool = {
                name: 'read_file',
                getVSCodeTool: () => ({
                    name: 'read_file',
                    description: 'Read file',
                    inputSchema: {},
                }),
            };

            mockToolExecutor.getAvailableTools.mockReturnValue([mockTool]);

            // Simulate conversation flow
            mockCopilotModelManager.sendRequest
                .mockResolvedValueOnce({
                    content:
                        'I need to read the file to understand the changes',
                    toolCalls: [
                        {
                            id: 'call_1',
                            function: {
                                name: 'read_file',
                                arguments: JSON.stringify({
                                    filePath: 'src/test.ts',
                                }),
                            },
                        },
                    ],
                })
                .mockResolvedValueOnce({
                    content:
                        'Based on the file content, here is my analysis: The function was renamed from old() to new().',
                    toolCalls: undefined,
                });

            // Mock successful tool execution
            mockToolExecutor.executeTools.mockResolvedValue([
                {
                    name: 'read_file',
                    success: true,
                    result: '<file_content>\n  <file>src/test.ts</file>\n  <content>\n1: function new() {}\n2: // Additional context\n  </content>\n</file_content>',
                },
            ]);

            const result = await analysisProvider.analyze(
                diff,
                tokenSource.token
            );

            expect(result.analysis).toBe(
                'Based on the file content, here is my analysis: The function was renamed from old() to new().'
            );

            // Verify conversation flow
            expect(mockConversationManager.clearHistory).toHaveBeenCalled();
            expect(mockConversationManager.addUserMessage).toHaveBeenCalledWith(
                expect.stringContaining('User message') // From promptGenerator
            );
            expect(
                mockConversationManager.addAssistantMessage
            ).toHaveBeenCalledWith(
                'I need to read the file to understand the changes',
                expect.arrayContaining([
                    expect.objectContaining({ id: 'call_1' }),
                ])
            );
            expect(mockConversationManager.addToolMessage).toHaveBeenCalledWith(
                'call_1',
                expect.stringContaining('<file_content>')
            );
            expect(
                mockConversationManager.addAssistantMessage
            ).toHaveBeenCalledWith(
                expect.stringContaining('Based on the file content'),
                undefined
            );
        });

        it('should handle errors gracefully and continue analysis', async () => {
            const diff = 'small diff';

            mockCopilotModelManager.sendRequest
                .mockRejectedValueOnce(new Error('API Error'))
                .mockResolvedValueOnce({
                    content: 'Analysis after error recovery',
                    toolCalls: undefined,
                });

            const result = await analysisProvider.analyze(
                diff,
                tokenSource.token
            );

            expect(result.analysis).toBe('Analysis after error recovery');
            expect(
                mockConversationManager.addAssistantMessage
            ).toHaveBeenCalledWith(
                expect.stringContaining('I encountered an error')
            );
        });

        it('should handle maximum iteration limit gracefully', async () => {
            const diff = 'small diff';

            // Mock infinite tool calling loop
            mockCopilotModelManager.sendRequest.mockResolvedValue({
                content: 'I need more information',
                toolCalls: [
                    {
                        id: 'call_infinite',
                        function: {
                            name: 'read_file',
                            arguments: '{"filePath": "test.ts"}',
                        },
                    },
                ],
            });

            mockToolExecutor.executeTools.mockResolvedValue([
                {
                    name: 'read_file',
                    success: true,
                    result: ['Some file content'],
                },
            ]);

            const result = await analysisProvider.analyze(
                diff,
                tokenSource.token
            );

            expect(result.analysis).toBe(
                'Conversation reached maximum iterations. The conversation may be incomplete.'
            );
        });
    });

    describe('Error handling', () => {
        it('should handle tool execution errors gracefully', async () => {
            const diff = 'small diff';

            mockCopilotModelManager.sendRequest
                .mockResolvedValueOnce({
                    content: 'I will call a tool',
                    toolCalls: [
                        {
                            id: 'call_1',
                            function: { name: 'broken_tool', arguments: '{}' },
                        },
                    ],
                })
                .mockResolvedValueOnce({
                    content: 'Analysis despite tool failure',
                    toolCalls: undefined,
                });

            mockToolExecutor.executeTools.mockResolvedValue([
                {
                    name: 'broken_tool',
                    success: false,
                    error: 'Tool execution failed',
                },
            ]);

            const result = await analysisProvider.analyze(
                diff,
                tokenSource.token
            );

            expect(result.analysis).toBe('Analysis despite tool failure');
            expect(mockConversationManager.addToolMessage).toHaveBeenCalledWith(
                'call_1',
                'Error: Tool execution failed'
            );
        });

        it('should handle malformed tool call arguments', async () => {
            const diff = 'small diff';

            mockCopilotModelManager.sendRequest
                .mockResolvedValueOnce({
                    content: 'I will call a tool',
                    toolCalls: [
                        {
                            id: 'call_1',
                            function: {
                                name: 'test_tool',
                                arguments: 'invalid json{',
                            },
                        },
                    ],
                })
                .mockResolvedValueOnce({
                    content: 'Analysis with malformed tool call handled',
                    toolCalls: undefined,
                });

            mockToolExecutor.executeTools.mockResolvedValue([
                {
                    name: 'test_tool',
                    success: false,
                    error: 'Invalid arguments',
                },
            ]);

            const result = await analysisProvider.analyze(
                diff,
                tokenSource.token
            );

            expect(result.analysis).toBe(
                'Analysis with malformed tool call handled'
            );
        });
    });
});
