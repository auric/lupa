import {
    ALLOWED_FINDING_CATEGORIES,
    FINDING_SEVERITIES,
} from '../../types/findingTypes';
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

function isObjectRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

function isResolutionJudgeVerdict(
    value: unknown
): value is ResolutionJudgeVerdict {
    return (
        value === 'resolved' ||
        value === 'unresolved' ||
        value === 'disputed' ||
        value === 'noise'
    );
}

export function getResolutionJudgePayloadValidationError(
    payload: unknown
): string | null {
    if (!isObjectRecord(payload)) {
        return 'payload must be a JSON object';
    }

    if (!isObjectRecord(payload.finding)) {
        return 'finding must be a JSON object';
    }

    const finding = payload.finding;
    if (!isNonEmptyString(finding.title)) {
        return 'finding.title must be a non-empty string';
    }
    if (
        !(FINDING_SEVERITIES as readonly string[]).includes(
            String(finding.severity)
        )
    ) {
        return `finding.severity must be one of ${(FINDING_SEVERITIES as readonly string[]).join(', ')}`;
    }
    if (
        !(ALLOWED_FINDING_CATEGORIES as readonly string[]).includes(
            String(finding.category)
        )
    ) {
        return (
            'finding.category must be one of ' +
            (ALLOWED_FINDING_CATEGORIES as readonly string[]).join(', ')
        );
    }
    if (!isNonEmptyString(finding.file)) {
        return 'finding.file must be a non-empty string';
    }
    if (
        !Array.isArray(finding.lineRange) ||
        finding.lineRange.length !== 2 ||
        !isPositiveInteger(finding.lineRange[0]) ||
        !isPositiveInteger(finding.lineRange[1]) ||
        finding.lineRange[1] < finding.lineRange[0]
    ) {
        return 'finding.lineRange must be a two-element array of positive integers with end >= start';
    }
    if (!isNonEmptyString(finding.description)) {
        return 'finding.description must be a non-empty string';
    }
    if (finding.sources !== undefined) {
        if (!Array.isArray(finding.sources)) {
            return 'finding.sources must be an array when provided';
        }
        for (let index = 0; index < finding.sources.length; index++) {
            const source = finding.sources[index];
            if (!isObjectRecord(source)) {
                return `finding.sources[${index}] must be an object`;
            }
            if (!isNonEmptyString(source.path)) {
                return `finding.sources[${index}].path must be a non-empty string`;
            }
            if (!isPositiveInteger(source.lineStart)) {
                return `finding.sources[${index}].lineStart must be a positive integer`;
            }
            if (!isPositiveInteger(source.lineEnd)) {
                return `finding.sources[${index}].lineEnd must be a positive integer`;
            }
            if (source.lineEnd < source.lineStart) {
                return `finding.sources[${index}].lineEnd must be >= lineStart`;
            }
        }
    }

    if (typeof payload.diffText !== 'string') {
        return 'diffText must be a string';
    }

    return null;
}

export function getResolutionJudgeResultValidationError(
    result: unknown
): string | null {
    if (!isObjectRecord(result)) {
        return 'result must be a JSON object';
    }
    if (!isResolutionJudgeVerdict(result.verdict)) {
        return 'result.verdict must be one of resolved, unresolved, disputed, or noise';
    }
    if (!isNonEmptyString(result.reason)) {
        return 'result.reason must be a non-empty string';
    }
    if (!isNonEmptyString(result.modelId)) {
        return 'result.modelId must be a non-empty string';
    }
    return null;
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
