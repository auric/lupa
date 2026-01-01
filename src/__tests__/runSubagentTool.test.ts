import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RunSubagentTool } from '../tools/runSubagentTool';
import { SubagentExecutor } from '../services/subagentExecutor';
import { SubagentSessionManager } from '../services/subagentSessionManager';
import { WorkspaceSettingsService } from '../services/workspaceSettingsService';
import { SubagentLimits } from '../models/toolConstants';
import { SUBAGENT_LIMITS } from '../models/workspaceSettingsSchema';
import type { SubagentResult } from '../types/modelTypes';
import type { ExecutionContext } from '../types/executionContext';
import { createMockWorkspaceSettings } from './testUtils/mockFactories';

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

const createExecutionContext = (
    executor: SubagentExecutor,
    sessionManager: SubagentSessionManager
): ExecutionContext => ({
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
            const context = createExecutionContext(
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
            const context = createExecutionContext(
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
            const context = createExecutionContext(
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
            const context = createExecutionContext(
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
            const context = createExecutionContext(
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
            const context = createExecutionContext(
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
            const context = createExecutionContext(
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
            const context = createExecutionContext(
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

    describe('Error Handling', () => {
        it('should return internal error when ExecutionContext is missing', async () => {
            const tool = new RunSubagentTool(workspaceSettings);

            const result = await tool.execute(
                {
                    task: 'Investigate the authentication flow thoroughly',
                },
                undefined
            );

            expect(result.success).toBe(false);
            expect(result.error).toContain('internal error');
        });

        it('should return internal error when subagentExecutor is missing', async () => {
            const tool = new RunSubagentTool(workspaceSettings);
            const partialContext = {
                subagentSessionManager: sessionManager,
            } as ExecutionContext;

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
            const context = createExecutionContext(
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
            const context = createExecutionContext(
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
    });
});
