import type {
    ConversationRunner,
    ToolCallHandler,
} from '../../models/conversationRunner';
import type { ConversationManager } from '../../models/conversationManager';
import type { FindingStoreSnapshot } from '../../sessions/findingStore';
import type {
    ReasoningChain,
    ReasoningChainSnapshot,
} from '../../sessions/reasoningChain';
import type { ITool } from '../../tools/ITool';
import type { Message } from '../../types/conversationTypes';
import type { FindingSeverity } from '../../types/findingTypes';
import type { PipelineContext } from './pipelineTypes';

const SEVERITY_ORDER: readonly FindingSeverity[] = [
    'LOW',
    'MEDIUM',
    'HIGH',
    'CRITICAL',
] as const;

type ConversationRunnerCompletionState = Pick<
    ConversationRunner,
    | 'wasCancelled'
    | 'hitMaxIterations'
    | 'hitRateLimit'
    | 'hitQuotaExhausted'
    | 'degraded'
    | 'exitReason'
>;

export interface ConversationCompletionStatus {
    completed: boolean;
    budgetExhausted: boolean;
    reason: string | undefined;
}

interface GuardedConversationPhaseOptions {
    context: Pick<
        PipelineContext,
        | 'conversationRunner'
        | 'conversationManager'
        | 'executionContext'
        | 'handler'
        | 'systemPrompt'
        | 'disabledToolNames'
        | 'findingStore'
    >;
    label: string;
    maxIterations: number;
    tools: ITool[];
    rollbackFindingStoreToSnapshot?: FindingStoreSnapshot;
    rollbackConversationHistory?: Message[];
}

export interface GuardedConversationPhaseResult {
    latestReview: string;
    completion: ConversationCompletionStatus;
}

type PhaseStateSnapshotContext = Pick<
    PipelineContext,
    'conversationManager' | 'executionContext' | 'findingStore'
> &
    Partial<Pick<PipelineContext, 'selfReflectionScores'>>;

interface PipelinePhaseStateSnapshotOptions {
    conversationHistory?: Message[];
    findingStoreSnapshot?: FindingStoreSnapshot;
    selfReflectionScores?: PipelineContext['selfReflectionScores'];
}

export interface PipelinePhaseStateSnapshot {
    conversationHistory?: Message[];
    findingStoreSnapshot?: FindingStoreSnapshot;
    selfReflectionScores?: PipelineContext['selfReflectionScores'];
    investigatedFiles?: Set<string>;
    completionReadiness?: PipelineContext['executionContext']['completionReadiness'];
    reasoningChainSnapshot?: ReasoningChainSnapshot;
}

/**
 * When a pipeline step drops a finding, dismiss any confirmed hypotheses linked to it.
 * Prevents orphaned confirmed hypotheses from blocking submit_review in later phases.
 */
export function dismissHypothesesForDroppedFinding(
    findingId: string,
    reasoningChain: ReasoningChain | undefined,
    reason: string
): void {
    if (!reasoningChain) {
        return;
    }
    reasoningChain.dismissConfirmedForFinding(findingId, reason);
}

export function downgradeSeverity(
    severity: FindingSeverity
): FindingSeverity | undefined {
    const idx = SEVERITY_ORDER.indexOf(severity);
    if (idx > 0) {
        return SEVERITY_ORDER[idx - 1];
    }
    return undefined;
}

export function classifyConversationCompletion(
    runner: ConversationRunnerCompletionState
): ConversationCompletionStatus {
    if (
        !runner.wasCancelled &&
        !runner.hitMaxIterations &&
        !runner.hitRateLimit &&
        !runner.hitQuotaExhausted &&
        !runner.degraded
    ) {
        return {
            completed: true,
            budgetExhausted: false,
            reason: undefined,
        };
    }

    const abnormalExitReason =
        runner.exitReason ?? (runner.degraded ? 'degraded' : 'unknown');

    return {
        completed: false,
        budgetExhausted: runner.hitMaxIterations || runner.hitQuotaExhausted,
        reason: runner.wasCancelled
            ? 'was cancelled'
            : runner.hitQuotaExhausted
              ? 'quota exhausted'
              : runner.hitRateLimit
                ? 'hit rate limit'
                : runner.hitMaxIterations
                  ? 'hit iteration limit'
                  : `exited abnormally (${abnormalExitReason})`,
    };
}

export function restoreConversationHistory(
    conversationManager: Pick<
        ConversationManager,
        'clearHistory' | 'prependHistoryMessages'
    >,
    history: Message[]
): void {
    conversationManager.clearHistory();
    conversationManager.prependHistoryMessages(history);
}

export function capturePipelinePhaseState(
    context: PhaseStateSnapshotContext,
    options: PipelinePhaseStateSnapshotOptions = {}
): PipelinePhaseStateSnapshot {
    return {
        conversationHistory: options.conversationHistory,
        findingStoreSnapshot: options.findingStoreSnapshot,
        selfReflectionScores:
            options.selfReflectionScores !== undefined
                ? structuredClone(options.selfReflectionScores)
                : undefined,
        investigatedFiles: context.executionContext.investigatedFiles
            ? new Set(context.executionContext.investigatedFiles)
            : undefined,
        completionReadiness: context.executionContext.completionReadiness
            ? structuredClone(context.executionContext.completionReadiness)
            : undefined,
        reasoningChainSnapshot:
            context.executionContext.reasoningChain?.createSnapshot(),
    };
}

export function restorePipelinePhaseState(
    context: PhaseStateSnapshotContext,
    snapshot: PipelinePhaseStateSnapshot
): void {
    if (snapshot.conversationHistory) {
        restoreConversationHistory(
            context.conversationManager,
            snapshot.conversationHistory
        );
    }

    if (snapshot.findingStoreSnapshot) {
        context.findingStore.restoreSnapshot(snapshot.findingStoreSnapshot);
    }

    if (
        'selfReflectionScores' in context &&
        snapshot.selfReflectionScores !== undefined
    ) {
        context.selfReflectionScores = structuredClone(
            snapshot.selfReflectionScores
        );
    }

    context.executionContext.investigatedFiles = snapshot.investigatedFiles
        ? new Set(snapshot.investigatedFiles)
        : undefined;

    context.executionContext.completionReadiness = snapshot.completionReadiness
        ? structuredClone(snapshot.completionReadiness)
        : undefined;

    if (snapshot.reasoningChainSnapshot) {
        context.executionContext.reasoningChain?.restoreSnapshot(
            snapshot.reasoningChainSnapshot
        );
    }
}

export interface BufferedToolCallHandler {
    handler: ToolCallHandler;
    flushCompletions(): void;
}

export function createBufferedHandler(
    source: ToolCallHandler
): BufferedToolCallHandler {
    const bufferedCallbacks: (
        | {
              type: 'start';
              args: Parameters<NonNullable<ToolCallHandler['onToolCallStart']>>;
          }
        | {
              type: 'complete';
              args: Parameters<
                  NonNullable<ToolCallHandler['onToolCallComplete']>
              >;
          }
    )[] = [];
    return {
        handler: {
            onIterationStart: source.onIterationStart,
            onToolCallStart: (...args) => {
                bufferedCallbacks.push({ type: 'start', args });
            },
            onToolCallComplete: (...args) => {
                bufferedCallbacks.push({ type: 'complete', args });
            },
            getContextStatusSuffix: source.getContextStatusSuffix,
        },
        flushCompletions() {
            for (const entry of bufferedCallbacks) {
                if (entry.type === 'start') {
                    source.onToolCallStart?.(...entry.args);
                } else {
                    source.onToolCallComplete?.(...entry.args);
                }
            }
            bufferedCallbacks.length = 0;
        },
    };
}

export function commitPipelinePhaseState(
    context: Pick<
        PipelineContext,
        | 'findingStore'
        | 'selfReflectionScores'
        | 'lastCommittedReviewText'
        | 'lastCommittedFindingStoreSnapshot'
        | 'lastCommittedSelfReflectionScores'
    >,
    reviewText: string
): void {
    context.lastCommittedReviewText = reviewText;
    context.lastCommittedFindingStoreSnapshot =
        context.findingStore.createSnapshot();
    context.lastCommittedSelfReflectionScores = structuredClone(
        context.selfReflectionScores
    );
}

export async function runGuardedConversationPhase(
    options: GuardedConversationPhaseOptions
): Promise<GuardedConversationPhaseResult> {
    const {
        context,
        label,
        maxIterations,
        tools,
        rollbackFindingStoreToSnapshot,
        rollbackConversationHistory,
    } = options;

    const { handler: phaseHandler, flushCompletions } = createBufferedHandler(
        context.handler
    );

    const rollbackState = capturePipelinePhaseState(context, {
        conversationHistory: rollbackConversationHistory,
        findingStoreSnapshot: rollbackFindingStoreToSnapshot,
    });

    const rollbackPhaseState = () => {
        restorePipelinePhaseState(context, rollbackState);
    };

    let latestReview: string;
    try {
        latestReview = await context.conversationRunner.run(
            {
                systemPrompt: context.systemPrompt,
                maxIterations,
                tools,
                disabledToolNames: context.disabledToolNames,
                label,
                requiresExplicitCompletion: true,
            },
            context.conversationManager,
            context.executionContext.cancellationToken,
            phaseHandler
        );
    } catch (error) {
        rollbackPhaseState();
        throw error;
    }

    const completion = classifyConversationCompletion(
        context.conversationRunner
    );

    if (!completion.completed) {
        rollbackPhaseState();
    } else {
        flushCompletions();
    }

    return { latestReview, completion };
}

export function filterTools(tools: ITool[], excludeNames: string[]): ITool[] {
    const excluded = new Set(excludeNames);
    return tools.filter((t) => !excluded.has(t.name));
}
