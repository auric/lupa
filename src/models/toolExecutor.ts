import * as vscode from 'vscode';
import { ToolRegistry } from './toolRegistry';
import type { ITool } from '../tools/ITool';
import { TokenConstants } from './tokenConstants';
import { ToolConstants } from './toolConstants';
import { WorkspaceSettingsService } from '../services/workspaceSettingsService';
import type { ToolResultMetadata } from '../types/toolResultTypes';
import type { ExecutionContext } from '../types/executionContext';
import { Log } from '../services/loggingService';

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
    result?: string;
    error?: string;
    /** Optional metadata for complex tool results (e.g., subagent nested tool calls) */
    metadata?: ToolResultMetadata;
}

/**
 * Service responsible for executing tools registered in the ToolRegistry.
 * Supports both single tool execution and parallel execution of multiple tools.
 * Includes rate limiting to prevent excessive tool call loops.
 *
 * IMPORTANT: Create a new ToolExecutor instance for each analysis.
 * This ensures proper isolation of tool call counts and execution context
 * between parallel analyses. Do NOT reuse a singleton ToolExecutor across
 * multiple concurrent analyses.
 */
export class ToolExecutor {
    private toolCallCount = 0;

    /**
     * @param toolRegistry Registry containing available tools
     * @param workspaceSettings Settings for rate limits etc.
     * @param executionContext Optional context for tools that need it.
     *   - Main analysis: Provides planManager for update_plan tool
     *   - Subagents: Typically undefined (subagents can't use plan tools)
     *   - Tools check for required context and return toolError if missing
     */
    constructor(
        private toolRegistry: ToolRegistry,
        private workspaceSettings: WorkspaceSettingsService,
        private executionContext?: ExecutionContext
    ) {}

    private get maxToolCalls(): number {
        return this.workspaceSettings.getMaxIterations();
    }

    /**
     * Format arguments for logging, truncating long values
     */
    private formatArgsForLog(args: any): string {
        try {
            const formatted = JSON.stringify(args, (_key, value) => {
                if (typeof value === 'string' && value.length > 100) {
                    return value.substring(0, 100) + '...';
                }
                return value;
            });
            return formatted.length > 200
                ? formatted.substring(0, 200) + '...'
                : formatted;
        } catch {
            return '[unable to serialize]';
        }
    }

    /**
     * Execute a single tool with the provided arguments.
     * @param name The name of the tool to execute
     * @param args The arguments to pass to the tool
     * @returns Promise resolving to the tool execution result
     */
    async executeTool(name: string, args: any): Promise<ToolExecutionResult> {
        const startTime = Date.now();

        // Count BEFORE validation intentionally - rate limit protects against attempts,
        // not just successful executions. A model making many invalid calls is broken
        // and should be stopped. Like password lockout, we count all attempts.
        this.toolCallCount++;

        Log.debug(`Tool '${name}' starting (call #${this.toolCallCount})`);

        if (this.toolCallCount > this.maxToolCalls) {
            Log.warn(
                `Tool '${name}' ✗ rate limit exceeded (${this.toolCallCount}/${this.maxToolCalls}) | args: ${this.formatArgsForLog(args)}`
            );
            return {
                name,
                success: false,
                error: ToolConstants.ERROR_MESSAGES.RATE_LIMIT_EXCEEDED(
                    this.maxToolCalls,
                    this.toolCallCount
                ),
            };
        }

        // Defensive cancellation check - tools should check themselves, but this
        // prevents starting new work if cancellation was requested between calls
        if (this.executionContext?.cancellationToken?.isCancellationRequested) {
            Log.debug(`Tool '${name}' skipped - analysis was cancelled`);
            throw new vscode.CancellationError();
        }

        try {
            const tool = this.toolRegistry.getTool(name);

            if (!tool) {
                Log.warn(
                    `Tool '${name}' ✗ not found in registry | args: ${this.formatArgsForLog(args)}`
                );
                return {
                    name,
                    success: false,
                    error: `Tool '${name}' not found in registry`,
                };
            }

            // Validate args with Zod schema before execution
            // VS Code's LM API should validate via JSON Schema, but some models bypass it
            const parseResult = tool.schema.safeParse(args);
            if (!parseResult.success) {
                const zodError = parseResult.error;
                const errorDetails = zodError.issues
                    .map(
                        (issue) =>
                            `${issue.path.map(String).join('.')}: ${issue.message}`
                    )
                    .join(', ');
                Log.warn(
                    `Tool '${name}' ✗ schema validation failed: ${errorDetails} | args: ${this.formatArgsForLog(args)}`
                );
                return {
                    name,
                    success: false,
                    error: `Invalid arguments: ${errorDetails}`,
                };
            }

            const validatedArgs = parseResult.data;
            const toolResult = await tool.execute(
                validatedArgs,
                this.executionContext
            );
            const elapsed = Date.now() - startTime;

            // Validate response size only for successful results with data
            if (toolResult.success && toolResult.data) {
                const validationResult = this.validateResponseSize(
                    toolResult.data,
                    name
                );
                if (!validationResult.isValid) {
                    Log.warn(
                        `Tool '${name}' ✗ response too large (${toolResult.data.length} chars) [${elapsed}ms] | args: ${this.formatArgsForLog(args)}`
                    );
                    return {
                        name,
                        success: false,
                        error: validationResult.errorMessage,
                    };
                }
            }

            if (toolResult.success) {
                const resultSize = toolResult.data?.length ?? 0;
                Log.info(
                    `Tool '${name}' ✓ (${resultSize} chars) [${elapsed}ms]`
                );
            } else {
                Log.info(
                    `Tool '${name}' ✗ ${toolResult.error ?? 'unknown error'} [${elapsed}ms] | args: ${this.formatArgsForLog(args)}`
                );
            }

            return {
                name,
                success: toolResult.success,
                result: toolResult.data,
                error: toolResult.error,
                metadata: toolResult.metadata,
            };
        } catch (error) {
            const elapsed = Date.now() - startTime;
            const errorMsg =
                error instanceof Error ? error.message : String(error);
            Log.error(
                `Tool '${name}' threw exception: ${errorMsg} [${elapsed}ms] | args: ${this.formatArgsForLog(args)}`
            );
            return {
                name,
                success: false,
                error: errorMsg,
            };
        }
    }

    /**
     * Execute multiple tools in parallel.
     * @param requests Array of tool execution requests
     * @returns Promise resolving to an array of tool execution results
     */
    async executeTools(
        requests: ToolExecutionRequest[]
    ): Promise<ToolExecutionResult[]> {
        if (requests.length === 0) {
            return [];
        }

        const toolNames = requests.map((r) => r.name).join(', ');
        Log.debug(
            `Executing ${requests.length} tools in parallel: ${toolNames}`
        );
        const startTime = Date.now();

        // Execute all tools in parallel using Promise.all
        const executionPromises = requests.map((request) =>
            this.executeTool(request.name, request.args)
        );

        try {
            const results = await Promise.all(executionPromises);
            const elapsed = Date.now() - startTime;
            const succeeded = results.filter((r) => r.success).length;
            const failed = results.length - succeeded;
            Log.info(
                `Execution complete: ${succeeded} succeeded, ${failed} failed [${elapsed}ms total]`
            );
            return results;
        } catch (error) {
            // This shouldn't happen since executeTool catches errors,
            // but just in case, handle any unexpected errors
            throw new Error(
                `Unexpected error during parallel tool execution: ${error instanceof Error ? error.message : String(error)}`
            );
        }
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

    /**
     * Get the current count of tool calls made in this session.
     * @returns The number of tools executed so far
     */
    getToolCallCount(): number {
        return this.toolCallCount;
    }

    /**
     * Reset the tool call counter for a new analysis session.
     * Should be called at the start of each new analysis to ensure clean rate limiting.
     */
    resetToolCallCount(): void {
        this.toolCallCount = 0;
    }

    /**
     * Validate the size of a tool response
     * @param result The result string returned by the tool
     * @param toolName Name of the tool for error messages
     * @returns Validation result with error message if invalid
     */
    private validateResponseSize(
        result: string,
        toolName: string
    ): { isValid: boolean; errorMessage?: string } {
        try {
            // Check if result exceeds maximum allowed size
            if (result.length > TokenConstants.MAX_TOOL_RESPONSE_CHARS) {
                return {
                    isValid: false,
                    errorMessage: `${TokenConstants.TOOL_CONTEXT_MESSAGES.RESPONSE_TOO_LARGE} Tool '${toolName}' returned ${result.length} characters, maximum allowed: ${TokenConstants.MAX_TOOL_RESPONSE_CHARS}.`,
                };
            }

            return { isValid: true };
        } catch {
            // If validation itself fails, allow the result through but log the issue
            return { isValid: true };
        }
    }

    public dispose(): void {
        // No resources to dispose of currently
    }
}
