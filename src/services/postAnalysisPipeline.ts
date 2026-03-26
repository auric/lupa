import * as vscode from 'vscode';
import type { FindingStore } from '../sessions/findingStore';
import type { ToolCallRecord } from '../types/toolCallTypes';
import type { ExecutionContext } from '../types/executionContext';
import type { DiffHunk } from '../types/contextTypes';
import type { ModelCalibrationProfile } from '../models/modelCalibration';
import type { SubagentExecutor } from './subagentExecutor';
import type { ConversationManager } from '../models/conversationManager';
import type {
    ConversationRunner,
    ToolCallHandler,
} from '../models/conversationRunner';
import type { ITool } from '../tools/ITool';
import type { ToolRegistry } from '../models/toolRegistry';
import type { FindingValidator, ValidatedFinding } from './findingValidator';
import { INVESTIGATION_TOOLS } from '../models/toolConstants';
import { EvidenceAuditor, type EvidenceAuditResult } from './evidenceAuditor';
import { AdversarialVerifier } from './adversarialVerifier';
import { scoreFinding, type ScoringContext } from './findingScorer';
import {
    runSelfReflection,
    type SelfReflectionScore,
} from './selfReflectionScorer';
import type { FeedbackStore as FeedbackStoreType } from './feedbackStore';
import { Log } from './loggingService';

export interface PostAnalysisPipelineOptions {
    findingStore: FindingStore;
    toolCallRecords: ToolCallRecord[];
    executionContext: ExecutionContext;
    parsedDiff: DiffHunk[];
    calibrationProfile: ModelCalibrationProfile;
    subagentExecutor: SubagentExecutor;
    conversationManager: ConversationManager;
    conversationRunner: ConversationRunner;
    systemPrompt: string;
    availableTools: ITool[];
    disabledToolNames?: Set<string>;
    token: vscode.CancellationToken;
    handler: ToolCallHandler;
    toolRegistry: ToolRegistry;
    feedbackStore?: FeedbackStoreType;
    progressCallback?: (message: string, increment?: number) => void;
}

export interface PostAnalysisPipelineResult {
    droppedTitles: string[];
    rewrittenAnalysis: string | undefined;
    additionalToolCallRecords: ToolCallRecord[];
    selfReflectionScores: SelfReflectionScore[];
}

export class PostAnalysisPipeline {
    constructor(private readonly findingValidator: FindingValidator) {}

    async run(
        options: PostAnalysisPipelineOptions
    ): Promise<PostAnalysisPipelineResult> {
        const droppedTitles: string[] = [];
        const additionalToolCallRecords: ToolCallRecord[] = [];
        let rewrittenAnalysis: string | undefined;
        let selfReflectionScores: SelfReflectionScore[] = [];

        // Stage 1: Workflow enforcement (runs regardless of finding count)
        if (!options.token.isCancellationRequested) {
            // Check if investigation tools are disabled (recursive mode).
            // The root agent is controller-only — it must delegate via
            // run_subagent_batch rather than calling read_file etc. directly.
            const investigationDisabled =
                options.disabledToolNames &&
                INVESTIGATION_TOOLS.some((t) =>
                    options.disabledToolNames!.has(t)
                );

            const workflowGaps: string[] = [];
            const ec = options.executionContext;

            const thinkToolAvailable = options.availableTools.some(
                (t) => t.name === 'think_about_completion'
            );
            const thinkCalled =
                (ec.toolCallCounts.get('think_about_completion') ?? 0) > 0;
            if (thinkToolAvailable && !thinkCalled) {
                workflowGaps.push(
                    'You did not call think_about_completion to reflect on your findings'
                );
            }

            const requiredTools =
                options.calibrationProfile.investigationProtocol
                    .requiredToolsBeforeDone;
            const availableToolNames = new Set(
                options.availableTools.map((t) => t.name)
            );
            const missingTools = requiredTools.filter(
                (t: string) =>
                    availableToolNames.has(t) &&
                    (ec.toolCallCounts.get(t) ?? 0) === 0
            );
            if (missingTools.length > 0) {
                workflowGaps.push(
                    `Required investigation tools not used: ${missingTools.join(', ')}`
                );
            }

            if (ec.completionReadiness && !ec.completionReadiness.ready) {
                const cr = ec.completionReadiness;
                const investigateInstruction = investigationDisabled
                    ? 'You do NOT have direct investigation tools (read_file, get_file_diff, etc.). ' +
                      'Use run_subagent_batch to delegate investigation of these files to subagents, then call submit_review.'
                    : 'Investigate these files before submitting.';
                workflowGaps.push(
                    `think_about_completion flagged ${cr.uninvestigatedFiles.length} uninvestigated file(s): ${cr.uninvestigatedFiles.join(', ')}. ${investigateInstruction}`
                );
            }

            if (workflowGaps.length > 0) {
                Log.info(
                    `Workflow enforcement: ${workflowGaps.length} gap(s) detected, re-entering for completion`
                );
                const findingCount = options.findingStore.size;
                options.conversationManager.addUserMessage(
                    `WORKFLOW INCOMPLETE — you recorded ${findingCount} finding(s) but skipped required steps:\n` +
                        workflowGaps.map((g) => `• ${g}`).join('\n') +
                        '\n\nComplete these steps NOW, then call submit_review again.'
                );

                const WORKFLOW_BUDGET = 30;
                await options.conversationRunner.run(
                    {
                        systemPrompt: options.systemPrompt,
                        maxIterations: WORKFLOW_BUDGET,
                        tools: options.availableTools,
                        disabledToolNames: options.disabledToolNames,
                        label: 'Workflow Completion',
                        requiresExplicitCompletion: true,
                    },
                    options.conversationManager,
                    options.token,
                    options.handler
                );
            }

            // Zero-finding challenge for dismissive models on non-trivial PRs
            const isNonTrivialPR = options.parsedDiff.length >= 5;
            const isDismissive =
                options.calibrationProfile.findingBias === 'dismissive';
            if (
                options.findingStore.size === 0 &&
                isNonTrivialPR &&
                isDismissive &&
                !options.token.isCancellationRequested
            ) {
                Log.info(
                    `Zero-finding challenge: dismissive model reported 0 findings on ${options.parsedDiff.length}-file PR`
                );
                const investigatedCount =
                    options.executionContext.investigatedFiles?.size ?? 0;
                const zfcInvestigateInstruction = investigationDisabled
                    ? '• You do NOT have direct investigation tools. Use run_subagent_batch to delegate investigation of skipped files to subagents'
                    : '• If you skipped files, investigate them now with get_file_diff and find_symbol';
                options.conversationManager.addUserMessage(
                    `ZERO FINDINGS ALERT — You reviewed ${options.parsedDiff.length} changed files ` +
                        `(investigated ${investigatedCount} via tools) and recorded 0 findings. ` +
                        `On a PR of this size with substantive code changes, this is unusual.\n\n` +
                        `Before finalizing:\n` +
                        `• Re-examine each file group for potential logic errors, missing error handling, or security issues\n` +
                        `${zfcInvestigateInstruction}\n` +
                        `• Record any genuine findings you may have overlooked with record_finding\n` +
                        `• If truly no issues exist, that is acceptable — but verify you checked thoroughly\n\n` +
                        `Then call submit_review again.`
                );

                const CHALLENGE_BUDGET = 15;
                await options.conversationRunner.run(
                    {
                        systemPrompt: options.systemPrompt,
                        maxIterations: CHALLENGE_BUDGET,
                        tools: options.availableTools,
                        disabledToolNames: options.disabledToolNames,
                        label: 'Zero-Finding Challenge',
                        requiresExplicitCompletion: true,
                    },
                    options.conversationManager,
                    options.token,
                    options.handler
                );
            }
        }

        // Stage 2: Evidence audit
        const findings = options.findingStore.getAll();
        if (findings.length > 0) {
            options.progressCallback?.('Auditing evidence trail...', 0.3);
            const evidenceAuditor = new EvidenceAuditor();
            const auditResult = evidenceAuditor.audit(
                findings,
                options.toolCallRecords
            );

            for (const entry of auditResult.entries) {
                if (entry.verdict === 'drop') {
                    droppedTitles.push(entry.finding.title);
                }
            }
            this.applyEvidenceAuditResults(auditResult, options.findingStore);
        }

        // Stage 3: Finding validation
        const survivingFindings = options.findingStore.getAll();
        if (survivingFindings.length > 0 && options.parsedDiff?.length) {
            options.progressCallback?.('Validating findings...', 0.5);
            const validation = await this.findingValidator.validate(
                survivingFindings,
                options.parsedDiff,
                options.token
            );

            for (const v of validation.validated) {
                if (v.verdict === 'drop') {
                    droppedTitles.push(v.finding.title);
                }
            }

            this.applyValidationResults(
                validation.validated,
                options.findingStore
            );

            if (validation.dropped > 0 || validation.downgraded > 0) {
                Log.info(
                    `FindingValidator: ${validation.kept} kept, ${validation.downgraded} downgraded, ${validation.dropped} dropped`
                );
            }
        }

        // Stage 4: Adversarial verification
        if (
            options.findingStore.size > 0 &&
            !options.token.isCancellationRequested
        ) {
            const adversarialVerifier = new AdversarialVerifier();
            const adversarialResult = await adversarialVerifier.verify(
                options.findingStore,
                options.calibrationProfile,
                options.subagentExecutor,
                options.parsedDiff,
                options.token,
                options.progressCallback
                    ? (msg) => options.progressCallback!(msg, 0.5)
                    : undefined
            );

            additionalToolCallRecords.push(
                ...adversarialResult.toolCallRecords
            );

            if (adversarialResult.refuted.length > 0) {
                droppedTitles.push(...adversarialResult.refuted);
            }
        }

        // Stage 5: Finding scoring
        if (
            options.findingStore.size > 0 &&
            !options.token.isCancellationRequested
        ) {
            options.progressCallback?.('Scoring findings...', 0.7);
            const allToolCalls = [
                ...options.toolCallRecords,
                ...additionalToolCallRecords,
            ];
            const baseScoringContext: ScoringContext = {
                toolCallRecords: allToolCalls,
                calibrationProfile: options.calibrationProfile,
            };
            const modelName = options.calibrationProfile.name;
            const findings = options.findingStore.getAll();
            const scores = findings.map((finding) => {
                const ctx: ScoringContext = { ...baseScoringContext };
                if (options.feedbackStore) {
                    const stats = options.feedbackStore.getStats(
                        finding.category,
                        modelName
                    );
                    ctx.feedbackRejectionRate =
                        options.feedbackStore.getRejectionRate(
                            finding.category,
                            modelName
                        );
                    ctx.feedbackTotalEntries = stats.total;
                }
                return scoreFinding(finding, ctx);
            });

            const severityOrder = [
                'LOW',
                'MEDIUM',
                'HIGH',
                'CRITICAL',
            ] as const;

            for (const score of scores) {
                if (score.recommendation === 'drop') {
                    const finding = options.findingStore.getById(
                        score.findingId
                    );
                    if (finding) {
                        droppedTitles.push(finding.title);
                        options.findingStore.remove(score.findingId);
                        Log.info(
                            `FindingScorer: dropped "${finding.title}" (score: ${score.overallScore})`
                        );
                    }
                } else if (score.recommendation === 'downgrade') {
                    const finding = options.findingStore.getById(
                        score.findingId
                    );
                    if (finding) {
                        const idx = severityOrder.indexOf(finding.severity);
                        if (idx > 0) {
                            const oldSeverity = finding.severity;
                            const newSeverity = severityOrder[idx - 1]!;
                            options.findingStore.updateSeverity(
                                score.findingId,
                                newSeverity
                            );
                            Log.info(
                                `FindingScorer: downgraded "${finding.title}" ${oldSeverity} → ${newSeverity} (score: ${score.overallScore})`
                            );
                        }
                    }
                }
            }
        }

        // Stage 5b: Self-reflection scoring (confidence re-evaluation)
        // Presents ALL surviving findings back to the model for 1-10 confidence scoring.
        // Findings below the per-model threshold are dropped. Replaces the binary self-critique.
        if (
            options.findingStore.size > 0 &&
            !options.token.isCancellationRequested
        ) {
            options.progressCallback?.('Self-reflection scoring...', 0.75);
            const reflectionResult = await runSelfReflection({
                findingStore: options.findingStore,
                parsedDiff: options.parsedDiff,
                calibrationProfile: options.calibrationProfile,
                conversationManager: options.conversationManager,
                conversationRunner: options.conversationRunner,
                systemPrompt: options.systemPrompt,
                token: options.token,
                handler: options.handler,
                toolRegistry: options.toolRegistry,
            });
            selfReflectionScores = reflectionResult.scores;
            droppedTitles.push(...reflectionResult.dropped);
        }

        // Stage 6: Unified rewrite
        if (
            droppedTitles.length > 0 &&
            !options.token.isCancellationRequested
        ) {
            Log.info(
                `Post-analysis dropped ${droppedTitles.length} finding(s), re-entering conversation for rewrite`
            );
            const droppedList = droppedTitles.map((t) => `"${t}"`).join(', ');
            options.conversationManager.addUserMessage(
                `Post-analysis verification has removed ${droppedTitles.length} finding(s): ${droppedList}. ` +
                    'These findings failed evidence audit, programmatic validation, or adversarial verification. ' +
                    'Rewrite your review WITHOUT these removed findings, then call submit_review.'
            );

            const REWRITE_BUDGET = 10;
            rewrittenAnalysis = await options.conversationRunner.run(
                {
                    systemPrompt: options.systemPrompt,
                    maxIterations: REWRITE_BUDGET,
                    tools: options.availableTools,
                    disabledToolNames: options.disabledToolNames,
                    label: 'Rewrite Phase',
                    requiresExplicitCompletion: true,
                },
                options.conversationManager,
                options.token,
                options.handler
            );
        }

        return {
            droppedTitles,
            rewrittenAnalysis,
            additionalToolCallRecords,
            selfReflectionScores,
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
}
