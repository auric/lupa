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
import type { DiffEnricher } from './diffEnricher';
import type { FindingValidator, ValidatedFinding } from './findingValidator';
import { INVESTIGATION_TOOLS } from '../models/toolConstants';
import type { ExecutionContext } from '../types/executionContext';
import { getCalibrationProfile } from '../models/modelCalibration';
import { AdversarialVerifier } from './adversarialVerifier';
import { EvidenceAuditor } from './evidenceAuditor';
import type { EvidenceAuditResult } from './evidenceAuditor';

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
            investigatedFiles: new Set<string>(),
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
                // Workflow enforcement: check required tools and self-reflection.
                // Only enforced when findings are recorded (clean reviews pass through).
                // Re-enters conversation with a small budget if checks fail.
                if (findingStore.size > 0 && !token.isCancellationRequested) {
                    const workflowGaps: string[] = [];

                    const thinkCalled =
                        (executionContext.toolCallCounts.get(
                            'think_about_completion'
                        ) ?? 0) > 0;
                    if (!thinkCalled) {
                        workflowGaps.push(
                            'You did not call think_about_completion to reflect on your findings'
                        );
                    }

                    const requiredTools =
                        calibrationProfile.investigationProtocol
                            .requiredToolsBeforeDone;
                    const missingTools = requiredTools.filter(
                        (t: string) =>
                            (executionContext.toolCallCounts.get(t) ?? 0) === 0
                    );
                    if (missingTools.length > 0) {
                        workflowGaps.push(
                            `Required investigation tools not used: ${missingTools.join(', ')}`
                        );
                    }

                    if (
                        executionContext.completionReadiness &&
                        !executionContext.completionReadiness.ready
                    ) {
                        const cr = executionContext.completionReadiness;
                        workflowGaps.push(
                            `think_about_completion flagged ${cr.uninvestigatedFiles.length} uninvestigated file(s): ${cr.uninvestigatedFiles.join(', ')}. Investigate these files before submitting.`
                        );
                    }

                    if (workflowGaps.length > 0) {
                        Log.info(
                            `Workflow enforcement: ${workflowGaps.length} gap(s) detected, re-entering for completion`
                        );
                        conversationManager.addUserMessage(
                            `WORKFLOW INCOMPLETE — you recorded ${findingStore.size} finding(s) but skipped required steps:\n` +
                                workflowGaps.map((g) => `• ${g}`).join('\n') +
                                '\n\nComplete these steps NOW, then call submit_review again.'
                        );

                        const WORKFLOW_BUDGET = 10;
                        analysisText = await conversationRunner.run(
                            {
                                systemPrompt,
                                maxIterations: WORKFLOW_BUDGET,
                                tools: availableTools,
                                label: 'Workflow Completion',
                                requiresExplicitCompletion: true,
                            },
                            conversationManager,
                            token,
                            handler
                        );
                    }
                }

                // Track all dropped findings across post-analysis stages for unified rewrite
                const droppedTitles: string[] = [];

                // Post-analysis: audit evidence trail against tool call records
                const findings = findingStore.getAll();
                if (findings.length > 0) {
                    progressCallback?.('Auditing evidence trail...', 0.3);
                    const evidenceAuditor = new EvidenceAuditor();
                    const auditResult = evidenceAuditor.audit(
                        findings,
                        toolCallRecords
                    );

                    // Collect titles before applying drops
                    for (const entry of auditResult.entries) {
                        if (entry.verdict === 'drop') {
                            droppedTitles.push(entry.finding.title);
                        }
                    }
                    this.applyEvidenceAuditResults(auditResult, findingStore);
                }

                // Post-analysis: validate findings programmatically
                const survivingFindings = findingStore.getAll();
                if (
                    survivingFindings.length > 0 &&
                    executionContext.parsedDiff
                ) {
                    progressCallback?.('Validating findings...', 0.5);
                    const validation = await this.findingValidator.validate(
                        survivingFindings,
                        executionContext.parsedDiff,
                        token
                    );

                    // Collect titles before applying drops
                    for (const v of validation.validated) {
                        if (v.verdict === 'drop') {
                            droppedTitles.push(v.finding.title);
                        }
                    }

                    // Apply validation results to FindingStore
                    this.applyValidationResults(
                        validation.validated,
                        findingStore
                    );

                    if (validation.dropped > 0 || validation.downgraded > 0) {
                        Log.info(
                            `FindingValidator: ${validation.kept} kept, ${validation.downgraded} downgraded, ${validation.dropped} dropped`
                        );
                    }
                }

                // Adversarial verification: run visible subagents against surviving findings
                if (findingStore.size > 0 && !token.isCancellationRequested) {
                    const adversarialVerifier = new AdversarialVerifier();
                    const adversarialResult = await adversarialVerifier.verify(
                        findingStore,
                        calibrationProfile,
                        subagentExecutor,
                        parsedDiff,
                        token,
                        progressCallback
                            ? (msg) => progressCallback(msg, 0.5)
                            : undefined
                    );

                    // Record adversarial tool calls in the webview report
                    toolCallRecords.push(...adversarialResult.toolCallRecords);

                    if (adversarialResult.refuted.length > 0) {
                        droppedTitles.push(...adversarialResult.refuted);
                    }
                }

                // Unified rewrite: if ANY findings were dropped across any stage,
                // re-enter conversation so the model rewrites its review without them.
                // This prevents stale finding references in the final output.
                if (
                    droppedTitles.length > 0 &&
                    !token.isCancellationRequested
                ) {
                    Log.info(
                        `Post-analysis dropped ${droppedTitles.length} finding(s), re-entering conversation for rewrite`
                    );
                    const droppedList = droppedTitles
                        .map((t) => `"${t}"`)
                        .join(', ');
                    conversationManager.addUserMessage(
                        `Post-analysis verification has removed ${droppedTitles.length} finding(s): ${droppedList}. ` +
                            'These findings failed evidence audit, programmatic validation, or adversarial verification. ' +
                            'Rewrite your review WITHOUT these removed findings, then call submit_review.'
                    );

                    // Re-enter conversation with small budget for rewrite
                    const REWRITE_BUDGET = 10;
                    analysisText = await conversationRunner.run(
                        {
                            systemPrompt,
                            maxIterations: REWRITE_BUDGET,
                            tools: availableTools,
                            label: 'Rewrite Phase',
                            requiresExplicitCompletion: true,
                        },
                        conversationManager,
                        token,
                        handler
                    );
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

    private applyEvidenceAuditResults(
        auditResult: EvidenceAuditResult,
        findingStore: FindingStore
    ): void {
        for (const entry of auditResult.entries) {
            if (entry.verdict === 'drop') {
                findingStore.remove(entry.finding.id);
            } else if (entry.verdict === 'downgrade') {
                // Step severity down by one level
                const severityOrder = [
                    'LOW',
                    'MEDIUM',
                    'HIGH',
                    'CRITICAL',
                ] as const;
                const idx = severityOrder.indexOf(entry.finding.severity);
                if (idx > 0) {
                    findingStore.updateSeverity(
                        entry.finding.id,
                        severityOrder[idx - 1]!
                    );
                }
            }
        }
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

    dispose(): void {
        // No resources to dispose of currently
    }
}
