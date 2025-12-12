import { ITool } from "../tools/ITool";

/**
 * Registry service for managing and storing tool instances.
 * Provides methods to register tools and retrieve them by name.
 */
export class ToolRegistry {
  private tools = new Map<string, ITool>();

  /**
   * Register a tool instance in the registry.
   * @param tool The tool instance to register
   * @throws Error if a tool with the same name is already registered
   */
  registerTool(tool: ITool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool with name "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  /**
   * Retrieve a tool by its name.
   * @param name The name of the tool to retrieve
   * @returns The tool instance or undefined if not found
   */
  getTool(name: string): ITool | undefined {
    return this.tools.get(name);
  }

  /**
   * Get all registered tool names.
   * @returns Array of registered tool names
   */
  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Get all registered tools.
   * @returns Array of registered tool instances
   */
  getAllTools(): ITool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Check if a tool is registered.
   * @param name The name of the tool to check
   * @returns True if the tool is registered, false otherwise
   */
  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Unregister a tool.
   * @param name The name of the tool to unregister
   * @returns True if the tool was unregistered, false if it wasn't found
   */
  unregisterTool(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * Clear all registered tools.
   */
  clear(): void {
    this.tools.clear();
  }

  public dispose(): void {
    this.clear();
  }
}