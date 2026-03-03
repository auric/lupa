import * as vscode from 'vscode';
import { Log } from '../services/loggingService';
import { SubagentExecutor } from '../services/subagentExecutor';
import { SubagentSessionManager } from '../services/subagentSessionManager';
import {
    RecursiveStateManager,
    RecursionConstants,
} from './recursiveStateManager';
import {
    SubagentBatchManager,
    type QueuedSubagent,
} from './subagentBatchManager';
import { RunSubagentTool } from '../tools/runSubagentTool';
import type { ExecutionContext } from '../types/executionContext';
import { isCancellationError } from '../utils/asyncUtils';
import { getErrorMessage } from '../utils/errorUtils';

/**
 * Create a callback that flushes batched subagent tasks for parallel execution.
 * Returns undefined (no-op) if there are no pending tasks or the model is still
 * accumulating (current iteration had run_subagent calls).
 *
 * Shared between ToolCallingAnalysisProvider and ChatParticipantService.
 */
export function createFlushBatchCallback(
    batchManager: SubagentBatchManager,
    subagentExecutor: SubagentExecutor,
    sessionManager: SubagentSessionManager,
    recursiveState: RecursiveStateManager | undefined,
    executionContext: ExecutionContext,
    parentToken: vscode.CancellationToken,
    fallbackTimeoutMs: number
): (currentToolNames: string[]) => Promise<string | undefined> {
    return async (currentToolNames: string[]) => {
        if (!batchManager.hasPending()) {
            return undefined;
        }

        // Still accumulating: this iteration had run_subagent calls
        if (currentToolNames.includes('run_subagent')) {
            return undefined;
        }

        const queued = batchManager.drain();
        Log.info(
            `Flushing ${queued.length} batched subagent(s) for parallel execution`
        );

        const results = await Promise.allSettled(
            queued.map((entry) =>
                executeBatchedSubagent(
                    entry,
                    subagentExecutor,
                    sessionManager,
                    recursiveState,
                    executionContext,
                    parentToken,
                    fallbackTimeoutMs
                )
            )
        );

        // Discard results if the parent analysis was cancelled during execution
        if (parentToken.isCancellationRequested) {
            Log.info('Discarding batched subagent results — parent cancelled');
            return undefined;
        }

        const lines: string[] = [
            `## Batched Subagent Results (${queued.length} executed in parallel)\n`,
        ];

        for (let i = 0; i < results.length; i++) {
            const result = results[i]!;
            const entry = queued[i]!;
            lines.push(`### Subagent #${entry.subagentId}\n`);
            if (result.status === 'fulfilled') {
                lines.push(result.value);
            } else {
                lines.push(`Error: ${getErrorMessage(result.reason)}`);
            }
            lines.push('');
        }

        return lines.join('\n');
    };
}

/**
 * Execute a single batched subagent with timeout/cancellation management.
 * Mirrors the execution logic from RunSubagentTool.execute() but without
 * the budget validation (already done at enqueue time).
 */
async function executeBatchedSubagent(
    entry: QueuedSubagent,
    executor: SubagentExecutor,
    sessionManager: SubagentSessionManager,
    recursiveState: RecursiveStateManager | undefined,
    executionContext: ExecutionContext,
    parentToken: vscode.CancellationToken,
    fallbackTimeoutMs: number
): Promise<string> {
    const timeoutMs =
        entry.childBudget !== undefined
            ? Math.max(
                  RecursionConstants.MIN_SUBAGENT_TIMEOUT_MS,
                  entry.childBudget *
                      RecursionConstants.TIMEOUT_PER_ITERATION_MS
              )
            : fallbackTimeoutMs;

    const cancellationTokenSource = new vscode.CancellationTokenSource();
    const parentCancellationDisposable =
        sessionManager.registerSubagentCancellation(cancellationTokenSource);
    let cancelledByTimeout = false;
    const timeoutHandle = setTimeout(() => {
        cancelledByTimeout = true;
        cancellationTokenSource.cancel();
    }, timeoutMs);

    try {
        const result = await executor.execute(
            { task: entry.task, context: entry.taskContext },
            cancellationTokenSource.token,
            entry.subagentId,
            {
                recursionDepth: 1,
                agentId: entry.childAgentId,
                recursiveState,
                parsedDiff: executionContext.parsedDiff,
                subagentSessionManager: sessionManager,
                childBudget: entry.childBudget,
            }
        );

        clearTimeout(timeoutHandle);

        // Update recursive state with results
        if (recursiveState && entry.childAgentId) {
            const filesExamined = RunSubagentTool.extractFilesExamined(
                result.toolCalls,
                executionContext.parsedDiff
            );
            if (result.success) {
                recursiveState.completeAgent(
                    entry.childAgentId,
                    [],
                    filesExamined
                );
            } else if (result.error === 'cancelled') {
                recursiveState.cancelAgent(entry.childAgentId);
            } else if (
                result.error === 'max_iterations' ||
                result.error === 'rate_limited'
            ) {
                recursiveState.completeAgent(
                    entry.childAgentId,
                    [],
                    filesExamined
                );
            } else {
                recursiveState.failAgent(
                    entry.childAgentId,
                    result.error ?? 'Unknown error'
                );
            }
        }

        if (!result.success) {
            if (result.error === 'cancelled') {
                if (
                    cancelledByTimeout &&
                    !parentToken.isCancellationRequested
                ) {
                    return `Subagent #${entry.subagentId} timed out after ${Math.round(timeoutMs / 1000)}s`;
                }
                return `Subagent #${entry.subagentId} was cancelled`;
            }
            const partial = result.response?.trim();
            const errorMsg = `Subagent #${entry.subagentId} failed: ${result.error}`;
            return partial
                ? `${errorMsg}\n\nPartial findings:\n${partial}`
                : errorMsg;
        }

        return (
            `**Subagent #${entry.subagentId} Investigation Complete**\n\n` +
            `**Tool calls made:** ${result.toolCallsMade}\n\n` +
            `---\n\n${result.response}`
        );
    } catch (error) {
        clearTimeout(timeoutHandle);

        if (recursiveState && entry.childAgentId) {
            if (isCancellationError(error)) {
                recursiveState.cancelAgent(entry.childAgentId);
            } else {
                recursiveState.failAgent(
                    entry.childAgentId,
                    getErrorMessage(error)
                );
            }
        }

        if (isCancellationError(error)) {
            throw error;
        }

        if (cancelledByTimeout && !parentToken.isCancellationRequested) {
            return `Subagent #${entry.subagentId} timed out after ${Math.round(timeoutMs / 1000)}s`;
        }

        sessionManager.rollbackSpawn();
        return `Subagent #${entry.subagentId} failed: ${getErrorMessage(error)}`;
    } finally {
        parentCancellationDisposable?.dispose();
        cancellationTokenSource.dispose();
    }
}
