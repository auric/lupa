import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolExecutor, ToolExecutionRequest } from '../models/toolExecutor';
import { ToolRegistry } from '../models/toolRegistry';
import { ITool } from '../tools/ITool';
import { z } from 'zod';

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

  async execute(args: any) {
    return `Success: ${args.message}`;
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

  async execute(args: any) {
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

  async execute(args: any) {
    await new Promise(resolve => setTimeout(resolve, args.delay));
    return `Delayed by ${args.delay}ms`;
  }
}

describe('ToolExecutor', () => {
  let toolExecutor: ToolExecutor;
  let toolRegistry: ToolRegistry;
  let successTool: MockSuccessTool;
  let errorTool: MockErrorTool;
  let delayTool: MockDelayTool;

  beforeEach(() => {
    toolRegistry = new ToolRegistry();
    toolExecutor = new ToolExecutor(toolRegistry);
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
    it('should handle tool returning null/undefined', async () => {
      // Mock a tool that returns undefined
      const nullTool: ITool = {
        name: 'null_tool',
        description: 'Returns null',
        schema: z.object({}),
        getVSCodeTool: () => ({ name: 'null_tool', description: 'test', inputSchema: {} }),
        execute: async () => undefined
      };

      toolRegistry.registerTool(nullTool);

      const result = await toolExecutor.executeTool('null_tool', {});
      expect(result.success).toBe(true);
      expect(result.result).toBeUndefined();
    });

    it('should handle tool throwing non-Error objects', async () => {
      const weirdErrorTool: ITool = {
        name: 'weird_error_tool',
        description: 'Throws non-Error',
        schema: z.object({}),
        getVSCodeTool: () => ({ name: 'weird_error_tool', description: 'test', inputSchema: {} }),
        execute: async () => { throw 'string error'; }
      };

      toolRegistry.registerTool(weirdErrorTool);

      const result = await toolExecutor.executeTool('weird_error_tool', {});
      expect(result.success).toBe(false);
      expect(result.error).toBe('string error');
    });
  });

  describe('Disposal', () => {
    it('should dispose without errors', () => {
      expect(() => toolExecutor.dispose()).not.toThrow();
    });
  });
});