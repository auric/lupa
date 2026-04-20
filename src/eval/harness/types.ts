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
}

export interface LoadedFixture {
    name: string;
    kind: FixtureKind;
    labels: FixtureLabels;
    /** Absolute path of the workspace root the headless runner should be invoked against. */
    workspaceRoot: string;
    baseRef: string;
    headRef: string;
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
    result: HeadlessAnalysisResult | null;
    match: MatchResult | null;
}

export interface AggregateStats {
    count: number;
    mean: number;
    stddev: number;
}

export interface PerModelAggregate {
    model: string;
    precision: AggregateStats;
    recall: AggregateStats;
    f1: AggregateStats;
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
