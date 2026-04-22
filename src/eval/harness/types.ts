import type {
    RecordedFinding,
    FindingSeverity,
    FindingCategory,
} from '../../types/findingTypes';
import type { HeadlessAnalysisResult } from '../headlessRunner';

export type FixtureKind = 'synthetic' | 'real';

export interface ExpectedFinding {
    severity: FindingSeverity;
    category: FindingCategory;
    path: string;
    lineHint: number;
    mustMention: string[];
    resolvedByDefault?: boolean;
}

export interface FixtureLabels {
    intent: string;
    expected_findings: ExpectedFinding[];
    minFilesExamined: number;
    maxFalsePositivesTolerated: number;
}

export interface RealFixtureFile extends FixtureLabels {
    repo: string;
    baseSha: string;
    headSha: string;
    mergeSha: string;
}

export interface LoadedFixture {
    name: string;
    kind: FixtureKind;
    labels: FixtureLabels;
    /** Absolute path of the workspace root the headless runner should be invoked against. */
    workspaceRoot: string;
    baseRef: string;
    headRef: string;
    mergeRef: string | undefined;
}

export type ResolutionVerdict =
    | 'resolved'
    | 'unresolved'
    | 'disputed'
    | 'noise';

export type ResolutionMetricStatus =
    | 'valid'
    | 'no-findings'
    | 'invalid-skipped';

export type ResolutionMethod =
    | 'synthetic-match'
    | 'label-override'
    | 'source-overlap'
    | 'line-range-fallback'
    | 'judge'
    | 'judge-unavailable';

export interface FindingResolution {
    findingId: string;
    severity: FindingSeverity;
    verdict: ResolutionVerdict;
    method: ResolutionMethod;
    path: string;
    reason: string;
    matchedLabelPath?: string;
    judgeModelId?: string;
}

export interface ResolutionWarning {
    findingId: string;
    severity: FindingSeverity;
    kind: 'judge-unavailable' | 'judge-failed' | 'classification-failed';
    path: string;
    message: string;
}

export interface ResolutionBucket {
    attempted: number;
    skipped: number;
    total: number;
    resolved: number;
    unresolved: number;
    disputed: number;
    noise: number;
    resolutionRate: number;
    metricStatus: ResolutionMetricStatus;
}

export interface ResolutionSummary extends ResolutionBucket {
    attempted: number;
    skipped: number;
    bySeverity: Partial<Record<FindingSeverity, ResolutionBucket>>;
    findings: FindingResolution[];
    warnings: ResolutionWarning[];
}

export interface ResolutionJudgePayload {
    finding: RecordedFinding;
    diffText: string;
}

export type ResolutionJudgeVerdict =
    | 'resolved'
    | 'unresolved'
    | 'disputed'
    | 'noise';

export interface ResolutionJudgeResult {
    verdict: ResolutionJudgeVerdict;
    reason: string;
    modelId: string;
}

export interface MatchedPair {
    expected: ExpectedFinding;
    produced: RecordedFinding;
    matchReason: 'category' | 'severity' | 'both';
}

export interface MatchResult {
    matched: MatchedPair[];
    missedExpected: ExpectedFinding[];
    falsePositives: RecordedFinding[];
    precision: number;
    recall: number;
    f1: number;
}

export interface SingleRun {
    fixture: string;
    kind: FixtureKind;
    model: string;
    seed: number;
    durationMs: number;
    ok: boolean;
    errorMessage: string | null;
    resolutionWarning: string | null;
    result: HeadlessAnalysisResult | null;
    match: MatchResult | null;
    resolution: ResolutionSummary | null;
}

export interface AggregateStats {
    count: number;
    mean: number;
    stddev: number;
    invalidCount: number;
    noFindingsCount: number;
}

export interface PerModelAggregate {
    model: string;
    precision: AggregateStats;
    recall: AggregateStats;
    f1: AggregateStats;
    resolutionRate: AggregateStats;
    resolutionRateBySeverity: Partial<Record<FindingSeverity, AggregateStats>>;
    iterations: AggregateStats;
    promptTokens: AggregateStats;
    completionTokens: AggregateStats;
    costUsd: AggregateStats;
    wallClockMs: AggregateStats;
    runs: number;
    failures: number;
}

export interface PerFixtureAggregate {
    fixture: string;
    kind: FixtureKind;
    perModel: PerModelAggregate[];
}

export interface HarnessReport {
    generatedAt: string;
    gitSha: string;
    models: string[];
    seeds: number;
    fixtures: string[];
    perFixture: PerFixtureAggregate[];
    perModel: PerModelAggregate[];
    rawRuns: SingleRun[];
}
