import { describe, it, expect, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import * as z from 'zod';
import { ToolExecutor, ToolExecutionRequest } from '../models/toolExecutor';
import { ToolRegistry } from '../models/toolRegistry';
import { ITool } from '../tools/ITool';
import { WorkspaceSettingsService } from '../services/workspaceSettingsService';
import {
    ANALYSIS_LIMITS,
    SUBAGENT_LIMITS,
} from '../models/workspaceSettingsSchema';
import { ToolResult, toolSuccess, toolError } from '../types/toolResultTypes';
import { TokenConstants } from '../models/tokenConstants';
import { TimeoutError } from '../types/errorTypes';
import { createMockExecutionContext } from './testUtils/mockFactories';
import type { ExecutionContext } from '../types/executionContext';

/**
 * Create a mock WorkspaceSettingsService for testing with a specific max iterations limit
 */
function createMockSettings(maxIterations: number): WorkspaceSettingsService {
    return {
        getMaxIterations: () => maxIterations,
        getRequestTimeoutSeconds: () =>
            ANALYSIS_LIMITS.requestTimeoutSeconds.default,
        getMaxSubagentsPerSession: () => SUBAGENT_LIMITS.maxPerSession.default,
    } as WorkspaceSettingsService;
}

// Mock tools for testing
class MockSuccessTool implements ITool {
    name = 'success_tool';
    description = 'A tool that always succeeds';
    schema = z.object({ message: z.string() });

    getVSCodeTool() {
        return {
            name: this.name,
            description: this.description,
            inputSchema: z.toJSONSchema(this.schema),
        };
    }

    async execute(args: any, _context: ExecutionContext): Promise<ToolResult> {
        return toolSuccess(`Success: ${args.message}`);
    }
}

class MockErrorTool implements ITool {
    name = 'error_tool';
    description = 'A tool that always throws errors';
    schema = z.object({ input: z.string() });

    getVSCodeTool() {
        return {
            name: this.name,
            description: this.description,
            inputSchema: z.toJSONSchema(this.schema),
        };
    }

    async execute(_args: any, _context: ExecutionContext): Promise<ToolResult> {
        throw new Error('Simulated tool error');
    }
}

class MockDelayTool implements ITool {
    name = 'delay_tool';
    description = 'A tool with artificial delay';
    schema = z.object({ delay: z.number() });

    getVSCodeTool() {
        return {
            name: this.name,
            description: this.description,
            inputSchema: z.toJSONSchema(this.schema),
        };
    }

    async execute(args: any, _context: ExecutionContext): Promise<ToolResult> {
        await new Promise((resolve) => setTimeout(resolve, args.delay));
        return toolSuccess(`Delayed by ${args.delay}ms`);
    }
}

describe('ToolExecutor', () => {
    let toolExecutor: ToolExecutor;
    let toolRegistry: ToolRegistry;
    let mockSettings: WorkspaceSettingsService;
    let successTool: MockSuccessTool;
    let errorTool: MockErrorTool;
    let delayTool: MockDelayTool;

    beforeEach(() => {
        toolRegistry = new ToolRegistry();
        mockSettings = createMockSettings(
            ANALYSIS_LIMITS.maxIterations.default
        );
        toolExecutor = new ToolExecutor(
            toolRegistry,
            mockSettings,
            createMockExecutionContext()
        );
        successTool = new MockSuccessTool();
        errorTool = new MockErrorTool();
        delayTool = new MockDelayTool();

        // Register tools
        toolRegistry.registerTool(successTool);
        toolRegistry.registerTool(errorTool);
        toolRegistry.registerTool(delayTool);
    });

    describe('Single Tool Execution', () => {
        it('should execute tool successfully', async () => {
            const result = await toolExecutor.executeTool('success_tool', {
                message: 'test',
            });

            expect(result.success).toBe(true);
            expect(result.name).toBe('success_tool');
            expect(result.result).toBe('Success: test');
            expect(result.error).toBeUndefined();
        });

        it('should handle tool not found', async () => {
            const result = await toolExecutor.executeTool('non_existent_tool', {
                input: 'test',
            });

            expect(result.success).toBe(false);
            expect(result.name).toBe('non_existent_tool');
            expect(result.error).toBe(
                "Tool 'non_existent_tool' not found in registry"
            );
            expect(result.result).toBeUndefined();
        });

        it('should handle tool execution errors', async () => {
            const result = await toolExecutor.executeTool('error_tool', {
                input: 'test',
            });

            expect(result.success).toBe(false);
            expect(result.name).toBe('error_tool');
            expect(result.error).toBe('Simulated tool error');
            expect(result.result).toBeUndefined();
        });
    });

    describe('Multiple Tools Execution (Parallel)', () => {
        it('should execute multiple tools in parallel', async () => {
            const requests: ToolExecutionRequest[] = [
                { name: 'success_tool', args: { message: 'first' } },
                { name: 'success_tool', args: { message: 'second' } },
            ];

            const results = await toolExecutor.executeTools(requests);

            expect(results).toHaveLength(2);
            expect(results[0].success).toBe(true);
            expect(results[0].result).toBe('Success: first');
            expect(results[1].success).toBe(true);
            expect(results[1].result).toBe('Success: second');
        });

        it('should handle mixed success and failure in parallel execution', async () => {
            const requests: ToolExecutionRequest[] = [
                { name: 'success_tool', args: { message: 'test' } },
                { name: 'error_tool', args: { input: 'test' } },
                { name: 'non_existent_tool', args: { any: 'value' } },
            ];

            const results = await toolExecutor.executeTools(requests);

            expect(results).toHaveLength(3);
            expect(results[0].success).toBe(true);
            expect(results[1].success).toBe(false);
            expect(results[1].error).toBe('Simulated tool error');
            expect(results[2].success).toBe(false);
            expect(results[2].error).toContain('not found in registry');
        });

        it('should handle empty requests array', async () => {
            const results = await toolExecutor.executeTools([]);
            expect(results).toHaveLength(0);
        });

        it('should execute tools truly in parallel', async () => {
            const startTime = Date.now();
            const requests: ToolExecutionRequest[] = [
                { name: 'delay_tool', args: { delay: 100 } },
                { name: 'delay_tool', args: { delay: 100 } },
                { name: 'delay_tool', args: { delay: 100 } },
            ];

            const results = await toolExecutor.executeTools(requests);
            const endTime = Date.now();
            const totalTime = endTime - startTime;

            expect(results).toHaveLength(3);
            expect(results.every((r) => r.success)).toBe(true);
            // If truly parallel, should take ~100ms, not ~300ms
            // Adding some tolerance for test environment
            expect(totalTime).toBeLessThan(250);
        });
    });

    describe('Tool Availability', () => {
        it('should return available tools', () => {
            const tools = toolExecutor.getAvailableTools();
            expect(tools).toHaveLength(3);
            expect(tools.map((t) => t.name)).toContain('success_tool');
            expect(tools.map((t) => t.name)).toContain('error_tool');
            expect(tools.map((t) => t.name)).toContain('delay_tool');
        });

        it('should check tool availability', () => {
            expect(toolExecutor.isToolAvailable('success_tool')).toBe(true);
            expect(toolExecutor.isToolAvailable('error_tool')).toBe(true);
            expect(toolExecutor.isToolAvailable('non_existent_tool')).toBe(
                false
            );
        });
    });

    describe('Edge Cases', () => {
        it('should handle tool returning toolError result', async () => {
            // Mock a tool that returns an error result (not throwing)
            const errorResultTool: ITool = {
                name: 'error_result_tool',
                description: 'Returns error result',
                schema: z.object({}),
                getVSCodeTool: () => ({
                    name: 'error_result_tool',
                    description: 'test',
                    inputSchema: {},
                }),
                execute: async (): Promise<ToolResult> =>
                    toolError('Something went wrong'),
            };

            toolRegistry.registerTool(errorResultTool);

            const result = await toolExecutor.executeTool(
                'error_result_tool',
                {}
            );
            expect(result.success).toBe(false);
            expect(result.error).toBe('Something went wrong');
            expect(result.result).toBeUndefined();
        });

        it('should handle tool throwing non-Error objects', async () => {
            const weirdErrorTool: ITool = {
                name: 'weird_error_tool',
                description: 'Throws non-Error',
                schema: z.object({}),
                getVSCodeTool: () => ({
                    name: 'weird_error_tool',
                    description: 'test',
                    inputSchema: {},
                }),
                execute: async (): Promise<ToolResult> => {
                    throw 'string error';
                },
            };

            toolRegistry.registerTool(weirdErrorTool);

            const result = await toolExecutor.executeTool(
                'weird_error_tool',
                {}
            );
            expect(result.success).toBe(false);
            expect(result.error).toBe('string error');
        });
    });

    describe('Rate Limiting', () => {
        it('should allow tool calls under the limit', async () => {
            const limitedExecutor = new ToolExecutor(
                toolRegistry,
                createMockSettings(3),
                createMockExecutionContext()
            );

            const result1 = await limitedExecutor.executeTool('success_tool', {
                message: 'test1',
            });
            const result2 = await limitedExecutor.executeTool('success_tool', {
                message: 'test2',
            });
            const result3 = await limitedExecutor.executeTool('success_tool', {
                message: 'test3',
            });

            expect(result1.success).toBe(true);
            expect(result2.success).toBe(true);
            expect(result3.success).toBe(true);
            expect(limitedExecutor.getToolCallCount()).toBe(3);
        });

        it('should reject tool calls exceeding the limit', async () => {
            const limitedExecutor = new ToolExecutor(
                toolRegistry,
                createMockSettings(3),
                createMockExecutionContext()
            );

            // Make 3 successful calls
            await limitedExecutor.executeTool('success_tool', {
                message: 'test1',
            });
            await limitedExecutor.executeTool('success_tool', {
                message: 'test2',
            });
            await limitedExecutor.executeTool('success_tool', {
                message: 'test3',
            });

            // 4th call should fail due to rate limit
            const result4 = await limitedExecutor.executeTool('success_tool', {
                message: 'test4',
            });

            expect(result4.success).toBe(false);
            expect(result4.error).toContain('Rate limit exceeded');
            expect(result4.error).toContain('4 tool calls made');
            expect(result4.error).toContain('maximum 3');
            expect(limitedExecutor.getToolCallCount()).toBe(4);
        });

        it('should track call count correctly', async () => {
            const limitedExecutor = new ToolExecutor(
                toolRegistry,
                createMockSettings(10),
                createMockExecutionContext()
            );

            await limitedExecutor.executeTool('success_tool', {
                message: 'test1',
            });
            expect(limitedExecutor.getToolCallCount()).toBe(1);

            await limitedExecutor.executeTool('success_tool', {
                message: 'test2',
            });
            expect(limitedExecutor.getToolCallCount()).toBe(2);

            await limitedExecutor.executeTool('error_tool', {
                input: 'will fail',
            });
            expect(limitedExecutor.getToolCallCount()).toBe(3);
        });

        it('should use settings with default limit', async () => {
            const defaultExecutor = new ToolExecutor(
                toolRegistry,
                createMockSettings(ANALYSIS_LIMITS.maxIterations.default),
                createMockExecutionContext()
            );

            expect(defaultExecutor.getToolCallCount()).toBe(0);

            await defaultExecutor.executeTool('success_tool', {
                message: 'test',
            });
            expect(defaultExecutor.getToolCallCount()).toBe(1);
        });
    });

    describe('Disposal', () => {
        it('should dispose without errors', () => {
            expect(() => toolExecutor.dispose()).not.toThrow();
        });
    });

    describe('Schema Validation', () => {
        it('should reject arguments that fail Zod schema validation', async () => {
            // success_tool requires { message: string }
            const result = await toolExecutor.executeTool('success_tool', {
                wrong_field: 123, // Missing 'message', has wrong field
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain('Invalid arguments');
            expect(result.error).toContain('message'); // Should mention the missing field
        });

        it('should reject arguments with wrong types', async () => {
            const result = await toolExecutor.executeTool('success_tool', {
                message: 123, // Should be string, not number
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain('Invalid arguments');
        });

        it('should accept valid arguments after schema validation', async () => {
            const result = await toolExecutor.executeTool('success_tool', {
                message: 'valid string',
            });

            expect(result.success).toBe(true);
            expect(result.result).toBe('Success: valid string');
        });

        it('should handle empty object when required fields are missing', async () => {
            const result = await toolExecutor.executeTool('success_tool', {});

            expect(result.success).toBe(false);
            expect(result.error).toContain('Invalid arguments');
            expect(result.error).toContain('message');
        });
    });

    describe('Response Size Validation', () => {
        it('should reject tool response exceeding MAX_TOOL_RESPONSE_CHARS', async () => {
            const oversizedTool: ITool = {
                name: 'oversized_tool',
                description: 'Returns oversized response',
                schema: z.object({}),
                getVSCodeTool: () => ({
                    name: 'oversized_tool',
                    description: 'test',
                    inputSchema: {},
                }),
                execute: async (): Promise<ToolResult> =>
                    toolSuccess(
                        'x'.repeat(TokenConstants.MAX_TOOL_RESPONSE_CHARS + 1)
                    ),
            };

            toolRegistry.registerTool(oversizedTool);
            const result = await toolExecutor.executeTool('oversized_tool', {});

            expect(result.success).toBe(false);
            expect(result.error).toContain('Response too large');
            expect(result.error).toContain('maximum allowed: 20000');
        });

        it('should allow tool response at exactly MAX_TOOL_RESPONSE_CHARS', async () => {
            const maxSizeTool: ITool = {
                name: 'maxsize_tool',
                description: 'Returns max-sized response',
                schema: z.object({}),
                getVSCodeTool: () => ({
                    name: 'maxsize_tool',
                    description: 'test',
                    inputSchema: {},
                }),
                execute: async (): Promise<ToolResult> =>
                    toolSuccess(
                        'x'.repeat(TokenConstants.MAX_TOOL_RESPONSE_CHARS)
                    ),
            };

            toolRegistry.registerTool(maxSizeTool);
            const result = await toolExecutor.executeTool('maxsize_tool', {});

            expect(result.success).toBe(true);
            expect(result.result).toHaveLength(
                TokenConstants.MAX_TOOL_RESPONSE_CHARS
            );
        });

        it('should skip size validation for failed tool results', async () => {
            // toolError() returns don't have data, so size check is skipped
            const failingTool: ITool = {
                name: 'failing_tool',
                description: 'Returns error',
                schema: z.object({}),
                getVSCodeTool: () => ({
                    name: 'failing_tool',
                    description: 'test',
                    inputSchema: {},
                }),
                execute: async (): Promise<ToolResult> =>
                    toolError('Some error message'),
            };

            toolRegistry.registerTool(failingTool);
            const result = await toolExecutor.executeTool('failing_tool', {});

            expect(result.success).toBe(false);
            expect(result.error).toBe('Some error message');
            // Should not contain size-related error
            expect(result.error).not.toContain('Response too large');
        });

        it('should allow normal-sized tool responses', async () => {
            // Create a tool that returns a normal-sized response
            const normalTool: ITool = {
                name: 'normal_tool',
                description: 'Returns normal response',
                schema: z.object({}),
                getVSCodeTool: () => ({
                    name: 'normal_tool',
                    description: 'test',
                    inputSchema: {},
                }),
                execute: async (): Promise<ToolResult> =>
                    toolSuccess('Normal sized response content'),
            };

            toolRegistry.registerTool(normalTool);
            const result = await toolExecutor.executeTool('normal_tool', {});

            expect(result.success).toBe(true);
            expect(result.result).toBe('Normal sized response content');
        });
    });

    describe('ExecutionContext Propagation', () => {
        it('should pass ExecutionContext to tool execute method', async () => {
            let capturedContext: unknown = null;

            const contextCaptureTool: ITool = {
                name: 'context_capture_tool',
                description: 'Captures ExecutionContext for testing',
                schema: z.object({}),
                getVSCodeTool: () => ({
                    name: 'context_capture_tool',
                    description: 'test',
                    inputSchema: {},
                }),
                execute: async (_args, context): Promise<ToolResult> => {
                    capturedContext = context;
                    return toolSuccess('captured');
                },
            };

            toolRegistry.registerTool(contextCaptureTool);

            const mockExecutionContext = createMockExecutionContext({
                planManager: { someProp: 'testPlan' } as any,
                subagentSessionManager: { someProp: 'testSession' } as any,
                subagentExecutor: { someProp: 'testExecutor' } as any,
            });

            const toolExecutorWithContext = new ToolExecutor(
                toolRegistry,
                mockSettings,
                mockExecutionContext
            );

            await toolExecutorWithContext.executeTool(
                'context_capture_tool',
                {}
            );

            expect(capturedContext).toBe(mockExecutionContext);
        });

        it('should pass context with non-cancelled token by default', async () => {
            let capturedContext: unknown = 'not-called';

            const contextCaptureTool: ITool = {
                name: 'context_check_tool',
                description: 'Checks context is passed',
                schema: z.object({}),
                getVSCodeTool: () => ({
                    name: 'context_check_tool',
                    description: 'test',
                    inputSchema: {},
                }),
                execute: async (_args, context): Promise<ToolResult> => {
                    capturedContext = context;
                    return toolSuccess('captured');
                },
            };

            toolRegistry.registerTool(contextCaptureTool);

            const toolExecutorWithContext = new ToolExecutor(
                toolRegistry,
                mockSettings,
                createMockExecutionContext()
            );

            await toolExecutorWithContext.executeTool('context_check_tool', {});

            // Context should always be defined and have a cancellation token
            expect(capturedContext).toBeDefined();
            expect(
                (capturedContext as any).cancellationToken
                    .isCancellationRequested
            ).toBe(false);
        });

        it('should throw CancellationError when token is cancelled before execution', async () => {
            const slowTool: ITool = {
                name: 'slow_tool',
                description: 'A slow tool',
                schema: z.object({}),
                getVSCodeTool: () => ({
                    name: 'slow_tool',
                    description: 'test',
                    inputSchema: {},
                }),
                execute: async (): Promise<ToolResult> => {
                    // This should never be called
                    return toolSuccess('should not reach');
                },
            };

            toolRegistry.registerTool(slowTool);

            const mockCancelledContext = {
                cancellationToken: {
                    isCancellationRequested: true,
                    onCancellationRequested: () => ({ dispose: () => {} }),
                },
            };

            const toolExecutorWithCancelledToken = new ToolExecutor(
                toolRegistry,
                mockSettings,
                mockCancelledContext as any
            );

            await expect(
                toolExecutorWithCancelledToken.executeTool('slow_tool', {})
            ).rejects.toThrow();
        });

        it('should rethrow CancellationError when tool throws it during execution', async () => {
            const cancellingTool: ITool = {
                name: 'cancelling_tool',
                description: 'A tool that throws CancellationError',
                schema: z.object({}),
                getVSCodeTool: () => ({
                    name: 'cancelling_tool',
                    description: 'test',
                    inputSchema: {},
                }),
                execute: async (): Promise<ToolResult> => {
                    throw new vscode.CancellationError();
                },
            };

            toolRegistry.registerTool(cancellingTool);

            await expect(
                toolExecutor.executeTool('cancelling_tool', {})
            ).rejects.toThrow(vscode.CancellationError);
        });

        it('should convert TimeoutError to structured error result', async () => {
            const timeoutTool: ITool = {
                name: 'timeout_tool',
                description: 'A tool that times out',
                schema: z.object({}),
                getVSCodeTool: () => ({
                    name: 'timeout_tool',
                    description: 'test',
                    inputSchema: {},
                }),
                execute: async (): Promise<ToolResult> => {
                    throw TimeoutError.create('test operation', 5000);
                },
            };

            toolRegistry.registerTool(timeoutTool);

            const result = await toolExecutor.executeTool('timeout_tool', {});

            expect(result.success).toBe(false);
            expect(result.error).toContain('timed out');
            expect(result.error).toContain('more specific query');
        });
    });

    describe('Cancellation Precedence', () => {
        it('should throw CancellationError even when rate limit is exceeded', async () => {
            // Create an executor with a low limit and a pre-cancelled token
            const mockCancelledContext = {
                cancellationToken: {
                    isCancellationRequested: true,
                    onCancellationRequested: () => ({ dispose: () => {} }),
                },
            };

            const limitedExecutor = new ToolExecutor(
                toolRegistry,
                createMockSettings(1), // Very low limit
                mockCancelledContext as any
            );

            // Make calls that would exceed the rate limit
            // First call should throw CancellationError, NOT increment count and return rate-limit error
            await expect(
                limitedExecutor.executeTool('success_tool', {
                    message: 'test1',
                })
            ).rejects.toThrow(vscode.CancellationError);

            // Call count should NOT have been incremented (cancellation checked before count)
            expect(limitedExecutor.getToolCallCount()).toBe(0);
        });

        it('should prioritize cancellation over rate limit when both would apply', async () => {
            // Create an executor with limit already exceeded AND cancelled token
            const mockCancelledContext = {
                cancellationToken: {
                    isCancellationRequested: true,
                    onCancellationRequested: () => ({ dispose: () => {} }),
                },
            };

            const limitedExecutor = new ToolExecutor(
                toolRegistry,
                createMockSettings(0), // Zero limit - any call would hit rate limit
                mockCancelledContext as any
            );

            // This would hit rate limit immediately if cancellation wasn't checked first
            // But cancellation should take precedence and throw CancellationError
            await expect(
                limitedExecutor.executeTool('success_tool', { message: 'test' })
            ).rejects.toThrow(vscode.CancellationError);
        });
    });
});
