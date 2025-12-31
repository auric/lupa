import * as vscode from 'vscode';
import * as z from 'zod';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolCallingAnalysisProvider } from '../services/toolCallingAnalysisProvider';
import { ToolResult } from '../types/toolResultTypes';
import { PromptGenerator } from '../models/promptGenerator';
import { ITool } from '../tools/ITool';
import { DiffUtils } from '../utils/diffUtils';
import type { DiffHunk } from '../types/contextTypes';
import { SubagentSessionManager } from '../services/subagentSessionManager';
import { SubmitReviewTool } from '../tools/submitReviewTool';
import {
    createMockWorkspaceSettings,
    createMockCancellationTokenSource,
} from './testUtils/mockFactories';

vi.mock('vscode');

vi.mock('../services/loggingService', () => ({
    Log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}));

// Mock tool for testing
class MockAnalysisTool implements ITool {
    name = 'find_symbol';
    description = 'Find the definition of a code symbol';
    schema = z.object({
        symbolName: z.string().describe('Symbol name to find'),
        includeFullBody: z
            .boolean()
            .default(true)
            .describe('Include full body'),
    });

    getVSCodeTool(): vscode.LanguageModelChatTool {
        return {
            name: this.name,
            description: this.description,
            inputSchema: this.schema as any,
        };
    }

    async execute(args: any): Promise<ToolResult> {
        return {
            success: true,
            data: `Symbol definition for ${args.symbolName}`,
        };
    }
}

describe('ToolCallingAnalysisProvider Integration', () => {
    let provider: ToolCallingAnalysisProvider;
    let mockToolRegistry: any;
    let mockCopilotModelManager: any;
    let mockPromptGenerator: PromptGenerator;
    let sampleDiff: string;
    let subagentSessionManager: SubagentSessionManager;
    let tokenSource: vscode.CancellationTokenSource;

    beforeEach(() => {
        // Sample diff for testing
        sampleDiff = `diff --git a/src/auth.ts b/src/auth.ts
index 1234567..abcdefg 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -10,6 +10,8 @@ export function authenticateUser(token: string): boolean {
     if (!token) {
         return false;
     }
+    // Add token validation
+    const isValid = validateToken(token);
-    return token === 'valid-token';
+    return isValid && token.length > 0;
 }`;

        // Mock dependencies
        // Note: ConversationManager is created internally per-analysis for concurrent-safety
        mockToolRegistry = {
            getAllTools: vi
                .fn()
                .mockReturnValue([
                    new MockAnalysisTool(),
                    new SubmitReviewTool(),
                ]),
            getTool: vi.fn((name: string) => {
                if (name === 'find_symbol') {
                    return new MockAnalysisTool();
                }
                if (name === 'submit_review') {
                    return new SubmitReviewTool();
                }
                return undefined;
            }),
            getToolNames: vi
                .fn()
                .mockReturnValue(['find_symbol', 'submit_review']),
        };

        const mockModel = {
            countTokens: vi.fn(() => Promise.resolve(100)),
            maxInputTokens: 8000,
        };

        mockCopilotModelManager = {
            getCurrentModel: vi.fn(() => Promise.resolve(mockModel)),
            sendRequest: vi.fn().mockResolvedValue({
                content: null,
                toolCalls: [
                    {
                        id: 'call_final',
                        function: {
                            name: 'submit_review',
                            arguments: JSON.stringify({
                                review_content:
                                    'Mock analysis result. This is the complete review with sufficient content to meet the 100 character minimum requirement for the review_content field.',
                            }),
                        },
                    },
                ],
            }),
        };

        mockPromptGenerator = new PromptGenerator();

        const mockWorkspaceSettings = createMockWorkspaceSettings();
        subagentSessionManager = new SubagentSessionManager(
            mockWorkspaceSettings
        );

        provider = new ToolCallingAnalysisProvider(
            mockToolRegistry,
            mockCopilotModelManager,
            mockPromptGenerator,
            mockWorkspaceSettings,
            subagentSessionManager
        );
        // Use shared CancellationTokenSource mock from mockFactories
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

    describe('analyze method integration', () => {
        it('should use tool-aware system prompt generation', async () => {
            // Spy on the prompt generator methods
            const generateToolAwareSystemPromptSpy = vi.spyOn(
                mockPromptGenerator,
                'generateToolAwareSystemPrompt'
            );
            const generateToolCallingUserPromptSpy = vi.spyOn(
                mockPromptGenerator,
                'generateToolCallingUserPrompt'
            );

            await provider.analyze(sampleDiff, tokenSource.token);

            // Verify tool-aware system prompt was generated with both tools
            expect(generateToolAwareSystemPromptSpy).toHaveBeenCalledWith([
                expect.any(MockAnalysisTool),
                expect.any(SubmitReviewTool),
            ]);

            // Verify tool-calling user prompt was generated
            expect(generateToolCallingUserPromptSpy).toHaveBeenCalledWith(
                expect.any(Array) // parsed diff
            );
        });

        it('should parse diff using DiffUtils', async () => {
            const parseDiffSpy = vi.spyOn(DiffUtils, 'parseDiff');

            await provider.analyze(sampleDiff, tokenSource.token);

            expect(parseDiffSpy).toHaveBeenCalledWith(sampleDiff);
        });

        // Note: conversation history clearing and message adding are now internal
        // to the analyze() method, tested via the overall analysis result

        it('should handle tool calls in conversation loop', async () => {
            // Create spy on the mock tool's execute method
            const mockTool = new MockAnalysisTool();
            const submitReviewTool = new SubmitReviewTool();
            const executeSpy = vi.spyOn(mockTool, 'execute');

            // Update registry to return our spied tool and submit_review
            mockToolRegistry.getAllTools.mockReturnValue([
                mockTool,
                submitReviewTool,
            ]);
            mockToolRegistry.getTool.mockImplementation((name: string) => {
                if (name === 'find_symbol') {
                    return mockTool;
                }
                if (name === 'submit_review') {
                    return submitReviewTool;
                }
                return undefined;
            });

            // Mock tool calls response
            mockCopilotModelManager.sendRequest
                .mockResolvedValueOnce({
                    content: 'I need to investigate this function',
                    toolCalls: [
                        {
                            id: 'call_1',
                            function: {
                                name: 'find_symbol',
                                arguments: JSON.stringify({
                                    symbolName: 'validateToken',
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
                                        'Final analysis based on tool results. This review includes comprehensive findings about the validateToken function and its usage patterns.',
                                }),
                            },
                        },
                    ],
                });

            const result = await provider.analyze(
                sampleDiff,
                tokenSource.token
            );

            // Verify tool execute was called with parsed arguments
            // Zod schema adds default value for includeFullBody
            expect(executeSpy).toHaveBeenCalledWith(
                { symbolName: 'validateToken', includeFullBody: true },
                // Verify ExecutionContext contains planManager with expected methods
                // This confirms per-analysis isolation is working
                expect.objectContaining({
                    planManager: expect.objectContaining({
                        updatePlan: expect.any(Function),
                        getPlan: expect.any(Function),
                    }),
                })
            );

            // Verify final result
            expect(result.analysis).toBe(
                'Final analysis based on tool results. This review includes comprehensive findings about the validateToken function and its usage patterns.'
            );
        });

        it('should generate comprehensive system prompt with available tools', async () => {
            const generateToolAwareSystemPromptSpy = vi.spyOn(
                mockPromptGenerator,
                'generateToolAwareSystemPrompt'
            );

            await provider.analyze(sampleDiff, tokenSource.token);

            const systemPromptCall =
                generateToolAwareSystemPromptSpy.mock.calls[0];
            const tools = systemPromptCall[0] as ITool[];

            expect(tools).toHaveLength(2);
            expect(tools[0]).toBeInstanceOf(MockAnalysisTool);
            expect(tools[0].name).toBe('find_symbol');
            expect(tools[1]).toBeInstanceOf(SubmitReviewTool);
            expect(tools[1].name).toBe('submit_review');
        });

        it('should structure user prompt for optimal tool usage', async () => {
            const generateToolCallingUserPromptSpy = vi.spyOn(
                mockPromptGenerator,
                'generateToolCallingUserPrompt'
            );

            await provider.analyze(sampleDiff, tokenSource.token);

            const userPromptCall =
                generateToolCallingUserPromptSpy.mock.calls[0];
            const [parsedDiffParam] = userPromptCall;

            expect(parsedDiffParam).toBeInstanceOf(Array);
            expect(parsedDiffParam[0]).toHaveProperty(
                'filePath',
                'src/auth.ts'
            );
            expect(parsedDiffParam[0]).toHaveProperty('hunks');
        });
    });

    describe('error handling', () => {
        it('should handle tool execution errors gracefully', async () => {
            // Create a mock tool that returns an error
            const failingTool = {
                name: 'find_symbol',
                description: 'Find the definition of a code symbol',
                schema: z.object({}),
                getVSCodeTool: () => ({
                    name: 'find_symbol',
                    description: 'Find the definition of a code symbol',
                    inputSchema: {},
                }),
                execute: vi.fn().mockResolvedValue({
                    success: false,
                    error: 'Tool execution failed',
                }),
            };
            const submitReviewTool = new SubmitReviewTool();

            mockToolRegistry.getAllTools.mockReturnValue([
                failingTool,
                submitReviewTool,
            ]);
            mockToolRegistry.getTool.mockImplementation((name: string) => {
                if (name === 'find_symbol') {
                    return failingTool;
                }
                if (name === 'submit_review') {
                    return submitReviewTool;
                }
                return undefined;
            });

            mockCopilotModelManager.sendRequest
                .mockResolvedValueOnce({
                    content: 'Using tools to analyze',
                    toolCalls: [
                        {
                            id: 'call_1',
                            function: {
                                name: 'find_symbol',
                                arguments: JSON.stringify({
                                    symbolName: 'test',
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
                                        'Analysis despite tool error. The review continues with available information and provides recommendations based on the code changes.',
                                }),
                            },
                        },
                    ],
                });

            const result = await provider.analyze(
                sampleDiff,
                tokenSource.token
            );

            expect(result.analysis).toBe(
                'Analysis despite tool error. The review continues with available information and provides recommendations based on the code changes.'
            );
            // Tool messages are now added to internal ConversationManager
            // The analysis result confirms error handling worked correctly
        });

        it('should handle malformed tool arguments', async () => {
            // Create spy-able mock tool
            const mockTool = {
                name: 'find_symbol',
                description: 'Find the definition of a code symbol',
                schema: z.object({}),
                getVSCodeTool: () => ({
                    name: 'find_symbol',
                    description: 'Find the definition of a code symbol',
                    inputSchema: {},
                }),
                execute: vi.fn().mockResolvedValue({
                    success: true,
                    data: 'Symbol definition found',
                }),
            };
            const submitReviewTool = new SubmitReviewTool();

            mockToolRegistry.getAllTools.mockReturnValue([
                mockTool,
                submitReviewTool,
            ]);
            mockToolRegistry.getTool.mockImplementation((name: string) => {
                if (name === 'find_symbol') {
                    return mockTool;
                }
                if (name === 'submit_review') {
                    return submitReviewTool;
                }
                return undefined;
            });

            mockCopilotModelManager.sendRequest
                .mockResolvedValueOnce({
                    content: 'Calling tool with bad args',
                    toolCalls: [
                        {
                            id: 'call_1',
                            function: {
                                name: 'find_symbol',
                                arguments: 'invalid json',
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
                                        'Final result. Despite the malformed tool arguments, the analysis completed successfully with comprehensive findings and recommendations.',
                                }),
                            },
                        },
                    ],
                });

            const result = await provider.analyze(
                sampleDiff,
                tokenSource.token
            );

            // Should still complete despite malformed arguments
            expect(result.analysis).toBe(
                'Final result. Despite the malformed tool arguments, the analysis completed successfully with comprehensive findings and recommendations.'
            );
            // Verify tool was called with empty object for malformed JSON
            expect(mockTool.execute).toHaveBeenCalledWith(
                {}, // Empty object for malformed JSON
                // Verify ExecutionContext contains planManager for per-analysis isolation
                expect.objectContaining({
                    planManager: expect.objectContaining({
                        updatePlan: expect.any(Function),
                        getPlan: expect.any(Function),
                    }),
                })
            );
        });

        it('should handle analysis errors and return error message', async () => {
            mockCopilotModelManager.sendRequest.mockRejectedValue(
                new Error('LLM service unavailable')
            );

            const result = await provider.analyze(
                sampleDiff,
                tokenSource.token
            );

            expect(result.analysis).toContain('Error during analysis');
            expect(result.analysis).toContain('LLM service unavailable');
        });
    });

    describe('diff parsing integration', () => {
        it('should correctly parse complex diffs', async () => {
            const complexDiff = `diff --git a/src/file1.ts b/src/file1.ts
index 1111111..2222222 100644
--- a/src/file1.ts
+++ b/src/file1.ts
@@ -1,3 +1,5 @@
+import { newFunction } from './utils';
+
 function oldFunction() {
     return 'old';
 }
diff --git a/src/file2.ts b/src/file2.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/file2.ts
@@ -0,0 +1,5 @@
+export function newFunction() {
+    return 'new';
+}`;

            const generateToolCallingUserPromptSpy = vi.spyOn(
                mockPromptGenerator,
                'generateToolCallingUserPrompt'
            );

            await provider.analyze(complexDiff, tokenSource.token);

            const parsedDiff = generateToolCallingUserPromptSpy.mock
                .calls[0][0] as DiffHunk[];

            expect(parsedDiff).toHaveLength(2);
            expect(parsedDiff[0].filePath).toBe('src/file1.ts');
            expect(parsedDiff[1].filePath).toBe('src/file2.ts');
            expect(parsedDiff[0].hunks).toHaveLength(1);
            expect(parsedDiff[1].hunks).toHaveLength(1);
        });
    });
});
