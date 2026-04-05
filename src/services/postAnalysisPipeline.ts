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
        };

        const stepRecords = await runPipeline(steps, context);

        return {
            droppedTitles: context.droppedTitles,
            rewrittenAnalysis: context.rewrittenAnalysis,
            additionalToolCallRecords: context.additionalToolCallRecords,
            selfReflectionScores: context.selfReflectionScores,
            stepRecords,
        };
    }
}
