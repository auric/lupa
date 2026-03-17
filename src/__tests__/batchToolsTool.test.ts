import { describe, it, expect, beforeEach } from 'vitest';
import * as z from 'zod';
import { BatchToolsTool } from '../tools/batchToolsTool';
import { ToolExecutor } from '../models/toolExecutor';
import { ToolRegistry } from '../models/toolRegistry';
import { ITool } from '../tools/ITool';
import { ToolResult, toolSuccess, toolError } from '../types/toolResultTypes';
import { TokenConstants } from '../models/tokenConstants';
import { createMockExecutionContext } from './testUtils/mockFactories';
import type { ExecutionContext } from '../types/executionContext';

// Mock tools for testing
class MockReadFileTool implements ITool {
    name = 'read_file';
    description = 'Reads a file';
    schema = z.object({ file_path: z.string() });

    getVSCodeTool() {
        return {
            name: this.name,
            description: this.description,
            inputSchema: z.toJSONSchema(this.schema),
        };
    }

    async execute(args: any, _context: ExecutionContext): Promise<ToolResult> {
        return toolSuccess(`Contents of ${args.file_path}`);
    }
}

class MockSearchTool implements ITool {
    name = 'search_for_pattern';
    description = 'Searches for a pattern';
    schema = z.object({ pattern: z.string() });

    getVSCodeTool() {
        return {
            name: this.name,
            description: this.description,
            inputSchema: z.toJSONSchema(this.schema),
        };
    }

    async execute(args: any, _context: ExecutionContext): Promise<ToolResult> {
        return toolSuccess(`Found matches for: ${args.pattern}`);
    }
}

class MockFailingTool implements ITool {
    name = 'failing_tool';
    description = 'A tool that fails';
    schema = z.object({ input: z.string() });

    getVSCodeTool() {
        return {
            name: this.name,
            description: this.description,
            inputSchema: z.toJSONSchema(this.schema),
        };
    }

    async execute(_args: any, _context: ExecutionContext): Promise<ToolResult> {
        return toolError('Simulated failure');
    }
}

class MockLargeOutputTool implements ITool {
    name = 'large_output_tool';
    description = 'Returns a large output';
    schema = z.object({ size: z.number() });

    getVSCodeTool() {
        return {
            name: this.name,
            description: this.description,
            inputSchema: z.toJSONSchema(this.schema),
        };
    }

    async execute(args: any, _context: ExecutionContext): Promise<ToolResult> {
        return toolSuccess('X'.repeat(args.size));
    }
}

describe('BatchToolsTool', () => {
    let batchTool: BatchToolsTool;
    let toolRegistry: ToolRegistry;
    let toolExecutor: ToolExecutor;
    let context: ExecutionContext;

    beforeEach(() => {
        batchTool = new BatchToolsTool();
        toolRegistry = new ToolRegistry();
        toolRegistry.registerTool(new MockReadFileTool());
        toolRegistry.registerTool(new MockSearchTool());
        toolRegistry.registerTool(new MockFailingTool());
        toolRegistry.registerTool(new MockLargeOutputTool());
        toolRegistry.registerTool(batchTool);

        context = createMockExecutionContext();
        toolExecutor = new ToolExecutor(toolRegistry, context);
        context.toolExecutor = toolExecutor;
    });

    describe('metadata', () => {
        it('should have correct name', () => {
            expect(batchTool.name).toBe('batch_tools');
        });

        it('should have a description', () => {
            expect(batchTool.description).toBeTruthy();
            expect(batchTool.description).toContain('parallel');
        });

        it('should generate valid VS Code tool', () => {
            const vsTool = batchTool.getVSCodeTool();
            expect(vsTool.name).toBe('batch_tools');
            expect(vsTool.inputSchema).toBeDefined();
        });
    });

    describe('schema validation', () => {
        it('should accept valid calls array', () => {
            const result = batchTool.schema.safeParse({
                calls: [
                    { tool: 'read_file', args: { file_path: 'a.ts' } },
                    { tool: 'search_for_pattern', args: { pattern: 'foo' } },
                ],
            });
            expect(result.success).toBe(true);
        });

        it('should reject empty calls array', () => {
            const result = batchTool.schema.safeParse({ calls: [] });
            expect(result.success).toBe(false);
        });

        it('should reject single call (min 2)', () => {
            const result = batchTool.schema.safeParse({
                calls: [{ tool: 'read_file', args: { file_path: 'a.ts' } }],
            });
            expect(result.success).toBe(false);
        });

        it('should reject missing tool name', () => {
            const result = batchTool.schema.safeParse({
                calls: [
                    { args: { file_path: 'a.ts' } },
                    { tool: 'search_for_pattern', args: { pattern: 'foo' } },
                ],
            });
            expect(result.success).toBe(false);
        });
    });

    describe('normalizeArgs', () => {
        it('should pass through valid args unchanged', () => {
            const args = {
                calls: [
                    { tool: 'read_file', args: { file_path: 'a.ts' } },
                    { tool: 'search_for_pattern', args: { pattern: 'foo' } },
                ],
            };
            expect(batchTool.normalizeArgs(args)).toEqual(args);
        });

        it('should handle "tools" alias for "calls"', () => {
            const args = {
                tools: [
                    { tool: 'read_file', args: { file_path: 'a.ts' } },
                    { tool: 'search_for_pattern', args: { pattern: 'foo' } },
                ],
            };
            const normalized = batchTool.normalizeArgs(args);
            expect(normalized.calls).toEqual(args.tools);
        });

        it('should parse JSON string calls', () => {
            const calls = [
                { tool: 'read_file', args: { file_path: 'a.ts' } },
                { tool: 'search_for_pattern', args: { pattern: 'foo' } },
            ];
            const args = { calls: JSON.stringify(calls) };
            const normalized = batchTool.normalizeArgs(args);
            expect(normalized.calls).toEqual(calls);
        });

        it('should wrap single call object in array', () => {
            const args = {
                calls: { tool: 'read_file', args: { file_path: 'a.ts' } },
            };
            const normalized = batchTool.normalizeArgs(args);
            expect(normalized.calls).toEqual([
                { tool: 'read_file', args: { file_path: 'a.ts' } },
            ]);
        });

        it('should filter null items from array', () => {
            const args = {
                calls: [
                    { tool: 'read_file', args: { file_path: 'a.ts' } },
                    null,
                    { tool: 'search_for_pattern', args: { pattern: 'foo' } },
                ],
            };
            const normalized = batchTool.normalizeArgs(args);
            expect(normalized.calls).toHaveLength(2);
        });

        it('should parse JSON string args in individual calls', () => {
            const args = {
                calls: [
                    {
                        tool: 'read_file',
                        args: JSON.stringify({ file_path: 'a.ts' }),
                    },
                    { tool: 'search_for_pattern', args: { pattern: 'foo' } },
                ],
            };
            const normalized = batchTool.normalizeArgs(args);
            expect((normalized.calls as any[])[0].args).toEqual({
                file_path: 'a.ts',
            });
        });

        it('should handle invalid JSON string gracefully', () => {
            const args = { calls: 'not-valid-json' };
            const normalized = batchTool.normalizeArgs(args);
            // Should leave as-is for Zod to reject
            expect(normalized.calls).toBe('not-valid-json');
        });

        it('should strip "functions." prefix from tool names', () => {
            const args = {
                calls: [
                    {
                        tool: 'functions.read_file',
                        args: { file_path: 'a.ts' },
                    },
                    {
                        tool: 'functions.search_for_pattern',
                        args: { pattern: 'foo' },
                    },
                ],
            };
            const normalized = batchTool.normalizeArgs(args);
            const calls = normalized.calls as any[];
            expect(calls[0].tool).toBe('read_file');
            expect(calls[1].tool).toBe('search_for_pattern');
        });

        it('should accept "parameters" as alias for "args"', () => {
            const args = {
                calls: [
                    { tool: 'read_file', parameters: { file_path: 'a.ts' } },
                    {
                        tool: 'search_for_pattern',
                        parameters: { pattern: 'foo' },
                    },
                ],
            };
            const normalized = batchTool.normalizeArgs(args);
            const calls = normalized.calls as any[];
            expect(calls[0].args).toEqual({ file_path: 'a.ts' });
            expect(calls[1].args).toEqual({ pattern: 'foo' });
            expect(calls[0].parameters).toBeUndefined();
        });

        it('should accept "arguments" as alias for "args"', () => {
            const args = {
                calls: [
                    { tool: 'read_file', arguments: { file_path: 'a.ts' } },
                    { tool: 'search_for_pattern', args: { pattern: 'foo' } },
                ],
            };
            const normalized = batchTool.normalizeArgs(args);
            const calls = normalized.calls as any[];
            expect(calls[0].args).toEqual({ file_path: 'a.ts' });
            expect(calls[0].arguments).toBeUndefined();
        });

        it('should default missing args to empty object', () => {
            const args = {
                calls: [
                    { tool: 'read_file' },
                    { tool: 'search_for_pattern', args: { pattern: 'foo' } },
                ],
            };
            const normalized = batchTool.normalizeArgs(args);
            const calls = normalized.calls as any[];
            expect(calls[0].args).toEqual({});
        });

        it('should handle combined quirks: functions. prefix + parameters alias', () => {
            const args = {
                calls: [
                    {
                        tool: 'functions.read_file',
                        parameters: { file_path: 'a.ts' },
                    },
                    {
                        tool: 'functions.search_for_pattern',
                        parameters: { pattern: 'foo' },
                    },
                ],
            };
            const normalized = batchTool.normalizeArgs(args);
            const calls = normalized.calls as any[];
            expect(calls[0].tool).toBe('read_file');
            expect(calls[0].args).toEqual({ file_path: 'a.ts' });
            expect(calls[1].tool).toBe('search_for_pattern');
            expect(calls[1].args).toEqual({ pattern: 'foo' });
        });
    });

    describe('execute', () => {
        it('should execute multiple tools in parallel', async () => {
            const result = await batchTool.execute(
                {
                    calls: [
                        { tool: 'read_file', args: { file_path: 'a.ts' } },
                        {
                            tool: 'search_for_pattern',
                            args: { pattern: 'foo' },
                        },
                    ],
                },
                context
            );

            expect(result.success).toBe(true);
            expect(result.data).toContain('2/2 succeeded');
            expect(result.data).toContain('Contents of a.ts');
            expect(result.data).toContain('Found matches for: foo');
        });

        it('should handle mixed success and failure', async () => {
            const result = await batchTool.execute(
                {
                    calls: [
                        { tool: 'read_file', args: { file_path: 'a.ts' } },
                        { tool: 'failing_tool', args: { input: 'test' } },
                    ],
                },
                context
            );

            expect(result.success).toBe(true);
            expect(result.data).toContain('1/2 succeeded');
            expect(result.data).toContain('Contents of a.ts');
            expect(result.data).toContain('Simulated failure');
        });

        it('should reject batch_tools self-call', async () => {
            const result = await batchTool.execute(
                {
                    calls: [
                        { tool: 'batch_tools', args: { calls: [] } },
                        { tool: 'read_file', args: { file_path: 'a.ts' } },
                    ],
                },
                context
            );

            expect(result.success).toBe(false);
            expect(result.error).toContain('batch_tools');
        });

        it('should return error when toolExecutor is missing', async () => {
            const contextWithoutExecutor = createMockExecutionContext();
            // Don't set toolExecutor

            const result = await batchTool.execute(
                {
                    calls: [
                        { tool: 'read_file', args: { file_path: 'a.ts' } },
                        {
                            tool: 'search_for_pattern',
                            args: { pattern: 'foo' },
                        },
                    ],
                },
                contextWithoutExecutor
            );

            expect(result.success).toBe(false);
            expect(result.error).toContain('toolExecutor');
        });

        it('should handle unknown tool gracefully', async () => {
            const result = await batchTool.execute(
                {
                    calls: [
                        {
                            tool: 'nonexistent_tool',
                            args: { foo: 'bar' },
                        },
                        { tool: 'read_file', args: { file_path: 'a.ts' } },
                    ],
                },
                context
            );

            expect(result.success).toBe(true);
            // One succeeds, one fails (unknown tool)
            expect(result.data).toContain('1/2 succeeded');
        });

        it('should handle schema validation failure in inner tool', async () => {
            const result = await batchTool.execute(
                {
                    calls: [
                        {
                            tool: 'read_file',
                            args: { wrong_arg: 'oops' },
                        },
                        {
                            tool: 'search_for_pattern',
                            args: { pattern: 'foo' },
                        },
                    ],
                },
                context
            );

            expect(result.success).toBe(true);
            // search succeeds, read_file fails validation
            expect(result.data).toContain('1/2 succeeded');
            expect(result.data).toContain('search_for_pattern');
        });

        it('should preserve result order matching input order', async () => {
            const result = await batchTool.execute(
                {
                    calls: [
                        {
                            tool: 'search_for_pattern',
                            args: { pattern: 'first' },
                        },
                        { tool: 'read_file', args: { file_path: 'second.ts' } },
                    ],
                },
                context
            );

            expect(result.success).toBe(true);
            const data = result.data!;
            const firstIdx = data.indexOf('search_for_pattern');
            const secondIdx = data.indexOf('read_file');
            expect(firstIdx).toBeLessThan(secondIdx);
        });

        it('should count inner calls toward rate limit', async () => {
            // Create executor with very low rate limit
            const limitedContext = createMockExecutionContext();
            const limitedExecutor = new ToolExecutor(
                toolRegistry,
                limitedContext,
                3 // Only 3 tool calls allowed (batch_tools itself + 2 inner)
            );
            limitedContext.toolExecutor = limitedExecutor;

            // This will use 1 call for batch_tools via the executor,
            // then 2 more for the inner calls
            const result = await limitedExecutor.executeTool('batch_tools', {
                calls: [
                    { tool: 'read_file', args: { file_path: 'a.ts' } },
                    { tool: 'search_for_pattern', args: { pattern: 'foo' } },
                ],
            });

            // Should succeed - 3 calls total (batch_tools + 2 inner) = at limit
            expect(result.success).toBe(true);
        });

        it('should truncate individual results when combined output would exceed max chars', async () => {
            // Each tool returns 40K chars; 2 calls = 80K which exceeds 60K limit
            const result = await batchTool.execute(
                {
                    calls: [
                        { tool: 'large_output_tool', args: { size: 40_000 } },
                        { tool: 'large_output_tool', args: { size: 40_000 } },
                    ],
                },
                context
            );

            expect(result.success).toBe(true);
            const data = result.data!;

            // The combined output must fit within MAX_TOOL_RESPONSE_CHARS
            expect(data.length).toBeLessThanOrEqual(
                TokenConstants.MAX_TOOL_RESPONSE_CHARS
            );

            // At least one result should have been truncated
            expect(data).toContain('(truncated from');
        });
    });
});
