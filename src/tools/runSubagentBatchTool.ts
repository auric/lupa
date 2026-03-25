import * as z from 'zod';
import * as vscode from 'vscode';
import { BaseTool } from './baseTool';
import { SubagentLimits, SubagentErrors } from '../models/toolConstants';
import { RecursionConstants } from '../sessions/recursiveStateManager';
import type { SubagentResult } from '../types/modelTypes';
import type { ToolCallRecord } from '../types/toolCallTypes';

import {
    ToolResult,
    ToolResultMetadata,
    toolSuccess,
    toolError,
} from '../types/toolResultTypes';
import {
    buildInvestigationAudit,
    formatCompactAudit,
} from '../utils/investigationAudit';
import { ExecutionContext } from '../types/executionContext';
import { Log } from '../services/loggingService';
import { WorkspaceSettingsService } from '../services/workspaceSettingsService';
import { isCancellationError } from '../utils/asyncUtils';
import { getErrorMessage } from '../utils/errorUtils';
import * as path from 'path';
import type { RecursiveStateManager } from '../sessions/recursiveStateManager';
import type { DiffHunk } from '../types/contextTypes';

const MAX_TASK_LABEL_LENGTH = 80;
const MAX_SUBAGENT_RESPONSE_CHARS = 150_000;

interface TaskAllocation {
    index: number;
    task: string;
    context: string | undefined;
    subagentId: number;
    childAgentId: string | undefined;
    childBudget: number | undefined;
}

type TaskOutcome =
    | {
          status: 'completed';
          result: SubagentResult;
          subagentId: number;
          allocation: TaskAllocation;
      }
    | {
          status: 'failed';
          error: string;
          subagentId: number;
          allocation: TaskAllocation;
          result?: SubagentResult;
      }
    | { status: 'skipped'; reason: string; index: number; task: string };

export class RunSubagentBatchTool extends BaseTool {
    name = 'run_subagent_batch';
    override maxResponseChars = MAX_SUBAGENT_RESPONSE_CHARS;
    description = `Spawn multiple focused investigation sub-agents in ONE tool call — all run in parallel.

Accepts an array of tasks; each gets its own isolated context window and tool access.

⚡ All tasks execute simultaneously, regardless of model limitations.

📋 TASK TEMPLATE (per task):
"Review [concern] in [files]:
Questions:
1. [Specific question about code/changes]
2. [Specific question about code/changes]
Files: [file1.ts, file2.ts]
Focus on: [key functions/classes]"

RULES:
- Include specific file paths in each task
- Target 2-4 files per sub-agent for thorough review
- Sub-agents CANNOT run tests or execute code`;

    schema: z.ZodObject<{
        tasks: z.ZodArray<
            z.ZodObject<{
                task: z.ZodString;
                context: z.ZodOptional<z.ZodString>;
            }>
        >;
    }>;

    constructor(private readonly workspaceSettings: WorkspaceSettingsService) {
        super();

        const taskItem = z.object({
            task: z
                .string()
                .min(
                    SubagentLimits.MIN_TASK_LENGTH,
                    SubagentErrors.taskTooShort(SubagentLimits.MIN_TASK_LENGTH)
                )
                .max(SubagentLimits.MAX_TASK_LENGTH)
                .describe(
                    'Detailed investigation task. Include: ' +
                        '1) WHAT to investigate (specific question or concern), ' +
                        '2) WHERE to look (relevant files, directories, symbols), ' +
                        '3) WHAT to return (expected deliverables).'
                ),
            context: z
                .string()
                .optional()
                .describe(
                    'Relevant context from your current analysis: code snippets, file paths, findings, or symbol names.'
                ),
        });

        this.schema = z.object({
            tasks: z
                .array(taskItem)
                .min(1)
                .max(40)
                .describe(
                    'Array of investigation tasks. All tasks run in parallel.'
                ),
        });
    }

    override normalizeArgs(
        args: Record<string, unknown>
    ): Record<string, unknown> {
        let rawTasks = args.tasks;

        // Handle models sending tasks as a JSON string instead of an array
        if (typeof rawTasks === 'string') {
            try {
                rawTasks = JSON.parse(rawTasks);
                Log.warn(
                    'run_subagent_batch: tasks was a JSON string — parsed into array'
                );
            } catch {
                Log.warn(
                    'run_subagent_batch: tasks was a non-JSON string — cannot parse'
                );
                rawTasks = [];
            }
        }

        // Handle models sending a single task object instead of an array
        if (
            rawTasks !== null &&
            typeof rawTasks === 'object' &&
            !Array.isArray(rawTasks)
        ) {
            Log.warn(
                'run_subagent_batch: tasks was a single object — wrapping in array'
            );
            rawTasks = [rawTasks];
        }

        const tasks = Array.isArray(rawTasks) ? rawTasks : [];
        const normalized = tasks
            .filter(
                (item): item is Record<string, unknown> =>
                    item !== null && typeof item === 'object'
            )
            .map((item: Record<string, unknown>) => {
                const task =
                    typeof item.task === 'string' ? item.task.trim() : '';
                const ctx =
                    typeof item.context === 'string' ? item.context.trim() : '';
                if (
                    task.length < SubagentLimits.MIN_TASK_LENGTH &&
                    ctx.length >= SubagentLimits.MIN_TASK_LENGTH
                ) {
                    Log.warn(
                        `run_subagent_batch: task field empty/short — using context field as task (${ctx.length} chars)`
                    );
                    return { ...item, task: ctx, context: undefined };
                }
                return item;
            });
        return { ...args, tasks: normalized };
    }

    async execute(
        args: z.infer<typeof this.schema>,
        context: ExecutionContext
    ): Promise<ToolResult> {
        if (context.cancellationToken.isCancellationRequested) {
            throw new vscode.CancellationError();
        }

        const executor = context.subagentExecutor;
        const sessionManager = context.subagentSessionManager;
        const recursiveState = context.recursiveState as
            | RecursiveStateManager
            | undefined;
        const currentDepth = context.currentDepth ?? 0;
        const currentAgentId = context.currentAgentId ?? 'root';

        if (!executor || !sessionManager) {
            return toolError(
                'Subagent execution requires ExecutionContext with subagentExecutor and subagentSessionManager. This is an internal error.'
            );
        }

        const { tasks } = args;
        const maxSubagents = this.workspaceSettings.getMaxSubagentsPerSession();
        const remaining = sessionManager.getRemainingBudget();

        if (remaining === 0) {
            Log.warn(
                `Subagent batch rejected: session limit reached (${maxSubagents})`
            );
            return toolError(SubagentErrors.maxExceeded(maxSubagents));
        }

        const spawnCount = Math.min(tasks.length, remaining);
        const outcomes: TaskOutcome[] = [];

        // Mark skipped tasks upfront
        for (let i = spawnCount; i < tasks.length; i++) {
            outcomes.push({
                status: 'skipped',
                reason: `Session limit reached (${maxSubagents} max)`,
                index: i,
                task: tasks[i]!.task,
            });
        }

        // Allocate all slots before launching
        const allocations: TaskAllocation[] = [];
        for (let i = 0; i < spawnCount; i++) {
            const { task, context: taskContext } = tasks[i]!;

            if (!sessionManager.canSpawn()) {
                outcomes.push({
                    status: 'skipped',
                    reason: `Session limit reached during allocation (${maxSubagents} max)`,
                    index: i,
                    task,
                });
                continue;
            }

            if (recursiveState) {
                const guard = recursiveState.canSpawnChild(currentAgentId);
                if (!guard.allowed) {
                    outcomes.push({
                        status: 'skipped',
                        reason:
                            guard.reason ??
                            'Cannot spawn child agent at this depth',
                        index: i,
                        task,
                    });
                    continue;
                }
            }

            const subagentId = sessionManager.recordSpawn();

            let childAgentId: string | undefined;
            let childBudget: number | undefined;
            if (recursiveState) {
                childBudget =
                    recursiveState.allocateChildBudget(currentAgentId);
                try {
                    childAgentId = recursiveState.registerAgent(
                        currentAgentId,
                        task,
                        childBudget
                    );
                } catch (error) {
                    sessionManager.rollbackSpawn();
                    Log.error(
                        `Failed to register agent in recursive tree: ${getErrorMessage(error)}`
                    );
                    outcomes.push({
                        status: 'skipped',
                        reason: `Failed to register subagent: ${getErrorMessage(error)}`,
                        index: i,
                        task,
                    });
                    continue;
                }
                recursiveState.startAgent(childAgentId);
            }

            allocations.push({
                index: i,
                task,
                context: taskContext,
                subagentId,
                childAgentId,
                childBudget,
            });
        }

        if (allocations.length === 0) {
            const skippedResults = this.formatOutcomes(outcomes, tasks);
            return toolError(skippedResults);
        }

        Log.info(
            `Subagent batch: launching ${allocations.length}/${tasks.length} tasks ` +
                `(${sessionManager.getCount()}/${maxSubagents} total spawned)`
        );

        // Execute all allocated subagents in parallel
        const promises = allocations.map((alloc) =>
            this.executeSubagent(
                alloc,
                context,
                executor,
                sessionManager,
                recursiveState,
                currentDepth
            )
        );

        const settled = await Promise.allSettled(promises);

        // Check for parent cancellation — if the parent was cancelled, propagate
        if (context.cancellationToken.isCancellationRequested) {
            // Update recursive state for any allocations
            for (const alloc of allocations) {
                if (recursiveState && alloc.childAgentId) {
                    // Only cancel agents not already completed/failed by the settled results
                    // But since parent is cancelled, we rethrow regardless
                }
            }
            throw new vscode.CancellationError();
        }

        // Process settled results
        for (let i = 0; i < settled.length; i++) {
            const result = settled[i]!;
            const alloc = allocations[i]!;

            if (result.status === 'fulfilled') {
                outcomes.push(result.value);
            } else {
                // Rejected promise — should only happen for unexpected errors
                // (CancellationError was already checked above)
                const error = result.reason as unknown;
                if (isCancellationError(error)) {
                    // Parent cancellation slipped through — rethrow
                    throw error;
                }
                if (recursiveState && alloc.childAgentId) {
                    recursiveState.failAgent(
                        alloc.childAgentId,
                        getErrorMessage(error)
                    );
                }
                sessionManager.rollbackSpawn();
                outcomes.push({
                    status: 'failed',
                    error: getErrorMessage(error),
                    subagentId: alloc.subagentId,
                    allocation: alloc,
                });
            }
        }

        // Sort outcomes by original task index
        outcomes.sort((a, b) => {
            const indexA =
                a.status === 'skipped' ? a.index : a.allocation.index;
            const indexB =
                b.status === 'skipped' ? b.index : b.allocation.index;
            return indexA - indexB;
        });

        const combinedMetadata = this.aggregateMetadata(outcomes);
        const completedCount = outcomes.filter(
            (o) => o.status === 'completed'
        ).length;
        const resultText = this.formatOutcomes(outcomes, tasks);
        const header = `## Batch Results: ${completedCount}/${tasks.length} subagents completed\n\n`;

        return toolSuccess(header + resultText, combinedMetadata);
    }

    private async executeSubagent(
        alloc: TaskAllocation,
        context: ExecutionContext,
        executor: NonNullable<ExecutionContext['subagentExecutor']>,
        sessionManager: NonNullable<ExecutionContext['subagentSessionManager']>,
        recursiveState: RecursiveStateManager | undefined,
        currentDepth: number
    ): Promise<TaskOutcome> {
        const timeoutMs =
            alloc.childBudget !== undefined
                ? Math.max(
                      RecursionConstants.MIN_SUBAGENT_TIMEOUT_MS,
                      alloc.childBudget *
                          RecursionConstants.TIMEOUT_PER_ITERATION_MS
                  )
                : this.workspaceSettings.getRequestTimeoutSeconds() * 1000;

        const cancellationTokenSource = new vscode.CancellationTokenSource();
        const parentCancellationDisposable =
            sessionManager.registerSubagentCancellation(
                cancellationTokenSource
            );
        let cancelledByTimeout = false;
        const timeoutHandle = setTimeout(() => {
            cancelledByTimeout = true;
            cancellationTokenSource.cancel();
        }, timeoutMs);

        try {
            const result = await executor.execute(
                {
                    task: alloc.task,
                    context: alloc.context,
                },
                cancellationTokenSource.token,
                alloc.subagentId,
                {
                    recursionDepth: currentDepth + 1,
                    agentId: alloc.childAgentId,
                    recursiveState,
                    parsedDiff: context.parsedDiff,
                    subagentSessionManager: sessionManager,
                    childBudget: alloc.childBudget,
                    findingStore: context.findingStore,
                    calibrationProfile: context.calibrationProfile,
                    investigatedFiles: context.investigatedFiles,
                }
            );

            clearTimeout(timeoutHandle);

            if (recursiveState && alloc.childAgentId) {
                const filesExamined = RunSubagentBatchTool.extractFilesExamined(
                    result.toolCalls,
                    context.parsedDiff
                );
                if (result.success) {
                    recursiveState.completeAgent(
                        alloc.childAgentId,
                        [],
                        filesExamined
                    );
                } else if (result.error === 'cancelled') {
                    recursiveState.cancelAgent(alloc.childAgentId);
                } else if (
                    result.error === 'max_iterations' ||
                    result.error === 'rate_limited' ||
                    result.error === 'quota_exhausted'
                ) {
                    recursiveState.completeAgent(
                        alloc.childAgentId,
                        [],
                        filesExamined
                    );
                } else {
                    recursiveState.failAgent(
                        alloc.childAgentId,
                        result.error ?? 'Unknown error'
                    );
                }
            }

            if (!result.success && result.error === 'cancelled') {
                if (
                    cancelledByTimeout &&
                    !context.cancellationToken.isCancellationRequested
                ) {
                    return {
                        status: 'failed',
                        error: SubagentErrors.timeout(timeoutMs),
                        subagentId: alloc.subagentId,
                        allocation: alloc,
                    };
                }
                // Parent cancellation — will be caught at the batch level
                throw new vscode.CancellationError();
            }

            if (!result.success && result.error === 'max_iterations') {
                const actualMaxIterations =
                    alloc.childBudget ??
                    this.workspaceSettings.getMaxIterations();
                const msg = SubagentErrors.maxIterations(
                    result.toolCallsMade,
                    actualMaxIterations
                );
                const partial = result.response?.trim();
                return {
                    status: 'failed',
                    error: partial
                        ? `${msg}\n\nPartial findings:\n${partial}`
                        : msg,
                    subagentId: alloc.subagentId,
                    allocation: alloc,
                    result,
                };
            }

            if (!result.success && result.error === 'rate_limited') {
                const msg = SubagentErrors.rateLimited(result.toolCallsMade);
                const partial = result.response?.trim();
                return {
                    status: 'failed',
                    error: partial
                        ? `${msg}\n\nPartial findings:\n${partial}`
                        : msg,
                    subagentId: alloc.subagentId,
                    allocation: alloc,
                    result,
                };
            }

            if (!result.success && result.error === 'quota_exhausted') {
                const msg = `Subagent #${alloc.subagentId} stopped: monthly Copilot quota exhausted after ${result.toolCallsMade} tool calls.`;
                const partial = result.response?.trim();
                return {
                    status: 'failed',
                    error: partial
                        ? `${msg}\n\nPartial findings:\n${partial}`
                        : msg,
                    subagentId: alloc.subagentId,
                    allocation: alloc,
                    result,
                };
            }

            if (!result.success) {
                sessionManager.rollbackSpawn();
                return {
                    status: 'failed',
                    error: SubagentErrors.failed(
                        result.error || 'Unknown error'
                    ),
                    subagentId: alloc.subagentId,
                    allocation: alloc,
                };
            }

            return {
                status: 'completed',
                result,
                subagentId: alloc.subagentId,
                allocation: alloc,
            };
        } catch (error) {
            clearTimeout(timeoutHandle);

            if (recursiveState && alloc.childAgentId) {
                if (isCancellationError(error)) {
                    recursiveState.cancelAgent(alloc.childAgentId);
                } else {
                    recursiveState.failAgent(
                        alloc.childAgentId,
                        getErrorMessage(error)
                    );
                }
            }

            if (isCancellationError(error)) {
                throw error;
            }

            if (
                cancelledByTimeout &&
                !context.cancellationToken.isCancellationRequested
            ) {
                return {
                    status: 'failed',
                    error: SubagentErrors.timeout(timeoutMs),
                    subagentId: alloc.subagentId,
                    allocation: alloc,
                };
            }

            sessionManager.rollbackSpawn();
            return {
                status: 'failed',
                error: SubagentErrors.failed(getErrorMessage(error)),
                subagentId: alloc.subagentId,
                allocation: alloc,
            };
        } finally {
            parentCancellationDisposable?.dispose();
            cancellationTokenSource.dispose();
        }
    }

    private formatOutcomes(
        outcomes: TaskOutcome[],
        tasks: { task: string }[]
    ): string {
        const OVERHEAD_PER_RESULT = 200; // headers, separators, audit lines

        // Build all parts, tracking which are completed (and thus truncatable)
        const rawParts: {
            text: string;
            truncatable: boolean;
            responseStart: number;
            responseEnd: number;
        }[] = [];

        for (const outcome of outcomes) {
            const index =
                outcome.status === 'skipped'
                    ? outcome.index
                    : outcome.allocation.index;
            const taskText = tasks[index]!.task;
            const label =
                taskText.length > MAX_TASK_LABEL_LENGTH
                    ? taskText.slice(0, MAX_TASK_LABEL_LENGTH) + '...'
                    : taskText;

            if (outcome.status === 'completed') {
                const audit = buildInvestigationAudit(outcome.result.toolCalls);
                const auditLine = formatCompactAudit(audit);
                const header =
                    `### Subagent #${outcome.subagentId} — ${label}\n\n` +
                    `**Tool calls made:** ${outcome.result.toolCallsMade}\n\n` +
                    `---\n\n`;
                const response = outcome.result.response;
                const text = header + response + auditLine;
                rawParts.push({
                    text,
                    truncatable: true,
                    responseStart: header.length,
                    responseEnd: header.length + response.length,
                });
            } else if (outcome.status === 'failed') {
                rawParts.push({
                    text:
                        `### Subagent #${outcome.subagentId} — FAILED\n\n` +
                        `${outcome.error}`,
                    truncatable: false,
                    responseStart: 0,
                    responseEnd: 0,
                });
            } else {
                rawParts.push({
                    text:
                        `### Task #${index + 1} — SKIPPED\n\n` +
                        `Reason: ${outcome.reason}`,
                    truncatable: false,
                    responseStart: 0,
                    responseEnd: 0,
                });
            }
        }

        const separator = '\n\n';
        const totalChars =
            rawParts.reduce((sum, p) => sum + p.text.length, 0) +
            separator.length * Math.max(0, rawParts.length - 1);

        // If within budget, return as-is
        if (totalChars <= MAX_SUBAGENT_RESPONSE_CHARS) {
            return rawParts.map((p) => p.text).join(separator);
        }

        // Proportional truncation: distribute budget across completed responses
        const nonTruncatableChars = rawParts
            .filter((p) => !p.truncatable)
            .reduce((sum, p) => sum + p.text.length, 0);
        const separatorChars =
            separator.length * Math.max(0, rawParts.length - 1);
        const truncatableCount = rawParts.filter((p) => p.truncatable).length;
        const availableForResponses =
            MAX_SUBAGENT_RESPONSE_CHARS -
            nonTruncatableChars -
            separatorChars -
            truncatableCount * OVERHEAD_PER_RESULT;
        const perResponseBudget = Math.max(
            500,
            Math.floor(availableForResponses / Math.max(1, truncatableCount))
        );

        Log.warn(
            `Subagent batch response too large (${totalChars} chars), truncating ${truncatableCount} responses to ~${perResponseBudget} chars each`
        );

        const parts = rawParts.map((p) => {
            if (!p.truncatable) {
                return p.text;
            }
            const responseLength = p.responseEnd - p.responseStart;
            const overhead = p.text.length - responseLength;
            const responseBudget = Math.max(200, perResponseBudget - overhead);
            if (responseLength <= responseBudget) {
                return p.text;
            }
            // Truncate the response portion, keeping header and audit
            const truncatedResponse =
                p.text.slice(
                    p.responseStart,
                    p.responseStart + responseBudget
                ) +
                `\n\n... [truncated ${responseLength - responseBudget} chars]`;
            return (
                p.text.slice(0, p.responseStart) +
                truncatedResponse +
                p.text.slice(p.responseEnd)
            );
        });

        return parts.join(separator);
    }

    private aggregateMetadata(outcomes: TaskOutcome[]): ToolResultMetadata {
        const perSubagentRecords: ToolCallRecord[] = [];
        let totalExecutionTimeMs = 0;
        let totalIterationsUsed = 0;

        for (const outcome of outcomes) {
            if (outcome.status === 'skipped') {
                continue;
            }

            const result =
                outcome.status === 'completed'
                    ? outcome.result
                    : outcome.result;

            if (!result) {
                continue;
            }

            // Create a synthetic ToolCallRecord per subagent so the webview
            // renders each as its own expandable InlineAgent entry.
            perSubagentRecords.push({
                id: `subagent-${outcome.subagentId}`,
                toolName: 'run_subagent_batch',
                arguments: { task: outcome.allocation.task },
                result: result.response,
                success: result.success,
                error: result.error,
                durationMs: undefined,
                timestamp: Date.now(),
                nestedCalls: result.toolCalls,
                executionTimeMs: result.executionTimeMs,
                iterationsUsed: result.iterationsUsed,
            });

            if (result.executionTimeMs !== undefined) {
                totalExecutionTimeMs += result.executionTimeMs;
            }
            if (result.iterationsUsed !== undefined) {
                totalIterationsUsed += result.iterationsUsed;
            }
        }

        return {
            nestedToolCalls: perSubagentRecords,
            executionTimeMs: totalExecutionTimeMs,
            iterationsUsed: totalIterationsUsed,
        };
    }

    static extractFilesExamined(
        toolCalls: ToolCallRecord[],
        parsedDiff?: DiffHunk[]
    ): string[] {
        const files = new Set<string>();
        for (const call of toolCalls) {
            if (call.toolName !== 'get_file_diff') {
                continue;
            }
            const raw = call.arguments['file_paths'];
            const filePaths = Array.isArray(raw)
                ? raw
                : typeof raw === 'string'
                  ? raw
                        .split('\n')
                        .map((l) => l.trim())
                        .filter(Boolean)
                  : [];
            for (const fp of filePaths) {
                if (typeof fp !== 'string') {
                    continue;
                }
                const resolved = parsedDiff
                    ? RunSubagentBatchTool.resolveToCanonicalPath(
                          fp,
                          parsedDiff
                      )
                    : fp;
                if (resolved) {
                    files.add(resolved);
                }
            }
        }
        return [...files];
    }

    private static resolveToCanonicalPath(
        rawPath: string,
        parsedDiff: DiffHunk[]
    ): string | undefined {
        const normalized = rawPath
            .trim()
            .replace(/\\/g, '/')
            .replace(/^\/+/, '')
            .replace(/^\.\//, '');
        const requestedPath = path.posix.normalize(normalized);

        const exactMatch = parsedDiff.find((f) => f.filePath === requestedPath);
        if (exactMatch) {
            return exactMatch.filePath;
        }

        // Case-insensitive fallback — models often use wrong casing for file paths
        const lowerRequested = requestedPath.toLowerCase();
        const ciMatches = parsedDiff.filter(
            (f) => f.filePath.toLowerCase() === lowerRequested
        );
        if (ciMatches.length === 1) {
            return ciMatches[0]!.filePath;
        }

        const suffixMatches = parsedDiff.filter((f) =>
            f.filePath.endsWith('/' + requestedPath)
        );
        if (suffixMatches.length === 1) {
            return suffixMatches[0]!.filePath;
        }

        return undefined;
    }
}
