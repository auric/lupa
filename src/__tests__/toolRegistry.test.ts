import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolRegistry } from '../models/toolRegistry';
import { ITool } from '../tools/ITool';
import * as z from 'zod';

// Mock tool for testing
class MockTool implements ITool {
  name = 'mock_tool';
  description = 'A mock tool for testing';
  schema = z.object({ input: z.string() });

  getVSCodeTool() {
    return {
      name: this.name,
      description: this.description,
      inputSchema: z.toJSONSchema(this.schema)
    };
  }

  async execute(args: any) {
    return `Executed with: ${args.input}`;
  }
}

class AnotherMockTool implements ITool {
  name = 'another_tool';
  description = 'Another mock tool';
  schema = z.object({ value: z.number() });

  getVSCodeTool() {
    return {
      name: this.name,
      description: this.description,
      inputSchema: z.toJSONSchema(this.schema)
    };
  }

  async execute(args: any) {
    return args.value * 2;
  }
}

describe('ToolRegistry', () => {
  let toolRegistry: ToolRegistry;
  let mockTool: MockTool;
  let anotherMockTool: AnotherMockTool;

  beforeEach(() => {
    toolRegistry = new ToolRegistry();
    mockTool = new MockTool();
    anotherMockTool = new AnotherMockTool();
  });

  describe('Tool Registration', () => {
    it('should register a tool successfully', () => {
      toolRegistry.registerTool(mockTool);

      expect(toolRegistry.hasTool('mock_tool')).toBe(true);
      expect(toolRegistry.getTool('mock_tool')).toBe(mockTool);
    });

    it('should throw error when registering duplicate tool names', () => {
      toolRegistry.registerTool(mockTool);

      expect(() => toolRegistry.registerTool(mockTool)).toThrow(
        'Tool with name "mock_tool" is already registered'
      );
    });

    it('should register multiple different tools', () => {
      toolRegistry.registerTool(mockTool);
      toolRegistry.registerTool(anotherMockTool);

      expect(toolRegistry.hasTool('mock_tool')).toBe(true);
      expect(toolRegistry.hasTool('another_tool')).toBe(true);
      expect(toolRegistry.getToolNames()).toHaveLength(2);
    });
  });

  describe('Tool Retrieval', () => {
    beforeEach(() => {
      toolRegistry.registerTool(mockTool);
      toolRegistry.registerTool(anotherMockTool);
    });

    it('should retrieve registered tool by name', () => {
      const tool = toolRegistry.getTool('mock_tool');
      expect(tool).toBe(mockTool);
    });

    it('should return undefined for non-existent tool', () => {
      const tool = toolRegistry.getTool('non_existent');
      expect(tool).toBeUndefined();
    });

    it('should return all tool names', () => {
      const names = toolRegistry.getToolNames();
      expect(names).toHaveLength(2);
      expect(names).toContain('mock_tool');
      expect(names).toContain('another_tool');
    });

    it('should return all tools', () => {
      const tools = toolRegistry.getAllTools();
      expect(tools).toHaveLength(2);
      expect(tools).toContain(mockTool);
      expect(tools).toContain(anotherMockTool);
    });

    it('should check if tool exists', () => {
      expect(toolRegistry.hasTool('mock_tool')).toBe(true);
      expect(toolRegistry.hasTool('non_existent')).toBe(false);
    });
  });

  describe('Tool Management', () => {
    beforeEach(() => {
      toolRegistry.registerTool(mockTool);
      toolRegistry.registerTool(anotherMockTool);
    });

    it('should unregister tool successfully', () => {
      const result = toolRegistry.unregisterTool('mock_tool');

      expect(result).toBe(true);
      expect(toolRegistry.hasTool('mock_tool')).toBe(false);
      expect(toolRegistry.getToolNames()).toHaveLength(1);
    });

    it('should return false when unregistering non-existent tool', () => {
      const result = toolRegistry.unregisterTool('non_existent');
      expect(result).toBe(false);
    });

    it('should clear all tools', () => {
      toolRegistry.clear();

      expect(toolRegistry.getToolNames()).toHaveLength(0);
      expect(toolRegistry.getAllTools()).toHaveLength(0);
      expect(toolRegistry.hasTool('mock_tool')).toBe(false);
    });
  });

  describe('Empty Registry', () => {
    it('should handle empty registry correctly', () => {
      expect(toolRegistry.getToolNames()).toHaveLength(0);
      expect(toolRegistry.getAllTools()).toHaveLength(0);
      expect(toolRegistry.getTool('any_tool')).toBeUndefined();
      expect(toolRegistry.hasTool('any_tool')).toBe(false);
    });
  });

  describe('Disposal', () => {
    it('should clear tools on disposal', () => {
      toolRegistry.registerTool(mockTool);
      toolRegistry.registerTool(anotherMockTool);

      expect(toolRegistry.getToolNames()).toHaveLength(2);

      toolRegistry.dispose();

      expect(toolRegistry.getToolNames()).toHaveLength(0);
    });
  });
});