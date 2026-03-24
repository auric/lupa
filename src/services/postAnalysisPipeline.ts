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
import type { FindingValidator, ValidatedFinding } from './findingValidator';
import { EvidenceAuditor, type EvidenceAuditResult } from './evidenceAuditor';
import { AdversarialVerifier } from './adversarialVerifier';
import { scoreFinding, type ScoringContext } from './findingScorer';
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
    feedbackStore?: FeedbackStoreType;
    progressCallback?: (message: string, increment?: number) => void;
}

export interface PostAnalysisPipelineResult {
    droppedTitles: string[];
    rewrittenAnalysis: string | undefined;
    additionalToolCallRecords: ToolCallRecord[];
}

export class PostAnalysisPipeline {
    constructor(private readonly findingValidator: FindingValidator) {}

    async run(
        options: PostAnalysisPipelineOptions
    ): Promise<PostAnalysisPipelineResult> {
        const droppedTitles: string[] = [];
        const additionalToolCallRecords: ToolCallRecord[] = [];
        let rewrittenAnalysis: string | undefined;

        // Stage 1: Workflow enforcement (runs regardless of finding count)
        if (!options.token.isCancellationRequested) {
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
                workflowGaps.push(
                    `think_about_completion flagged ${cr.uninvestigatedFiles.length} uninvestigated file(s): ${cr.uninvestigatedFiles.join(', ')}. Investigate these files before submitting.`
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
                options.conversationManager.addUserMessage(
                    `ZERO FINDINGS ALERT — You reviewed ${options.parsedDiff.length} changed files ` +
                        `(investigated ${investigatedCount} via tools) and recorded 0 findings. ` +
                        `On a PR of this size with substantive code changes, this is unusual.\n\n` +
                        `Before finalizing:\n` +
                        `• Re-examine each file group for potential logic errors, missing error handling, or security issues\n` +
                        `• If you skipped files, investigate them now with get_file_diff and find_symbol\n` +
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
        if (survivingFindings.length > 0 && options.parsedDiff) {
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

        // Stage 5b: Self-critique — fresh perspective on surviving findings
        if (
            options.findingStore.size > 0 &&
            !options.token.isCancellationRequested
        ) {
            options.progressCallback?.('Self-critiquing findings...', 0.75);
            const selfCritiqueDrops = await this.runSelfCritique(options);
            droppedTitles.push(...selfCritiqueDrops);
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

        return { droppedTitles, rewrittenAnalysis, additionalToolCallRecords };
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

    /**
     * Stage 5b: Self-critique — asks the model to re-evaluate its own
     * surviving findings from a senior developer perspective.
     *
     * Implements the "self-critique pass" pattern (Graphite: 5-8% FP rate).
     * The model reviews each finding and lists those that are speculative,
     * cosmetic, or based on absence of features rather than concrete bugs.
     */
    private async runSelfCritique(
        options: PostAnalysisPipelineOptions
    ): Promise<string[]> {
        const findings = options.findingStore.getAll();
        if (findings.length === 0) {
            return [];
        }

        const findingsList = findings
            .map(
                (f, i) =>
                    `${i + 1}. [${f.severity}] "${f.title}" (${f.file}:${f.lineRange[0]})\n` +
                    `   Description: ${f.description}\n` +
                    `   Affected component: ${f.affectedComponent || 'N/A'}\n` +
                    `   Failure mechanism: ${f.failureMechanism || 'N/A'}\n` +
                    `   Evidence: ${f.disproof.attempted ? f.disproof.result : 'none recorded'}`
            )
            .join('\n\n');

        options.conversationManager.addUserMessage(
            `SELF-CRITIQUE REVIEW — Imagine you are a DIFFERENT senior engineer receiving this code review. ` +
                `The following ${findings.length} finding(s) survived all previous verification stages:\n\n` +
                findingsList +
                `\n\nFor each finding, critically evaluate:\n` +
                `• Does this describe a CONCRETE behavioral bug (wrong output, crash, security bypass, data corruption)?\n` +
                `• Is the evidence based on actual code you examined, or on speculation about what MIGHT happen?\n` +
                `• Would you spend engineering time fixing this, or would you dismiss it as noise?\n` +
                `• Is this about MISSING features/tests/docs rather than INCORRECT behavior?\n\n` +
                `Reply with ONLY the titles of findings to DROP (those that are speculative, cosmetic, or describe missing features rather than bugs), ` +
                `one per line prefixed with "DROP: ". If all findings are valid, reply with "ALL VALID".`
        );

        const SELF_CRITIQUE_BUDGET = 10;
        const response = await options.conversationRunner.run(
            {
                systemPrompt: options.systemPrompt,
                maxIterations: SELF_CRITIQUE_BUDGET,
                tools: [],
                label: 'Self-Critique',
            },
            options.conversationManager,
            options.token,
            options.handler
        );

        // Parse DROP directives from the model's response
        const dropped: string[] = [];
        if (response) {
            const lines = response.split('\n');
            for (const line of lines) {
                const match = line.match(/^DROP:\s*"?(.+?)"?\s*$/i);
                if (match) {
                    const droppedTitle = match[1]!.trim();
                    // Find matching finding by title (fuzzy: case-insensitive, trimmed)
                    const finding = findings.find(
                        (f) =>
                            f.title.toLowerCase().trim() ===
                            droppedTitle.toLowerCase().trim()
                    );
                    if (finding) {
                        if (options.findingStore.remove(finding.id)) {
                            dropped.push(finding.title);
                            Log.info(
                                `Self-critique: dropped "${finding.title}"`
                            );
                        }
                    }
                }
            }
        }

        if (dropped.length === 0 && findings.length > 0) {
            Log.info(
                `Self-critique: all ${findings.length} finding(s) survived`
            );
        }

        return dropped;
    }
}
