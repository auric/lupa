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
import { RecursiveStateManager } from '../sessions/recursiveStateManager';
import { FindingStore } from '../sessions/findingStore';
import { AdversarialPromptGenerator } from '../prompts/adversarialPromptGenerator';
import type { DiffEnricher } from './diffEnricher';
import type { FindingValidator, ValidatedFinding } from './findingValidator';
import type { RecordedFinding, FindingSeverity } from '../types/findingTypes';
import { FINDING_SEVERITIES } from '../types/findingTypes';

import { INVESTIGATION_TOOLS } from '../models/toolConstants';
import type { ExecutionContext } from '../types/executionContext';
import { getCalibrationProfile } from '../models/modelCalibration';

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
        private workspaceSettings: WorkspaceSettingsService,
        private diffEnricher: DiffEnricher,
        private findingValidator: FindingValidator
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
            cancellationToken: token,
            recursiveState,
            currentDepth: 0,
            currentAgentId: 'root',
            findingStore,
            toolCallCounts: new Map<string, number>(),
        } as ExecutionContext;

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

            // Enrich changed symbols with LSP metadata for the Code Intelligence Brief
            progressCallback?.('Building code intelligence brief...', 0.5);
            const codeIntelBrief = await this.diffEnricher.enrich(
                parsedDiff,
                token
            );
            Log.info(
                `Code intelligence brief: ${codeIntelBrief.enrichedSymbols.length} symbols, ${codeIntelBrief.timeoutCount} timeouts`
            );

            // Resolve model and calibration profile before prompt generation
            const model = await this.copilotModelManager.getCurrentModel();
            Log.info(
                `Using model: ${model.name} (${model.vendor}/${model.id}, ${model.maxInputTokens} tokens)`
            );

            const calibrationProfile = getCalibrationProfile(
                model.family,
                model.id
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
                undefined,
                isRecursiveMode,
                this.workspaceSettings.getMaxSubagentsPerSession(),
                codeIntelBrief
            );

            conversationManager.addUserMessage(userMessage);
            progressCallback?.('Starting conversation with AI model...', 0.5);

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
                },
                conversationManager,
                token,
                handler
            );
            analysisCompleted = !conversationRunner.wasCancelled;

            if (analysisCompleted) {
                // Post-analysis: validate findings programmatically
                const findings = findingStore.getAll();
                if (findings.length > 0 && executionContext.parsedDiff) {
                    progressCallback?.('Validating findings...', 0.5);
                    const validation = await this.findingValidator.validate(
                        findings,
                        executionContext.parsedDiff,
                        token
                    );

                    // Apply validation results to FindingStore
                    this.applyValidationResults(
                        validation.validated,
                        findingStore
                    );

                    if (validation.dropped > 0 || validation.downgraded > 0) {
                        Log.info(
                            `FindingValidator: ${validation.kept} kept, ${validation.downgraded} downgraded, ${validation.dropped} dropped`
                        );

                        // Append validation summary to analysis text
                        analysisText += this.formatValidationSummary(
                            validation.validated
                        );
                    }

                    // Adversarial verification for findings at or above the calibration threshold
                    const threshold =
                        executionContext.calibrationProfile
                            .adversarialVerificationThreshold;
                    const findingsToVerify = this.getFindingsAtOrAboveSeverity(
                        findingStore,
                        threshold
                    );
                    if (
                        findingsToVerify.length > 0 &&
                        !token.isCancellationRequested
                    ) {
                        progressCallback?.(
                            `Adversarial verification of ${findingsToVerify.length} finding(s)...`,
                            0.5
                        );
                        const adversarialResults =
                            await this.runAdversarialVerification(
                                findingsToVerify,
                                executionContext,
                                subagentExecutor,
                                findingStore,
                                token,
                                progressCallback
                            );
                        if (adversarialResults.removed > 0) {
                            analysisText += `\n*Adversarial verification: ${adversarialResults.removed} finding(s) refuted and removed*`;
                        }
                    }
                }

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

    private async runAdversarialVerification(
        findings: RecordedFinding[],
        executionContext: ExecutionContext,
        subagentExecutor: SubagentExecutor,
        findingStore: FindingStore,
        token: vscode.CancellationToken,
        progressCallback?: AnalysisProgressCallback
    ): Promise<{ removed: number; confirmed: number }> {
        const adversarialPromptGen = new AdversarialPromptGenerator();
        let removed = 0;
        let confirmed = 0;

        for (
            let findingIndex = 0;
            findingIndex < findings.length;
            findingIndex++
        ) {
            const finding = findings[findingIndex]!;
            if (token.isCancellationRequested) {
                break;
            }

            try {
                progressCallback?.(
                    `Verifying finding ${findingIndex + 1}/${findings.length}: ${finding.title}`,
                    0.5
                );

                const adversarialTask =
                    adversarialPromptGen.generateSystemPrompt(finding);

                const budget =
                    executionContext.calibrationProfile.adversarialBudget;

                Log.info(
                    `Adversarial verification for ${finding.severity} finding: ${finding.title} in ${finding.file} (budget: ${budget})`
                );

                const result = await subagentExecutor.execute(
                    {
                        task: adversarialTask,
                        context: `Finding to verify: "${finding.title}" in ${finding.file}:${finding.lineRange[0]}-${finding.lineRange[1]}`,
                    },
                    token,
                    findingIndex + 1,
                    {
                        agentId: `adversarial-${findingIndex + 1}`,
                        childBudget: budget,
                        calibrationProfile: executionContext.calibrationProfile,
                    }
                );

                const verdict = this.parseAdversarialVerdict(result.response);

                if (verdict === 'CONFIRMED') {
                    confirmed++;
                    Log.info(
                        `Adversarial CONFIRMED: ${finding.title} — keeping`
                    );
                } else {
                    // REFUTED or UNCERTAIN → remove.
                    // If a dedicated adversarial agent can't confirm the finding,
                    // it's not confirmed — precision over recall.
                    findingStore.remove(finding.id);
                    removed++;
                    Log.info(
                        `Adversarial ${verdict}: ${finding.title} — removed from findings`
                    );
                }
            } catch (error) {
                if (isCancellationError(error)) {
                    throw error;
                }
                Log.warn(
                    `Adversarial verification failed for ${finding.title}: ${getErrorMessage(error)}`
                );
                // Verification failure → can't confirm → remove
                findingStore.remove(finding.id);
                removed++;
            }
        }

        return { removed, confirmed };
    }

    private parseAdversarialVerdict(
        response: string
    ): 'REFUTED' | 'CONFIRMED' | 'UNCERTAIN' {
        const upper = response.toUpperCase();
        // Look for explicit verdict markers
        if (
            upper.includes('VERDICT: REFUTED') ||
            upper.includes('VERDICT:REFUTED')
        ) {
            return 'REFUTED';
        }
        if (
            upper.includes('VERDICT: CONFIRMED') ||
            upper.includes('VERDICT:CONFIRMED')
        ) {
            return 'CONFIRMED';
        }
        if (
            upper.includes('VERDICT: UNCERTAIN') ||
            upper.includes('VERDICT:UNCERTAIN')
        ) {
            return 'UNCERTAIN';
        }
        // Fallback: check for standalone keywords at word boundaries
        if (/\bREFUTED\b/.test(upper) && !/\bCONFIRMED\b/.test(upper)) {
            return 'REFUTED';
        }
        if (/\bCONFIRMED\b/.test(upper) && !/\bREFUTED\b/.test(upper)) {
            return 'CONFIRMED';
        }
        return 'UNCERTAIN';
    }

    private getFindingsAtOrAboveSeverity(
        findingStore: FindingStore,
        threshold: FindingSeverity
    ): RecordedFinding[] {
        const thresholdIndex = FINDING_SEVERITIES.indexOf(threshold);
        const severities = FINDING_SEVERITIES.filter(
            (_, i) => i <= thresholdIndex
        );
        return severities.flatMap((s) => findingStore.getBySeverity(s));
    }

    private applyValidationResults(
        validated: ValidatedFinding[],
        findingStore: FindingStore
    ): void {
        for (const v of validated) {
            if (v.verdict === 'drop') {
                findingStore.remove(v.finding.id);
            } else if (v.verdict === 'downgrade' && v.downgradedSeverity) {
                findingStore.updateSeverity(v.finding.id, v.downgradedSeverity);
            }
        }
    }

    private formatValidationSummary(validated: ValidatedFinding[]): string {
        const dropped = validated.filter((v) => v.verdict === 'drop');
        const downgraded = validated.filter((v) => v.verdict === 'downgrade');

        if (dropped.length === 0 && downgraded.length === 0) {
            return '';
        }

        let summary = '\n\n---\n*Post-analysis validation:';
        if (dropped.length > 0) {
            summary += ` ${dropped.length} finding(s) removed (${dropped.map((d) => d.violations[0]).join('; ')})`;
        }
        if (downgraded.length > 0) {
            if (dropped.length > 0) {
                summary += ',';
            }
            summary += ` ${downgraded.length} finding(s) downgraded`;
        }
        summary += '*';
        return summary;
    }

    dispose(): void {
        // No resources to dispose of currently
    }
}
