import * as vscode from 'vscode';
import { ConversationManager } from '../models/conversationManager';
import { ToolExecutor } from '../models/toolExecutor';
import { ToolRegistry } from '../models/toolRegistry';
import { PromptGenerator } from '../models/promptGenerator';
import { TokenValidator } from '../models/tokenValidator';
import {
    ConversationRunner,
    type ToolCallHandler,
    type ExitReason,
} from '../models/conversationRunner';
import type { ToolCallRecord } from '../types/toolCallTypes';
import type { DiffHunk } from '../types/contextTypes';
import type { RecordedFinding } from '../types/findingTypes';
import { Log } from './loggingService';
import { isCancellationError } from '../utils/asyncUtils';
import { getErrorMessage } from '../utils/errorUtils';
import { WorkspaceSettingsService } from './workspaceSettingsService';
import { SubagentSessionManager } from './subagentSessionManager';
import { SubagentExecutor } from './subagentExecutor';
import { SubagentPromptGenerator } from '../prompts/subagentPromptGenerator';
import { PlanSessionManager } from './planSessionManager';
import { RecursiveStateManager } from '../sessions/recursiveStateManager';
import { FindingStore } from '../sessions/findingStore';
import { ReasoningChain } from '../sessions/reasoningChain';
import type { DiffEnricher } from './diffEnricher';
import type { FindingValidator } from './findingValidator';
import { INVESTIGATION_TOOLS } from '../models/toolConstants';
import type { ExecutionContext } from '../types/executionContext';
import { getCalibrationProfile } from '../models/modelCalibration';
import { PostAnalysisPipeline } from './postAnalysisPipeline';
import { type SelfReflectionScore } from './selfReflectionScorer';
import type { StepRecord } from './pipeline/pipelineTypes';
import type { ILLMClient } from '../models/ILLMClient';
import type { ChatToolCallHandler } from '../types/chatTypes';

export interface ModelInfo {
    family: string;
    id: string;
    name: string;
    maxInputTokens: number;
}

export interface AnalysisEngineInput {
    parsedDiff: DiffHunk[];
    llmClient: ILLMClient;
    model: ModelInfo;
    token: vscode.CancellationToken;
    userPromptSuffix: string | undefined;
    chatHandler: ChatToolCallHandler | undefined;
}

export interface AnalysisEngineOutput {
    onProgress(message: string, increment?: number): void;
    onAgentProgress?(
        completed: number,
        total: number,
        running: number,
        turn: number,
        maxTurns: number
    ): void;
    onToolCallStart?(
        toolName: string,
        args: Record<string, unknown>,
        toolIndex: number,
        totalTools: number
    ): void;
    onToolCallComplete?(record: ToolCallRecord): void;
    onIterationStart?(current: number, max: number): void;
}

export interface AnalysisEngineResult {
    analysisText: string;
    toolCallRecords: ToolCallRecord[];
    completed: boolean;
    wasCancelled: boolean;
    error: string | undefined;
    iterationsUsed: number | undefined;
    selfReflectionScores: SelfReflectionScore[];
    filesAnalyzed: number;
    stepRecords: StepRecord[];
    findings: RecordedFinding[];
    wasTruncated: boolean;
}

/**
 * Orchestrates the entire analysis process, including managing the conversation loop,
 * invoking tools, and interacting with the LLM.
 *
 * This class is designed to be concurrent-safe. All per-analysis state is created
 * locally within the analyze() method, allowing multiple concurrent analyses.
 */
export class AnalysisEngine implements vscode.Disposable {
    constructor(
        private readonly toolRegistry: ToolRegistry,
        private readonly promptGenerator: PromptGenerator,
        private readonly workspaceSettings: WorkspaceSettingsService,
        private readonly diffEnricher: DiffEnricher,
        private readonly findingValidator: FindingValidator
    ) {}

    private get maxIterations(): number {
        return this.workspaceSettings.getMaxIterations();
    }

    /**
     * Analyze a diff using the LLM with tool-calling capabilities.
     *
     * This method is concurrent-safe: all per-analysis state is created locally,
     * allowing multiple analyses to run in parallel without interference.
     */
    async analyze(
        input: AnalysisEngineInput,
        output: AnalysisEngineOutput
    ): Promise<AnalysisEngineResult> {
        // === Per-analysis state (local for concurrent-safety) ===
        const toolCallRecords: ToolCallRecord[] = [];
        let currentIteration = 0;
        let currentMaxIterations = this.maxIterations;

        // Create per-analysis instances for complete isolation
        const conversationManager = new ConversationManager();
        const planManager = new PlanSessionManager();
        const subagentSessionManager = new SubagentSessionManager(
            this.workspaceSettings
        );

        // Determine analysis approach and recursive mode early — needed for SubagentExecutor setup.
        const maxRecursionDepth = this.workspaceSettings.getMaxRecursionDepth();
        const isRecursiveMode = maxRecursionDepth >= 1;

        // Only pass onAgentProgress in recursive mode — it signals SubagentExecutor
        // to suppress text-based progress in favor of structured agent progress.
        // In non-recursive mode, text progress via progressCallback is the only channel.
        const subagentExecutor = new SubagentExecutor(
            input.llmClient,
            this.toolRegistry,
            new SubagentPromptGenerator(),
            this.workspaceSettings,
            input.chatHandler,
            (msg, inc) => output.onProgress(msg, inc),
            isRecursiveMode && output.onAgentProgress
                ? (completed, total, running) =>
                      output.onAgentProgress!(
                          completed,
                          total,
                          running,
                          currentIteration,
                          currentMaxIterations
                      )
                : undefined
        );

        // Create RecursiveStateManager when in recursive mode
        const recursiveState = isRecursiveMode
            ? new RecursiveStateManager(maxRecursionDepth)
            : undefined;

        const findingStore = new FindingStore();

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

        // Create execution context as a mutable reference so parsedDiff and
        // calibrationProfile can be set after model resolution.
        // Type assertion needed because calibrationProfile/toolCallCounts are
        // populated later (calibrationProfile after model resolution,
        // toolCallCounts by ToolExecutor constructor).
        const executionContext = {
            planManager,
            subagentSessionManager,
            subagentExecutor,
            cancellationToken: input.token,
            recursiveState,
            currentDepth: 0,
            currentAgentId: 'root',
            findingStore,
            reasoningChain: new ReasoningChain(),
            toolCallCounts: new Map<string, number>(),
            investigatedFiles: new Set<string>(),
        } as ExecutionContext;

        const toolExecutor = new ToolExecutor(
            this.toolRegistry,
            executionContext
        );
        toolExecutor.bindToContext();
        executionContext.toolExecutor = toolExecutor;
        const conversationRunner = new ConversationRunner(
            input.llmClient,
            toolExecutor
        );

        let analysisCompleted = false;
        let analysisError: string | undefined;
        let analysisText = '';
        let filesAnalyzed = 0;
        let selfReflectionScores: SelfReflectionScore[] = [];
        let stepRecords: StepRecord[] = [];
        let mainAnalysisWasCancelled = false;
        let mainAnalysisIterationsUsed = 0;
        let wasTruncated = false;
        let mainAnalysisDegraded = false;
        let mainAnalysisExitReason: ExitReason | undefined;
        let mainAnalysisHitQuotaExhausted = false;
        let mainAnalysisHitRateLimit = false;
        let mainAnalysisHitMaxIterations = false;
        let mainAnalysisFinished = false;
        let pipelineWasCancelled = false;

        try {
            Log.info('Starting analysis with tool-calling support');
            output.onProgress('Initializing analysis...', 0.5);
            subagentSessionManager.setParentCancellationToken(input.token);

            // Parse diff for structured analysis (reuse pre-parsed if provided)
            output.onProgress('Processing diff...', 0.5);
            const parsedDiff = input.parsedDiff;
            filesAnalyzed = parsedDiff.length;

            Log.info(
                `Tools always enabled, ${parsedDiff.length} files via diff tools`
            );

            // Enrich changed symbols with LSP metadata for the Code Intelligence Brief
            output.onProgress('Building code intelligence brief...', 0.5);
            const codeIntelBrief = await this.diffEnricher.enrich(
                parsedDiff,
                input.token
            );
            Log.info(
                `Code intelligence brief: ${codeIntelBrief.enrichedSymbols.length} symbols, ${codeIntelBrief.timeoutCount} timeouts`
            );

            // Resolve model and calibration profile before prompt generation
            Log.info(
                `Using model: ${input.model.name} (${input.model.id}, ${input.model.maxInputTokens} tokens)`
            );

            const calibrationProfile = getCalibrationProfile(
                input.model.family,
                input.model.id
            );
            executionContext.calibrationProfile = calibrationProfile;
            Log.info(
                `Model calibration: using '${calibrationProfile.name}' profile (bias: ${calibrationProfile.findingBias})`
            );

            // Get available tools and generate system prompt
            const availableTools = toolExecutor.getAvailableTools();
            const systemPrompt = isRecursiveMode
                ? this.promptGenerator.generateRecursiveSystemPrompt(
                      calibrationProfile
                  )
                : this.promptGenerator.generateToolAwareSystemPrompt(
                      calibrationProfile
                  );

            // Generate user prompt
            executionContext.parsedDiff = parsedDiff;
            const userMessage = this.promptGenerator.generateUserPrompt(
                parsedDiff,
                input.userPromptSuffix,
                isRecursiveMode,
                this.workspaceSettings.getMaxSubagentsPerSession(),
                codeIntelBrief
            );

            conversationManager.addUserMessage(userMessage);
            output.onProgress('Starting conversation with AI model...', 0.5);

            const chatModel = await input.llmClient.getCurrentModel();
            const tokenValidator = new TokenValidator(chatModel);

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
                    const usagePercent = Math.min(
                        100,
                        Math.round(
                            (validation.totalTokens / validation.maxTokens) *
                                100
                        )
                    );
                    const remainingK = Math.max(
                        0,
                        Math.round(
                            (validation.maxTokens - validation.totalTokens) /
                                1000
                        )
                    );

                    let suffix = '';
                    if (usagePercent >= 90) {
                        suffix = `\n\n⚠️ [ctx: ${usagePercent}% | ${remainingK}k remaining — wrap up NOW]`;
                    } else if (usagePercent >= 70) {
                        suffix = `\n\n[ctx: ${usagePercent}% | ${remainingK}k remaining]`;
                    }

                    // Periodic FindingStore reminder for dismissive models at parent level.
                    // GPT-4.1 loses prosecution instructions after many subagent results;
                    // re-inject a reminder of recorded findings every 5 iterations.
                    if (
                        calibrationProfile.findingBias === 'dismissive' &&
                        currentIteration > 0 &&
                        currentIteration % 5 === 0 &&
                        findingStore.size > 0
                    ) {
                        const findings = findingStore.getAll();
                        const findingSummary = findings
                            .map(
                                (f) =>
                                    `[${f.id}] ${f.severity}: ${f.title} (${f.file})`
                            )
                            .join('; ');
                        suffix +=
                            `\n\n📋 REMINDER: ${findingStore.size} finding(s) recorded so far: ${findingSummary}. ` +
                            'These MUST appear in your final review or be explicitly retracted.';
                    }

                    return suffix;
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
                    output.onIterationStart?.(current, max);
                },
                onToolCallStart: (toolName, args, toolIndex, totalTools) => {
                    output.onToolCallStart?.(
                        toolName,
                        args,
                        toolIndex,
                        totalTools
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
                    const record: ToolCallRecord = {
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
                    };
                    toolCallRecords.push(record);
                    output.onToolCallComplete?.(record);
                },
                getContextStatusSuffix,
            };

            // Shared mutable set: the afterToolCalls callback adds investigation
            // tool names after the first subagent round, and the runner reads it
            // each iteration to filter the tool list.
            const disabledToolNames = new Set<string>();

            // Apply model-specific tool filtering from calibration profile.
            // Research shows fewer tools = better selection accuracy for GPT-4.1.
            for (const tool of calibrationProfile.disabledTools) {
                disabledToolNames.add(tool);
            }

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
                },
                conversationManager,
                input.token,
                handler
            );
            mainAnalysisFinished = true;
            mainAnalysisWasCancelled = conversationRunner.wasCancelled;
            mainAnalysisIterationsUsed = conversationRunner.iterationsUsed;
            mainAnalysisDegraded = conversationRunner.degraded;
            mainAnalysisExitReason = conversationRunner.exitReason;
            mainAnalysisHitQuotaExhausted =
                conversationRunner.hitQuotaExhausted;
            mainAnalysisHitRateLimit = conversationRunner.hitRateLimit;
            mainAnalysisHitMaxIterations = conversationRunner.hitMaxIterations;
            analysisCompleted =
                !mainAnalysisWasCancelled &&
                !mainAnalysisHitQuotaExhausted &&
                !mainAnalysisHitRateLimit &&
                !mainAnalysisDegraded;
            wasTruncated =
                !mainAnalysisWasCancelled &&
                (mainAnalysisHitMaxIterations ||
                    (mainAnalysisDegraded &&
                        !mainAnalysisHitQuotaExhausted &&
                        !mainAnalysisHitRateLimit));
            const shouldRunPipeline =
                !mainAnalysisWasCancelled &&
                !mainAnalysisHitQuotaExhausted &&
                !mainAnalysisHitRateLimit &&
                (analysisCompleted || findingStore.size > 0);

            if (shouldRunPipeline) {
                if (wasTruncated) {
                    Log.info(
                        `Analysis truncated — running post-analysis pipeline on ${findingStore.size} recorded findings`
                    );
                }

                const pipeline = new PostAnalysisPipeline(
                    this.findingValidator
                );
                const pipelineResult = await pipeline.run({
                    findingStore,
                    toolCallRecords,
                    initialAnalysisText: analysisText,
                    executionContext,
                    parsedDiff,
                    calibrationProfile,
                    subagentExecutor,
                    conversationManager,
                    conversationRunner,
                    systemPrompt,
                    availableTools,
                    disabledToolNames,
                    handler,
                    progressCallback: (msg, inc) => output.onProgress(msg, inc),
                });

                toolCallRecords.push(
                    ...pipelineResult.additionalToolCallRecords
                );
                if (pipelineResult.rewrittenAnalysis) {
                    analysisText = pipelineResult.rewrittenAnalysis;
                }

                selfReflectionScores = pipelineResult.selfReflectionScores;
                stepRecords = pipelineResult.stepRecords;
                pipelineWasCancelled = conversationRunner.wasCancelled;

                output.onProgress(
                    `Analysis complete (${toolCallRecords.length} tool calls)`,
                    2
                );
                if (wasTruncated) {
                    Log.info(
                        'Analysis truncated — post-analysis pipeline run on recorded findings'
                    );
                } else {
                    Log.info('Analysis completed successfully');
                }
            } else if (
                mainAnalysisHitQuotaExhausted ||
                mainAnalysisHitRateLimit
            ) {
                Log.warn(
                    'Analysis ended due to API quota or rate limit exhaustion'
                );
            } else if (mainAnalysisDegraded) {
                Log.warn(
                    `Analysis ended in degraded state: ${mainAnalysisExitReason ?? 'degraded'}`
                );
            } else if (mainAnalysisWasCancelled) {
                Log.info('Analysis was cancelled by user');
            }
        } catch (error) {
            if (isCancellationError(error)) {
                // Distinguish main-analysis cancellation from pipeline
                // cancellation to preserve snapshot invariants.
                if (mainAnalysisFinished) {
                    pipelineWasCancelled = true;
                } else {
                    mainAnalysisWasCancelled = true;
                }
                throw error;
            }
            analysisError = getErrorMessage(error);
            // Only mark as not-completed if the main analysis itself failed.
            // If the main analysis succeeded but the post-analysis pipeline
            // failed, preserve the completed state so consumers can tell
            // the difference.
            if (!mainAnalysisFinished) {
                analysisCompleted = false;
            }
            const errorMessage = `Error during analysis: ${analysisError}`;
            Log.error(errorMessage, error);
            // Preserve existing analysis text so partial findings are not
            // hidden from consumers (chat UI, webview) on pipeline errors.
            if (!analysisText || analysisText.trim().length === 0) {
                analysisText = errorMessage;
            }
        } finally {
            // Clear parent cancellation token to release references
            subagentSessionManager.setParentCancellationToken(undefined);
            // Complete root agent lifecycle in recursive state tree.
            // Order matters: error > cancelled > quota/rate-limit > degraded > complete.
            // Cancellation takes precedence over degraded/quota because a user
            // may cancel during the post-analysis pipeline.
            // Max-iterations without degradation intentionally falls through to
            // completeAgent because the analysis succeeded — it was merely cut
            // short by the iteration budget.
            // Use mainAnalysis* snapshots because the pipeline may have called
            // conversationRunner.run() again, resetting the runner's flags.
            if (recursiveState) {
                if (analysisError) {
                    recursiveState.failAgent('root', analysisError);
                } else if (mainAnalysisWasCancelled || pipelineWasCancelled) {
                    recursiveState.cancelAgent('root');
                } else if (
                    mainAnalysisHitQuotaExhausted ||
                    mainAnalysisHitRateLimit
                ) {
                    recursiveState.completeAgent('root');
                } else if (mainAnalysisDegraded) {
                    recursiveState.failAgent(
                        'root',
                        mainAnalysisExitReason ?? 'degraded'
                    );
                } else {
                    recursiveState.completeAgent('root');
                }
            }
        }

        return {
            analysisText,
            toolCallRecords: [...toolCallRecords],
            completed: analysisCompleted,
            wasCancelled: mainAnalysisWasCancelled || pipelineWasCancelled,
            error: analysisError,
            iterationsUsed: mainAnalysisIterationsUsed,
            selfReflectionScores,
            filesAnalyzed,
            stepRecords,
            findings: findingStore.getAll(),
            wasTruncated,
        };
    }

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
            if (!toolNames.includes('run_subagent_batch')) {
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
            // Check for specific investigation tools rather than set size, since
            // calibration profiles may pre-populate disabledToolNames.
            if (!disabledToolNames.has(INVESTIGATION_TOOLS[0])) {
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

    dispose(): void {
        // No resources to dispose of currently
    }
}
