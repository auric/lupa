import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { SubagentExecutor } from '../services/subagentExecutor';
import { CopilotModelManager } from '../models/copilotModelManager';
import { ToolRegistry } from '../models/toolRegistry';
import { SubagentPromptGenerator } from '../prompts/subagentPromptGenerator';
import { SubagentLimits } from '../models/toolConstants';
import { WorkspaceSettingsService } from '../services/workspaceSettingsService';
import type { ITool } from '../tools/ITool';
import {
    createMockWorkspaceSettings,
    createMockCancellationTokenSource,
} from './testUtils/mockFactories';

const createMockModelManager = (
    responses: Array<{ content: string | null; toolCalls?: any[] }>
) => {
    let callIndex = 0;
    return {
        sendRequest: vi.fn().mockImplementation(() => {
            const response = responses[callIndex] || {
                content: 'Default response',
                toolCalls: undefined,
            };
            callIndex++;
            return Promise.resolve(response);
        }),
        getCurrentModel: vi.fn().mockResolvedValue({
            id: 'test-model',
            maxInputTokens: 100000,
            countTokens: vi.fn().mockResolvedValue(100),
        }),
    } as unknown as CopilotModelManager;
};

const createMockTool = (name: string): ITool =>
    ({
        name,
        description: `Mock ${name} tool`,
        schema: {},
        execute: vi.fn().mockResolvedValue({ success: true, data: 'result' }),
        getVSCodeTool: vi.fn().mockReturnValue({
            name,
            description: `Mock ${name} tool`,
            inputSchema: { type: 'object', properties: {} },
        }),
    }) as unknown as ITool;

const createMockPromptGenerator = () =>
    ({
        generateSystemPrompt: vi.fn().mockReturnValue('You are a subagent.'),
    }) as unknown as SubagentPromptGenerator;

describe('SubagentExecutor', () => {
    let workspaceSettings: WorkspaceSettingsService;
    let promptGenerator: SubagentPromptGenerator;
    let tokenSource: vscode.CancellationTokenSource;

    beforeEach(() => {
        workspaceSettings = createMockWorkspaceSettings();
        promptGenerator = createMockPromptGenerator();
        tokenSource = createMockCancellationTokenSource();
    });

    const createExecutor = (
        modelManager: CopilotModelManager,
        tools: ITool[] = [createMockTool('read_file')]
    ) => {
        const registry = new ToolRegistry();
        for (const tool of tools) {
            registry.registerTool(tool);
        }
        return new SubagentExecutor(
            modelManager,
            registry,
            promptGenerator,
            workspaceSettings
        );
    };

    const defaultTask = {
        task: 'Investigate the authentication flow in auth.ts thoroughly',
        context: undefined,
    };

    describe('Normal Completion', () => {
        it('should return success with response from LLM', async () => {
            const modelManager = createMockModelManager([
                { content: 'Investigation complete: no issues found.' },
            ]);
            const executor = createExecutor(modelManager);

            const result = await executor.execute(
                defaultTask,
                tokenSource.token,
                1
            );

            expect(result.success).toBe(true);
            expect(result.response).toBe(
                'Investigation complete: no issues found.'
            );
        });

        it('should track tool calls made during investigation', async () => {
            const modelManager = createMockModelManager([
                {
                    content: null,
                    toolCalls: [
                        {
                            id: 'call_1',
                            function: {
                                name: 'read_file',
                                arguments: '{"path":"auth.ts"}',
                            },
                        },
                    ],
                },
                { content: 'Found issue in auth.ts' },
            ]);
            const executor = createExecutor(modelManager);

            const result = await executor.execute(
                defaultTask,
                tokenSource.token,
                1
            );

            expect(result.success).toBe(true);
            expect(result.toolCallsMade).toBe(1);
            expect(result.toolCalls).toHaveLength(1);
            expect(result.toolCalls[0]!.toolName).toBe('read_file');
        });
    });

    describe('Max Iterations Detection', () => {
        it('should detect when runner hits max iterations', async () => {
            // Make model always return tool calls to exhaust iterations
            const modelManager = createMockModelManager(
                Array(10).fill({
                    content: null,
                    toolCalls: [
                        {
                            id: 'call_1',
                            function: {
                                name: 'read_file',
                                arguments: '{}',
                            },
                        },
                    ],
                })
            );

            // Use low maxIterations via settings override
            const lowIterSettings = createMockWorkspaceSettings({
                maxIterations: 2,
            });
            const registry = new ToolRegistry();
            registry.registerTool(createMockTool('read_file'));
            const executor = new SubagentExecutor(
                modelManager,
                registry,
                promptGenerator,
                lowIterSettings
            );

            const result = await executor.execute(
                defaultTask,
                tokenSource.token,
                1
            );

            expect(result.success).toBe(false);
            expect(result.error).toBe('max_iterations');
        });

        it('should preserve partial response on max iterations', async () => {
            const modelManager = createMockModelManager(
                Array(10).fill({
                    content: null,
                    toolCalls: [
                        {
                            id: 'call_1',
                            function: {
                                name: 'read_file',
                                arguments: '{}',
                            },
                        },
                    ],
                })
            );
            const lowIterSettings = createMockWorkspaceSettings({
                maxIterations: 2,
            });
            const registry = new ToolRegistry();
            registry.registerTool(createMockTool('read_file'));
            const executor = new SubagentExecutor(
                modelManager,
                registry,
                promptGenerator,
                lowIterSettings
            );

            const result = await executor.execute(
                defaultTask,
                tokenSource.token,
                1
            );

            expect(result.success).toBe(false);
            expect(result.error).toBe('max_iterations');
            // Response contains the runner's max-iterations message
            expect(result.response).toBeTruthy();
        });
    });

    describe('Cancellation Detection', () => {
        it('should detect cancellation via wasCancelled flag', async () => {
            // Pre-cancel the token before execution
            tokenSource.cancel();

            const modelManager = createMockModelManager([
                { content: 'Should not reach here' },
            ]);
            const executor = createExecutor(modelManager);

            const result = await executor.execute(
                defaultTask,
                tokenSource.token,
                1
            );

            expect(result.success).toBe(false);
            expect(result.error).toBe('cancelled');
            expect(result.response).toBe('');
        });

        it('should detect cancellation when CancellationError thrown by model', async () => {
            // ConversationRunner catches CancellationError internally, returns
            // empty string, and sets wasCancelled=true. SubagentExecutor detects
            // the flag and returns cancelled result (does NOT rethrow).
            const modelManager = {
                sendRequest: vi
                    .fn()
                    .mockRejectedValue(new vscode.CancellationError()),
                getCurrentModel: vi.fn().mockResolvedValue({
                    id: 'test-model',
                    maxInputTokens: 100000,
                    countTokens: vi.fn().mockResolvedValue(100),
                }),
            } as unknown as CopilotModelManager;

            const executor = createExecutor(modelManager);

            const result = await executor.execute(
                defaultTask,
                tokenSource.token,
                1
            );

            expect(result.success).toBe(false);
            expect(result.error).toBe('cancelled');
        });
    });

    describe('Error Handling', () => {
        it('should catch errors thrown before runner.run and return failure', async () => {
            // If promptGenerator throws, the error is caught by SubagentExecutor's
            // try/catch (not ConversationRunner's internal loop).
            const modelManager = createMockModelManager([{ content: 'Done' }]);
            const failingPromptGen = {
                generateSystemPrompt: vi.fn().mockImplementation(() => {
                    throw new Error('Prompt generation failed');
                }),
            } as unknown as SubagentPromptGenerator;

            const registry = new ToolRegistry();
            registry.registerTool(createMockTool('read_file'));
            const executor = new SubagentExecutor(
                modelManager,
                registry,
                failingPromptGen,
                workspaceSettings
            );

            const result = await executor.execute(
                defaultTask,
                tokenSource.token,
                1
            );

            expect(result.success).toBe(false);
            expect(result.error).toContain('Prompt generation failed');
        });

        it('should rethrow CancellationError from setup phase', async () => {
            const modelManager = createMockModelManager([{ content: 'Done' }]);
            const failingPromptGen = {
                generateSystemPrompt: vi.fn().mockImplementation(() => {
                    throw new vscode.CancellationError();
                }),
            } as unknown as SubagentPromptGenerator;

            const registry = new ToolRegistry();
            registry.registerTool(createMockTool('read_file'));
            const executor = new SubagentExecutor(
                modelManager,
                registry,
                failingPromptGen,
                workspaceSettings
            );

            await expect(
                executor.execute(defaultTask, tokenSource.token, 1)
            ).rejects.toThrow(vscode.CancellationError);
        });
    });

    describe('Tool Filtering', () => {
        it('should filter out disallowed tools', async () => {
            const modelManager = createMockModelManager([{ content: 'Done' }]);

            const allowedTool = createMockTool('read_file');
            const disallowedTools = SubagentLimits.DISALLOWED_TOOLS.map(
                (name) => createMockTool(name)
            );
            const allTools = [allowedTool, ...disallowedTools];

            const executor = createExecutor(modelManager, allTools);
            const result = await executor.execute(
                defaultTask,
                tokenSource.token,
                1
            );

            expect(result.success).toBe(true);

            // Verify prompt generator received only allowed tools
            const promptCall = vi.mocked(promptGenerator.generateSystemPrompt)
                .mock.calls[0]!;
            const toolsPassedToPrompt = promptCall[1] as ITool[];
            const filteredNames = toolsPassedToPrompt.map((t) => t.name);

            expect(filteredNames).toContain('read_file');
            for (const disallowed of SubagentLimits.DISALLOWED_TOOLS) {
                expect(filteredNames).not.toContain(disallowed);
            }
        });

        it('should keep think_about_investigation tool', async () => {
            const modelManager = createMockModelManager([{ content: 'Done' }]);

            const thinkTool = createMockTool('think_about_investigation');
            const executor = createExecutor(modelManager, [thinkTool]);
            await executor.execute(defaultTask, tokenSource.token, 1);

            const promptCall = vi.mocked(promptGenerator.generateSystemPrompt)
                .mock.calls[0]!;
            const toolsPassedToPrompt = promptCall[1] as ITool[];
            expect(toolsPassedToPrompt.map((t) => t.name)).toContain(
                'think_about_investigation'
            );
        });
    });

    describe('Progress Reporting', () => {
        it('should call progress callback with context prefix', async () => {
            const modelManager = createMockModelManager([{ content: 'Done' }]);
            const progressCallback = vi.fn();
            const progressContext = {
                getCurrentIteration: vi.fn().mockReturnValue(3),
                getMaxIterations: vi.fn().mockReturnValue(10),
            };

            const registry = new ToolRegistry();
            registry.registerTool(createMockTool('read_file'));

            const executor = new SubagentExecutor(
                modelManager,
                registry,
                promptGenerator,
                workspaceSettings,
                undefined, // chatHandler
                progressCallback,
                progressContext
            );

            await executor.execute(defaultTask, tokenSource.token, 1);

            expect(progressCallback).toHaveBeenCalledWith(
                expect.stringContaining('Turn 3/10'),
                expect.any(Number)
            );
        });
    });
});
