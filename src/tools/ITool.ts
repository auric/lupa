import * as z from 'zod';
import * as vscode from 'vscode';
import { ToolResult } from '../types/toolResultTypes';
import { ExecutionContext } from '../types/executionContext';

/**
 * Base interface for LLM-callable tools.
 *
 * Tools extend this interface (via BaseTool) and are registered with the ToolRegistry.
 * The ToolExecutor passes an ExecutionContext containing per-analysis dependencies.
 *
 * @example
 * ```typescript
 * class MyTool extends BaseTool {
 *   name = 'my_tool';
 *   schema = z.object({ query: z.string() });
 *
 *   async execute(args: z.infer<typeof this.schema>, context?: ExecutionContext): Promise<ToolResult> {
 *     // Access per-analysis dependencies from context
 *     const planManager = context?.planManager;
 *     // ...
 *   }
 * }
 * ```
 */
export interface ITool {
    /** Unique identifier for the tool (used in LLM tool calls) */
    name: string;

    /** Human-readable description shown to the LLM */
    description: string;

    /** Zod schema for validating tool arguments */
    schema: z.ZodType;

    /** Returns VS Code LanguageModelChatTool for API registration */
    getVSCodeTool(): vscode.LanguageModelChatTool;

    /**
     * Execute the tool with validated arguments.
     *
     * @param args - Validated arguments matching the schema
     * @param context - Per-analysis execution context (optional for backward compatibility)
     *
     * **ExecutionContext fields:**
     * - `repoRootPath?: string` - Git repository root path for file operations
     * - `planManager?: PlanSessionManager` - Review plan state (main analysis only)
     * - `subagentSessionManager?: SubagentSessionManager` - Subagent spawn tracking (main analysis only)
     * - `subagentExecutor?: SubagentExecutor` - Subagent execution (main analysis only)
     *
     * **When context is provided:**
     * - Main analysis: All fields present
     * - Subagent analysis: repoRootPath only
     * - Exploration mode: repoRootPath only
     * - Agent Mode / external calls: May be undefined
     *
     * @returns Promise resolving to ToolResult (use toolSuccess/toolError helpers)
     */
    execute(args: any, context?: ExecutionContext): Promise<ToolResult>;
}
