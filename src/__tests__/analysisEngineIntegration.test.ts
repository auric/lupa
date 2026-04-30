import * as vscode from 'vscode';
import * as z from 'zod';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnalysisEngine } from '../services/analysisEngine';
import { ToolResult } from '../types/toolResultTypes';
import { PromptGenerator } from '../models/promptGenerator';
import { ITool } from '../tools/ITool';
import { DiffUtils } from '../utils/diffUtils';
import type { DiffHunk } from '../types/contextTypes';
import { SubmitReviewTool } from '../tools/submitReviewTool';
import { RecordFindingTool } from '../tools/recordFindingTool';
import { PostAnalysisPipeline } from '../services/postAnalysisPipeline';
import {
    createMockWorkspaceSettings,
    createMockCancellationTokenSource,
    createMockAnalysisEngineInput,
    createMockAnalysisEngineOutput,
} from './testUtils/mockFactories';
import type { ExecutionContext } from '../types/executionContext';

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
        file: z
            .string()
            .optional()
            .describe('Optional file path for tracking investigated files'),
    });

    getVSCodeTool(): vscode.LanguageModelChatTool {
        return {
            name: this.name,
            description: this.description,
            inputSchema: this.schema as any,
        };
    }

    async execute(args: any, _context: ExecutionContext): Promise<ToolResult> {
        return {
            success: true,
            data: `Symbol definition for ${args.symbolName}`,
        };
    }
}

describe('AnalysisEngine Integration', () => {
    let provider: AnalysisEngine;
    let mockToolRegistry: any;
    let mockCopilotModelManager: any;
    let mockPromptGenerator: PromptGenerator;
    let sampleDiff: string;
    let tokenSource: vscode.CancellationTokenSource;
    let mockDiffEnricher: any;
    let mockFindingValidator: any;

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
            hasTool: vi.fn().mockReturnValue(false),
            registerTool: vi.fn(),
            unregisterTool: vi.fn(),
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

        const mockWorkspaceSettings = createMockWorkspaceSettings({
            maxRecursionDepth: 0,
        });

        mockDiffEnricher = {
            enrich: vi.fn().mockResolvedValue({
                enrichedSymbols: [],
                generatedAt: Date.now(),
                timeoutCount: 0,
            }),
            dispose: vi.fn(),
        } as any;

        mockFindingValidator = {
            validate: vi.fn().mockResolvedValue({
                validated: [],
                dropped: 0,
                downgraded: 0,
                kept: 0,
            }),
        } as any;

        provider = new AnalysisEngine(
            mockToolRegistry,
            mockPromptGenerator,
            mockWorkspaceSettings,
            mockDiffEnricher,
            mockFindingValidator
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
            const generateUserPromptSpy = vi.spyOn(
                mockPromptGenerator,
                'generateUserPrompt'
            );

            await provider.analyze(
                createMockAnalysisEngineInput({
                    parsedDiff: DiffUtils.parseDiff(sampleDiff),
                    llmClient: mockCopilotModelManager as any,
                    token: tokenSource.token,
                }),
                createMockAnalysisEngineOutput()
            );

            // Verify tool-aware system prompt was generated
            expect(generateToolAwareSystemPromptSpy).toHaveBeenCalled();

            // Verify user prompt was generated with parsed diff
            expect(generateUserPromptSpy).toHaveBeenCalledWith(
                expect.any(Array), // parsed diff
                undefined, // no user instructions
                false, // non-recursive mode (maxRecursionDepth=0)
                expect.any(Number), // maxSubagents
                expect.objectContaining({
                    enrichedSymbols: [],
                    timeoutCount: 0,
                }) // codeIntelBrief
            );
        });

        it('should pass pre-parsed diff to prompt generator', async () => {
            const parsedDiff = DiffUtils.parseDiff(sampleDiff);
            const generateUserPromptSpy = vi.spyOn(
                mockPromptGenerator,
                'generateUserPrompt'
            );

            await provider.analyze(
                createMockAnalysisEngineInput({
                    parsedDiff,
                    llmClient: mockCopilotModelManager as any,
                    token: tokenSource.token,
                }),
                createMockAnalysisEngineOutput()
            );

            expect(generateUserPromptSpy).toHaveBeenCalledWith(
                parsedDiff,
                expect.toSatisfy(() => true),
                expect.toSatisfy(() => true),
                expect.toSatisfy(() => true),
                expect.toSatisfy(() => true)
            );
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
                createMockAnalysisEngineInput({
                    parsedDiff: DiffUtils.parseDiff(sampleDiff),
                    llmClient: mockCopilotModelManager as any,
                    token: tokenSource.token,
                }),
                createMockAnalysisEngineOutput()
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
            expect(result.analysisText).toBe(
                'Final analysis based on tool results. This review includes comprehensive findings about the validateToken function and its usage patterns.'
            );
        });

        it('should generate comprehensive system prompt with available tools', async () => {
            const generateToolAwareSystemPromptSpy = vi.spyOn(
                mockPromptGenerator,
                'generateToolAwareSystemPrompt'
            );

            await provider.analyze(
                createMockAnalysisEngineInput({
                    parsedDiff: DiffUtils.parseDiff(sampleDiff),
                    llmClient: mockCopilotModelManager as any,
                    token: tokenSource.token,
                }),
                createMockAnalysisEngineOutput()
            );

            // System prompt generation no longer receives tools directly (sent via VS Code API)
            expect(generateToolAwareSystemPromptSpy).toHaveBeenCalled();

            // Verify tools are still registered in the registry
            const registeredTools = mockToolRegistry.getAllTools();
            expect(registeredTools).toHaveLength(2);
            expect(registeredTools[0]).toBeInstanceOf(MockAnalysisTool);
            expect(registeredTools[0].name).toBe('find_symbol');
            expect(registeredTools[1]).toBeInstanceOf(SubmitReviewTool);
            expect(registeredTools[1].name).toBe('submit_review');
        });

        it('should structure user prompt for optimal tool usage', async () => {
            const generateUserPromptSpy = vi.spyOn(
                mockPromptGenerator,
                'generateUserPrompt'
            );

            await provider.analyze(
                createMockAnalysisEngineInput({
                    parsedDiff: DiffUtils.parseDiff(sampleDiff),
                    llmClient: mockCopilotModelManager as any,
                    token: tokenSource.token,
                }),
                createMockAnalysisEngineOutput()
            );

            const userPromptCall = generateUserPromptSpy.mock.calls[0];
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
                createMockAnalysisEngineInput({
                    parsedDiff: DiffUtils.parseDiff(sampleDiff),
                    llmClient: mockCopilotModelManager as any,
                    token: tokenSource.token,
                }),
                createMockAnalysisEngineOutput()
            );

            expect(result.analysisText).toBe(
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
                createMockAnalysisEngineInput({
                    parsedDiff: DiffUtils.parseDiff(sampleDiff),
                    llmClient: mockCopilotModelManager as any,
                    token: tokenSource.token,
                }),
                createMockAnalysisEngineOutput()
            );

            // Should still complete despite malformed arguments
            expect(result.analysisText).toBe(
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
                createMockAnalysisEngineInput({
                    parsedDiff: DiffUtils.parseDiff(sampleDiff),
                    llmClient: mockCopilotModelManager as any,
                    token: tokenSource.token,
                }),
                createMockAnalysisEngineOutput()
            );

            expect(result.analysisText).toContain('Error during analysis');
            expect(result.analysisText).toContain('LLM service unavailable');
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

            const generateUserPromptSpy = vi.spyOn(
                mockPromptGenerator,
                'generateUserPrompt'
            );

            await provider.analyze(
                createMockAnalysisEngineInput({
                    parsedDiff: DiffUtils.parseDiff(complexDiff),
                    llmClient: mockCopilotModelManager as any,
                    token: tokenSource.token,
                }),
                createMockAnalysisEngineOutput()
            );

            const parsedDiff = generateUserPromptSpy.mock
                .calls[0][0] as DiffHunk[];

            expect(parsedDiff).toHaveLength(2);
            expect(parsedDiff[0].filePath).toBe('src/file1.ts');
            expect(parsedDiff[1].filePath).toBe('src/file2.ts');
            expect(parsedDiff[0].hunks).toHaveLength(1);
            expect(parsedDiff[1].hunks).toHaveLength(1);
        });
    });

    describe('Concurrent Analysis', () => {
        it('should handle concurrent analyses without state interference', async () => {
            // Two distinct diffs with unique identifiers
            const diff1 = `diff --git a/concurrent-test-file1.ts b/concurrent-test-file1.ts
index 1111111..2222222 100644
--- a/concurrent-test-file1.ts
+++ b/concurrent-test-file1.ts
@@ -1,3 +1,3 @@
-const old1 = 'value';
+const new1 = 'value';`;

            const diff2 = `diff --git a/concurrent-test-file2.ts b/concurrent-test-file2.ts
index 3333333..4444444 100644
--- a/concurrent-test-file2.ts
+++ b/concurrent-test-file2.ts
@@ -1,3 +1,3 @@
-const old2 = 'value';
+const new2 = 'value';`;

            // Mock LLM to return different responses based on diff content
            mockCopilotModelManager.sendRequest.mockImplementation(
                (request: {
                    messages: Array<{ role: string; content: string }>;
                }) => {
                    const userMessage = request.messages.find(
                        (m) => m.role === 'user'
                    );
                    const content = userMessage?.content || '';

                    if (content.includes('concurrent-test-file1')) {
                        return Promise.resolve({
                            content: null,
                            toolCalls: [
                                {
                                    id: 'call_analysis_1',
                                    function: {
                                        name: 'submit_review',
                                        arguments: JSON.stringify({
                                            review_content:
                                                'Concurrent analysis 1: Changes to file1 look good. The variable rename is appropriate. Adding padding to meet minimum character requirement.',
                                        }),
                                    },
                                },
                            ],
                        });
                    } else if (content.includes('concurrent-test-file2')) {
                        return Promise.resolve({
                            content: null,
                            toolCalls: [
                                {
                                    id: 'call_analysis_2',
                                    function: {
                                        name: 'submit_review',
                                        arguments: JSON.stringify({
                                            review_content:
                                                'Concurrent analysis 2: Changes to file2 are acceptable. Variable naming is consistent. Adding padding to meet minimum character requirement.',
                                        }),
                                    },
                                },
                            ],
                        });
                    }
                    return Promise.resolve({
                        content: 'Unexpected call',
                        toolCalls: [],
                    });
                }
            );

            // Create separate cancellation tokens for each analysis
            const tokenSource1 = new vscode.CancellationTokenSource();
            const tokenSource2 = new vscode.CancellationTokenSource();

            // Run both analyses concurrently
            const [result1, result2] = await Promise.all([
                provider.analyze(
                    createMockAnalysisEngineInput({
                        parsedDiff: DiffUtils.parseDiff(diff1),
                        llmClient: mockCopilotModelManager as any,
                        token: tokenSource1.token,
                    }),
                    createMockAnalysisEngineOutput()
                ),
                provider.analyze(
                    createMockAnalysisEngineInput({
                        parsedDiff: DiffUtils.parseDiff(diff2),
                        llmClient: mockCopilotModelManager as any,
                        token: tokenSource2.token,
                    }),
                    createMockAnalysisEngineOutput()
                ),
            ]);

            // Verify each analysis got its own distinct result
            expect(result1.analysisText).toContain('Concurrent analysis 1');
            expect(result1.analysisText).toContain('file1');
            expect(result2.analysisText).toContain('Concurrent analysis 2');
            expect(result2.analysisText).toContain('file2');

            // Verify tool call records are separate for each analysis
            expect(result1.toolCallRecords).toHaveLength(1);
            expect(result1.toolCallRecords[0].id).toBe('call_analysis_1');
            expect(result2.toolCallRecords).toHaveLength(1);
            expect(result2.toolCallRecords[0].id).toBe('call_analysis_2');

            // Verify both completed successfully
            expect(result1.completed).toBe(true);
            expect(result2.completed).toBe(true);

            // Cleanup
            tokenSource1.dispose();
            tokenSource2.dispose();
        });

        it('should maintain separate iteration counts for concurrent analyses', async () => {
            // Two diffs that will trigger different numbers of iterations
            const simpleDiff = `diff --git a/simple.ts b/simple.ts
+const x = 1;`;

            const complexDiff = `diff --git a/complex.ts b/complex.ts
+const complexLogic = () => { return 'needs investigation'; };`;

            let simpleCallCount = 0;
            let complexCallCount = 0;

            mockCopilotModelManager.sendRequest.mockImplementation(
                (request: {
                    messages: Array<{ role: string; content: string }>;
                }) => {
                    const userMessage = request.messages.find(
                        (m) => m.role === 'user'
                    );
                    const content = userMessage?.content || '';

                    if (content.includes('simple.ts')) {
                        simpleCallCount++;
                        // Simple: submit immediately
                        return Promise.resolve({
                            content: null,
                            toolCalls: [
                                {
                                    id: `call_simple_${simpleCallCount}`,
                                    function: {
                                        name: 'submit_review',
                                        arguments: JSON.stringify({
                                            review_content:
                                                'Simple change reviewed. Single iteration needed. Adding padding to meet minimum character requirement for review submission.',
                                        }),
                                    },
                                },
                            ],
                        });
                    } else if (content.includes('complex.ts')) {
                        complexCallCount++;
                        // Complex: first call uses tool, second submits
                        if (complexCallCount === 1) {
                            return Promise.resolve({
                                content: 'Let me analyze this complex logic.',
                                toolCalls: [
                                    {
                                        id: `call_complex_tool_${complexCallCount}`,
                                        function: {
                                            name: 'find_symbol',
                                            arguments: JSON.stringify({
                                                symbolName: 'complexLogic',
                                            }),
                                        },
                                    },
                                ],
                            });
                        } else {
                            return Promise.resolve({
                                content: null,
                                toolCalls: [
                                    {
                                        id: `call_complex_submit_${complexCallCount}`,
                                        function: {
                                            name: 'submit_review',
                                            arguments: JSON.stringify({
                                                review_content:
                                                    'Complex change reviewed after tool investigation. Two iterations needed. Padding for minimum characters.',
                                            }),
                                        },
                                    },
                                ],
                            });
                        }
                    }
                    return Promise.resolve({
                        content: 'Unexpected',
                        toolCalls: [],
                    });
                }
            );

            const tokenSource1 = new vscode.CancellationTokenSource();
            const tokenSource2 = new vscode.CancellationTokenSource();

            const [simpleResult, complexResult] = await Promise.all([
                provider.analyze(
                    createMockAnalysisEngineInput({
                        parsedDiff: DiffUtils.parseDiff(simpleDiff),
                        llmClient: mockCopilotModelManager as any,
                        token: tokenSource1.token,
                    }),
                    createMockAnalysisEngineOutput()
                ),
                provider.analyze(
                    createMockAnalysisEngineInput({
                        parsedDiff: DiffUtils.parseDiff(complexDiff),
                        llmClient: mockCopilotModelManager as any,
                        token: tokenSource2.token,
                    }),
                    createMockAnalysisEngineOutput()
                ),
            ]);

            // Simple analysis: 1 iteration (immediate submit)
            expect(simpleResult.toolCallRecords.length).toBe(1);
            expect(simpleResult.analysisText).toContain('Single iteration');

            // Complex analysis: 2 iterations (tool call + submit)
            expect(complexResult.toolCallRecords.length).toBe(2);
            expect(complexResult.analysisText).toContain('Two iterations');

            // Both completed independently
            expect(simpleResult.completed).toBe(true);
            expect(complexResult.completed).toBe(true);

            tokenSource1.dispose();
            tokenSource2.dispose();
        });

        it('should isolate subagent session managers between concurrent analyses', async () => {
            // This test verifies that each analysis has its own SubagentSessionManager
            // so that subagent spawn counts don't interfere between analyses

            // Two diffs that would both want to spawn subagents
            const diff1 = `diff --git a/subagent-test-1.ts b/subagent-test-1.ts
+const module1 = require('./complex-module');`;

            const diff2 = `diff --git a/subagent-test-2.ts b/subagent-test-2.ts
+const module2 = require('./another-complex-module');`;

            // Track which analysis each call is from
            const analysisCallCounts = { analysis1: 0, analysis2: 0 };

            mockCopilotModelManager.sendRequest.mockImplementation(
                (request: {
                    messages: Array<{ role: string; content: string }>;
                }) => {
                    const userMessage = request.messages.find(
                        (m) => m.role === 'user'
                    );
                    const content = userMessage?.content || '';

                    if (content.includes('subagent-test-1')) {
                        analysisCallCounts.analysis1++;
                        return Promise.resolve({
                            content: null,
                            toolCalls: [
                                {
                                    id: `call_1_${analysisCallCounts.analysis1}`,
                                    function: {
                                        name: 'submit_review',
                                        arguments: JSON.stringify({
                                            review_content:
                                                'Analysis 1 completed. SubagentSessionManager isolated correctly. Padding for minimum chars.',
                                        }),
                                    },
                                },
                            ],
                        });
                    } else if (content.includes('subagent-test-2')) {
                        analysisCallCounts.analysis2++;
                        return Promise.resolve({
                            content: null,
                            toolCalls: [
                                {
                                    id: `call_2_${analysisCallCounts.analysis2}`,
                                    function: {
                                        name: 'submit_review',
                                        arguments: JSON.stringify({
                                            review_content:
                                                'Analysis 2 completed. SubagentSessionManager isolated correctly. Padding for minimum chars.',
                                        }),
                                    },
                                },
                            ],
                        });
                    }
                    return Promise.resolve({
                        content: 'Unexpected',
                        toolCalls: [],
                    });
                }
            );

            const tokenSource1 = new vscode.CancellationTokenSource();
            const tokenSource2 = new vscode.CancellationTokenSource();

            // Run both analyses concurrently
            const [result1, result2] = await Promise.all([
                provider.analyze(
                    createMockAnalysisEngineInput({
                        parsedDiff: DiffUtils.parseDiff(diff1),
                        llmClient: mockCopilotModelManager as any,
                        token: tokenSource1.token,
                    }),
                    createMockAnalysisEngineOutput()
                ),
                provider.analyze(
                    createMockAnalysisEngineInput({
                        parsedDiff: DiffUtils.parseDiff(diff2),
                        llmClient: mockCopilotModelManager as any,
                        token: tokenSource2.token,
                    }),
                    createMockAnalysisEngineOutput()
                ),
            ]);

            // Both should complete successfully without interfering
            expect(result1.completed).toBe(true);
            expect(result2.completed).toBe(true);
            expect(result1.analysisText).toContain(
                'SubagentSessionManager isolated'
            );
            expect(result2.analysisText).toContain(
                'SubagentSessionManager isolated'
            );

            // Each analysis should have independent tool call records
            expect(result1.toolCallRecords[0].id).toContain('call_1_');
            expect(result2.toolCallRecords[0].id).toContain('call_2_');

            tokenSource1.dispose();
            tokenSource2.dispose();
        });
    });

    describe('cancellation handling', () => {
        it('should return wasCancelled=true and completed=false with pre-cancelled token', async () => {
            const cancelledSource = createMockCancellationTokenSource();
            cancelledSource.cancel();

            const result = await provider.analyze(
                createMockAnalysisEngineInput({
                    parsedDiff: DiffUtils.parseDiff(sampleDiff),
                    llmClient: mockCopilotModelManager as any,
                    token: cancelledSource.token,
                }),
                createMockAnalysisEngineOutput()
            );

            expect(result.wasCancelled).toBe(true);
            expect(result.completed).toBe(false);
        });
    });

    describe('result metadata', () => {
        it('should set filesAnalyzed to the number of files in the diff', async () => {
            const multiFileDiff = `diff --git a/src/auth.ts b/src/auth.ts
index 1234567..abcdefg 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,3 +1,4 @@
+import { validate } from './validate';
 export function auth() {}

diff --git a/src/utils.ts b/src/utils.ts
index 1234567..abcdefg 100644
--- a/src/utils.ts
+++ b/src/utils.ts
@@ -1,3 +1,4 @@
+export const helper = true;
 export function utils() {}

diff --git a/src/config.ts b/src/config.ts
index 1234567..abcdefg 100644
--- a/src/config.ts
+++ b/src/config.ts
@@ -1,3 +1,4 @@
+export const setting = 42;
 export function config() {}`;

            const parsedDiff = DiffUtils.parseDiff(multiFileDiff);
            expect(parsedDiff).toHaveLength(3);

            const result = await provider.analyze(
                createMockAnalysisEngineInput({
                    parsedDiff,
                    llmClient: mockCopilotModelManager as any,
                    token: tokenSource.token,
                }),
                createMockAnalysisEngineOutput()
            );

            expect(result.filesAnalyzed).toBe(3);
            expect(Array.isArray(result.selfReflectionScores)).toBe(true);
        });
    });

    describe('recursive mode integration', () => {
        it('should use recursive system prompt when analysisApproach is rlm with depth >= 1', async () => {
            const rlmSettings = createMockWorkspaceSettings({
                maxRecursionDepth: 2,
            });

            const rlmProvider = new AnalysisEngine(
                mockToolRegistry,
                mockPromptGenerator,
                rlmSettings,
                mockDiffEnricher,
                mockFindingValidator
            );

            const generateRecursiveSpy = vi.spyOn(
                mockPromptGenerator,
                'generateRecursiveSystemPrompt'
            );
            const generateToolAwareSpy = vi.spyOn(
                mockPromptGenerator,
                'generateToolAwareSystemPrompt'
            );

            await rlmProvider.analyze(
                createMockAnalysisEngineInput({
                    parsedDiff: DiffUtils.parseDiff(sampleDiff),
                    llmClient: mockCopilotModelManager as any,
                    token: tokenSource.token,
                }),
                createMockAnalysisEngineOutput()
            );

            expect(generateRecursiveSpy).toHaveBeenCalled();
            expect(generateToolAwareSpy).not.toHaveBeenCalled();
        });

        it('should use non-recursive prompt when rlm approach with depth 0', async () => {
            const noRecursionSettings = createMockWorkspaceSettings({
                maxRecursionDepth: 0,
            });

            const noRecursionProvider = new AnalysisEngine(
                mockToolRegistry,
                mockPromptGenerator,
                noRecursionSettings,
                mockDiffEnricher,
                mockFindingValidator
            );

            const generateRecursiveSpy = vi.spyOn(
                mockPromptGenerator,
                'generateRecursiveSystemPrompt'
            );
            const generateToolAwareSpy = vi.spyOn(
                mockPromptGenerator,
                'generateToolAwareSystemPrompt'
            );

            await noRecursionProvider.analyze(
                createMockAnalysisEngineInput({
                    parsedDiff: DiffUtils.parseDiff(sampleDiff),
                    llmClient: mockCopilotModelManager as any,
                    token: tokenSource.token,
                }),
                createMockAnalysisEngineOutput()
            );

            expect(generateToolAwareSpy).toHaveBeenCalled();
            expect(generateRecursiveSpy).not.toHaveBeenCalled();
        });
    });

    describe('truncation handling', () => {
        it('should run post-analysis pipeline on recorded findings when analysis exits degraded', async () => {
            // Reproduce the bug: model records findings but never calls submit_review,
            // causing the runner to exit degraded. Before the fix, the pipeline was
            // skipped because analysisCompleted was false. After the fix, pipeline
            // runs because findings exist (findingStore.size > 0).
            const recordFindingTool = new RecordFindingTool();
            const submitReviewTool = new SubmitReviewTool();
            const mockTool = new MockAnalysisTool();

            mockToolRegistry.getAllTools.mockReturnValue([
                mockTool,
                recordFindingTool,
                submitReviewTool,
            ]);
            mockToolRegistry.getTool.mockImplementation((name: string) => {
                if (name === 'find_symbol') {
                    return mockTool;
                }
                if (name === 'record_finding') {
                    return recordFindingTool;
                }
                if (name === 'submit_review') {
                    return submitReviewTool;
                }
                return undefined;
            });

            // Requires enough iterations for investigation calls + record_finding +
            // completion nudges to exhaust. MAX_COMPLETION_NUDGES = 2, so we need
            // at least 3 text-only iterations after record_finding to trigger degraded.
            const truncatedSettings = createMockWorkspaceSettings({
                maxIterations: 8,
                maxRecursionDepth: 0,
            });

            const truncatedProvider = new AnalysisEngine(
                mockToolRegistry,
                mockPromptGenerator,
                truncatedSettings,
                mockDiffEnricher,
                mockFindingValidator
            );

            let callCount = 0;
            mockCopilotModelManager.sendRequest.mockImplementation(() => {
                callCount++;
                if (callCount <= 3) {
                    // Iterations 1-3: investigation tool calls. The default
                    // calibration profile requires >=2 investigation calls before
                    // the first finding; we use 3 to be safe across all profiles.
                    return Promise.resolve({
                        content: 'Investigating...',
                        toolCalls: [
                            {
                                id: `call_investigate_${callCount}`,
                                function: {
                                    name: 'find_symbol',
                                    arguments: JSON.stringify({
                                        symbolName: 'validateToken',
                                        file: 'src/auth.ts',
                                    }),
                                },
                            },
                        ],
                    });
                }
                if (callCount === 4) {
                    // Iteration 4: record a finding.
                    return Promise.resolve({
                        content: 'Found an issue',
                        toolCalls: [
                            {
                                id: 'call_record_1',
                                function: {
                                    name: 'record_finding',
                                    arguments: JSON.stringify({
                                        severity: 'HIGH',
                                        category: 'logic_error',
                                        title: 'Off-by-one error',
                                        file: 'src/auth.ts',
                                        line: 15,
                                        description:
                                            'The loop condition uses <= instead of <, causing an off-by-one error that reads past the array boundary.',
                                        verification_evidence:
                                            'Inspected the loop bounds via read_file tool.',
                                        disproof_note:
                                            'Checked callers with find_usages — all 3 callers pass unvalidated input.',
                                        affected_component: 'authenticateUser',
                                        failure_mechanism: 'runtime_exception',
                                    }),
                                },
                            },
                        ],
                    });
                }
                // Iterations 5+: respond with text but never call submit_review.
                // After 3 text-only responses (soft continue + 2 nudges),
                // the runner exits degraded.
                return Promise.resolve({
                    content:
                        'I have recorded the finding. Let me continue investigating...',
                    toolCalls: [],
                });
            });

            const pipelineRunSpy = vi
                .spyOn(PostAnalysisPipeline.prototype, 'run')
                .mockResolvedValue({
                    droppedTitles: [],
                    rewrittenAnalysis: undefined,
                    additionalToolCallRecords: [],
                    selfReflectionScores: [],
                    stepRecords: [],
                });

            try {
                const result = await truncatedProvider.analyze(
                    createMockAnalysisEngineInput({
                        parsedDiff: DiffUtils.parseDiff(sampleDiff),
                        llmClient: mockCopilotModelManager as any,
                        token: tokenSource.token,
                    }),
                    createMockAnalysisEngineOutput()
                );

                // The finding should survive even though submit_review was never called.
                expect(result.findings.length).toBeGreaterThan(0);
                expect(result.findings[0].title).toBe('Off-by-one error');

                // The pipeline must have been invoked — this is the core fix.
                expect(pipelineRunSpy).toHaveBeenCalledTimes(1);

                // The result must indicate truncation because degraded was true.
                expect(result.wasTruncated).toBe(true);
                expect(result.completed).toBe(false);
                // 3 investigation calls + 1 record_finding + text-only responses
                // until degraded with MAX_COMPLETION_NUDGES=2.
                expect(result.iterationsUsed).toBe(7);
            } finally {
                pipelineRunSpy.mockRestore();
            }
        });

        it('should set wasTruncated when runner hits max iterations', async () => {
            // Synthetic scenario: model records a finding early, then keeps
            // making tool calls until the iteration cap is hit.
            const recordFindingTool = new RecordFindingTool();
            const submitReviewTool = new SubmitReviewTool();
            const mockTool = new MockAnalysisTool();

            mockToolRegistry.getAllTools.mockReturnValue([
                mockTool,
                recordFindingTool,
                submitReviewTool,
            ]);
            mockToolRegistry.getTool.mockImplementation((name: string) => {
                if (name === 'find_symbol') {
                    return mockTool;
                }
                if (name === 'record_finding') {
                    return recordFindingTool;
                }
                if (name === 'submit_review') {
                    return submitReviewTool;
                }
                return undefined;
            });

            const capSettings = createMockWorkspaceSettings({
                maxIterations: 5,
                maxRecursionDepth: 0,
            });

            const capProvider = new AnalysisEngine(
                mockToolRegistry,
                mockPromptGenerator,
                capSettings,
                mockDiffEnricher,
                mockFindingValidator
            );

            let callCount = 0;
            mockCopilotModelManager.sendRequest.mockImplementation(() => {
                callCount++;
                if (callCount <= 3) {
                    // Iterations 1-3: investigation calls. The default calibration
                    // profile requires >=2 investigation calls before the first
                    // finding; we use 3 to be safe across all profiles.
                    return Promise.resolve({
                        content: 'Investigating...',
                        toolCalls: [
                            {
                                id: `call_investigate_${callCount}`,
                                function: {
                                    name: 'find_symbol',
                                    arguments: JSON.stringify({
                                        symbolName: 'validateToken',
                                        file: 'src/auth.ts',
                                    }),
                                },
                            },
                        ],
                    });
                }
                if (callCount === 4) {
                    // Iteration 4: record a finding.
                    return Promise.resolve({
                        content: 'Found an issue',
                        toolCalls: [
                            {
                                id: 'call_record_1',
                                function: {
                                    name: 'record_finding',
                                    arguments: JSON.stringify({
                                        severity: 'HIGH',
                                        category: 'logic_error',
                                        title: 'Buffer overflow risk',
                                        file: 'src/auth.ts',
                                        line: 20,
                                        description:
                                            'Unbounded string copy into fixed-size buffer.',
                                        verification_evidence:
                                            'Read the function body carefully.',
                                        disproof_note:
                                            'Checked callers with find_usages — all pass unvalidated input.',
                                        affected_component: 'authenticateUser',
                                        failure_mechanism: 'runtime_exception',
                                    }),
                                },
                            },
                        ],
                    });
                }
                // Burn the last iteration with a tool call so we hit the cap
                // without ever calling submit_review.
                return Promise.resolve({
                    content: 'Investigating further...',
                    toolCalls: [
                        {
                            id: `call_tool_${callCount}`,
                            function: {
                                name: 'find_symbol',
                                arguments: JSON.stringify({
                                    symbolName: 'foo',
                                }),
                            },
                        },
                    ],
                });
            });

            const pipelineRunSpy = vi
                .spyOn(PostAnalysisPipeline.prototype, 'run')
                .mockResolvedValue({
                    droppedTitles: [],
                    rewrittenAnalysis: undefined,
                    additionalToolCallRecords: [],
                    selfReflectionScores: [],
                    stepRecords: [],
                });

            try {
                const result = await capProvider.analyze(
                    createMockAnalysisEngineInput({
                        parsedDiff: DiffUtils.parseDiff(sampleDiff),
                        llmClient: mockCopilotModelManager as any,
                        token: tokenSource.token,
                    }),
                    createMockAnalysisEngineOutput()
                );

                expect(result.findings.length).toBeGreaterThan(0);
                expect(result.wasTruncated).toBe(true);
                // When max iterations is hit (not degraded), analysisCompleted is
                // still true because none of the negative flags are set.
                expect(result.completed).toBe(true);
                expect(result.iterationsUsed).toBe(5);
                expect(pipelineRunSpy).toHaveBeenCalledTimes(1);
            } finally {
                pipelineRunSpy.mockRestore();
            }
        });

        it('should skip pipeline when degraded with no findings', async () => {
            // Negative path: runner exits degraded but nothing was ever recorded.
            // The pipeline should NOT run in this case.
            const submitReviewTool = new SubmitReviewTool();
            const mockTool = new MockAnalysisTool();

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

            const noFindingsSettings = createMockWorkspaceSettings({
                maxIterations: 5,
                maxRecursionDepth: 0,
            });

            const noFindingsProvider = new AnalysisEngine(
                mockToolRegistry,
                mockPromptGenerator,
                noFindingsSettings,
                mockDiffEnricher,
                mockFindingValidator
            );

            mockCopilotModelManager.sendRequest.mockImplementation(() => {
                // Never call any tool — just text responses until completion
                // nudges exhaust and runner exits degraded.
                return Promise.resolve({
                    content: 'Looking at the diff...',
                    toolCalls: [],
                });
            });

            const pipelineRunSpy = vi
                .spyOn(PostAnalysisPipeline.prototype, 'run')
                .mockResolvedValue({
                    droppedTitles: [],
                    rewrittenAnalysis: undefined,
                    additionalToolCallRecords: [],
                    selfReflectionScores: [],
                    stepRecords: [],
                });

            try {
                const result = await noFindingsProvider.analyze(
                    createMockAnalysisEngineInput({
                        parsedDiff: DiffUtils.parseDiff(sampleDiff),
                        llmClient: mockCopilotModelManager as any,
                        token: tokenSource.token,
                    }),
                    createMockAnalysisEngineOutput()
                );

                expect(result.findings.length).toBe(0);
                expect(result.wasTruncated).toBe(true);
                expect(result.completed).toBe(false);
                expect(result.iterationsUsed).toBe(3);
                // Pipeline must NOT have been invoked — no findings to process.
                expect(pipelineRunSpy).not.toHaveBeenCalled();
            } finally {
                pipelineRunSpy.mockRestore();
            }
        });

        it('should still run pipeline when max iterations hit with no findings', async () => {
            // Boundary: runner hits max iterations without ever recording a finding.
            // analysisCompleted remains true, so the pipeline still runs.
            const submitReviewTool = new SubmitReviewTool();
            const mockTool = new MockAnalysisTool();

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

            const capNoFindingsSettings = createMockWorkspaceSettings({
                maxIterations: 3,
                maxRecursionDepth: 0,
            });

            const capNoFindingsProvider = new AnalysisEngine(
                mockToolRegistry,
                mockPromptGenerator,
                capNoFindingsSettings,
                mockDiffEnricher,
                mockFindingValidator
            );

            mockCopilotModelManager.sendRequest.mockImplementation(() => {
                // Burn iterations with tool calls but never record findings.
                return Promise.resolve({
                    content: 'Investigating...',
                    toolCalls: [
                        {
                            id: 'call_find',
                            function: {
                                name: 'find_symbol',
                                arguments: JSON.stringify({
                                    symbolName: 'foo',
                                    file: 'src/auth.ts',
                                }),
                            },
                        },
                    ],
                });
            });

            const pipelineRunSpy = vi
                .spyOn(PostAnalysisPipeline.prototype, 'run')
                .mockResolvedValue({
                    droppedTitles: [],
                    rewrittenAnalysis: undefined,
                    additionalToolCallRecords: [],
                    selfReflectionScores: [],
                    stepRecords: [],
                });

            try {
                const result = await capNoFindingsProvider.analyze(
                    createMockAnalysisEngineInput({
                        parsedDiff: DiffUtils.parseDiff(sampleDiff),
                        llmClient: mockCopilotModelManager as any,
                        token: tokenSource.token,
                    }),
                    createMockAnalysisEngineOutput()
                );

                expect(result.findings.length).toBe(0);
                expect(result.wasTruncated).toBe(true);
                expect(result.completed).toBe(true);
                // Pipeline still runs because analysisCompleted is true (max
                // iterations does not set any negative flag).
                expect(pipelineRunSpy).toHaveBeenCalledTimes(1);
            } finally {
                pipelineRunSpy.mockRestore();
            }
        });

        it('should skip pipeline when cancelled', async () => {
            const pipelineRunSpy = vi
                .spyOn(PostAnalysisPipeline.prototype, 'run')
                .mockResolvedValue({
                    droppedTitles: [],
                    rewrittenAnalysis: undefined,
                    additionalToolCallRecords: [],
                    selfReflectionScores: [],
                    stepRecords: [],
                });

            try {
                const cancelledSource = createMockCancellationTokenSource();
                cancelledSource.cancel();

                const result = await provider.analyze(
                    createMockAnalysisEngineInput({
                        parsedDiff: DiffUtils.parseDiff(sampleDiff),
                        llmClient: mockCopilotModelManager as any,
                        token: cancelledSource.token,
                    }),
                    createMockAnalysisEngineOutput()
                );

                expect(result.findings.length).toBe(0);
                expect(result.wasTruncated).toBe(false);
                expect(result.completed).toBe(false);
                expect(pipelineRunSpy).not.toHaveBeenCalled();
            } finally {
                pipelineRunSpy.mockRestore();
            }
        });

        it('should skip pipeline when quota exhausted', async () => {
            class ChatQuotaExceeded extends Error {
                constructor(message = 'Quota exceeded') {
                    super(message);
                    this.name = 'ChatQuotaExceeded';
                }
            }

            const pipelineRunSpy = vi
                .spyOn(PostAnalysisPipeline.prototype, 'run')
                .mockResolvedValue({
                    droppedTitles: [],
                    rewrittenAnalysis: undefined,
                    additionalToolCallRecords: [],
                    selfReflectionScores: [],
                    stepRecords: [],
                });

            try {
                mockCopilotModelManager.sendRequest.mockRejectedValue(
                    new ChatQuotaExceeded()
                );

                const result = await provider.analyze(
                    createMockAnalysisEngineInput({
                        parsedDiff: DiffUtils.parseDiff(sampleDiff),
                        llmClient: mockCopilotModelManager as any,
                        token: tokenSource.token,
                    }),
                    createMockAnalysisEngineOutput()
                );

                expect(result.findings.length).toBe(0);
                expect(result.wasTruncated).toBe(false);
                expect(result.completed).toBe(false);
                expect(pipelineRunSpy).not.toHaveBeenCalled();
            } finally {
                pipelineRunSpy.mockRestore();
            }
        });

        it('should skip pipeline when rate limited', async () => {
            class ChatRateLimited extends Error {
                constructor(message = 'Rate limited') {
                    super(message);
                    this.name = 'ChatRateLimited';
                }
            }

            vi.useFakeTimers();

            const pipelineRunSpy = vi
                .spyOn(PostAnalysisPipeline.prototype, 'run')
                .mockResolvedValue({
                    droppedTitles: [],
                    rewrittenAnalysis: undefined,
                    additionalToolCallRecords: [],
                    selfReflectionScores: [],
                    stepRecords: [],
                });

            try {
                mockCopilotModelManager.sendRequest.mockRejectedValue(
                    new ChatRateLimited()
                );

                const runPromise = provider.analyze(
                    createMockAnalysisEngineInput({
                        parsedDiff: DiffUtils.parseDiff(sampleDiff),
                        llmClient: mockCopilotModelManager as any,
                        token: tokenSource.token,
                    }),
                    createMockAnalysisEngineOutput()
                );

                // Advance timers past all retry backoffs. The runner retries
                // up to 5 times with cumulative backoff well under 120s.
                await vi.advanceTimersByTimeAsync(120_000);
                const result = await runPromise;

                expect(result.findings.length).toBe(0);
                expect(result.wasTruncated).toBe(false);
                expect(result.completed).toBe(false);
                expect(pipelineRunSpy).not.toHaveBeenCalled();
            } finally {
                pipelineRunSpy.mockRestore();
                vi.useRealTimers();
            }
        });

        it('should surface pipeline errors without losing recorded findings', async () => {
            const recordFindingTool = new RecordFindingTool();
            const submitReviewTool = new SubmitReviewTool();
            const mockTool = new MockAnalysisTool();

            mockToolRegistry.getAllTools.mockReturnValue([
                mockTool,
                recordFindingTool,
                submitReviewTool,
            ]);
            mockToolRegistry.getTool.mockImplementation((name: string) => {
                if (name === 'find_symbol') {
                    return mockTool;
                }
                if (name === 'record_finding') {
                    return recordFindingTool;
                }
                if (name === 'submit_review') {
                    return submitReviewTool;
                }
                return undefined;
            });

            let callCount = 0;
            mockCopilotModelManager.sendRequest.mockImplementation(() => {
                callCount++;
                if (callCount <= 3) {
                    return Promise.resolve({
                        content: 'Investigating...',
                        toolCalls: [
                            {
                                id: `call_${callCount}`,
                                function: {
                                    name: 'find_symbol',
                                    arguments: JSON.stringify({
                                        symbolName: 'validateToken',
                                        file: 'src/auth.ts',
                                    }),
                                },
                            },
                        ],
                    });
                }
                if (callCount === 4) {
                    return Promise.resolve({
                        content: 'I found an issue.',
                        toolCalls: [
                            {
                                id: 'call_record',
                                function: {
                                    name: 'record_finding',
                                    arguments: JSON.stringify({
                                        severity: 'HIGH',
                                        category: 'logic_error',
                                        title: 'Buffer overflow risk',
                                        file: 'src/auth.ts',
                                        line: 20,
                                        description:
                                            'Unbounded string copy into fixed-size buffer.',
                                        verification_evidence:
                                            'Read the function body carefully.',
                                        disproof_note:
                                            'Checked callers with find_usages — all pass unvalidated input.',
                                        affected_component: 'authenticateUser',
                                        failure_mechanism: 'runtime_exception',
                                    }),
                                },
                            },
                        ],
                    });
                }
                return Promise.resolve({
                    content: 'Continuing investigation...',
                    toolCalls: [],
                });
            });

            const pipelineRunSpy = vi
                .spyOn(PostAnalysisPipeline.prototype, 'run')
                .mockRejectedValue(new Error('Pipeline failure'));

            try {
                const truncatedSettings = createMockWorkspaceSettings({
                    maxIterations: 8,
                    maxRecursionDepth: 0,
                });

                const truncatedProvider = new AnalysisEngine(
                    mockToolRegistry,
                    mockPromptGenerator,
                    truncatedSettings,
                    mockDiffEnricher,
                    mockFindingValidator
                );

                const result = await truncatedProvider.analyze(
                    createMockAnalysisEngineInput({
                        parsedDiff: DiffUtils.parseDiff(sampleDiff),
                        llmClient: mockCopilotModelManager as any,
                        token: tokenSource.token,
                    }),
                    createMockAnalysisEngineOutput()
                );

                // Findings should still be present despite pipeline error
                expect(result.findings.length).toBeGreaterThan(0);
                expect(result.error).toContain('Pipeline failure');
                expect(result.completed).toBe(false);
                expect(result.wasTruncated).toBe(true);
                expect(pipelineRunSpy).toHaveBeenCalledTimes(1);
            } finally {
                pipelineRunSpy.mockRestore();
            }
        });
    });
});
