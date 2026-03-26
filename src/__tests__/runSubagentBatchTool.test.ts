import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { RunSubagentBatchTool } from '../tools/runSubagentBatchTool';
import { SubagentExecutor } from '../services/subagentExecutor';
import { SubagentSessionManager } from '../services/subagentSessionManager';
import { WorkspaceSettingsService } from '../services/workspaceSettingsService';
import { ANALYSIS_LIMITS } from '../models/workspaceSettingsSchema';
import type { SubagentResult } from '../types/modelTypes';
import type { ExecutionContext } from '../types/executionContext';
import type { DiffHunk } from '../types/contextTypes';
import type { ToolCallRecord } from '../types/toolCallTypes';
import {
    createMockWorkspaceSettings,
    createMockExecutionContext,
    createTestRecursiveState,
} from './testUtils/mockFactories';

const VALID_TASK =
    'Investigate the authentication flow thoroughly for security issues';

const createMockExecutor = (
    result: Partial<SubagentResult> = {}
): SubagentExecutor =>
    ({
        execute: vi.fn().mockResolvedValue({
            success: true,
            response: 'Investigation complete: no issues found.',
            toolCallsMade: 5,
            toolCalls: [],
            executionTimeMs: 1000,
            iterationsUsed: 3,
            ...result,
        }),
    }) as unknown as SubagentExecutor;

const createMockExecutorWithResults = (
    results: Partial<SubagentResult>[]
): SubagentExecutor => {
    const defaultResult: SubagentResult = {
        success: true,
        response: 'Investigation complete: no issues found.',
        toolCallsMade: 5,
        toolCalls: [],
        executionTimeMs: 1000,
        iterationsUsed: 3,
    };
    const mock = vi.fn();
    for (const result of results) {
        mock.mockResolvedValueOnce({ ...defaultResult, ...result });
    }
    return { execute: mock } as unknown as SubagentExecutor;
};

const createMockSessionManager = (): SubagentSessionManager => {
    return new SubagentSessionManager(createMockWorkspaceSettings());
};

const createBatchExecutionContext = (
    executor: SubagentExecutor,
    sessionManager: SubagentSessionManager,
    overrides?: Partial<ExecutionContext>
): ExecutionContext =>
    createMockExecutionContext({
        subagentExecutor: executor,
        subagentSessionManager: sessionManager,
        ...overrides,
    });

describe('RunSubagentBatchTool', () => {
    let sessionManager: SubagentSessionManager;
    let workspaceSettings: WorkspaceSettingsService;

    beforeEach(() => {
        workspaceSettings = createMockWorkspaceSettings();
        sessionManager = new SubagentSessionManager(workspaceSettings);
    });

    describe('Tool Metadata', () => {
        it('should have correct name', () => {
            const tool = new RunSubagentBatchTool(workspaceSettings);
            expect(tool.name).toBe('run_subagent_batch');
        });

        it('should generate VS Code tool format', () => {
            const tool = new RunSubagentBatchTool(workspaceSettings);
            const vscTool = tool.getVSCodeTool();

            expect(vscTool.name).toBe('run_subagent_batch');
            expect(vscTool.description).toBe(tool.description);
            expect(vscTool.inputSchema).toBeDefined();
        });
    });

    describe('Input Validation', () => {
        it('should reject empty tasks array', async () => {
            const executor = createMockExecutor();
            const tool = new RunSubagentBatchTool(workspaceSettings);
            const context = createBatchExecutionContext(
                executor,
                sessionManager
            );

            const result = await tool.execute({ tasks: [] as any }, context);

            expect(result.success).toBe(false);
        });

        it('should reject tasks with too-short task strings via schema', () => {
            const tool = new RunSubagentBatchTool(workspaceSettings);
            const parseResult = tool.schema.safeParse({
                tasks: [{ task: 'short' }],
            });

            expect(parseResult.success).toBe(false);
        });

        it('should accept valid single-task batch', async () => {
            const executor = createMockExecutor();
            const tool = new RunSubagentBatchTool(workspaceSettings);
            const context = createBatchExecutionContext(
                executor,
                sessionManager
            );

            const result = await tool.execute(
                { tasks: [{ task: VALID_TASK }] },
                context
            );

            expect(result.success).toBe(true);
        });

        it('should accept valid multi-task batch', async () => {
            const executor = createMockExecutor();
            const tool = new RunSubagentBatchTool(workspaceSettings);
            const context = createBatchExecutionContext(
                executor,
                sessionManager
            );

            const result = await tool.execute(
                {
                    tasks: [
                        { task: VALID_TASK },
                        {
                            task: 'Review database queries for SQL injection vulnerabilities',
                        },
                        {
                            task: 'Check error handling patterns across the codebase thoroughly',
                        },
                    ],
                },
                context
            );

            expect(result.success).toBe(true);
            expect(executor.execute).toHaveBeenCalledTimes(3);
        });
    });

    describe('normalizeArgs', () => {
        it('should swap context into task per item when task is empty/short', () => {
            const tool = new RunSubagentBatchTool(workspaceSettings);
            const longContext =
                'Investigate the authentication flow in detail for security issues';

            const result = tool.normalizeArgs({
                tasks: [
                    { task: '', context: longContext },
                    {
                        task: 'ok',
                        context:
                            'another long context for investigation purposes',
                    },
                ],
            });

            const tasks = (result as any).tasks;
            expect(tasks[0].task).toBe(longContext);
            expect(tasks[0].context).toBeUndefined();
            expect(tasks[1].task).toBe(
                'another long context for investigation purposes'
            );
            expect(tasks[1].context).toBeUndefined();
        });

        it('should leave items alone when task is long enough', () => {
            const tool = new RunSubagentBatchTool(workspaceSettings);

            const result = tool.normalizeArgs({
                tasks: [{ task: VALID_TASK, context: 'some context' }],
            });

            const tasks = (result as any).tasks;
            expect(tasks[0].task).toBe(VALID_TASK);
            expect(tasks[0].context).toBe('some context');
        });

        it('should parse tasks from JSON string', () => {
            const tool = new RunSubagentBatchTool(workspaceSettings);
            const tasksArray = [{ task: VALID_TASK, context: 'some context' }];

            const result = tool.normalizeArgs({
                tasks: JSON.stringify(tasksArray),
            });

            const tasks = (result as any).tasks;
            expect(tasks).toHaveLength(1);
            expect(tasks[0].task).toBe(VALID_TASK);
        });

        it('should wrap single task object in array', () => {
            const tool = new RunSubagentBatchTool(workspaceSettings);

            const result = tool.normalizeArgs({
                tasks: { task: VALID_TASK, context: 'ctx' },
            });

            const tasks = (result as any).tasks;
            expect(tasks).toHaveLength(1);
            expect(tasks[0].task).toBe(VALID_TASK);
        });

        it('should filter out null items in tasks array', () => {
            const tool = new RunSubagentBatchTool(workspaceSettings);

            const result = tool.normalizeArgs({
                tasks: [null, { task: VALID_TASK }, undefined],
            });

            const tasks = (result as any).tasks;
            expect(tasks).toHaveLength(1);
            expect(tasks[0].task).toBe(VALID_TASK);
        });

        it('should return empty tasks array for non-parseable string', () => {
            const tool = new RunSubagentBatchTool(workspaceSettings);

            const result = tool.normalizeArgs({
                tasks: 'not valid json',
            });

            const tasks = (result as any).tasks;
            expect(tasks).toHaveLength(0);
        });
    });

    describe('Parallel Execution', () => {
        it('should execute multiple tasks in parallel', async () => {
            const executor = createMockExecutor();
            const tool = new RunSubagentBatchTool(workspaceSettings);
            const context = createBatchExecutionContext(
                executor,
                sessionManager
            );

            await tool.execute(
                {
                    tasks: [
                        { task: VALID_TASK },
                        {
                            task: 'Review database queries for SQL injection vulnerabilities',
                        },
                    ],
                },
                context
            );

            expect(executor.execute).toHaveBeenCalledTimes(2);
        });

        it('should call executor.execute for each subagent separately', async () => {
            const executor = createMockExecutorWithResults([
                { response: 'Result A' },
                { response: 'Result B' },
                { response: 'Result C' },
            ]);
            const tool = new RunSubagentBatchTool(workspaceSettings);
            const context = createBatchExecutionContext(
                executor,
                sessionManager
            );

            const result = await tool.execute(
                {
                    tasks: [
                        { task: VALID_TASK },
                        {
                            task: 'Review database queries for SQL injection vulnerabilities',
                        },
                        {
                            task: 'Check error handling patterns across the codebase thoroughly',
                        },
                    ],
                },
                context
            );

            expect(executor.execute).toHaveBeenCalledTimes(3);
            expect(result.data).toContain('Result A');
            expect(result.data).toContain('Result B');
            expect(result.data).toContain('Result C');
        });

        it('should order results by original task index', async () => {
            const executor = createMockExecutorWithResults([
                { response: 'First result' },
                { response: 'Second result' },
            ]);
            const tool = new RunSubagentBatchTool(workspaceSettings);
            const context = createBatchExecutionContext(
                executor,
                sessionManager
            );

            const result = await tool.execute(
                {
                    tasks: [
                        { task: VALID_TASK },
                        {
                            task: 'Review database queries for SQL injection vulnerabilities',
                        },
                    ],
                },
                context
            );

            const firstIdx = result.data!.indexOf('First result');
            const secondIdx = result.data!.indexOf('Second result');
            expect(firstIdx).toBeLessThan(secondIdx);
        });
    });

    describe('Session Limits', () => {
        it('should spawn only as many as getRemainingBudget allows', async () => {
            const maxSubagents = ANALYSIS_LIMITS.maxSubagentsPerSession;
            // Fill all but 2 slots
            for (let i = 0; i < maxSubagents - 2; i++) {
                sessionManager.recordSpawn();
            }

            const executor = createMockExecutor();
            const tool = new RunSubagentBatchTool(workspaceSettings);
            const context = createBatchExecutionContext(
                executor,
                sessionManager
            );

            const result = await tool.execute(
                {
                    tasks: [
                        { task: VALID_TASK },
                        {
                            task: 'Review database queries for SQL injection vulnerabilities',
                        },
                        {
                            task: 'Check error handling patterns across the codebase thoroughly',
                        },
                        {
                            task: 'Analyze memory management patterns in the application code',
                        },
                    ],
                },
                context
            );

            expect(executor.execute).toHaveBeenCalledTimes(2);
            expect(result.data).toContain('SKIPPED');
            expect(result.data).toContain('Session limit');
        });

        it('should mark excess tasks as skipped with reason', async () => {
            const maxSubagents = ANALYSIS_LIMITS.maxSubagentsPerSession;
            for (let i = 0; i < maxSubagents - 1; i++) {
                sessionManager.recordSpawn();
            }

            const executor = createMockExecutor();
            const tool = new RunSubagentBatchTool(workspaceSettings);
            const context = createBatchExecutionContext(
                executor,
                sessionManager
            );

            const result = await tool.execute(
                {
                    tasks: [
                        { task: VALID_TASK },
                        {
                            task: 'Review database queries for SQL injection vulnerabilities',
                        },
                    ],
                },
                context
            );

            expect(executor.execute).toHaveBeenCalledTimes(1);
            expect(result.data).toContain('SKIPPED');
        });

        it('should return error when 0 slots available', async () => {
            const maxSubagents = ANALYSIS_LIMITS.maxSubagentsPerSession;
            for (let i = 0; i < maxSubagents; i++) {
                sessionManager.recordSpawn();
            }

            const executor = createMockExecutor();
            const tool = new RunSubagentBatchTool(workspaceSettings);
            const context = createBatchExecutionContext(
                executor,
                sessionManager
            );

            const result = await tool.execute(
                { tasks: [{ task: VALID_TASK }] },
                context
            );

            expect(result.success).toBe(false);
            expect(result.error).toContain('Maximum subagents');
            expect(executor.execute).not.toHaveBeenCalled();
        });

        it('should NOT rollback on successful batch', async () => {
            const executor = createMockExecutor();
            const tool = new RunSubagentBatchTool(workspaceSettings);
            const context = createBatchExecutionContext(
                executor,
                sessionManager
            );

            await tool.execute(
                {
                    tasks: [
                        { task: VALID_TASK },
                        {
                            task: 'Review database queries for SQL injection vulnerabilities',
                        },
                    ],
                },
                context
            );

            expect(sessionManager.getCount()).toBe(2);
        });

        it('should NOT rollback on partially successful batch', async () => {
            const executor = createMockExecutorWithResults([
                { success: true },
                { success: false, error: 'max_iterations', toolCallsMade: 30 },
            ]);
            const tool = new RunSubagentBatchTool(workspaceSettings);
            const context = createBatchExecutionContext(
                executor,
                sessionManager
            );

            await tool.execute(
                {
                    tasks: [
                        { task: VALID_TASK },
                        {
                            task: 'Review database queries for SQL injection vulnerabilities',
                        },
                    ],
                },
                context
            );

            expect(sessionManager.getCount()).toBe(2);
        });
    });

    describe('Partial Failures', () => {
        it('should return combined results when some succeed and some fail', async () => {
            const executor = createMockExecutorWithResults([
                { success: true, response: 'Auth looks good' },
                { success: false, error: 'LLM service error', response: '' },
            ]);
            const tool = new RunSubagentBatchTool(workspaceSettings);
            const context = createBatchExecutionContext(
                executor,
                sessionManager
            );

            const result = await tool.execute(
                {
                    tasks: [
                        { task: VALID_TASK },
                        {
                            task: 'Review database queries for SQL injection vulnerabilities',
                        },
                    ],
                },
                context
            );

            expect(result.success).toBe(true);
            expect(result.data).toContain('1/2 subagents completed');
            expect(result.data).toContain('Auth looks good');
            expect(result.data).toContain('FAILED');
        });

        it('should include partial findings for max_iterations failures', async () => {
            const executor = createMockExecutor({
                success: false,
                error: 'max_iterations',
                response: 'Found 3 issues before running out of iterations',
                toolCallsMade: 30,
            });
            const tool = new RunSubagentBatchTool(workspaceSettings);
            const context = createBatchExecutionContext(
                executor,
                sessionManager
            );

            const result = await tool.execute(
                { tasks: [{ task: VALID_TASK }] },
                context
            );

            expect(result.data).toContain('FAILED');
            expect(result.data).toContain('Partial findings');
            expect(result.data).toContain('Found 3 issues');
        });

        it('should include partial findings for rate_limited failures', async () => {
            const executor = createMockExecutor({
                success: false,
                error: 'rate_limited',
                response: 'Partial rate-limited findings',
                toolCallsMade: 8,
            });
            const tool = new RunSubagentBatchTool(workspaceSettings);
            const context = createBatchExecutionContext(
                executor,
                sessionManager
            );

            const result = await tool.execute(
                { tasks: [{ task: VALID_TASK }] },
                context
            );

            expect(result.data).toContain('FAILED');
            expect(result.data).toContain('Partial rate-limited findings');
        });

        it('should trigger rollback on generic failure', async () => {
            const executor = createMockExecutor({
                success: false,
                error: 'LLM service error',
                response: '',
                toolCallsMade: 0,
            });
            const tool = new RunSubagentBatchTool(workspaceSettings);
            const context = createBatchExecutionContext(
                executor,
                sessionManager
            );

            await tool.execute({ tasks: [{ task: VALID_TASK }] }, context);

            expect(sessionManager.getCount()).toBe(0);
        });
    });

    describe('Cancellation', () => {
        it('should throw CancellationError immediately when pre-cancelled', async () => {
            const executor = createMockExecutor();
            const tool = new RunSubagentBatchTool(workspaceSettings);
            const context = createBatchExecutionContext(
                executor,
                sessionManager,
                {
                    cancellationToken: {
                        isCancellationRequested: true,
                        onCancellationRequested: vi.fn(),
                    },
                }
            );

            await expect(
                tool.execute({ tasks: [{ task: VALID_TASK }] }, context)
            ).rejects.toThrow(vscode.CancellationError);

            expect(executor.execute).not.toHaveBeenCalled();
        });

        it('should throw CancellationError when parent cancels during execution', async () => {
            const parentTokenSource = new vscode.CancellationTokenSource();
            sessionManager.setParentCancellationToken(parentTokenSource.token);

            let resolvers: ((value: SubagentResult) => void)[] = [];
            const executor = {
                execute: vi.fn().mockImplementation(() => {
                    return new Promise<SubagentResult>((resolve) => {
                        resolvers.push(resolve);
                    });
                }),
            } as unknown as SubagentExecutor;

            const tool = new RunSubagentBatchTool(workspaceSettings);
            const context = createBatchExecutionContext(
                executor,
                sessionManager,
                {
                    cancellationToken: parentTokenSource.token,
                }
            );

            const promise = tool.execute(
                {
                    tasks: [
                        { task: VALID_TASK },
                        {
                            task: 'Review database queries for SQL injection vulnerabilities',
                        },
                    ],
                },
                context
            );

            // Cancel parent while tasks are in-flight
            parentTokenSource.cancel();

            // Resolve executors with cancelled result
            for (const resolve of resolvers) {
                resolve({
                    success: false,
                    response: '',
                    error: 'cancelled',
                    toolCallsMade: 0,
                    toolCalls: [],
                    executionTimeMs: 0,
                });
            }

            await expect(promise).rejects.toThrow(vscode.CancellationError);
        });

        it('should report individual subagent timeout as failed (not rethrown)', async () => {
            vi.useFakeTimers();
            try {
                const shortTimeoutSettings = {
                    ...createMockWorkspaceSettings(),
                    getRequestTimeoutSeconds: () => 0.01, // 10ms
                } as WorkspaceSettingsService;

                const resolvers: ((value: SubagentResult) => void)[] = [];
                const executor = {
                    execute: vi.fn().mockImplementation(() => {
                        return new Promise<SubagentResult>((resolve) => {
                            resolvers.push(resolve);
                        });
                    }),
                } as unknown as SubagentExecutor;

                const tool = new RunSubagentBatchTool(shortTimeoutSettings);
                const sm = new SubagentSessionManager(shortTimeoutSettings);
                const context = createBatchExecutionContext(executor, sm);

                const promise = tool.execute(
                    {
                        tasks: [
                            { task: VALID_TASK },
                            {
                                task: 'Review database queries for SQL injection vulnerabilities',
                            },
                        ],
                    },
                    context
                );

                // Advance past the 10ms timeout so cancelledByTimeout = true
                await vi.advanceTimersByTimeAsync(50);

                resolvers[0]!({
                    success: true,
                    response: 'Quick result',
                    toolCallsMade: 3,
                    toolCalls: [],
                    executionTimeMs: 5,
                    iterationsUsed: 1,
                });
                resolvers[1]!({
                    success: false,
                    error: 'cancelled',
                    response: '',
                    toolCallsMade: 0,
                    toolCalls: [],
                    executionTimeMs: 10,
                    iterationsUsed: 0,
                });

                const result = await promise;
                expect(result.success).toBe(true);
                expect(result.data).toContain('1/2 subagents completed');
            } finally {
                vi.useRealTimers();
            }
        });
    });

    describe('Recursive State', () => {
        it('should register each task as an agent in recursive tree', async () => {
            const { recursiveState, rootId } = createTestRecursiveState();
            const executor = createMockExecutor();
            const tool = new RunSubagentBatchTool(workspaceSettings);
            const context = createBatchExecutionContext(
                executor,
                sessionManager,
                {
                    recursiveState,
                    currentDepth: 0,
                    currentAgentId: rootId,
                }
            );

            await tool.execute(
                {
                    tasks: [
                        { task: VALID_TASK },
                        {
                            task: 'Review database queries for SQL injection vulnerabilities',
                        },
                    ],
                },
                context
            );

            // root + 2 children
            expect(recursiveState.getTotalAgentCount()).toBe(3);
        });

        it('should complete successful agents', async () => {
            const { recursiveState, rootId } = createTestRecursiveState();
            const executor = createMockExecutor({ success: true });
            const tool = new RunSubagentBatchTool(workspaceSettings);
            const context = createBatchExecutionContext(
                executor,
                sessionManager,
                {
                    recursiveState,
                    currentDepth: 0,
                    currentAgentId: rootId,
                }
            );

            await tool.execute({ tasks: [{ task: VALID_TASK }] }, context);

            const rootNode = recursiveState.getNode(rootId)!;
            const childNode = recursiveState.getNode(rootNode.childIds[0]!)!;
            expect(childNode.status).toBe('completed');
        });

        it('should fail failed agents', async () => {
            const { recursiveState, rootId } = createTestRecursiveState();
            const executor = createMockExecutor({
                success: false,
                error: 'LLM service error',
                response: '',
            });
            const tool = new RunSubagentBatchTool(workspaceSettings);
            const context = createBatchExecutionContext(
                executor,
                sessionManager,
                {
                    recursiveState,
                    currentDepth: 0,
                    currentAgentId: rootId,
                }
            );

            await tool.execute({ tasks: [{ task: VALID_TASK }] }, context);

            const rootNode = recursiveState.getNode(rootId)!;
            const childNode = recursiveState.getNode(rootNode.childIds[0]!)!;
            expect(childNode.status).toBe('failed');
        });

        it('should cancel cancelled agents', async () => {
            const { recursiveState, rootId } = createTestRecursiveState();
            const executor = {
                execute: vi
                    .fn()
                    .mockRejectedValue(new vscode.CancellationError()),
            } as unknown as SubagentExecutor;

            const tool = new RunSubagentBatchTool(workspaceSettings);
            const context = createBatchExecutionContext(
                executor,
                sessionManager,
                {
                    recursiveState,
                    currentDepth: 0,
                    currentAgentId: rootId,
                }
            );

            await expect(
                tool.execute({ tasks: [{ task: VALID_TASK }] }, context)
            ).rejects.toThrow(vscode.CancellationError);

            const rootNode = recursiveState.getNode(rootId)!;
            const childNode = recursiveState.getNode(rootNode.childIds[0]!)!;
            expect(childNode.status).toBe('cancelled');
        });

        it('should skip tasks when canSpawnChild returns not allowed', async () => {
            const mockRecursiveState = {
                canSpawnChild: vi.fn().mockReturnValue({
                    allowed: false,
                    reason: 'Insufficient budget (2 < 3)',
                }),
            };

            const executor = createMockExecutor();
            const tool = new RunSubagentBatchTool(workspaceSettings);
            const context = createBatchExecutionContext(
                executor,
                sessionManager,
                {
                    recursiveState: mockRecursiveState as any,
                    currentDepth: 1,
                    currentAgentId: 'child-1',
                }
            );

            const result = await tool.execute(
                {
                    tasks: [
                        { task: VALID_TASK },
                        {
                            task: 'Review database queries for SQL injection vulnerabilities',
                        },
                    ],
                },
                context
            );

            expect(executor.execute).not.toHaveBeenCalled();
            expect(result.success).toBe(false);
            expect(result.error).toContain('Insufficient budget');
        });

        it('should rollback spawn when agent registration fails', async () => {
            const { recursiveState, rootId } = createTestRecursiveState();
            vi.spyOn(recursiveState, 'registerAgent').mockImplementation(() => {
                throw new Error('Max agents exceeded');
            });

            const executor = createMockExecutor();
            const tool = new RunSubagentBatchTool(workspaceSettings);
            const context = createBatchExecutionContext(
                executor,
                sessionManager,
                {
                    recursiveState,
                    currentDepth: 0,
                    currentAgentId: rootId,
                }
            );

            await tool.execute({ tasks: [{ task: VALID_TASK }] }, context);

            expect(sessionManager.getCount()).toBe(0);
            expect(executor.execute).not.toHaveBeenCalled();
        });
    });

    describe('Result Format', () => {
        it('should contain batch header with completion count', async () => {
            const executor = createMockExecutorWithResults([
                { success: true, response: 'Good' },
                { success: false, error: 'LLM error', response: '' },
            ]);
            const tool = new RunSubagentBatchTool(workspaceSettings);
            const context = createBatchExecutionContext(
                executor,
                sessionManager
            );

            const result = await tool.execute(
                {
                    tasks: [
                        { task: VALID_TASK },
                        {
                            task: 'Review database queries for SQL injection vulnerabilities',
                        },
                    ],
                },
                context
            );

            expect(result.data).toContain('1/2 subagents completed');
        });

        it('should include tool call count and response for successful subagents', async () => {
            const executor = createMockExecutor({
                success: true,
                response: 'Found no issues in the auth module',
                toolCallsMade: 12,
            });
            const tool = new RunSubagentBatchTool(workspaceSettings);
            const context = createBatchExecutionContext(
                executor,
                sessionManager
            );

            const result = await tool.execute(
                { tasks: [{ task: VALID_TASK }] },
                context
            );

            expect(result.data).toContain('12');
            expect(result.data).toContain('Found no issues in the auth module');
        });

        it('should include error message for failed subagents', async () => {
            const executor = createMockExecutor({
                success: false,
                error: 'Connection timeout',
                response: '',
            });
            const tool = new RunSubagentBatchTool(workspaceSettings);
            const context = createBatchExecutionContext(
                executor,
                sessionManager
            );

            const result = await tool.execute(
                { tasks: [{ task: VALID_TASK }] },
                context
            );

            expect(result.data).toContain('FAILED');
            expect(result.data).toContain('Connection timeout');
        });

        it('should include reason for skipped tasks', async () => {
            const maxSubagents = ANALYSIS_LIMITS.maxSubagentsPerSession;
            for (let i = 0; i < maxSubagents - 1; i++) {
                sessionManager.recordSpawn();
            }

            const executor = createMockExecutor();
            const tool = new RunSubagentBatchTool(workspaceSettings);
            const context = createBatchExecutionContext(
                executor,
                sessionManager
            );

            const result = await tool.execute(
                {
                    tasks: [
                        { task: VALID_TASK },
                        {
                            task: 'Review database queries for SQL injection vulnerabilities',
                        },
                    ],
                },
                context
            );

            expect(result.data).toContain('SKIPPED');
            expect(result.data).toContain('Session limit');
        });
    });

    describe('Metadata Aggregation', () => {
        it('should aggregate nestedToolCalls from all subagents', async () => {
            const toolCall1 = {
                id: '1',
                toolName: 'read_file',
                arguments: { filePath: 'a.ts' },
                result: 'content',
                success: true,
                error: undefined,
                durationMs: 10,
                timestamp: Date.now(),
            };
            const toolCall2 = {
                id: '2',
                toolName: 'find_symbol',
                arguments: { symbol: 'foo' },
                result: 'found',
                success: true,
                error: undefined,
                durationMs: 20,
                timestamp: Date.now(),
            };

            const executor = createMockExecutorWithResults([
                { success: true, toolCalls: [toolCall1] },
                { success: true, toolCalls: [toolCall2] },
            ]);
            const tool = new RunSubagentBatchTool(workspaceSettings);
            const context = createBatchExecutionContext(
                executor,
                sessionManager
            );

            const result = await tool.execute(
                {
                    tasks: [
                        { task: VALID_TASK },
                        {
                            task: 'Review database queries for SQL injection vulnerabilities',
                        },
                    ],
                },
                context
            );

            expect(result.metadata?.nestedToolCalls).toHaveLength(2);
            // Each entry is a synthetic per-subagent record with nested calls
            const subagentRecords = result.metadata!.nestedToolCalls!;
            expect(subagentRecords[0]!.toolName).toBe('run_subagent_batch');
            expect(subagentRecords[0]!.nestedCalls).toEqual([toolCall1]);
            expect(subagentRecords[1]!.toolName).toBe('run_subagent_batch');
            expect(subagentRecords[1]!.nestedCalls).toEqual([toolCall2]);
        });

        it('should sum executionTimeMs across subagents', async () => {
            const executor = createMockExecutorWithResults([
                { success: true, executionTimeMs: 500 },
                { success: true, executionTimeMs: 1500 },
            ]);
            const tool = new RunSubagentBatchTool(workspaceSettings);
            const context = createBatchExecutionContext(
                executor,
                sessionManager
            );

            const result = await tool.execute(
                {
                    tasks: [
                        { task: VALID_TASK },
                        {
                            task: 'Review database queries for SQL injection vulnerabilities',
                        },
                    ],
                },
                context
            );

            expect(result.metadata?.executionTimeMs).toBe(2000);
        });

        it('should sum iterationsUsed across subagents', async () => {
            const executor = createMockExecutorWithResults([
                { success: true, iterationsUsed: 5 },
                { success: true, iterationsUsed: 8 },
            ]);
            const tool = new RunSubagentBatchTool(workspaceSettings);
            const context = createBatchExecutionContext(
                executor,
                sessionManager
            );

            const result = await tool.execute(
                {
                    tasks: [
                        { task: VALID_TASK },
                        {
                            task: 'Review database queries for SQL injection vulnerabilities',
                        },
                    ],
                },
                context
            );

            expect(result.metadata?.iterationsUsed).toBe(13);
        });
    });

    describe('Response Truncation', () => {
        let tool: RunSubagentBatchTool;

        beforeEach(() => {
            tool = new RunSubagentBatchTool(workspaceSettings);
        });

        it('should return full responses when within budget', async () => {
            const response = 'Investigation complete: no issues found.';
            const executor = createMockExecutor({ response });
            const sessionManager = createMockSessionManager();
            const context = createBatchExecutionContext(
                executor,
                sessionManager
            );

            const result = await tool.execute(
                {
                    tasks: [
                        { task: VALID_TASK },
                        {
                            task: 'Check error handling in API endpoints for proper status codes',
                        },
                    ],
                },
                context
            );

            expect(result.success).toBe(true);
            expect(result.data).toContain(response);
            expect(result.data).not.toContain('truncated');
        });

        it('should truncate individual responses proportionally when total exceeds budget', async () => {
            // Create responses that collectively exceed MAX_SUBAGENT_RESPONSE_CHARS (150K)
            const largeResponse = 'A'.repeat(60_000);
            const executor = createMockExecutorWithResults([
                { response: largeResponse },
                { response: largeResponse },
                { response: largeResponse },
            ]);
            const sessionManager = createMockSessionManager();
            const context = createBatchExecutionContext(
                executor,
                sessionManager
            );

            const result = await tool.execute(
                {
                    tasks: [
                        { task: VALID_TASK },
                        {
                            task: 'Check error handling in API endpoints for proper status codes',
                        },
                        {
                            task: 'Review database queries for SQL injection vulnerabilities',
                        },
                    ],
                },
                context
            );

            expect(result.success).toBe(true);
            // Should contain truncation markers
            expect(result.data).toContain('truncated');
            // Should still contain all subagent headers
            expect(result.data).toContain('Subagent #1');
            expect(result.data).toContain('Subagent #2');
            expect(result.data).toContain('Subagent #3');
        });

        it('should have maxResponseChars set to 150000', () => {
            expect(tool.maxResponseChars).toBe(150_000);
        });
    });

    describe('extractFilesExamined', () => {
        const makeDiffHunk = (filePath: string): DiffHunk => ({
            filePath,
            hunks: [],
            isNewFile: false,
            isDeletedFile: false,
            originalHeader: `diff --git a/${filePath} b/${filePath}`,
        });

        const makeGetFileDiffCall = (
            filePaths: string | string[]
        ): ToolCallRecord => ({
            id: 'test-id',
            toolName: 'get_file_diff',
            arguments: { file_paths: filePaths },
            result: 'diff content',
            success: true,
            error: undefined,
            durationMs: 10,
            timestamp: Date.now(),
        });

        it('should resolve exact-match file paths', () => {
            const diff = [makeDiffHunk('src/services/auth.ts')];
            const calls = [makeGetFileDiffCall(['src/services/auth.ts'])];
            const result = RunSubagentBatchTool.extractFilesExamined(
                calls,
                diff
            );
            expect(result).toEqual(['src/services/auth.ts']);
        });

        it('should resolve case-insensitive file paths', () => {
            const diff = [makeDiffHunk('src/services/auth.ts')];
            const calls = [makeGetFileDiffCall(['src/services/Auth.ts'])];
            const result = RunSubagentBatchTool.extractFilesExamined(
                calls,
                diff
            );
            expect(result).toEqual(['src/services/auth.ts']);
        });

        it('should resolve suffix matches', () => {
            const diff = [makeDiffHunk('src/services/auth.ts')];
            const calls = [makeGetFileDiffCall(['auth.ts'])];
            const result = RunSubagentBatchTool.extractFilesExamined(
                calls,
                diff
            );
            expect(result).toEqual(['src/services/auth.ts']);
        });

        it('should prefer exact match over case-insensitive', () => {
            const diff = [
                makeDiffHunk('src/Auth.ts'),
                makeDiffHunk('src/auth.ts'),
            ];
            const calls = [makeGetFileDiffCall(['src/auth.ts'])];
            const result = RunSubagentBatchTool.extractFilesExamined(
                calls,
                diff
            );
            expect(result).toEqual(['src/auth.ts']);
        });

        it('should handle newline-separated string input', () => {
            const diff = [makeDiffHunk('src/a.ts'), makeDiffHunk('src/b.ts')];
            const calls = [makeGetFileDiffCall('src/a.ts\nsrc/b.ts')];
            const result = RunSubagentBatchTool.extractFilesExamined(
                calls,
                diff
            );
            expect(result).toEqual(['src/a.ts', 'src/b.ts']);
        });

        it('should deduplicate resolved paths', () => {
            const diff = [makeDiffHunk('src/auth.ts')];
            const calls = [
                makeGetFileDiffCall(['src/auth.ts']),
                makeGetFileDiffCall(['src/Auth.ts']),
            ];
            const result = RunSubagentBatchTool.extractFilesExamined(
                calls,
                diff
            );
            expect(result).toEqual(['src/auth.ts']);
        });

        it('should skip unresolvable paths', () => {
            const diff = [makeDiffHunk('src/auth.ts')];
            const calls = [makeGetFileDiffCall(['src/nonexistent.ts'])];
            const result = RunSubagentBatchTool.extractFilesExamined(
                calls,
                diff
            );
            expect(result).toEqual([]);
        });

        it('should ignore non-get_file_diff tool calls', () => {
            const diff = [makeDiffHunk('src/auth.ts')];
            const calls: ToolCallRecord[] = [
                {
                    id: 'test-id',
                    toolName: 'read_file',
                    arguments: { file_paths: ['src/auth.ts'] },
                    result: 'content',
                    success: true,
                    error: undefined,
                    durationMs: 10,
                    timestamp: Date.now(),
                },
            ];
            const result = RunSubagentBatchTool.extractFilesExamined(
                calls,
                diff
            );
            expect(result).toEqual([]);
        });
    });
});
