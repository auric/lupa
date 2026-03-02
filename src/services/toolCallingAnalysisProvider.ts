import * as vscode from 'vscode';
import { ConversationManager } from '../models/conversationManager';
import { ToolExecutor } from '../models/toolExecutor';
import { ToolRegistry } from '../models/toolRegistry';
import { CopilotModelManager } from '../models/copilotModelManager';
import { PromptGenerator } from '../models/promptGenerator';
import { TokenValidator } from '../models/tokenValidator';
import {
    ConversationRunner,
    type ToolCallHandler,
} from '../models/conversationRunner';
import type {
    ToolCallRecord,
    ToolCallingAnalysisResult,
    AnalysisProgressCallback,
    SubagentProgressContext,
} from '../types/toolCallTypes';
import { DiffUtils } from '../utils/diffUtils';
import type { DiffHunk } from '../types/contextTypes';
import { Log } from './loggingService';
import { isCancellationError } from '../utils/asyncUtils';
import { getErrorMessage } from '../utils/errorUtils';
import { WorkspaceSettingsService } from './workspaceSettingsService';
import { SubagentSessionManager } from './subagentSessionManager';
import { SubagentExecutor } from './subagentExecutor';
import { SubagentPromptGenerator } from '../prompts/subagentPromptGenerator';
import { PlanSessionManager } from './planSessionManager';
import {
    RecursiveStateManager,
    RecursionConstants,
} from '../sessions/recursiveStateManager';
import {
    SubagentBatchManager,
    type QueuedSubagent,
} from '../sessions/subagentBatchManager';
import { INVESTIGATION_TOOLS } from '../models/toolConstants';
import { RunSubagentTool } from '../tools/runSubagentTool';
import type { ExecutionContext } from '../types/executionContext';

/**
 * Orchestrates the entire analysis process, including managing the conversation loop,
 * invoking tools, and interacting with the LLM.
 *
 * This class is designed to be concurrent-safe. All per-analysis state is created
 * locally within the analyze() method, allowing multiple concurrent analyses.
 */
export class ToolCallingAnalysisProvider {
    constructor(
        private toolRegistry: ToolRegistry,
        private copilotModelManager: CopilotModelManager,
        private promptGenerator: PromptGenerator,
        private workspaceSettings: WorkspaceSettingsService
    ) {}

    private get maxIterations(): number {
        return this.workspaceSettings.getMaxIterations();
    }

    /**
     * Analyze a diff using the LLM with tool-calling capabilities.
     *
     * This method is concurrent-safe: all per-analysis state is created locally,
     * allowing multiple analyses to run in parallel without interference.
     *
     * @param diff The diff content to analyze
     * @param token Cancellation token
     * @param progressCallback Optional callback for reporting progress to UI
     * @returns Promise resolving to the analysis result with tool call history
     */
    async analyze(
        diff: string,
        token: vscode.CancellationToken,
        progressCallback?: AnalysisProgressCallback
    ): Promise<ToolCallingAnalysisResult> {
        // === Per-analysis state (local for concurrent-safety) ===
        const toolCallRecords: ToolCallRecord[] = [];
        let currentIteration = 0;
        let currentMaxIterations = this.maxIterations;

        // Create progress context that captures local variables
        const progressContext: SubagentProgressContext = {
            getCurrentIteration: () => currentIteration,
            getMaxIterations: () => currentMaxIterations,
        };

        // Create per-analysis instances for complete isolation
        const conversationManager = new ConversationManager();
        const planManager = new PlanSessionManager();
        const subagentSessionManager = new SubagentSessionManager(
            this.workspaceSettings
        );
        const subagentExecutor = new SubagentExecutor(
            this.copilotModelManager,
            this.toolRegistry,
            new SubagentPromptGenerator(),
            this.workspaceSettings,
            undefined, // No chat handler in command context
            progressCallback,
            progressContext
        );

        // Determine analysis approach and recursive mode.
        const maxRecursionDepth = this.workspaceSettings.getMaxRecursionDepth();
        const isRecursiveMode = maxRecursionDepth >= 1;

        // Create RecursiveStateManager when in recursive mode
        const recursiveState = isRecursiveMode
            ? new RecursiveStateManager(maxRecursionDepth)
            : undefined;

        // Wire recursive state to SubagentExecutor for aggregate progress reporting
        if (recursiveState) {
            subagentExecutor.setRecursiveState(recursiveState);
        }

        // Register root agent in recursive state tree
        if (recursiveState) {
            recursiveState.registerAgent(
                undefined,
                'Root review controller',
                this.maxIterations
            );
            recursiveState.startAgent('root');
        }

        // Create batch manager for accumulating subagent calls across iterations.
        // Only in recursive mode (which has subagents) and when the setting is enabled.
        const batchManager =
            isRecursiveMode &&
            this.workspaceSettings.getEnableSubagentBatching()
                ? new SubagentBatchManager()
                : undefined;

        // Create execution context as a mutable reference so parsedDiff can be
        // set after diff processing
        const executionContext: ExecutionContext = {
            planManager,
            subagentSessionManager,
            subagentExecutor,
            cancellationToken: token,
            recursiveState,
            currentDepth: 0,
            currentAgentId: 'root',
            subagentBatchManager: batchManager,
        };

        const toolExecutor = new ToolExecutor(
            this.toolRegistry,
            executionContext
        );
        const conversationRunner = new ConversationRunner(
            this.copilotModelManager,
            toolExecutor
        );

        let analysisCompleted = false;
        let analysisError: string | undefined;
        let analysisText = '';
        let toolCallCount = 0;

        try {
            Log.info('Starting analysis with tool-calling support');
            progressCallback?.('Initializing analysis...', 0.5);
            subagentSessionManager.setParentCancellationToken(token);

            // Parse diff for structured analysis
            progressCallback?.('Processing diff...', 0.5);
            const parsedDiff = DiffUtils.parseDiff(diff);

            Log.info(
                `Tools always enabled, ${parsedDiff.length} files via diff tools`
            );

            // Get available tools and generate system prompt
            const availableTools = toolExecutor.getAvailableTools();
            const systemPrompt = isRecursiveMode
                ? this.promptGenerator.generateRecursiveSystemPrompt()
                : this.promptGenerator.generateToolAwareSystemPrompt();

            // Generate user prompt
            executionContext.parsedDiff = parsedDiff;
            const userMessage = this.promptGenerator.generateUserPrompt(
                parsedDiff,
                undefined,
                isRecursiveMode,
                this.workspaceSettings.getMaxSubagentsPerSession()
            );

            conversationManager.addUserMessage(userMessage);
            progressCallback?.('Starting conversation with AI model...', 0.5);

            // Create token validator for this analysis
            const model = await this.copilotModelManager.getCurrentModel();
            Log.info(
                `Using model: ${model.name} (${model.vendor}/${model.id}, ${model.maxInputTokens} tokens)`
            );
            const tokenValidator = new TokenValidator(model);

            // Create context status function that captures local state
            const getContextStatusSuffix = async (): Promise<string> => {
                try {
                    const messages = conversationManager
                        .getHistory()
                        .map((msg) => ({
                            role: msg.role,
                            content: msg.content,
                            toolCalls: msg.toolCalls,
                            toolCallId: msg.toolCallId,
                        }));

                    const validation = await tokenValidator.validateTokens(
                        messages,
                        systemPrompt
                    );
                    const usagePercent = Math.round(
                        (validation.totalTokens / validation.maxTokens) * 100
                    );
                    const remainingK = Math.round(
                        (validation.maxTokens - validation.totalTokens) / 1000
                    );

                    if (usagePercent >= 90) {
                        return `\n\n⚠️ [ctx: ${usagePercent}% | ${remainingK}k remaining — wrap up NOW]`;
                    } else if (usagePercent >= 70) {
                        return `\n\n[ctx: ${usagePercent}% | ${remainingK}k remaining]`;
                    }
                    return '';
                } catch (error) {
                    Log.error('Error calculating context status:', error);
                    return '';
                }
            };

            // Create handler to record tool calls and track iteration for subagent context
            const handler: ToolCallHandler = {
                onIterationStart: (current, max) => {
                    currentIteration = current;
                    currentMaxIterations = max;
                    progressCallback?.(
                        `Turn ${current}/${max}: Analyzing...`,
                        0.2
                    );
                },
                onToolCallComplete: (
                    toolCallId,
                    toolName,
                    args,
                    result,
                    success,
                    error,
                    durationMs,
                    metadata
                ) => {
                    toolCallCount++;
                    toolCallRecords.push({
                        id: toolCallId,
                        toolName,
                        arguments: args,
                        result,
                        success,
                        error,
                        durationMs: durationMs ?? 0,
                        timestamp: Date.now(),
                        nestedCalls: metadata?.nestedToolCalls,
                        executionTimeMs: metadata?.executionTimeMs,
                        iterationsUsed: metadata?.iterationsUsed,
                    });
                },
                getContextStatusSuffix,
            };

            // Shared mutable set: the afterToolCalls callback adds investigation
            // tool names after the first subagent round, and the runner reads it
            // each iteration to filter the tool list.
            const disabledToolNames = new Set<string>();

            // Run conversation loop using extracted ConversationRunner
            analysisText = await conversationRunner.run(
                {
                    systemPrompt,
                    maxIterations: this.maxIterations,
                    tools: availableTools,
                    label: 'Main Analysis',
                    requiresExplicitCompletion: true,
                    afterToolCalls: this.createCoverageGapCallback(
                        recursiveState,
                        parsedDiff,
                        disabledToolNames,
                        subagentSessionManager
                    ),
                    disabledToolNames,
                    flushBatchedSubagents: batchManager
                        ? this.createFlushBatchCallback(
                              batchManager,
                              subagentExecutor,
                              subagentSessionManager,
                              recursiveState,
                              executionContext,
                              token
                          )
                        : undefined,
                },
                conversationManager,
                token,
                handler
            );
            analysisCompleted = !conversationRunner.wasCancelled;

            if (analysisCompleted) {
                progressCallback?.(
                    `Analysis complete (${toolCallCount} tool calls)`,
                    2
                );
                Log.info('Analysis completed successfully');
            } else {
                Log.info('Analysis was cancelled by user');
            }
        } catch (error) {
            if (isCancellationError(error)) {
                throw error;
            }
            analysisError = getErrorMessage(error);
            const errorMessage = `Error during analysis: ${analysisError}`;
            Log.error(errorMessage, error);
            analysisText = errorMessage;
        } finally {
            // Clear parent cancellation token to release references
            subagentSessionManager.setParentCancellationToken(undefined);
            // Complete root agent lifecycle in recursive state tree
            if (recursiveState) {
                if (analysisCompleted) {
                    recursiveState.completeAgent('root');
                } else if (analysisError) {
                    recursiveState.failAgent('root', analysisError);
                } else {
                    recursiveState.cancelAgent('root');
                }
            }
        }

        return this.buildAnalysisResult(
            toolCallRecords,
            analysisText,
            analysisCompleted,
            analysisError,
            conversationRunner.wasCancelled,
            conversationRunner.iterationsUsed
        );
    }

    /**
     * Creates a callback that injects coverage gap messages after subagent rounds.
     * When subagents complete, reports which files haven't been examined yet,
     * prompting the root agent to spawn additional subagents for uncovered files.
     */
    private createCoverageGapCallback(
        recursiveState: RecursiveStateManager | undefined,
        parsedDiff: DiffHunk[],
        disabledToolNames: Set<string>,
        sessionManager: SubagentSessionManager
    ): ((toolNames: string[]) => string | undefined) | undefined {
        if (!recursiveState || parsedDiff.length === 0) {
            return undefined;
        }

        const allFiles = parsedDiff.map((d) => d.filePath);

        return (toolNames: string[]) => {
            if (!toolNames.includes('run_subagent')) {
                return undefined;
            }

            // If subagent budget is exhausted, re-enable investigation tools
            // so the root can directly examine uncovered files.
            if (!sessionManager.canSpawn()) {
                for (const tool of INVESTIGATION_TOOLS) {
                    disabledToolNames.delete(tool);
                }
                return recursiveState.getCoverageGapFallbackMessage(allFiles);
            }

            // After first subagent round, disable investigation tools for the root.
            // The root is a controller — it delegates, not investigates.
            if (disabledToolNames.size === 0) {
                for (const tool of INVESTIGATION_TOOLS) {
                    disabledToolNames.add(tool);
                }
                Log.info(
                    'Root agent investigation tools disabled after first subagent round'
                );
            }

            return recursiveState.getCoverageGapMessage(allFiles);
        };
    }

    private buildAnalysisResult(
        toolCallRecords: ToolCallRecord[],
        analysis: string,
        completed: boolean,
        error: string | undefined,
        wasCancelled: boolean,
        iterationsUsed?: number
    ): ToolCallingAnalysisResult {
        const successfulCalls = toolCallRecords.filter((r) => r.success).length;
        const failedCalls = toolCallRecords.filter((r) => !r.success).length;

        return {
            analysis,
            toolCalls: {
                calls: [...toolCallRecords],
                totalCalls: toolCallRecords.length,
                successfulCalls,
                failedCalls,
                analysisCompleted: completed,
                analysisError: error,
                iterationsUsed,
                maxIterations: this.maxIterations,
            },
            wasCancelled,
        };
    }

    /**
     * Create a callback that flushes batched subagent tasks for parallel execution.
     * Returns undefined (no-op) if there are no pending tasks or the model is still
     * accumulating (current iteration had run_subagent calls).
     */
    private createFlushBatchCallback(
        batchManager: SubagentBatchManager,
        subagentExecutor: SubagentExecutor,
        sessionManager: SubagentSessionManager,
        recursiveState: RecursiveStateManager | undefined,
        executionContext: ExecutionContext,
        parentToken: vscode.CancellationToken
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
                    this.executeBatchedSubagent(
                        entry,
                        subagentExecutor,
                        sessionManager,
                        recursiveState,
                        executionContext,
                        parentToken
                    )
                )
            );

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
    private async executeBatchedSubagent(
        entry: QueuedSubagent,
        executor: SubagentExecutor,
        sessionManager: SubagentSessionManager,
        recursiveState: RecursiveStateManager | undefined,
        executionContext: ExecutionContext,
        parentToken: vscode.CancellationToken
    ): Promise<string> {
        const timeoutMs =
            entry.childBudget !== undefined
                ? Math.max(
                      RecursionConstants.MIN_SUBAGENT_TIMEOUT_MS,
                      entry.childBudget *
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

    dispose(): void {
        // No resources to dispose of currently
    }
}
