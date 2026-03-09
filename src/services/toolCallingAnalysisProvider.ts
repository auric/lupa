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
import { EvidenceLedger } from '../sessions/evidenceLedger';
import { FindingStore } from '../sessions/findingStore';
import { AdversarialPromptGenerator } from '../prompts/adversarialPromptGenerator';
import type { DiffEnricher } from './diffEnricher';
import type { FindingValidator, ValidatedFinding } from './findingValidator';
import type { RecordedFinding } from '../types/findingTypes';

import { INVESTIGATION_TOOLS } from '../models/toolConstants';
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

        const evidenceLedger = new EvidenceLedger();
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
            evidenceLedger,
            findingStore,
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

            // Enrich changed symbols with LSP metadata for the Code Intelligence Brief
            progressCallback?.('Building code intelligence brief...', 0.5);
            const codeIntelBrief = await this.diffEnricher.enrich(
                parsedDiff,
                token
            );
            Log.info(
                `Code intelligence brief: ${codeIntelBrief.enrichedSymbols.length} symbols, ${codeIntelBrief.timeoutCount} timeouts`
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
                this.workspaceSettings.getMaxSubagentsPerSession(),
                codeIntelBrief
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

                    // Adversarial verification for CRITICAL findings
                    const criticalFindings =
                        findingStore.getBySeverity('CRITICAL');
                    if (
                        criticalFindings.length > 0 &&
                        !token.isCancellationRequested
                    ) {
                        progressCallback?.(
                            'Adversarial verification of CRITICAL findings...',
                            0.5
                        );
                        const adversarialResults =
                            await this.runAdversarialVerification(
                                criticalFindings,
                                executionContext,
                                subagentExecutor,
                                findingStore,
                                token
                            );
                        if (adversarialResults.refuted > 0) {
                            analysisText += `\n*Adversarial verification: ${adversarialResults.refuted} CRITICAL finding(s) refuted and removed*`;
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
        criticalFindings: RecordedFinding[],
        executionContext: ExecutionContext,
        subagentExecutor: SubagentExecutor,
        findingStore: FindingStore,
        token: vscode.CancellationToken
    ): Promise<{ refuted: number; confirmed: number; uncertain: number }> {
        const adversarialPromptGen = new AdversarialPromptGenerator();
        const ADVERSARIAL_BUDGET = 7;
        let refuted = 0;
        let confirmed = 0;
        let uncertain = 0;

        for (const finding of criticalFindings) {
            if (token.isCancellationRequested) {
                break;
            }

            try {
                const adversarialTask =
                    adversarialPromptGen.generateSystemPrompt(finding);

                Log.info(
                    `Adversarial verification for CRITICAL finding: ${finding.title} in ${finding.file}`
                );

                const result = await subagentExecutor.execute(
                    {
                        task: adversarialTask,
                        context: `Finding to verify: "${finding.title}" in ${finding.file}:${finding.lineRange[0]}-${finding.lineRange[1]}`,
                    },
                    token,
                    -1, // negative ID to distinguish adversarial from regular subagents
                    { childBudget: ADVERSARIAL_BUDGET }
                );

                const verdict = this.parseAdversarialVerdict(result.response);

                if (verdict === 'REFUTED') {
                    findingStore.remove(finding.id);
                    refuted++;
                    Log.info(
                        `Adversarial REFUTED: ${finding.title} — removed from findings`
                    );
                } else if (verdict === 'CONFIRMED') {
                    confirmed++;
                    Log.info(
                        `Adversarial CONFIRMED: ${finding.title} — keeping`
                    );
                } else {
                    uncertain++;
                    Log.info(
                        `Adversarial UNCERTAIN: ${finding.title} — keeping (benefit of doubt)`
                    );
                }
            } catch (error) {
                if (isCancellationError(error)) {
                    throw error;
                }
                Log.warn(
                    `Adversarial verification failed for ${finding.title}: ${getErrorMessage(error)}`
                );
                uncertain++;
            }
        }

        return { refuted, confirmed, uncertain };
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
