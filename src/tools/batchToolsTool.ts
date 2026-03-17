import * as z from 'zod';
import { BaseTool } from './baseTool';
import { ToolResult, toolSuccess, toolError } from '../types/toolResultTypes';
import type { ExecutionContext } from '../types/executionContext';
import { Log } from '../services/loggingService';
import { isCancellationError } from '../utils/asyncUtils';

/**
 * Maximum number of tool calls allowed in a single batch.
 * Prevents token exhaustion from excessively large batches.
 */
const MAX_BATCH_SIZE = 15;

/**
 * Tools that cannot be called via batch_tools.
 * - batch_tools: prevent infinite recursion
 */
const DISALLOWED_TOOLS = new Set(['batch_tools']);

const callSchema = z.object({
    tool: z.string().describe('Name of the tool to call'),
    args: z
        .record(z.string(), z.unknown())
        .describe('Arguments object for the tool call'),
});

export class BatchToolsTool extends BaseTool {
    name = 'batch_tools';
    description = `Execute multiple tool calls in parallel within a single turn.

Use this when you need to call 2+ independent tools and want them to run simultaneously.
Accepts an array of tool calls; each specifies the tool name and its arguments.

⚡ All calls execute in parallel. Results are returned in the same order as the input.

Example: Read two files and search for a pattern simultaneously:
{ "calls": [
  { "tool": "read_file", "args": { "file_path": "src/main.ts" } },
  { "tool": "read_file", "args": { "file_path": "src/utils.ts" } },
  { "tool": "search_for_pattern", "args": { "pattern": "TODO" } }
]}`;

    schema = z.object({
        calls: z
            .array(callSchema)
            .min(2)
            .max(MAX_BATCH_SIZE)
            .describe(
                'Array of tool calls to execute in parallel. Minimum 2 (no point batching 1 call).'
            ),
    });

    /**
     * Normalize model arguments to handle common LLM quirks:
     * - `calls` as a JSON string
     * - `tools` alias for `calls`
     * - Single call object (wrap in array)
     */
    override normalizeArgs(
        args: Record<string, unknown>
    ): Record<string, unknown> {
        let calls = args.calls ?? args.tools;

        // Parse JSON string
        if (typeof calls === 'string') {
            try {
                calls = JSON.parse(calls);
            } catch {
                // Leave as-is for Zod to reject
                return { calls };
            }
        }

        // Wrap single call in array
        if (
            calls &&
            typeof calls === 'object' &&
            !Array.isArray(calls) &&
            'tool' in (calls as Record<string, unknown>)
        ) {
            calls = [calls];
        }

        // Filter null/undefined items from array
        if (Array.isArray(calls)) {
            calls = calls.filter(
                (item: unknown) => item !== null && item !== undefined
            );

            // Normalize each call entry for common LLM quirks
            calls = (calls as Record<string, unknown>[]).map(
                (call: Record<string, unknown>) => {
                    const normalized = { ...call };

                    // Strip "functions." prefix from tool names (some models add it)
                    if (
                        typeof normalized.tool === 'string' &&
                        normalized.tool.startsWith('functions.')
                    ) {
                        normalized.tool = normalized.tool.slice(
                            'functions.'.length
                        );
                    }

                    // Accept "parameters" as alias for "args"
                    if (
                        normalized.parameters !== undefined &&
                        normalized.args === undefined
                    ) {
                        normalized.args = normalized.parameters;
                        delete normalized.parameters;
                    }

                    // Accept "arguments" as alias for "args"
                    if (
                        normalized.arguments !== undefined &&
                        normalized.args === undefined
                    ) {
                        normalized.args = normalized.arguments;
                        delete normalized.arguments;
                    }

                    // Parse JSON string args
                    if (typeof normalized.args === 'string') {
                        try {
                            normalized.args = JSON.parse(
                                normalized.args as string
                            );
                        } catch {
                            // Leave for Zod to reject
                        }
                    }

                    // Default missing args to empty object
                    if (normalized.args === undefined) {
                        normalized.args = {};
                    }

                    return normalized;
                }
            );
        }

        return { calls };
    }

    async execute(
        args: z.infer<typeof this.schema>,
        context: ExecutionContext
    ): Promise<ToolResult> {
        const { calls } = args;

        if (!context.toolExecutor) {
            return toolError(
                'batch_tools requires toolExecutor in ExecutionContext. This is a configuration error.'
            );
        }

        // Validate no disallowed tools
        const disallowed = calls.filter((c) => DISALLOWED_TOOLS.has(c.tool));
        if (disallowed.length > 0) {
            const names = disallowed.map((c) => c.tool).join(', ');
            return toolError(
                `Cannot batch the following tools: ${names}. Call them directly instead.`
            );
        }

        const toolNames = calls.map((c) => c.tool).join(', ');
        Log.info(
            `batch_tools: executing ${calls.length} calls in parallel: ${toolNames}`
        );
        const startTime = Date.now();

        // Build execution requests and execute in parallel via ToolExecutor
        const requests = calls.map((call) => ({
            name: call.tool,
            args: call.args,
        }));

        try {
            const results = await context.toolExecutor.executeTools(requests);
            const elapsed = Date.now() - startTime;

            const succeeded = results.filter((r) => r.success).length;
            const failed = results.length - succeeded;
            Log.info(
                `batch_tools: completed ${results.length} calls (${succeeded} succeeded, ${failed} failed) [${elapsed}ms]`
            );

            // Format results as indexed sections for clear LLM consumption
            const sections = results.map((result, i) => {
                const call = calls[i]!;
                const header = `[${i + 1}/${results.length}] ${call.tool}`;
                if (result.success) {
                    return `${header}: ✓\n${result.result ?? '(no output)'}`;
                } else {
                    return `${header}: ✗ ${result.error ?? 'unknown error'}`;
                }
            });

            const summary = `Batch complete: ${succeeded}/${results.length} succeeded [${elapsed}ms]`;
            return toolSuccess(`${summary}\n\n${sections.join('\n\n---\n\n')}`);
        } catch (error) {
            // CancellationError must propagate
            if (isCancellationError(error)) {
                throw error;
            }
            Log.error(`batch_tools: unexpected error`, error);
            return toolError(`Batch execution failed: ${String(error)}`);
        }
    }
}
