import { ToolRegistry } from './toolRegistry';
import { ITool } from '../tools/ITool';

/**
 * Interface for tool execution requests
 */
export interface ToolExecutionRequest {
  name: string;
  args: any;
}

/**
 * Interface for tool execution results
 */
export interface ToolExecutionResult {
  name: string;
  success: boolean;
  result?: any;
  error?: string;
}

/**
 * Service responsible for executing tools registered in the ToolRegistry.
 * Supports both single tool execution and parallel execution of multiple tools.
 */
export class ToolExecutor {
  constructor(private toolRegistry: ToolRegistry) { }

  /**
   * Execute a single tool with the provided arguments.
   * @param name The name of the tool to execute
   * @param args The arguments to pass to the tool
   * @returns Promise resolving to the tool execution result
   */
  async executeTool(name: string, args: any): Promise<ToolExecutionResult> {
    try {
      const tool = this.toolRegistry.getTool(name);

      if (!tool) {
        return {
          name,
          success: false,
          error: `Tool '${name}' not found in registry`
        };
      }

      const result = await tool.execute(args);

      return {
        name,
        success: true,
        result
      };
    } catch (error) {
      return {
        name,
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Execute multiple tools in parallel.
   * @param requests Array of tool execution requests
   * @returns Promise resolving to an array of tool execution results
   */
  async executeTools(requests: ToolExecutionRequest[]): Promise<ToolExecutionResult[]> {
    if (requests.length === 0) {
      return [];
    }

    // Execute all tools in parallel using Promise.all
    const executionPromises = requests.map(request =>
      this.executeTool(request.name, request.args)
    );

    try {
      const results = await Promise.all(executionPromises);
      return results;
    } catch (error) {
      // This shouldn't happen since executeTool catches errors,
      // but just in case, handle any unexpected errors
      throw new Error(`Unexpected error during parallel tool execution: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Execute multiple tools sequentially (one after another).
   * Useful when tool execution order matters or to avoid overwhelming the system.
   * @param requests Array of tool execution requests
   * @returns Promise resolving to an array of tool execution results
   */
  async executeToolsSequentially(requests: ToolExecutionRequest[]): Promise<ToolExecutionResult[]> {
    const results: ToolExecutionResult[] = [];

    for (const request of requests) {
      const result = await this.executeTool(request.name, request.args);
      results.push(result);

      // If a tool fails and it's critical, you could break here
      // For now, we continue execution regardless of individual failures
    }

    return results;
  }

  /**
   * Get all available tools from the registry.
   * @returns Array of available tool instances
   */
  getAvailableTools(): ITool[] {
    return this.toolRegistry.getAllTools();
  }

  /**
   * Check if a tool is available for execution.
   * @param name The name of the tool to check
   * @returns True if the tool is available, false otherwise
   */
  isToolAvailable(name: string): boolean {
    return this.toolRegistry.hasTool(name);
  }

  public dispose(): void {
    // No resources to dispose of currently
  }
}