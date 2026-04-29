import {
    ALLOWED_FINDING_CATEGORIES,
    FAILURE_MECHANISMS,
    FINDING_SEVERITIES,
} from '../../types/findingTypes';
import type {
    FindingSource,
    RecordedFinding,
    FindingSeverity,
    FindingCategory,
} from '../../types/findingTypes';
import type { HeadlessAnalysisResult } from '../headlessRunner';

/**
 * Headless analysis JSON accepts `sources` as an optional array without
 * rejecting malformed members up front, so per-finding consumers must treat
 * those entries as untrusted until they sanitize them.
 */
export type HarnessRecordedFinding = Omit<RecordedFinding, 'sources'> & {
    sources?: Array<Partial<FindingSource> | unknown>;
};

export type HarnessHeadlessAnalysisResult = Omit<
    HeadlessAnalysisResult,
    'findings'
> & {
    findings: HarnessRecordedFinding[];
};

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
    | 'judge';

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
    kind:
        | 'judge-unavailable'
        | 'judge-failed'
        | 'classification-failed'
        | 'invalid-sources';
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

function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

export function isResolutionJudgeVerdict(
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

    if (!isNonEmptyString(payload.diffText)) {
        return 'diffText must be a non-empty string';
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

function getRecordedFindingValidationError(
    finding: unknown,
    fieldName: string
): string | null {
    if (!isObjectRecord(finding)) {
        return `${fieldName} must be an object`;
    }
    if (!isNonEmptyString(finding.id)) {
        return `${fieldName}.id must be a non-empty string`;
    }
    if (!isNonEmptyString(finding.agentId)) {
        return `${fieldName}.agentId must be a non-empty string`;
    }
    if (!isFiniteNumber(finding.timestamp)) {
        return `${fieldName}.timestamp must be a finite number`;
    }
    if (
        !(FINDING_SEVERITIES as readonly string[]).includes(
            String(finding.severity)
        )
    ) {
        return `${fieldName}.severity must be one of ${(FINDING_SEVERITIES as readonly string[]).join(', ')}`;
    }
    if (
        !(ALLOWED_FINDING_CATEGORIES as readonly string[]).includes(
            String(finding.category)
        )
    ) {
        return (
            `${fieldName}.category must be one of ` +
            (ALLOWED_FINDING_CATEGORIES as readonly string[]).join(', ')
        );
    }
    if (!isNonEmptyString(finding.title)) {
        return `${fieldName}.title must be a non-empty string`;
    }
    if (!isNonEmptyString(finding.file)) {
        return `${fieldName}.file must be a non-empty string`;
    }
    if (
        !Array.isArray(finding.lineRange) ||
        finding.lineRange.length !== 2 ||
        !isPositiveInteger(finding.lineRange[0]) ||
        !isPositiveInteger(finding.lineRange[1]) ||
        finding.lineRange[1] < finding.lineRange[0]
    ) {
        return `${fieldName}.lineRange must be a two-element array of positive integers with end >= start`;
    }
    if (!isNonEmptyString(finding.description)) {
        return `${fieldName}.description must be a non-empty string`;
    }
    if (!isNonEmptyString(finding.affectedComponent)) {
        return `${fieldName}.affectedComponent must be a non-empty string`;
    }
    if (
        !(FAILURE_MECHANISMS as readonly string[]).includes(
            String(finding.failureMechanism)
        )
    ) {
        return `${fieldName}.failureMechanism must be one of ${(FAILURE_MECHANISMS as readonly string[]).join(', ')}`;
    }
    if (
        !Array.isArray(finding.supportingToolCalls) ||
        finding.supportingToolCalls.some(
            (toolCallId) => !isNonEmptyString(toolCallId)
        )
    ) {
        return `${fieldName}.supportingToolCalls must be an array of non-empty strings`;
    }
    if (!isObjectRecord(finding.disproof)) {
        return `${fieldName}.disproof must be an object`;
    }
    if (typeof finding.disproof.attempted !== 'boolean') {
        return `${fieldName}.disproof.attempted must be a boolean`;
    }
    if (typeof finding.disproof.method !== 'string') {
        return `${fieldName}.disproof.method must be a string`;
    }
    if (typeof finding.disproof.result !== 'string') {
        return `${fieldName}.disproof.result must be a string`;
    }
    if (!Array.isArray(finding.verifiableClaims)) {
        return `${fieldName}.verifiableClaims must be an array`;
    }
    if (finding.sources !== undefined && !Array.isArray(finding.sources)) {
        return `${fieldName}.sources must be an array when provided`;
    }
    if (finding.lspValidation !== undefined) {
        if (!isObjectRecord(finding.lspValidation)) {
            return `${fieldName}.lspValidation must be an object when provided`;
        }
        if (
            !['verified', 'refuted', 'inconclusive', 'pending'].includes(
                String(finding.lspValidation.status)
            )
        ) {
            return `${fieldName}.lspValidation.status must be one of verified, refuted, inconclusive, or pending`;
        }
        if (typeof finding.lspValidation.details !== 'string') {
            return `${fieldName}.lspValidation.details must be a string`;
        }
        if (!Array.isArray(finding.lspValidation.claimResults)) {
            return `${fieldName}.lspValidation.claimResults must be an array`;
        }
    }
    return null;
}

function getToolCallRecordValidationError(
    record: unknown,
    fieldName: string
): string | null {
    if (!isObjectRecord(record)) {
        return `${fieldName} must be an object`;
    }
    if (!isNonEmptyString(record.id)) {
        return `${fieldName}.id must be a non-empty string`;
    }
    if (!isNonEmptyString(record.toolName)) {
        return `${fieldName}.toolName must be a non-empty string`;
    }
    if (typeof record.success !== 'boolean') {
        return `${fieldName}.success must be a boolean`;
    }
    if (!isFiniteNumber(record.timestamp)) {
        return `${fieldName}.timestamp must be a finite number`;
    }
    if (typeof record.arguments !== 'object' || record.arguments === null) {
        return `${fieldName}.arguments must be an object`;
    }
    if (
        typeof record.result !== 'string' &&
        (typeof record.result !== 'object' || record.result === null)
    ) {
        return `${fieldName}.result must be a string or object`;
    }
    if (record.error !== undefined && typeof record.error !== 'string') {
        return `${fieldName}.error must be a string when provided`;
    }
    if (record.durationMs !== undefined && !isFiniteNumber(record.durationMs)) {
        return `${fieldName}.durationMs must be a finite number when provided`;
    }
    if (
        record.executionTimeMs !== undefined &&
        !isFiniteNumber(record.executionTimeMs)
    ) {
        return `${fieldName}.executionTimeMs must be a finite number when provided`;
    }
    if (
        record.iterationsUsed !== undefined &&
        !isNonNegativeInteger(record.iterationsUsed)
    ) {
        return `${fieldName}.iterationsUsed must be a non-negative integer when provided`;
    }
    if (record.nestedCalls !== undefined) {
        if (!Array.isArray(record.nestedCalls)) {
            return `${fieldName}.nestedCalls must be an array when provided`;
        }
        for (let index = 0; index < record.nestedCalls.length; index++) {
            const error = getToolCallRecordValidationError(
                record.nestedCalls[index],
                `${fieldName}.nestedCalls[${index}]`
            );
            if (error) {
                return error;
            }
        }
    }
    return null;
}

export function getHeadlessAnalysisResultValidationError(
    result: unknown
): string | null {
    if (!isObjectRecord(result)) {
        return 'result must be a JSON object';
    }
    if (!Array.isArray(result.findings)) {
        return 'result.findings must be an array';
    }
    for (let index = 0; index < result.findings.length; index++) {
        const error = getRecordedFindingValidationError(
            result.findings[index],
            `result.findings[${index}]`
        );
        if (error) {
            return error;
        }
    }
    if (typeof result.narrative !== 'string') {
        return 'result.narrative must be a string';
    }
    if (!isObjectRecord(result.telemetry)) {
        return 'result.telemetry must be a JSON object';
    }
    if (!isNonNegativeInteger(result.telemetry.iterations)) {
        return 'result.telemetry.iterations must be a non-negative integer';
    }
    if (!isNonNegativeInteger(result.telemetry.toolCalls)) {
        return 'result.telemetry.toolCalls must be a non-negative integer';
    }
    if (!isNonNegativeInteger(result.telemetry.promptTokens)) {
        return 'result.telemetry.promptTokens must be a non-negative integer';
    }
    if (!isNonNegativeInteger(result.telemetry.completionTokens)) {
        return 'result.telemetry.completionTokens must be a non-negative integer';
    }
    if (!isNonNegativeInteger(result.telemetry.durationMs)) {
        return 'result.telemetry.durationMs must be a non-negative integer';
    }
    if (!isNonNegativeInteger(result.telemetry.compactionsUsed)) {
        return 'result.telemetry.compactionsUsed must be a non-negative integer';
    }
    if (typeof result.completed !== 'boolean') {
        return 'result.completed must be a boolean';
    }
    if (typeof result.wasTruncated !== 'boolean') {
        return 'result.wasTruncated must be a boolean';
    }
    if (!Array.isArray(result.rawToolCallLog)) {
        return 'result.rawToolCallLog must be an array';
    }
    for (let index = 0; index < result.rawToolCallLog.length; index++) {
        const error = getToolCallRecordValidationError(
            result.rawToolCallLog[index],
            `result.rawToolCallLog[${index}]`
        );
        if (error) {
            return error;
        }
    }
    if (!isNonEmptyString(result.modelId)) {
        return 'result.modelId must be a non-empty string';
    }
    if (!isNonNegativeInteger(result.seed)) {
        return 'result.seed must be a non-negative integer';
    }
    return null;
}

export interface MatchedPair {
    expected: ExpectedFinding;
    produced: HarnessRecordedFinding;
    matchReason: 'category' | 'severity' | 'both';
}

export interface MatchResult {
    matched: MatchedPair[];
    missedExpected: ExpectedFinding[];
    falsePositives: HarnessRecordedFinding[];
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
    cellDurationMs: number;
    ok: boolean;
    errorMessage: string | null;
    resolutionWarning: string | null;
    result: HarnessHeadlessAnalysisResult | null;
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
