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
import type { FindingValidator } from './findingValidator';
import type { SelfReflectionScore } from './selfReflectionScorer';
import type { FeedbackStore as FeedbackStoreType } from './feedbackStore';
import type { StepRecord } from './pipeline/pipelineTypes';
import {
    runPipeline,
    createWorkflowEnforcementStep,
    createZeroFindingChallengeStep,
    createEvidenceAuditStep,
    createFindingValidationStep,
    createAdversarialVerificationStep,
    createFindingScoringStep,
    createSelfReflectionStep,
    createRewriteStep,
} from './pipeline/pipeline';

export interface PostAnalysisPipelineOptions {
    findingStore: FindingStore;
    toolCallRecords: ToolCallRecord[];
    initialAnalysisText: string;
    executionContext: ExecutionContext;
    parsedDiff: DiffHunk[];
    calibrationProfile: ModelCalibrationProfile;
    subagentExecutor: SubagentExecutor;
    conversationManager: ConversationManager;
    conversationRunner: ConversationRunner;
    systemPrompt: string;
    availableTools: ITool[];
    disabledToolNames?: Set<string>;
    handler: ToolCallHandler;
    feedbackStore?: FeedbackStoreType;
    progressCallback?: (message: string, increment?: number) => void;
}

export interface PostAnalysisPipelineResult {
    droppedTitles: string[];
    rewrittenAnalysis: string | undefined;
    additionalToolCallRecords: ToolCallRecord[];
    selfReflectionScores: SelfReflectionScore[];
    stepRecords: StepRecord[];
}

export class PostAnalysisPipeline {
    constructor(private readonly findingValidator: FindingValidator) {}

    async run(
        options: PostAnalysisPipelineOptions
    ): Promise<PostAnalysisPipelineResult> {
        const steps = [
            createWorkflowEnforcementStep(),
            createZeroFindingChallengeStep(),
            createEvidenceAuditStep(),
            createFindingValidationStep(),
            createAdversarialVerificationStep(),
            createFindingScoringStep(),
            createSelfReflectionStep(),
            createRewriteStep(),
        ];

        const context = {
            ...options,
            findingValidator: this.findingValidator,
            droppedTitles: [] as string[],
            downgradedTitles: [] as string[],
            additionalToolCallRecords: [] as ToolCallRecord[],
            selfReflectionScores: [] as SelfReflectionScore[],
            rewrittenAnalysis: undefined as string | undefined,
            lastCommittedReviewText: options.initialAnalysisText,
            lastCommittedFindingStoreSnapshot:
                options.findingStore.createSnapshot(),
            lastCommittedSelfReflectionScores: [] as SelfReflectionScore[],
        };

        const stepRecords = await runPipeline(steps, context);

        // Final reconciliation: filter out scores for findings that were dropped
        // during later pipeline steps but whose scores weren't cleaned up.
        // Also filter out scores for findings that exist in the store but are not
        // substantively mentioned in the final review text — this prevents showing
        // confidence scores for issues the rewrite LLM silently omitted.
        const finalReviewText = (
            context.rewrittenAnalysis ??
            context.lastCommittedReviewText ??
            ''
        ).toLowerCase();
        const reconciledScores = context.selfReflectionScores.filter(
            (score) => {
                if (!context.findingStore.getById(score.findingId)) {
                    return false;
                }
                // If no rewrite happened, keep all scores for existing findings
                if (!context.rewrittenAnalysis) {
                    return true;
                }
                // Verify the finding is actually discussed in the review text
                const titleWords = score.title
                    .toLowerCase()
                    .split(/\s+/)
                    .filter((w) => w.length >= 3);
                const matchingWordCount = titleWords.filter((w) =>
                    finalReviewText.includes(w)
                ).length;
                return matchingWordCount >= Math.min(2, titleWords.length);
            }
        );

        return {
            droppedTitles: context.droppedTitles,
            rewrittenAnalysis: context.rewrittenAnalysis,
            additionalToolCallRecords: context.additionalToolCallRecords,
            selfReflectionScores: reconciledScores,
            stepRecords,
        };
    }
}
