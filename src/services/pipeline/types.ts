import type { ToolCallRecord } from '../../types/toolCallTypes';
import type { FindingStore } from '../../sessions/findingStore';
import type { ExecutionContext } from '../../types/executionContext';
import type { DiffHunk } from '../../types/contextTypes';
import type { ModelCalibrationProfile } from '../../models/modelCalibration';
import type { SubagentExecutor } from '../subagentExecutor';
import type { ConversationManager } from '../../models/conversationManager';
import type {
    ConversationRunner,
    ToolCallHandler,
} from '../../models/conversationRunner';
import type { ITool } from '../../tools/ITool';
import type { SelfReflectionScore } from '../selfReflectionScorer';
import type { FindingValidator } from '../findingValidator';
import type { FeedbackStore } from '../feedbackStore';
import type * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Step kind — determines UI treatment and execution expectations
// ---------------------------------------------------------------------------

export type PipelineStepKind =
    | 'llm-conversation'
    | 'programmatic'
    | 'llm-subagent';

// ---------------------------------------------------------------------------
// Result returned by each step's execute()
// ---------------------------------------------------------------------------

export interface PipelineStepResult {
    findingsDropped: string[];
    findingsDowngraded: string[];
    toolCallRecords: ToolCallRecord[];
    summary?: string;
}

// ---------------------------------------------------------------------------
// Record of a single step's execution (for telemetry / webview Phase UI)
// ---------------------------------------------------------------------------

export type StepStatus = 'skipped' | 'executed' | 'cancelled';

export interface StepRecord {
    name: string;
    label: string;
    kind: PipelineStepKind;
    status: StepStatus;
    durationMs: number;
    result?: PipelineStepResult;
}

// ---------------------------------------------------------------------------
// Shared mutable context threaded through all steps
// ---------------------------------------------------------------------------

export interface PipelineContext {
    // --- Original options (immutable references) ---
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
    findingValidator: FindingValidator;
    feedbackStore?: FeedbackStore;
    progressCallback?: (message: string, increment?: number) => void;

    // --- Accumulated state (mutated by steps) ---
    droppedTitles: string[];
    additionalToolCallRecords: ToolCallRecord[];
    selfReflectionScores: SelfReflectionScore[];
    rewrittenAnalysis: string | undefined;
}

// ---------------------------------------------------------------------------
// Step interface — each pipeline stage implements this
// ---------------------------------------------------------------------------

export interface PipelineStep {
    readonly name: string;
    readonly label: string;
    readonly description: string;
    readonly kind: PipelineStepKind;

    /** Return false to skip this step entirely. */
    shouldRun(context: PipelineContext): boolean;

    /** Execute the step, returning structured results. */
    execute(context: PipelineContext): Promise<PipelineStepResult>;
}
