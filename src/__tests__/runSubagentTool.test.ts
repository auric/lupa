import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { RunSubagentTool } from '../tools/runSubagentTool';
import { SubagentExecutor } from '../services/subagentExecutor';
import { SubagentSessionManager } from '../services/subagentSessionManager';
import { WorkspaceSettingsService } from '../services/workspaceSettingsService';
import { SubagentLimits } from '../models/toolConstants';
import { SUBAGENT_LIMITS } from '../models/workspaceSettingsSchema';
import type { SubagentResult } from '../types/modelTypes';
import type { ExecutionContext } from '../types/executionContext';
import {
    createMockWorkspaceSettings,
    createMockExecutionContext,
} from './testUtils/mockFactories';
import { RecursiveStateManager } from '../sessions/recursiveStateManager';
import { TimeoutError } from '../types/errorTypes';

const createMockExecutor = (
    result: Partial<SubagentResult> = {}
): SubagentExecutor =>
    ({
        execute: vi.fn().mockResolvedValue({
            success: true,
            response: 'Test investigation findings with details',
            toolCallsMade: 5,
            toolCalls: [],
            ...result,
        }),
    }) as unknown as SubagentExecutor;

/**
 * Creates an ExecutionContext with subagent dependencies using the standard mock factories.
 */
const createSubagentExecutionContext = (
    executor: SubagentExecutor,
    sessionManager: SubagentSessionManager
): ExecutionContext =>
    createMockExecutionContext({
        subagentExecutor: executor,
        subagentSessionManager: sessionManager,
    });

describe('RunSubagentTool', () => {
    let sessionManager: SubagentSessionManager;
    let workspaceSettings: WorkspaceSettingsService;

    beforeEach(() => {
        workspaceSettings = createMockWorkspaceSettings();
        sessionManager = new SubagentSessionManager(workspaceSettings);
    });

    describe('Tool Metadata', () => {
        it('should have correct name', () => {
            const tool = new RunSubagentTool(workspaceSettings);
            expect(tool.name).toBe('run_subagent');
        });

        it('should have a description', () => {
            const tool = new RunSubagentTool(workspaceSettings);
            expect(tool.description).toBeTruthy();
            expect(tool.description.length).toBeGreaterThan(50);
        });

        it('should generate VS Code tool format', () => {
            const tool = new RunSubagentTool(workspaceSettings);
            const vscTool = tool.getVSCodeTool();

            expect(vscTool.name).toBe('run_subagent');
            expect(vscTool.description).toBe(tool.description);
            expect(vscTool.inputSchema).toBeDefined();
        });
    });

    describe('Input Validation', () => {
        it('should reject tasks that are too short', async () => {
            const mockExecutor = createMockExecutor();
            const tool = new RunSubagentTool(workspaceSettings);
            const context = createSubagentExecutionContext(
                mockExecutor,
                sessionManager
            );

            const result = await tool.execute({ task: 'short' }, context);

            expect(result.success).toBe(false);
            expect(result.error).toContain('chars');
        });

        it('should accept tasks of minimum length', async () => {
            const mockExecutor = createMockExecutor();
            const tool = new RunSubagentTool(workspaceSettings);
            const context = createSubagentExecutionContext(
                mockExecutor,
                sessionManager
            );
            const validTask = 'a'.repeat(SubagentLimits.MIN_TASK_LENGTH);

            const result = await tool.execute({ task: validTask }, context);

            expect(result.success).toBe(true);
        });

        it('should accept optional context parameter', async () => {
            const mockExecutor = createMockExecutor();
            const tool = new RunSubagentTool(workspaceSettings);
            const context = createSubagentExecutionContext(
                mockExecutor,
                sessionManager
            );

            await tool.execute(
                {
                    task: 'Investigate the authentication flow thoroughly',
                    context: 'PR adds new JWT validation',
                },
                context
            );

            expect(mockExecutor.execute).toHaveBeenCalledWith(
                expect.objectContaining({
                    context: 'PR adds new JWT validation',
                }),
                expect.anything(),
                expect.any(Number),
                expect.anything()
            );
        });
    });

    describe('Session Limits', () => {
        it('should track spawned subagents', async () => {
            const mockExecutor = createMockExecutor();
            const tool = new RunSubagentTool(workspaceSettings);
            const context = createSubagentExecutionContext(
                mockExecutor,
                sessionManager
            );

            await tool.execute(
                {
                    task: 'Investigate the authentication flow thoroughly',
                },
                context
            );

            expect(sessionManager.getCount()).toBe(1);
        });

        it('should pass subagent ID to executor', async () => {
            const mockExecutor = createMockExecutor();
            const tool = new RunSubagentTool(workspaceSettings);
            const context = createSubagentExecutionContext(
                mockExecutor,
                sessionManager
            );

            await tool.execute(
                {
                    task: 'Investigate the authentication flow thoroughly',
                },
                context
            );

            expect(mockExecutor.execute).toHaveBeenCalledWith(
                expect.anything(),
                expect.anything(),
                1,
                expect.anything()
            );
        });

        it('should reject when session limit reached', async () => {
            const maxSubagents = SUBAGENT_LIMITS.maxPerSession.default;
            const mockExecutor = createMockExecutor();
            const tool = new RunSubagentTool(workspaceSettings);
            const context = createSubagentExecutionContext(
                mockExecutor,
                sessionManager
            );

            for (let i = 0; i < maxSubagents; i++) {
                sessionManager.recordSpawn();
            }

            const result = await tool.execute(
                {
                    task: 'Investigate the authentication flow thoroughly',
                },
                context
            );

            expect(result.success).toBe(false);
            expect(result.error).toContain('Maximum subagents');
        });

        it('should rollback spawn count on generic executor failure', async () => {
            const mockExecutor = createMockExecutor({
                success: false,
                response: '',
                error: 'LLM service error',
                toolCallsMade: 0,
            });
            const tool = new RunSubagentTool(workspaceSettings);
            const context = createSubagentExecutionContext(
                mockExecutor,
                sessionManager
            );

            expect(sessionManager.getCount()).toBe(0);

            await tool.execute(
                {
                    task: 'Investigate the authentication flow thoroughly',
                },
                context
            );

            // Slot should be recovered — agent barely started
            expect(sessionManager.getCount()).toBe(0);
        });

        it('should NOT rollback spawn count on max_iterations (agent completed work)', async () => {
            const mockExecutor = createMockExecutor({
                success: false,
                response: 'Partial findings',
                error: 'max_iterations',
                toolCallsMade: 30,
            });
            const tool = new RunSubagentTool(workspaceSettings);
            const context = createSubagentExecutionContext(
                mockExecutor,
                sessionManager
            );

            await tool.execute(
                {
                    task: 'Investigate the authentication flow thoroughly',
                },
                context
            );

            // Slot stays consumed — agent ran to iteration limit
            expect(sessionManager.getCount()).toBe(1);
        });

        it('should rollback spawn count when executor throws non-cancellation error', async () => {
            const mockExecutor = {
                execute: vi
                    .fn()
                    .mockRejectedValue(new Error('Unexpected executor crash')),
            } as unknown as SubagentExecutor;
            const tool = new RunSubagentTool(workspaceSettings);
            const context = createSubagentExecutionContext(
                mockExecutor,
                sessionManager
            );

            expect(sessionManager.getCount()).toBe(0);

            await tool.execute(
                {
                    task: 'Investigate the authentication flow thoroughly',
                },
                context
            );

            // Slot should be recovered — executor crashed
            expect(sessionManager.getCount()).toBe(0);
        });
    });

    describe('Result Formatting', () => {
        it('should format successful results with subagent ID', async () => {
            const mockExecutor = createMockExecutor({
                success: true,
                response:
                    'Found security issue in JWT validation. File: auth.ts:45',
                toolCallsMade: 8,
            });
            const tool = new RunSubagentTool(workspaceSettings);
            const context = createSubagentExecutionContext(
                mockExecutor,
                sessionManager
            );

            const result = await tool.execute(
                {
                    task: 'Investigate the authentication flow thoroughly',
                },
                context
            );

            expect(result.success).toBe(true);
            expect(result.data).toContain('Subagent #1');
            expect(result.data).toContain('Investigation Complete');
            expect(result.data).toContain(
                'Found security issue in JWT validation'
            );
            expect(result.data).toContain('8');
        });

        it('should report generic failures as tool errors', async () => {
            const mockExecutor = createMockExecutor({
                success: false,
                response: '',
                error: 'Connection timeout',
                toolCallsMade: 3,
            });
            const tool = new RunSubagentTool(workspaceSettings);
            const context = createSubagentExecutionContext(
                mockExecutor,
                sessionManager
            );

            const result = await tool.execute(
                {
                    task: 'Investigate the authentication flow thoroughly',
                },
                context
            );

            expect(result.success).toBe(false);
            expect(result.error).toContain('Subagent failed');
            expect(result.error).toContain('Connection timeout');
        });
    });

    describe('Max Iterations Handling', () => {
        it('should report max_iterations as failed tool call', async () => {
            const mockExecutor = createMockExecutor({
                success: false,
                response: 'Partial investigation findings so far',
                error: 'max_iterations',
                toolCallsMade: 12,
            });
            const tool = new RunSubagentTool(workspaceSettings);
            const context = createSubagentExecutionContext(
                mockExecutor,
                sessionManager
            );

            const result = await tool.execute(
                {
                    task: 'Investigate the authentication flow thoroughly',
                },
                context
            );

            expect(result.success).toBe(false);
            expect(result.error).toContain('maximum iterations');
            expect(result.error).toContain('12');
        });

        it('should include partial findings in max_iterations error', async () => {
            const mockExecutor = createMockExecutor({
                success: false,
                response: 'Found 3 security issues in auth module',
                error: 'max_iterations',
                toolCallsMade: 50,
            });
            const tool = new RunSubagentTool(workspaceSettings);
            const context = createSubagentExecutionContext(
                mockExecutor,
                sessionManager
            );

            const result = await tool.execute(
                {
                    task: 'Investigate the authentication flow thoroughly',
                },
                context
            );

            expect(result.success).toBe(false);
            expect(result.error).toContain('Partial findings');
            expect(result.error).toContain(
                'Found 3 security issues in auth module'
            );
        });

        it('should handle max_iterations with empty response', async () => {
            const mockExecutor = createMockExecutor({
                success: false,
                response: '',
                error: 'max_iterations',
                toolCallsMade: 100,
            });
            const tool = new RunSubagentTool(workspaceSettings);
            const context = createSubagentExecutionContext(
                mockExecutor,
                sessionManager
            );

            const result = await tool.execute(
                {
                    task: 'Investigate the authentication flow thoroughly',
                },
                context
            );

            expect(result.success).toBe(false);
            expect(result.error).toContain('maximum iterations');
            expect(result.error).not.toContain('Partial findings');
        });
    });

    describe('Error Handling', () => {
        it('should return internal error when subagentExecutor and subagentSessionManager are missing', async () => {
            const tool = new RunSubagentTool(workspaceSettings);
            // Use createMockExecutionContext which has no subagentExecutor/sessionManager by default
            const minimalContext = createMockExecutionContext();

            const result = await tool.execute(
                {
                    task: 'Investigate the authentication flow thoroughly',
                },
                minimalContext
            );

            expect(result.success).toBe(false);
            expect(result.error).toContain('internal error');
        });

        it('should return internal error when subagentExecutor is missing', async () => {
            const tool = new RunSubagentTool(workspaceSettings);
            const partialContext = createMockExecutionContext({
                subagentSessionManager: sessionManager,
            });

            const result = await tool.execute(
                {
                    task: 'Investigate the authentication flow thoroughly',
                },
                partialContext
            );

            expect(result.success).toBe(false);
            expect(result.error).toContain('internal error');
        });

        it('should throw CancellationError immediately when context token is pre-cancelled', async () => {
            const mockExecutor = createMockExecutor();
            const tool = new RunSubagentTool(workspaceSettings);
            const context = createSubagentExecutionContext(
                mockExecutor,
                sessionManager
            );

            // Override with a pre-cancelled token
            const cancelledContext: ExecutionContext = {
                ...context,
                cancellationToken: {
                    isCancellationRequested: true,
                    onCancellationRequested: vi.fn(),
                },
            };

            await expect(
                tool.execute(
                    {
                        task: 'Investigate the authentication flow thoroughly',
                    },
                    cancelledContext
                )
            ).rejects.toThrow(vscode.CancellationError);

            // Executor should never be called
            expect(mockExecutor.execute).not.toHaveBeenCalled();
        });

        it('should handle executor errors gracefully', async () => {
            const mockExecutor = {
                execute: vi.fn().mockRejectedValue(new Error('Internal error')),
            } as unknown as SubagentExecutor;
            const tool = new RunSubagentTool(workspaceSettings);
            const context = createSubagentExecutionContext(
                mockExecutor,
                sessionManager
            );

            const result = await tool.execute(
                {
                    task: 'Investigate the authentication flow thoroughly',
                },
                context
            );

            expect(result.success).toBe(false);
            expect(result.error).toContain('Internal error');
        });

        it('should report timeout correctly when cancelled', async () => {
            const mockExecutor = createMockExecutor({
                success: false,
                response: '',
                error: 'cancelled',
                toolCallsMade: 2,
            });
            const tool = new RunSubagentTool(workspaceSettings);
            const context = createSubagentExecutionContext(
                mockExecutor,
                sessionManager
            );

            const result = await tool.execute(
                {
                    task: 'Investigate the authentication flow thoroughly',
                },
                context
            );

            expect(result.success).toBe(false);
        });

        it('should propagate CancellationError instead of converting to error message', async () => {
            const mockExecutor = {
                execute: vi
                    .fn()
                    .mockRejectedValue(new vscode.CancellationError()),
            } as unknown as SubagentExecutor;
            const tool = new RunSubagentTool(workspaceSettings);
            const context = createSubagentExecutionContext(
                mockExecutor,
                sessionManager
            );

            await expect(
                tool.execute(
                    {
                        task: 'Investigate the authentication flow thoroughly',
                    },
                    context
                )
            ).rejects.toThrow(vscode.CancellationError);
        });

        it('should handle TimeoutError from executor without crashing', async () => {
            const mockExecutor = {
                execute: vi
                    .fn()
                    .mockRejectedValue(TimeoutError.create('subagent', 60000)),
            } as unknown as SubagentExecutor;
            const tool = new RunSubagentTool(workspaceSettings);
            const context = createSubagentExecutionContext(
                mockExecutor,
                sessionManager
            );

            const result = await tool.execute(
                {
                    task: 'Investigate the authentication flow thoroughly',
                },
                context
            );

            // TimeoutError should be converted to error result, not crash the subagent
            expect(result.success).toBe(false);
            // Error message contains the TimeoutError message
            expect(result.error).toContain('Subagent failed');
            expect(result.error).toContain('timed out');
        });

        it('should continue working after a tool inside subagent times out', async () => {
            // Simulates the case where a tool INSIDE the subagent times out
            // The subagent executor should handle this gracefully and return a result
            const mockExecutor = createMockExecutor({
                success: true,
                response: 'Partial findings before timeout occurred',
                toolCallsMade: 3,
            });
            const tool = new RunSubagentTool(workspaceSettings);
            const context = createSubagentExecutionContext(
                mockExecutor,
                sessionManager
            );

            const result = await tool.execute(
                {
                    task: 'Investigate the authentication flow thoroughly',
                },
                context
            );

            // Subagent should return whatever partial results it collected
            expect(result.success).toBe(true);
            expect(result.data).toContain('Partial findings');
        });

        it('should report pre-cancelled executor result as tool error', async () => {
            // When context is pre-cancelled, the executor might return a non-standard error.
            // The tool reports all generic failures as toolError for clear LLM signaling.
            const mockExecutor = createMockExecutor({
                success: false,
                response: '',
                error: 'Analysis was cancelled',
                toolCallsMade: 0,
            });
            const tool = new RunSubagentTool(workspaceSettings);
            const context = createSubagentExecutionContext(
                mockExecutor,
                sessionManager
            );

            const result = await tool.execute(
                {
                    task: 'Investigate the authentication flow thoroughly',
                },
                context
            );

            expect(result.success).toBe(false);
            expect(result.error).toContain('Subagent failed');
        });

        it('should prioritize parent cancellation over timeout when both occur', async () => {
            // Race condition: timeout fires during executor unwinding from parent cancellation.
            // Use 10ms timeout; executor delays 100ms to ensure timeout fires first.
            const shortTimeoutSettings = createMockWorkspaceSettings({
                requestTimeoutSeconds: 0.01,
            });

            const parentTokenSource = new vscode.CancellationTokenSource();
            sessionManager.setParentCancellationToken(parentTokenSource.token);

            const mockExecutor = {
                execute: vi.fn().mockImplementation(async () => {
                    // Wait for the 10ms timeout to fire
                    await new Promise((resolve) => setTimeout(resolve, 100));
                    // Parent also cancels during execution (the race)
                    parentTokenSource.cancel();
                    return {
                        success: false,
                        response: '',
                        error: 'cancelled',
                        toolCallsMade: 0,
                        toolCalls: [],
                    };
                }),
            } as unknown as SubagentExecutor;

            const tool = new RunSubagentTool(shortTimeoutSettings);
            const context = createMockExecutionContext({
                subagentExecutor: mockExecutor,
                subagentSessionManager: sessionManager,
                cancellationToken: parentTokenSource.token,
            });

            const result = await tool.execute(
                {
                    task: 'Investigate the authentication flow thoroughly',
                },
                context
            );

            // Both timeout AND parent cancellation occurred, but parent wins
            expect(result.success).toBe(false);
            expect(result.error).not.toContain('timed out');
        });
    });

    describe('Parallel Execution Safety', () => {
        it('should use separate cancellation tokens for parallel executions', async () => {
            const capturedTokens: vscode.CancellationToken[] = [];
            const mockExecutor = {
                execute: vi
                    .fn()
                    .mockImplementation(
                        (
                            _task: any,
                            token: vscode.CancellationToken,
                            _id: number
                        ) => {
                            capturedTokens.push(token);
                            return Promise.resolve({
                                success: true,
                                response: 'Done',
                                toolCallsMade: 1,
                                toolCalls: [],
                            });
                        }
                    ),
            } as unknown as SubagentExecutor;

            const tool = new RunSubagentTool(workspaceSettings);
            const context = createSubagentExecutionContext(
                mockExecutor,
                sessionManager
            );

            // Execute two subagents in parallel
            const [result1, result2] = await Promise.all([
                tool.execute(
                    { task: 'Investigate auth module for security issues' },
                    context
                ),
                tool.execute(
                    { task: 'Investigate database module for SQL injection' },
                    context
                ),
            ]);

            expect(result1.success).toBe(true);
            expect(result2.success).toBe(true);
            expect(capturedTokens).toHaveLength(2);
            // Each execution should receive a distinct token object
            expect(capturedTokens[0]).not.toBe(capturedTokens[1]);
            // Both spawns should be tracked in session count
            expect(sessionManager.getCount()).toBe(2);
        });

        it('should propagate parent cancellation to child subagent tokens', async () => {
            let resolveExecutor!: (value: SubagentResult) => void;
            const capturedTokens: vscode.CancellationToken[] = [];
            const mockExecutor = {
                execute: vi
                    .fn()
                    .mockImplementation(
                        (_task: any, token: vscode.CancellationToken) => {
                            capturedTokens.push(token);
                            // Return a pending promise so we can test during execution
                            return new Promise<SubagentResult>((resolve) => {
                                resolveExecutor = resolve;
                            });
                        }
                    ),
            } as unknown as SubagentExecutor;

            const parentTokenSource = new vscode.CancellationTokenSource();
            // Critical: link parent token to session manager for propagation
            sessionManager.setParentCancellationToken(parentTokenSource.token);

            const tool = new RunSubagentTool(workspaceSettings);
            const context = createMockExecutionContext({
                subagentExecutor: mockExecutor,
                subagentSessionManager: sessionManager,
                cancellationToken: parentTokenSource.token,
            });

            // Start execution (won't resolve until we say so)
            const executePromise = tool.execute(
                { task: 'Investigate auth module for security issues' },
                context
            );

            // Child token captured and not yet cancelled
            expect(capturedTokens).toHaveLength(1);
            expect(capturedTokens[0].isCancellationRequested).toBe(false);

            // Cancel parent — should propagate to child via session manager
            parentTokenSource.cancel();
            expect(capturedTokens[0].isCancellationRequested).toBe(true);

            // Resolve executor so the promise completes
            resolveExecutor({
                success: false,
                response: '',
                error: 'cancelled',
                toolCallsMade: 0,
                toolCalls: [],
            });

            const result = await executePromise;
            expect(result.success).toBe(false);
        });
    });

    describe('Recursive Depth Tracking', () => {
        it('should pass recursionDepth=1 to executor when no recursiveState', async () => {
            const mockExecutor = createMockExecutor();
            const tool = new RunSubagentTool(workspaceSettings);
            const context = createSubagentExecutionContext(
                mockExecutor,
                sessionManager
            );

            await tool.execute(
                { task: 'Investigate the authentication flow thoroughly' },
                context
            );

            expect(mockExecutor.execute).toHaveBeenCalledWith(
                expect.anything(),
                expect.anything(),
                expect.any(Number),
                expect.objectContaining({
                    recursionDepth: 1,
                    agentId: undefined,
                    recursiveState: undefined,
                })
            );
        });

        it('should use currentDepth from context for recursionDepth calculation', async () => {
            const mockExecutor = createMockExecutor();
            const tool = new RunSubagentTool(workspaceSettings);
            const context = createMockExecutionContext({
                subagentExecutor: mockExecutor,
                subagentSessionManager: sessionManager,
                currentDepth: 2,
                currentAgentId: 'child-1',
            });

            await tool.execute(
                { task: 'Investigate the authentication flow thoroughly' },
                context
            );

            expect(mockExecutor.execute).toHaveBeenCalledWith(
                expect.anything(),
                expect.anything(),
                expect.any(Number),
                expect.objectContaining({
                    recursionDepth: 3,
                })
            );
        });

        it('should use RecursiveStateManager spawn guard when available', async () => {
            const recursiveState = new RecursiveStateManager(3);
            const rootId = recursiveState.registerAgent(
                undefined,
                'root task',
                100
            );
            recursiveState.startAgent(rootId);

            const mockExecutor = createMockExecutor();
            const tool = new RunSubagentTool(workspaceSettings);
            const context = createMockExecutionContext({
                subagentExecutor: mockExecutor,
                subagentSessionManager: sessionManager,
                recursiveState,
                currentDepth: 0,
                currentAgentId: rootId,
            });

            const result = await tool.execute(
                { task: 'Investigate the authentication flow thoroughly' },
                context
            );

            expect(result.success).toBe(true);
            // Should have registered a child agent
            expect(recursiveState.getTotalAgentCount()).toBe(2);
        });

        it('should reject spawn when RecursiveStateManager depth limit reached', async () => {
            const recursiveState = new RecursiveStateManager(1);
            const rootId = recursiveState.registerAgent(undefined, 'root', 100);
            recursiveState.startAgent(rootId);
            const childId = recursiveState.registerAgent(rootId, 'child', 50);
            recursiveState.startAgent(childId);

            const mockExecutor = createMockExecutor();
            const tool = new RunSubagentTool(workspaceSettings);
            const context = createMockExecutionContext({
                subagentExecutor: mockExecutor,
                subagentSessionManager: sessionManager,
                recursiveState,
                currentDepth: 1,
                currentAgentId: childId,
            });

            const result = await tool.execute(
                { task: 'Investigate the authentication flow thoroughly' },
                context
            );

            expect(result.success).toBe(false);
            expect(result.error).toContain('depth');
            expect(mockExecutor.execute).not.toHaveBeenCalled();
        });

        it('should pass recursiveState through to executor options', async () => {
            const recursiveState = new RecursiveStateManager(3);
            const rootId = recursiveState.registerAgent(undefined, 'root', 100);
            recursiveState.startAgent(rootId);

            const mockExecutor = createMockExecutor();
            const tool = new RunSubagentTool(workspaceSettings);
            const context = createMockExecutionContext({
                subagentExecutor: mockExecutor,
                subagentSessionManager: sessionManager,
                recursiveState,
                currentDepth: 0,
                currentAgentId: rootId,
            });

            await tool.execute(
                { task: 'Investigate the authentication flow thoroughly' },
                context
            );

            expect(mockExecutor.execute).toHaveBeenCalledWith(
                expect.anything(),
                expect.anything(),
                expect.any(Number),
                expect.objectContaining({
                    recursiveState,
                })
            );
        });

        it('should pass parsedDiff through to executor options', async () => {
            const recursiveState = new RecursiveStateManager(3);
            const rootId = recursiveState.registerAgent(undefined, 'root', 100);
            recursiveState.startAgent(rootId);

            const parsedDiff = [
                {
                    filePath: 'file.ts',
                    hunks: [],
                    isNewFile: false,
                    isDeletedFile: false,
                    originalHeader: 'diff --git a/file.ts b/file.ts',
                },
            ];

            const mockExecutor = createMockExecutor();
            const tool = new RunSubagentTool(workspaceSettings);
            const context = createMockExecutionContext({
                subagentExecutor: mockExecutor,
                subagentSessionManager: sessionManager,
                recursiveState,
                currentDepth: 0,
                currentAgentId: rootId,
                parsedDiff,
            });

            await tool.execute(
                { task: 'Investigate the authentication flow thoroughly' },
                context
            );

            expect(mockExecutor.execute).toHaveBeenCalledWith(
                expect.anything(),
                expect.anything(),
                expect.any(Number),
                expect.objectContaining({
                    parsedDiff,
                })
            );
        });

        it('should default currentDepth to 0 when undefined with recursiveState', async () => {
            const recursiveState = new RecursiveStateManager(3);
            const rootId = recursiveState.registerAgent(undefined, 'root', 100);
            recursiveState.startAgent(rootId);

            const mockExecutor = createMockExecutor();
            const tool = new RunSubagentTool(workspaceSettings);
            const context = createMockExecutionContext({
                subagentExecutor: mockExecutor,
                subagentSessionManager: sessionManager,
                recursiveState,
                // currentDepth intentionally omitted — should default to 0
                currentAgentId: rootId,
            });

            await tool.execute(
                { task: 'Investigate the authentication flow thoroughly' },
                context
            );

            // recursionDepth should be currentDepth(0) + 1 = 1
            expect(mockExecutor.execute).toHaveBeenCalledWith(
                expect.anything(),
                expect.anything(),
                expect.any(Number),
                expect.objectContaining({
                    recursionDepth: 1,
                })
            );
        });

        it('should mark child agent as completed on success', async () => {
            const recursiveState = new RecursiveStateManager(3);
            const rootId = recursiveState.registerAgent(undefined, 'root', 100);
            recursiveState.startAgent(rootId);

            const mockExecutor = createMockExecutor({ success: true });
            const tool = new RunSubagentTool(workspaceSettings);
            const context = createMockExecutionContext({
                subagentExecutor: mockExecutor,
                subagentSessionManager: sessionManager,
                recursiveState,
                currentDepth: 0,
                currentAgentId: rootId,
            });

            await tool.execute(
                { task: 'Investigate the authentication flow thoroughly' },
                context
            );

            // Find the child node
            const rootNode = recursiveState.getNode(rootId)!;
            expect(rootNode.childIds).toHaveLength(1);
            const childNode = recursiveState.getNode(rootNode.childIds[0]!)!;
            expect(childNode.status).toBe('completed');
        });

        it('should mark child agent as failed on executor error', async () => {
            const recursiveState = new RecursiveStateManager(3);
            const rootId = recursiveState.registerAgent(undefined, 'root', 100);
            recursiveState.startAgent(rootId);

            const mockExecutor = {
                execute: vi.fn().mockRejectedValue(new Error('LLM failure')),
            } as unknown as SubagentExecutor;
            const tool = new RunSubagentTool(workspaceSettings);
            const context = createMockExecutionContext({
                subagentExecutor: mockExecutor,
                subagentSessionManager: sessionManager,
                recursiveState,
                currentDepth: 0,
                currentAgentId: rootId,
            });

            await tool.execute(
                { task: 'Investigate the authentication flow thoroughly' },
                context
            );

            const rootNode = recursiveState.getNode(rootId)!;
            const childNode = recursiveState.getNode(rootNode.childIds[0]!)!;
            expect(childNode.status).toBe('failed');
        });

        it('should mark child agent as cancelled on cancellation result', async () => {
            const recursiveState = new RecursiveStateManager(3);
            const rootId = recursiveState.registerAgent(undefined, 'root', 100);
            recursiveState.startAgent(rootId);

            const mockExecutor = createMockExecutor({
                success: false,
                error: 'cancelled',
            });
            const tool = new RunSubagentTool(workspaceSettings);
            const context = createMockExecutionContext({
                subagentExecutor: mockExecutor,
                subagentSessionManager: sessionManager,
                recursiveState,
                currentDepth: 0,
                currentAgentId: rootId,
            });

            await tool.execute(
                { task: 'Investigate the authentication flow thoroughly' },
                context
            );

            const rootNode = recursiveState.getNode(rootId)!;
            const childNode = recursiveState.getNode(rootNode.childIds[0]!)!;
            expect(childNode.status).toBe('cancelled');
        });

        it('should fall back to flat SessionManager when no recursiveState', async () => {
            const maxSubagents = SUBAGENT_LIMITS.maxPerSession.default;
            for (let i = 0; i < maxSubagents; i++) {
                sessionManager.recordSpawn();
            }

            const mockExecutor = createMockExecutor();
            const tool = new RunSubagentTool(workspaceSettings);
            const context = createSubagentExecutionContext(
                mockExecutor,
                sessionManager
            );
            // No recursiveState → uses sessionManager.canSpawn()

            const result = await tool.execute(
                { task: 'Investigate the authentication flow thoroughly' },
                context
            );

            expect(result.success).toBe(false);
            expect(result.error).toContain('Maximum subagents');
        });

        it('should enforce session limit even when recursiveState is present', async () => {
            const maxSubagents = SUBAGENT_LIMITS.maxPerSession.default;
            for (let i = 0; i < maxSubagents; i++) {
                sessionManager.recordSpawn();
            }

            const recursiveState = new RecursiveStateManager(3);
            const rootId = recursiveState.registerAgent(
                undefined,
                'root task',
                200
            );
            recursiveState.startAgent(rootId);

            const mockExecutor = createMockExecutor();
            const tool = new RunSubagentTool(workspaceSettings);
            const context = createMockExecutionContext({
                subagentExecutor: mockExecutor,
                subagentSessionManager: sessionManager,
                recursiveState,
                currentDepth: 0,
                currentAgentId: rootId,
            });

            const result = await tool.execute(
                { task: 'Investigate the authentication flow thoroughly' },
                context
            );

            expect(result.success).toBe(false);
            expect(result.error).toContain('Maximum subagents');
            expect(mockExecutor.execute).not.toHaveBeenCalled();
        });

        it('should mark child agent as cancelled (not failed) when executor throws CancellationError', async () => {
            const recursiveState = new RecursiveStateManager(3);
            const rootId = recursiveState.registerAgent(undefined, 'root', 100);
            recursiveState.startAgent(rootId);

            const mockExecutor = {
                execute: vi
                    .fn()
                    .mockRejectedValue(new vscode.CancellationError()),
            } as unknown as SubagentExecutor;
            const tool = new RunSubagentTool(workspaceSettings);
            const context = createMockExecutionContext({
                subagentExecutor: mockExecutor,
                subagentSessionManager: sessionManager,
                recursiveState,
                currentDepth: 0,
                currentAgentId: rootId,
            });

            await expect(
                tool.execute(
                    {
                        task: 'Investigate the authentication flow thoroughly',
                    },
                    context
                )
            ).rejects.toThrow(vscode.CancellationError);

            // Agent should be marked as cancelled, NOT failed
            const rootNode = recursiveState.getNode(rootId)!;
            const childNode = recursiveState.getNode(rootNode.childIds[0]!)!;
            expect(childNode.status).toBe('cancelled');
        });

        it('should pass subagentSessionManager through to executor options', async () => {
            const recursiveState = new RecursiveStateManager(3);
            const rootId = recursiveState.registerAgent(undefined, 'root', 100);
            recursiveState.startAgent(rootId);

            const mockExecutor = createMockExecutor();
            const tool = new RunSubagentTool(workspaceSettings);
            const context = createMockExecutionContext({
                subagentExecutor: mockExecutor,
                subagentSessionManager: sessionManager,
                recursiveState,
                currentDepth: 0,
                currentAgentId: rootId,
            });

            await tool.execute(
                { task: 'Investigate the authentication flow thoroughly' },
                context
            );

            expect(mockExecutor.execute).toHaveBeenCalledWith(
                expect.anything(),
                expect.anything(),
                expect.any(Number),
                expect.objectContaining({
                    subagentSessionManager: sessionManager,
                })
            );
        });

        it('should return toolError when registerAgent throws', async () => {
            // Create a mock recursiveState where registerAgent throws
            const mockRecursiveState = {
                canSpawnChild: vi.fn().mockReturnValue({ allowed: true }),
                allocateChildBudget: vi.fn().mockReturnValue(30),
                registerAgent: vi.fn().mockImplementation(() => {
                    throw new Error('Root agent already registered');
                }),
            };

            const mockExecutor = createMockExecutor();
            const tool = new RunSubagentTool(workspaceSettings);
            const context = createMockExecutionContext({
                subagentExecutor: mockExecutor,
                subagentSessionManager: sessionManager,
                recursiveState: mockRecursiveState as any,
                currentDepth: 0,
                currentAgentId: 'root',
            });

            const result = await tool.execute(
                { task: 'Investigate the authentication flow thoroughly' },
                context
            );

            expect(result.success).toBe(false);
            expect(result.error).toContain('Failed to register subagent');
            expect(mockExecutor.execute).not.toHaveBeenCalled();
            // Spawn count should be rolled back so the budget slot isn't consumed
            expect(sessionManager.getCount()).toBe(0);
        });
    });
});
