import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RunSubagentTool } from '../tools/runSubagentTool';
import { SubagentExecutor } from '../services/subagentExecutor';
import { SubagentSessionManager } from '../services/subagentSessionManager';
import { SubagentLimits, SubagentErrors } from '../models/toolConstants';
import type { SubagentResult } from '../types/modelTypes';

// Mock the SubagentExecutor
const createMockExecutor = (result: Partial<SubagentResult> = {}): SubagentExecutor => ({
    execute: vi.fn().mockResolvedValue({
        success: true,
        findings: 'Test findings',
        summary: 'Test summary',
        answer: 'Test answer',
        toolCallsMade: 5,
        ...result
    })
} as unknown as SubagentExecutor);

describe('RunSubagentTool', () => {
    let sessionManager: SubagentSessionManager;

    beforeEach(() => {
        sessionManager = new SubagentSessionManager();
    });

    describe('Tool Metadata', () => {
        it('should have correct name', () => {
            const tool = new RunSubagentTool(createMockExecutor(), sessionManager);
            expect(tool.name).toBe('run_subagent');
        });

        it('should have a description', () => {
            const tool = new RunSubagentTool(createMockExecutor(), sessionManager);
            expect(tool.description).toBeTruthy();
            expect(tool.description.length).toBeGreaterThan(50);
        });

        it('should generate VS Code tool format', () => {
            const tool = new RunSubagentTool(createMockExecutor(), sessionManager);
            const vscTool = tool.getVSCodeTool();

            expect(vscTool.name).toBe('run_subagent');
            expect(vscTool.description).toBe(tool.description);
            expect(vscTool.inputSchema).toBeDefined();
        });
    });

    describe('Input Validation', () => {
        it('should reject tasks that are too short', async () => {
            const tool = new RunSubagentTool(createMockExecutor(), sessionManager);

            const result = await tool.execute({ task: 'short' });

            expect(result.success).toBe(false);
            expect(result.error).toContain('chars');
        });

        it('should accept tasks of minimum length', async () => {
            const tool = new RunSubagentTool(createMockExecutor(), sessionManager);
            const validTask = 'a'.repeat(SubagentLimits.MIN_TASK_LENGTH);

            const result = await tool.execute({ task: validTask });

            expect(result.success).toBe(true);
        });

        it('should accept optional context parameter', async () => {
            const mockExecutor = createMockExecutor();
            const tool = new RunSubagentTool(mockExecutor, sessionManager);

            await tool.execute({
                task: 'Investigate the authentication flow thoroughly',
                context: 'PR adds new JWT validation'
            });

            expect(mockExecutor.execute).toHaveBeenCalledWith(
                expect.objectContaining({ context: 'PR adds new JWT validation' }),
                expect.anything()
            );
        });

        it('should accept optional max_tool_calls parameter', async () => {
            const mockExecutor = createMockExecutor();
            const tool = new RunSubagentTool(mockExecutor, sessionManager);

            await tool.execute({
                task: 'Investigate the authentication flow thoroughly',
                max_tool_calls: 12
            });

            expect(mockExecutor.execute).toHaveBeenCalledWith(
                expect.objectContaining({ maxToolCalls: 12 }),
                expect.anything()
            );
        });

        it('should reject max_tool_calls above limit', async () => {
            const tool = new RunSubagentTool(createMockExecutor(), sessionManager);

            const result = await tool.execute({
                task: 'Investigate the authentication flow thoroughly',
                max_tool_calls: SubagentLimits.MAX_TOOL_CALLS + 1
            });

            expect(result.success).toBe(false);
        });
    });

    describe('Session Limits', () => {
        it('should track spawned subagents', async () => {
            const tool = new RunSubagentTool(createMockExecutor(), sessionManager);

            await tool.execute({ task: 'Investigate the authentication flow thoroughly' });

            expect(sessionManager.getCount()).toBe(1);
        });

        it('should reject when session limit reached', async () => {
            const tool = new RunSubagentTool(createMockExecutor(), sessionManager);

            // Fill up the session
            for (let i = 0; i < SubagentLimits.MAX_PER_SESSION; i++) {
                sessionManager.recordSpawn();
            }

            const result = await tool.execute({
                task: 'Investigate the authentication flow thoroughly'
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain('Maximum subagents');
        });
    });

    describe('Result Formatting', () => {
        it('should format successful results', async () => {
            const mockExecutor = createMockExecutor({
                success: true,
                findings: 'Found security issue',
                summary: 'JWT validation missing',
                answer: 'Yes, there is a vulnerability',
                toolCallsMade: 8
            });
            const tool = new RunSubagentTool(mockExecutor, sessionManager);

            const result = await tool.execute({
                task: 'Investigate the authentication flow thoroughly'
            });

            expect(result.success).toBe(true);
            expect(result.data).toContain('Investigation Complete');
            expect(result.data).toContain('Found security issue');
            expect(result.data).toContain('JWT validation missing');
            expect(result.data).toContain('Yes, there is a vulnerability');
            expect(result.data).toContain('8');
        });

        it('should format failed results', async () => {
            const mockExecutor = createMockExecutor({
                success: false,
                error: 'Connection timeout',
                toolCallsMade: 3
            });
            const tool = new RunSubagentTool(mockExecutor, sessionManager);

            const result = await tool.execute({
                task: 'Investigate the authentication flow thoroughly'
            });

            expect(result.success).toBe(true); // Tool execution succeeded, subagent reported failure
            expect(result.data).toContain('Failed');
            expect(result.data).toContain('Connection timeout');
        });
    });

    describe('Error Handling', () => {
        it('should handle executor errors gracefully', async () => {
            const mockExecutor = {
                execute: vi.fn().mockRejectedValue(new Error('Internal error'))
            } as unknown as SubagentExecutor;

            const tool = new RunSubagentTool(mockExecutor, sessionManager);

            const result = await tool.execute({
                task: 'Investigate the authentication flow thoroughly'
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain('Internal error');
        });
    });
});
