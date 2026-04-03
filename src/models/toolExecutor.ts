import * as vscode from 'vscode';
import { ToolRegistry } from './toolRegistry';
import type { ITool } from '../tools/ITool';
import { TokenConstants } from './tokenConstants';
import { ToolConstants } from './toolConstants';
import { ANALYSIS_LIMITS } from './workspaceSettingsSchema';
import type { ToolResultMetadata } from '../types/toolResultTypes';
import type { ExecutionContext } from '../types/executionContext';
import { Log } from '../services/loggingService';
import { isCancellationError, isTimeoutError } from '../utils/asyncUtils';
import { getErrorMessage } from '../utils/errorUtils';

const FILE_TRACKING_TOOLS = new Set([
    'read_file',
    'find_symbol',
    'find_usages',
    'validate_claim',
]);

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
    private sharedCallCount: { value: number };
    private toolCallCountsByName: Map<string, number>;
    private readonly localTools = new Map<string, ITool>();
    private restrictToLocal = false;

    /**
     * @param toolRegistry Registry containing available tools
     * @param executionContext Context for tools containing per-analysis dependencies.
     *   - Main analysis: Full context with planManager, subagentExecutor, etc.
     *   - Subagents: Minimal context with just cancellationToken
     *   - Tests: Use createMockExecutionContext() from mockFactories.ts
     * @param maxToolCalls Maximum number of tool calls before rate limiting (defaults to maxIterations * toolCallMultiplier)
     */
    constructor(
        private toolRegistry: ToolRegistry,
        private executionContext: ExecutionContext,
        private readonly maxToolCalls: number = ANALYSIS_LIMITS.maxIterations *
            ANALYSIS_LIMITS.toolCallMultiplier
    ) {
        // Fail fast if ExecutionContext lacks cancellationToken - catches misconfigured callers early
        if (!executionContext?.cancellationToken) {
            throw new Error(
                'ToolExecutor requires ExecutionContext with a valid cancellationToken'
            );
        }
        this.sharedCallCount = { value: 0 };
        this.toolCallCountsByName = new Map<string, number>();
        // NOTE: executionContext.toolCallCounts is NOT set here — callers must
        // call bindToContext() after construction for the primary executor.
        // This avoids a transient clobber in createScoped() where the constructor
        // would momentarily overwrite the parent's map with a fresh empty one.
    }

    /**
     * The execution context for the current analysis.
     * Used by ConversationRunner to save/restore toolExecutor across scoped runs.
     */
    getExecutionContext(): ExecutionContext {
        return this.executionContext;
    }

    /**
     * Bind this executor's counters to the execution context.
     * Must be called once after constructing the primary (non-scoped) executor.
     */
    bindToContext(): void {
        this.executionContext.toolCallCounts = this.toolCallCountsByName;
    }

    /**
     * Create a scoped ToolExecutor that includes additional local tools
     * beyond those in the shared registry. Local tools take precedence
     * over registry tools with the same name. The original registry is
     * never mutated — no cleanup needed.
     */
    createScoped(
        additionalTools: ITool[],
        options?: { restrictToLocal?: boolean }
    ): ToolExecutor {
        const scoped = new ToolExecutor(
            this.toolRegistry,
            this.executionContext,
            this.maxToolCalls
        );
        // Share parent's counters so all tool calls (direct and via batch_tools)
        // are tracked in one place, maintaining consistent rate limiting.
        scoped.sharedCallCount = this.sharedCallCount;
        scoped.toolCallCountsByName = this.toolCallCountsByName;
        scoped.restrictToLocal = options?.restrictToLocal ?? false;
        for (const tool of additionalTools) {
            scoped.localTools.set(tool.name, tool);
        }
        // Update executionContext so batch_tools dispatches via scoped executor
        // (which has access to local tools like score_finding).
        this.executionContext.toolExecutor = scoped;
        return scoped;
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

        // Defensive cancellation check FIRST - before any other logic.
        // This ensures cancellation takes precedence over rate limiting,
        // preventing the case where a cancelled analysis continues because
        // rate-limit error masked the cancellation.
        if (this.executionContext.cancellationToken.isCancellationRequested) {
            Log.debug(`Tool '${name}' skipped - analysis was cancelled`);
            throw new vscode.CancellationError();
        }

        // Count BEFORE validation intentionally - rate limit protects against attempts,
        // not just successful executions. A model making many invalid calls is broken
        // and should be stopped. Like password lockout, we count all attempts.
        this.sharedCallCount.value++;
        this.toolCallCountsByName.set(
            name,
            (this.toolCallCountsByName.get(name) ?? 0) + 1
        );

        Log.debug(
            `Tool '${name}' starting (call #${this.sharedCallCount.value})`
        );

        if (this.sharedCallCount.value > this.maxToolCalls) {
            Log.warn(
                `Tool '${name}' ✗ rate limit exceeded (${this.sharedCallCount.value}/${this.maxToolCalls}) | args: ${this.formatArgsForLog(args)}`
            );
            return {
                name,
                success: false,
                error: ToolConstants.ERROR_MESSAGES.RATE_LIMIT_EXCEEDED(
                    this.maxToolCalls,
                    this.sharedCallCount.value
                ),
            };
        }

        let managesOwnRecording = false;
        try {
            const tool = this.restrictToLocal
                ? this.localTools.get(name)
                : (this.localTools.get(name) ??
                  this.toolRegistry.getTool(name));

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

            // Normalize args before validation (handles model-specific quirks like GPT-4.1
            // putting run_subagent_batch task content in the context field)
            const normalizedArgs = tool.normalizeArgs
                ? tool.normalizeArgs(args)
                : args;

            // Validate args with Zod schema before execution
            // VS Code's LM API should validate via JSON Schema, but some models bypass it
            const parseResult = tool.schema.safeParse(normalizedArgs);
            if (!parseResult.success) {
                const zodError = parseResult.error;
                const errorDetails = zodError.issues
                    .map(
                        (issue) =>
                            `${issue.path.map(String).join('.')}: ${issue.message}`
                    )
                    .join(', ');
                const argsChanged = normalizedArgs !== args;
                Log.warn(
                    `Tool '${name}' ✗ schema validation failed: ${errorDetails} | args: ${this.formatArgsForLog(args)}${argsChanged ? ` | normalized: ${this.formatArgsForLog(normalizedArgs)}` : ''}`
                );
                return {
                    name,
                    success: false,
                    error: `Invalid arguments: ${errorDetails}`,
                };
            }

            const validatedArgs = parseResult.data;
            managesOwnRecording = tool.managesOwnChainRecording ?? false;
            const toolResult = await tool.execute(
                validatedArgs,
                this.executionContext
            );
            const elapsed = Date.now() - startTime;

            // Record tool call in reasoning chain for evidence-aware gating
            if (!managesOwnRecording) {
                this.executionContext.reasoningChain?.recordToolCall(name);
            }

            // Validate response size only for successful results with data
            if (toolResult.success && toolResult.data) {
                const maxChars =
                    tool.maxResponseChars ??
                    TokenConstants.MAX_TOOL_RESPONSE_CHARS;
                const validationResult = this.validateResponseSize(
                    toolResult.data,
                    name,
                    maxChars
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

            // Track files investigated via deep investigation tools.
            // This excludes get_file_diff (which only shows changed hunks) to ensure
            // the model has read the actual file content before recording findings.
            if (
                toolResult.success &&
                this.executionContext.investigatedFiles &&
                FILE_TRACKING_TOOLS.has(name)
            ) {
                const parsed = validatedArgs as Record<string, unknown>;
                const filePath =
                    parsed.file_path ?? parsed.file ?? parsed.relative_path;
                if (
                    filePath &&
                    typeof filePath === 'string' &&
                    filePath !== '.'
                ) {
                    this.executionContext.investigatedFiles.add(
                        filePath.replace(/\\/g, '/')
                    );
                }
            }

            return {
                name,
                success: toolResult.success,
                result: toolResult.data,
                error: toolResult.error,
                metadata: toolResult.metadata,
            };
        } catch (error) {
            // CancellationError must propagate to stop the entire analysis
            if (isCancellationError(error)) {
                Log.debug(`Tool '${name}' cancelled`);
                throw error;
            }

            const elapsed = Date.now() - startTime;

            // TimeoutError gets a helpful message for the LLM
            if (isTimeoutError(error)) {
                Log.warn(
                    `Tool '${name}' timed out [${elapsed}ms] | args: ${this.formatArgsForLog(args)}`
                );
                if (!managesOwnRecording) {
                    this.executionContext.reasoningChain?.recordToolCall(name);
                }
                return {
                    name,
                    success: false,
                    error: `Operation timed out. Try a more specific query or limit the search scope.`,
                };
            }

            const errorMsg = getErrorMessage(error);
            Log.error(
                `Tool '${name}' threw exception: ${errorMsg} [${elapsed}ms] | args: ${this.formatArgsForLog(args)}`,
                error
            );
            if (!managesOwnRecording) {
                this.executionContext.reasoningChain?.recordToolCall(name);
            }
            return {
                name,
                success: false,
                error: errorMsg,
            };
        }
    }

    /**
     * Execute multiple tools in parallel.
     *
     * Cancellation behavior: When any tool throws CancellationError, Promise.all rejects
     * immediately and the error propagates up to stop the analysis. Other in-flight tools
     * continue running but their results are discarded. This is intentional—tools observe
     * the shared cancellation token and clean up their own resources (e.g., ripgrep kills
     * child processes, withCancellableTimeout races against the token). Forcibly aborting
     * promises isn't possible in JavaScript; cancellation is cooperative.
     *
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
            // CancellationError must propagate to stop the entire analysis.
            // executeTool rethrows CancellationError, so it reaches here via Promise.all rejection.
            if (isCancellationError(error)) {
                Log.debug('Parallel tool execution cancelled');
                throw error;
            }

            // Note: TimeoutError is handled inside executeTool (converted to toolError result),
            // so it won't propagate here. Only CancellationError bubbles up from tools.

            // This shouldn't happen since executeTool catches other errors,
            // but just in case, handle any unexpected errors
            throw new Error(
                `Unexpected error during parallel tool execution: ${getErrorMessage(error)}`
            );
        }
    }

    /**
     * Get all available tools from the registry.
     * @returns Array of available tool instances
     */
    getAvailableTools(): ITool[] {
        const registryTools = this.restrictToLocal
            ? []
            : this.toolRegistry.getAllTools();
        const localToolArray = Array.from(this.localTools.values());
        if (localToolArray.length === 0) {
            return registryTools;
        }
        const seen = new Set(localToolArray.map((t) => t.name));
        return [
            ...localToolArray,
            ...registryTools.filter((t) => !seen.has(t.name)),
        ];
    }

    getToolCallCountByName(name: string): number {
        return this.toolCallCountsByName.get(name) ?? 0;
    }

    /**
     * Check if a tool is available for execution.
     * @param name The name of the tool to check
     * @returns True if the tool is available, false otherwise
     */
    isToolAvailable(name: string): boolean {
        if (this.localTools.has(name)) {
            return true;
        }
        return !this.restrictToLocal && this.toolRegistry.hasTool(name);
    }

    /**
     * Get the current count of tool calls made in this session.
     * @returns The number of tools executed so far
     */
    getToolCallCount(): number {
        return this.sharedCallCount.value;
    }

    /**
     * Reset the tool call counter for a new analysis session.
     * Should be called at the start of each new analysis to ensure clean rate limiting.
     */
    resetToolCallCount(): void {
        this.sharedCallCount.value = 0;
        this.toolCallCountsByName.clear();
    }

    /**
     * Validate the size of a tool response
     * @param result The result string returned by the tool
     * @param toolName Name of the tool for error messages
     * @returns Validation result with error message if invalid
     */
    private validateResponseSize(
        result: string,
        toolName: string,
        maxChars: number
    ): { isValid: boolean; errorMessage?: string } {
        try {
            // Check if result exceeds maximum allowed size
            if (result.length > maxChars) {
                return {
                    isValid: false,
                    errorMessage: `${TokenConstants.TOOL_CONTEXT_MESSAGES.RESPONSE_TOO_LARGE} Tool '${toolName}' returned ${result.length} characters, maximum allowed: ${maxChars}.`,
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
