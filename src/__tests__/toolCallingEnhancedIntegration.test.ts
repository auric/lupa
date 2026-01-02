import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';
import * as vscode from 'vscode';
import { z } from 'zod';
import { ToolCallingAnalysisProvider } from '../services/toolCallingAnalysisProvider';
import { TokenConstants } from '../models/tokenConstants';
import { SubmitReviewTool } from '../tools/submitReviewTool';
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
        debug: vi.fn(),
    },
}));

describe('ToolCallingAnalysisProvider Enhanced Integration', () => {
    let analysisProvider: ToolCallingAnalysisProvider;
    let mockToolRegistry: {
        getAllTools: Mock;
        getTool: Mock;
        getToolNames: Mock;
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
    let tokenSource: vscode.CancellationTokenSource;

    beforeEach(() => {
        mockModel = {
            countTokens: vi.fn(() => Promise.resolve(100)),
            maxInputTokens: 8000,
        };

        mockCopilotModelManager = {
            getCurrentModel: vi.fn(() => Promise.resolve(mockModel)),
            sendRequest: vi.fn(),
        };

        mockToolRegistry = {
            getAllTools: vi.fn(() => []),
            getTool: vi.fn(() => undefined),
            getToolNames: vi.fn(() => []),
        };

        mockPromptGenerator = {
            generateToolAwareSystemPrompt: vi.fn(() => 'System prompt'),
            generateToolCallingUserPrompt: vi.fn(() => 'User message'),
        };

        const mockWorkspaceSettings = createMockWorkspaceSettings();
        analysisProvider = new ToolCallingAnalysisProvider(
            mockToolRegistry as any,
            mockCopilotModelManager as any,
            mockPromptGenerator as any,
            mockWorkspaceSettings
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

            // Register SubmitReviewTool for final submission
            const submitReviewTool = new SubmitReviewTool();
            mockToolRegistry.getAllTools.mockReturnValue([submitReviewTool]);
            mockToolRegistry.getTool.mockImplementation((name: string) => {
                if (name === 'submit_review') {
                    return submitReviewTool;
                }
                return undefined;
            });

            // Mock LLM response with submit_review tool call (required to complete analysis)
            mockCopilotModelManager.sendRequest.mockResolvedValue({
                content: null,
                toolCalls: [
                    {
                        id: 'call_final',
                        function: {
                            name: 'submit_review',
                            arguments: JSON.stringify({
                                review_content:
                                    'Final analysis based on available context. Adding padding to ensure minimum 100 character requirement for review_content field.',
                            }),
                        },
                    },
                ],
            });

            const result = await analysisProvider.analyze(
                smallDiff,
                tokenSource.token
            );

            expect(result.analysis).toBe(
                'Final analysis based on available context. Adding padding to ensure minimum 100 character requirement for review_content field.'
            );
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

            // Register SubmitReviewTool for final submission
            const submitReviewTool = new SubmitReviewTool();
            mockToolRegistry.getAllTools.mockReturnValue([submitReviewTool]);
            mockToolRegistry.getTool.mockImplementation((name: string) => {
                if (name === 'submit_review') {
                    return submitReviewTool;
                }
                return undefined;
            });

            mockCopilotModelManager.sendRequest.mockResolvedValue({
                content: null,
                toolCalls: [
                    {
                        id: 'call_final',
                        function: {
                            name: 'submit_review',
                            arguments: JSON.stringify({
                                review_content:
                                    'Final analysis with limited context. Adding padding to ensure minimum 100 character requirement for review_content field.',
                            }),
                        },
                    },
                ],
            });

            const result = await analysisProvider.analyze(
                smallDiff,
                tokenSource.token
            );

            expect(result.analysis).toBe(
                'Final analysis with limited context. Adding padding to ensure minimum 100 character requirement for review_content field.'
            );
        });
    });

    describe('Tool response size validation', () => {
        it('should handle tools that return responses exceeding size limits', async () => {
            const smallDiff = 'small diff';

            // Mock a tool that returns oversized response
            const mockReadFileTool = {
                name: 'read_file',
                description: 'Read file content',
                schema: z.object({}),
                getVSCodeTool: () => ({
                    name: 'read_file',
                    description: 'Read file',
                    inputSchema: {},
                }),
                execute: vi.fn().mockResolvedValue({
                    success: false,
                    error: `${TokenConstants.TOOL_CONTEXT_MESSAGES.RESPONSE_TOO_LARGE} Tool 'read_file' returned 10000 characters, maximum allowed: ${TokenConstants.MAX_TOOL_RESPONSE_CHARS}.`,
                }),
            };

            const submitReviewTool = new SubmitReviewTool();
            mockToolRegistry.getAllTools.mockReturnValue([
                mockReadFileTool,
                submitReviewTool,
            ]);
            mockToolRegistry.getTool.mockImplementation((name: string) => {
                if (name === 'read_file') {
                    return mockReadFileTool;
                }
                if (name === 'submit_review') {
                    return submitReviewTool;
                }
                return undefined;
            });

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
                    content: null,
                    toolCalls: [
                        {
                            id: 'call_final',
                            function: {
                                name: 'submit_review',
                                arguments: JSON.stringify({
                                    review_content:
                                        'Analysis based on error message. Adding padding to ensure minimum 100 character requirement for review_content field.',
                                }),
                            },
                        },
                    ],
                });

            const result = await analysisProvider.analyze(
                smallDiff,
                tokenSource.token
            );

            expect(result.analysis).toBe(
                'Analysis based on error message. Adding padding to ensure minimum 100 character requirement for review_content field.'
            );
            // The tool error is passed to the LLM internally, verifiable through the final result
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

            // Register SubmitReviewTool for final submission (even when tools are disabled for analysis)
            const submitReviewTool = new SubmitReviewTool();
            mockToolRegistry.getTool.mockImplementation((name: string) => {
                if (name === 'submit_review') {
                    return submitReviewTool;
                }
                return undefined;
            });

            mockCopilotModelManager.sendRequest.mockResolvedValue({
                content: null,
                toolCalls: [
                    {
                        id: 'call_final',
                        function: {
                            name: 'submit_review',
                            arguments: JSON.stringify({
                                review_content:
                                    'Analysis of truncated diff without tools. Adding padding to ensure minimum 100 character requirement for review_content field.',
                            }),
                        },
                    },
                ],
            });

            const doesntMatterDiff =
                'diff --git a/file.ts b/file.ts\nindex abc..def\n--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,3 @@\n-old line\n+new line';
            const result = await analysisProvider.analyze(
                doesntMatterDiff,
                tokenSource.token
            );

            expect(result.analysis).toBe(
                'Analysis of truncated diff without tools. Adding padding to ensure minimum 100 character requirement for review_content field.'
            );

            // Should generate system prompt with no tools
            expect(
                mockPromptGenerator.generateToolAwareSystemPrompt
            ).toHaveBeenCalledWith([]);

            // Should add tools disabled message to user prompt
            expect(
                mockPromptGenerator.generateToolCallingUserPrompt
            ).toHaveBeenCalledWith(expect.any(Object));
        });

        it('should keep tools available when diff is reasonably sized', async () => {
            const reasonableDiff =
                'diff --git a/file.ts b/file.ts\nindex abc..def\n--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,3 @@\n-old line\n+new line';

            const submitReviewTool = new SubmitReviewTool();
            const mockTools = [
                { name: 'read_file', getVSCodeTool: () => ({}) },
                { name: 'find_symbol', getVSCodeTool: () => ({}) },
                submitReviewTool,
            ];

            mockToolRegistry.getAllTools.mockReturnValue(mockTools);
            mockToolRegistry.getTool.mockImplementation((name: string) => {
                if (name === 'submit_review') {
                    return submitReviewTool;
                }
                return mockTools.find((t) => t.name === name);
            });

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
                content: null,
                toolCalls: [
                    {
                        id: 'call_final',
                        function: {
                            name: 'submit_review',
                            arguments: JSON.stringify({
                                review_content:
                                    'Analysis with tools available. Adding padding to ensure minimum 100 character requirement for review_content field.',
                            }),
                        },
                    },
                ],
            });

            const result = await analysisProvider.analyze(
                reasonableDiff,
                tokenSource.token
            );

            expect(result.analysis).toBe(
                'Analysis with tools available. Adding padding to ensure minimum 100 character requirement for review_content field.'
            );

            // Should generate system prompt with tools available
            expect(
                mockPromptGenerator.generateToolAwareSystemPrompt
            ).toHaveBeenCalledWith(mockTools);
        });
    });

    describe('Complete workflow integration', () => {
        it('should handle full analysis workflow with tool calls and context management', async () => {
            const diff =
                'diff --git a/src/test.ts b/src/test.ts\nindex abc..def\n--- a/src/test.ts\n+++ b/src/test.ts\n@@ -1,3 +1,3 @@\n-function old() {}\n+function new() {}';

            const mockTool = {
                name: 'read_file',
                schema: z.object({}),
                getVSCodeTool: () => ({
                    name: 'read_file',
                    description: 'Read file',
                    inputSchema: {},
                }),
                execute: vi.fn().mockResolvedValue({
                    success: true,
                    data: '<file_content>\n  <file>src/test.ts</file>\n  <content>\n1: function new() {}\n2: // Additional context\n  </content>\n</file_content>',
                }),
            };

            const submitReviewTool = new SubmitReviewTool();
            mockToolRegistry.getAllTools.mockReturnValue([
                mockTool,
                submitReviewTool,
            ]);
            mockToolRegistry.getTool.mockImplementation((name: string) => {
                if (name === 'read_file') {
                    return mockTool;
                }
                if (name === 'submit_review') {
                    return submitReviewTool;
                }
                return undefined;
            });

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
                    content: null,
                    toolCalls: [
                        {
                            id: 'call_final',
                            function: {
                                name: 'submit_review',
                                arguments: JSON.stringify({
                                    review_content:
                                        'Based on the file content, here is my analysis: The function was renamed from old() to new(). Padding added for minimum character requirement.',
                                }),
                            },
                        },
                    ],
                });

            const result = await analysisProvider.analyze(
                diff,
                tokenSource.token
            );

            expect(result.analysis).toBe(
                'Based on the file content, here is my analysis: The function was renamed from old() to new(). Padding added for minimum character requirement.'
            );

            // Verify the tool was executed as part of the workflow
            expect(mockTool.execute).toHaveBeenCalled();
        });

        it('should handle errors gracefully and continue analysis', async () => {
            const diff = 'small diff';

            // Register SubmitReviewTool for final submission
            const submitReviewTool = new SubmitReviewTool();
            mockToolRegistry.getAllTools.mockReturnValue([submitReviewTool]);
            mockToolRegistry.getTool.mockImplementation((name: string) => {
                if (name === 'submit_review') {
                    return submitReviewTool;
                }
                return undefined;
            });

            mockCopilotModelManager.sendRequest
                .mockRejectedValueOnce(new Error('API Error'))
                .mockResolvedValueOnce({
                    content: null,
                    toolCalls: [
                        {
                            id: 'call_final',
                            function: {
                                name: 'submit_review',
                                arguments: JSON.stringify({
                                    review_content:
                                        'Analysis after error recovery. Adding padding to ensure minimum 100 character requirement for review_content field.',
                                }),
                            },
                        },
                    ],
                });

            const result = await analysisProvider.analyze(
                diff,
                tokenSource.token
            );

            expect(result.analysis).toBe(
                'Analysis after error recovery. Adding padding to ensure minimum 100 character requirement for review_content field.'
            );
            // Error recovery is handled internally, verifiable through successful analysis completion
        });

        it('should handle maximum iteration limit gracefully', async () => {
            const diff = 'small diff';

            const mockTool = {
                name: 'read_file',
                schema: z.object({}),
                getVSCodeTool: () => ({
                    name: 'read_file',
                    description: 'Read file',
                    inputSchema: {},
                }),
                execute: vi.fn().mockResolvedValue({
                    success: true,
                    data: 'Some file content',
                }),
            };

            mockToolRegistry.getAllTools.mockReturnValue([mockTool]);
            mockToolRegistry.getTool.mockReturnValue(mockTool);

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

            const mockBrokenTool = {
                name: 'broken_tool',
                schema: z.object({}),
                getVSCodeTool: () => ({
                    name: 'broken_tool',
                    description: 'Broken tool',
                    inputSchema: {},
                }),
                execute: vi.fn().mockResolvedValue({
                    success: false,
                    error: 'Tool execution failed',
                }),
            };

            const submitReviewTool = new SubmitReviewTool();
            mockToolRegistry.getAllTools.mockReturnValue([
                mockBrokenTool,
                submitReviewTool,
            ]);
            mockToolRegistry.getTool.mockImplementation((name: string) => {
                if (name === 'broken_tool') {
                    return mockBrokenTool;
                }
                if (name === 'submit_review') {
                    return submitReviewTool;
                }
                return undefined;
            });

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
                    content: null,
                    toolCalls: [
                        {
                            id: 'call_final',
                            function: {
                                name: 'submit_review',
                                arguments: JSON.stringify({
                                    review_content:
                                        'Analysis despite tool failure. Adding padding to ensure minimum 100 character requirement for review_content field.',
                                }),
                            },
                        },
                    ],
                });

            const result = await analysisProvider.analyze(
                diff,
                tokenSource.token
            );

            expect(result.analysis).toBe(
                'Analysis despite tool failure. Adding padding to ensure minimum 100 character requirement for review_content field.'
            );
            // The tool error is passed to the LLM internally, verifiable through the final result
        });

        it('should handle malformed tool call arguments', async () => {
            const diff = 'small diff';

            const mockTestTool = {
                name: 'test_tool',
                schema: z.object({}),
                getVSCodeTool: () => ({
                    name: 'test_tool',
                    description: 'Test tool',
                    inputSchema: {},
                }),
                execute: vi.fn().mockResolvedValue({
                    success: false,
                    error: 'Invalid arguments',
                }),
            };

            const submitReviewTool = new SubmitReviewTool();
            mockToolRegistry.getAllTools.mockReturnValue([
                mockTestTool,
                submitReviewTool,
            ]);
            mockToolRegistry.getTool.mockImplementation((name: string) => {
                if (name === 'test_tool') {
                    return mockTestTool;
                }
                if (name === 'submit_review') {
                    return submitReviewTool;
                }
                return undefined;
            });

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
                    content: null,
                    toolCalls: [
                        {
                            id: 'call_final',
                            function: {
                                name: 'submit_review',
                                arguments: JSON.stringify({
                                    review_content:
                                        'Analysis with malformed tool call handled. Adding padding to ensure minimum 100 character requirement for review_content field.',
                                }),
                            },
                        },
                    ],
                });

            const result = await analysisProvider.analyze(
                diff,
                tokenSource.token
            );

            expect(result.analysis).toBe(
                'Analysis with malformed tool call handled. Adding padding to ensure minimum 100 character requirement for review_content field.'
            );
        });
    });
});
