import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { ToolExecutor, ToolExecutionRequest } from '../models/toolExecutor';
import { ToolRegistry } from '../models/toolRegistry';
import { ITool } from '../tools/ITool';
import { WorkspaceSettingsService } from '../services/workspaceSettingsService';
import { ANALYSIS_LIMITS } from '../models/workspaceSettingsSchema';
import { ToolResult, toolSuccess, toolError } from '../types/toolResultTypes';

/**
 * Create a mock WorkspaceSettingsService for testing with a specific max tool calls limit
 */
function createMockSettings(maxToolCalls: number): WorkspaceSettingsService {
  return {
    getMaxToolCalls: () => maxToolCalls,
    getMaxIterations: () => ANALYSIS_LIMITS.maxIterations.default,
    getRequestTimeoutSeconds: () => ANALYSIS_LIMITS.requestTimeoutSeconds.default
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
      inputSchema: z.toJSONSchema(this.schema)
    };
  }

  async execute(args: any): Promise<ToolResult<string>> {
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
      inputSchema: z.toJSONSchema(this.schema)
    };
  }

  async execute(args: any): Promise<ToolResult<string>> {
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
      inputSchema: z.toJSONSchema(this.schema)
    };
  }

  async execute(args: any): Promise<ToolResult<string>> {
    await new Promise(resolve => setTimeout(resolve, args.delay));
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
    mockSettings = createMockSettings(ANALYSIS_LIMITS.maxToolCalls.default);
    toolExecutor = new ToolExecutor(toolRegistry, mockSettings);
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
      const result = await toolExecutor.executeTool('success_tool', { message: 'test' });

      expect(result.success).toBe(true);
      expect(result.name).toBe('success_tool');
      expect(result.result).toBe('Success: test');
      expect(result.error).toBeUndefined();
    });

    it('should handle tool not found', async () => {
      const result = await toolExecutor.executeTool('non_existent_tool', { input: 'test' });

      expect(result.success).toBe(false);
      expect(result.name).toBe('non_existent_tool');
      expect(result.error).toBe("Tool 'non_existent_tool' not found in registry");
      expect(result.result).toBeUndefined();
    });

    it('should handle tool execution errors', async () => {
      const result = await toolExecutor.executeTool('error_tool', { input: 'test' });

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
        { name: 'success_tool', args: { message: 'second' } }
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
        { name: 'non_existent_tool', args: { any: 'value' } }
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
        { name: 'delay_tool', args: { delay: 100 } }
      ];

      const results = await toolExecutor.executeTools(requests);
      const endTime = Date.now();
      const totalTime = endTime - startTime;

      expect(results).toHaveLength(3);
      expect(results.every(r => r.success)).toBe(true);
      // If truly parallel, should take ~100ms, not ~300ms
      // Adding some tolerance for test environment
      expect(totalTime).toBeLessThan(250);
    });
  });

  describe('Sequential Tool Execution', () => {
    it('should execute tools sequentially', async () => {
      const requests: ToolExecutionRequest[] = [
        { name: 'success_tool', args: { message: 'first' } },
        { name: 'success_tool', args: { message: 'second' } }
      ];

      const results = await toolExecutor.executeToolsSequentially(requests);

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[0].result).toBe('Success: first');
      expect(results[1].success).toBe(true);
      expect(results[1].result).toBe('Success: second');
    });

    it('should continue execution even when one tool fails', async () => {
      const requests: ToolExecutionRequest[] = [
        { name: 'success_tool', args: { message: 'test' } },
        { name: 'error_tool', args: { input: 'test' } },
        { name: 'success_tool', args: { message: 'after_error' } }
      ];

      const results = await toolExecutor.executeToolsSequentially(requests);

      expect(results).toHaveLength(3);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(false);
      expect(results[2].success).toBe(true);
      expect(results[2].result).toBe('Success: after_error');
    });

    it('should execute tools truly sequentially', async () => {
      const startTime = Date.now();
      const requests: ToolExecutionRequest[] = [
        { name: 'delay_tool', args: { delay: 50 } },
        { name: 'delay_tool', args: { delay: 50 } },
        { name: 'delay_tool', args: { delay: 50 } }
      ];

      const results = await toolExecutor.executeToolsSequentially(requests);
      const endTime = Date.now();
      const totalTime = endTime - startTime;

      expect(results).toHaveLength(3);
      expect(results.every(r => r.success)).toBe(true);
      // If truly sequential, should take ~150ms
      expect(totalTime).toBeGreaterThan(120);
    });
  });

  describe('Tool Availability', () => {
    it('should return available tools', () => {
      const tools = toolExecutor.getAvailableTools();
      expect(tools).toHaveLength(3);
      expect(tools.map(t => t.name)).toContain('success_tool');
      expect(tools.map(t => t.name)).toContain('error_tool');
      expect(tools.map(t => t.name)).toContain('delay_tool');
    });

    it('should check tool availability', () => {
      expect(toolExecutor.isToolAvailable('success_tool')).toBe(true);
      expect(toolExecutor.isToolAvailable('error_tool')).toBe(true);
      expect(toolExecutor.isToolAvailable('non_existent_tool')).toBe(false);
    });
  });

  describe('Edge Cases', () => {
    it('should handle tool returning toolError result', async () => {
      // Mock a tool that returns an error result (not throwing)
      const errorResultTool: ITool = {
        name: 'error_result_tool',
        description: 'Returns error result',
        schema: z.object({}),
        getVSCodeTool: () => ({ name: 'error_result_tool', description: 'test', inputSchema: {} }),
        execute: async (): Promise<ToolResult<string>> => toolError('Something went wrong')
      };

      toolRegistry.registerTool(errorResultTool);

      const result = await toolExecutor.executeTool('error_result_tool', {});
      expect(result.success).toBe(false);
      expect(result.error).toBe('Something went wrong');
      expect(result.result).toBeUndefined();
    });

    it('should handle tool throwing non-Error objects', async () => {
      const weirdErrorTool: ITool = {
        name: 'weird_error_tool',
        description: 'Throws non-Error',
        schema: z.object({}),
        getVSCodeTool: () => ({ name: 'weird_error_tool', description: 'test', inputSchema: {} }),
        execute: async (): Promise<ToolResult<string>> => { throw 'string error'; }
      };

      toolRegistry.registerTool(weirdErrorTool);

      const result = await toolExecutor.executeTool('weird_error_tool', {});
      expect(result.success).toBe(false);
      expect(result.error).toBe('string error');
    });
  });

  describe('Rate Limiting', () => {
    it('should allow tool calls under the limit', async () => {
      const limitedExecutor = new ToolExecutor(toolRegistry, createMockSettings(3));

      const result1 = await limitedExecutor.executeTool('success_tool', { message: 'test1' });
      const result2 = await limitedExecutor.executeTool('success_tool', { message: 'test2' });
      const result3 = await limitedExecutor.executeTool('success_tool', { message: 'test3' });

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      expect(result3.success).toBe(true);
      expect(limitedExecutor.getToolCallCount()).toBe(3);
    });

    it('should reject tool calls exceeding the limit', async () => {
      const limitedExecutor = new ToolExecutor(toolRegistry, createMockSettings(3));

      // Make 3 successful calls
      await limitedExecutor.executeTool('success_tool', { message: 'test1' });
      await limitedExecutor.executeTool('success_tool', { message: 'test2' });
      await limitedExecutor.executeTool('success_tool', { message: 'test3' });

      // 4th call should fail due to rate limit
      const result4 = await limitedExecutor.executeTool('success_tool', { message: 'test4' });

      expect(result4.success).toBe(false);
      expect(result4.error).toContain('Rate limit exceeded');
      expect(result4.error).toContain('4 tool calls made');
      expect(result4.error).toContain('maximum 3');
      expect(limitedExecutor.getToolCallCount()).toBe(4);
    });

    it('should track call count correctly', async () => {
      const limitedExecutor = new ToolExecutor(toolRegistry, createMockSettings(10));

      await limitedExecutor.executeTool('success_tool', { message: 'test1' });
      expect(limitedExecutor.getToolCallCount()).toBe(1);

      await limitedExecutor.executeTool('success_tool', { message: 'test2' });
      expect(limitedExecutor.getToolCallCount()).toBe(2);

      await limitedExecutor.executeTool('error_tool', { input: 'will fail' });
      expect(limitedExecutor.getToolCallCount()).toBe(3);
    });

    it('should use settings with default limit', async () => {
      const defaultExecutor = new ToolExecutor(
        toolRegistry,
        createMockSettings(ANALYSIS_LIMITS.maxToolCalls.default)
      );

      expect(defaultExecutor.getToolCallCount()).toBe(0);

      await defaultExecutor.executeTool('success_tool', { message: 'test' });
      expect(defaultExecutor.getToolCallCount()).toBe(1);
    });
  });

  describe('Disposal', () => {
    it('should dispose without errors', () => {
      expect(() => toolExecutor.dispose()).not.toThrow();
    });
  });
});