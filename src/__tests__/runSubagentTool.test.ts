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
                expect.any(Number)
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
                1
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

        it('should format failed results with subagent ID', async () => {
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

            expect(result.success).toBe(true);
            expect(result.data).toContain('Subagent #1');
            expect(result.data).toContain('Failed');
            expect(result.data).toContain('Connection timeout');
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

        it('should not propagate pre-cancelled token as error if executor handles it', async () => {
            // When context is pre-cancelled, the executor might return a cancelled result
            // The tool wraps this in toolSuccess with formatted failure message
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

            // Tool returns success=true with formatted failure message
            // (so the parent LLM can interpret the cancellation gracefully)
            expect(result.success).toBe(true);
            expect(result.data).toContain('Failed');
        });
    });
});
