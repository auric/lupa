import type { RecordedFinding, FindingCategory } from '../types/findingTypes';
import { CONCRETE_FAILURE_MECHANISMS } from '../types/findingTypes';
import type { ToolCallRecord } from '../types/toolCallTypes';
import type { ModelCalibrationProfile } from '../models/modelCalibration';
import { flattenToolCalls } from '../utils/investigationAudit';

export interface ScoringContext {
    toolCallRecords: ToolCallRecord[];
    calibrationProfile: ModelCalibrationProfile;
    /** Rejection rate from FeedbackStore for this finding's category+model combo. */
    feedbackRejectionRate?: number;
    /** Total feedback entries for this category+model combo. */
    feedbackTotalEntries?: number;
}

export interface SignalBreakdown {
    signal: string;
    rawValue: number;
    weight: number;
    contribution: number;
}

export interface FindingScore {
    findingId: string;
    overallScore: number;
    signals: SignalBreakdown[];
    recommendation: 'keep' | 'drop' | 'downgrade';
}

/** Score below which findings are dropped */
export const DROP_THRESHOLD = 25;

/** Score below which findings are downgraded one severity level */
export const DOWNGRADE_THRESHOLD = 45;

const HIGH_RISK_CATEGORIES: ReadonlySet<FindingCategory> = new Set([
    'security_vulnerability',
    'logic_error',
    'data_integrity',
]);

const MEDIUM_RISK_CATEGORIES: ReadonlySet<FindingCategory> = new Set([
    'error_handling_gap',
    'resource_leak',
]);

function toolCallMatchesFile(record: ToolCallRecord, file: string): boolean {
    const normalizedFile = file.replace(/\\/g, '/');
    const fileName = normalizedFile.split('/').pop()!;
    // Check structured argument fields for exact path matches
    // instead of substring matching on serialized JSON
    const argValues = Object.values(record.arguments).filter(
        (v): v is string => typeof v === 'string'
    );
    return argValues.some((v) => {
        const normalized = v.replace(/\\/g, '/');
        return (
            normalized === normalizedFile ||
            normalized.endsWith(normalizedFile) ||
            normalizedFile.endsWith(normalized) ||
            normalized === fileName
        );
    });
}

function scoreInvestigationDepth(
    finding: RecordedFinding,
    toolCallRecords: ToolCallRecord[]
): SignalBreakdown {
    const weight = 20;
    const matchingCalls = toolCallRecords.filter((r) =>
        toolCallMatchesFile(r, finding.file)
    ).length;

    let contribution: number;
    if (matchingCalls === 0) {
        contribution = 0;
    } else if (matchingCalls === 1) {
        contribution = 5;
    } else if (matchingCalls === 2) {
        contribution = 10;
    } else if (matchingCalls === 3) {
        contribution = 15;
    } else {
        contribution = 20;
    }

    return {
        signal: 'investigationDepth',
        rawValue: matchingCalls,
        weight,
        contribution,
    };
}

function scoreDisproofAttempted(finding: RecordedFinding): SignalBreakdown {
    const weight = 15;
    const attempted = finding.disproof.attempted;
    return {
        signal: 'disproofAttempted',
        rawValue: attempted ? 1 : 0,
        weight,
        contribution: attempted ? 15 : 0,
    };
}

function scoreLspValidation(finding: RecordedFinding): SignalBreakdown {
    const weight = 15;
    const status = finding.lspValidation?.status;

    let contribution: number;
    if (status === 'verified') {
        contribution = 15;
    } else if (status === 'inconclusive') {
        contribution = 8;
    } else if (status === 'refuted') {
        contribution = 0;
    } else {
        contribution = 5;
    }

    return {
        signal: 'lspValidation',
        rawValue: contribution / weight,
        weight,
        contribution,
    };
}

function scoreModelBias(
    calibrationProfile: ModelCalibrationProfile
): SignalBreakdown {
    const weight = 8;
    const bias = calibrationProfile.findingBias;

    // Under prosecution mode, dismissive models are pushed to report —
    // the "if they report it, it must be real" assumption no longer holds.
    // Only give bonus when the model is naturally reluctant (devils-advocate).
    let contribution: number;
    if (
        bias === 'dismissive' &&
        calibrationProfile.challengeMode === 'prosecution'
    ) {
        contribution = 0;
    } else if (bias === 'dismissive') {
        contribution = 8;
    } else if (bias === 'balanced') {
        contribution = 4;
    } else {
        contribution = 0;
    }

    return {
        signal: 'modelBias',
        rawValue: contribution / weight,
        weight,
        contribution,
    };
}

function scoreCategoryRisk(finding: RecordedFinding): SignalBreakdown {
    const weight = 5;
    let contribution: number;

    if (HIGH_RISK_CATEGORIES.has(finding.category)) {
        contribution = 5;
    } else if (MEDIUM_RISK_CATEGORIES.has(finding.category)) {
        contribution = 3;
    } else {
        contribution = 1;
    }

    return {
        signal: 'categoryRisk',
        rawValue: contribution / weight,
        weight,
        contribution,
    };
}

function scoreDescriptionQuality(finding: RecordedFinding): SignalBreakdown {
    const weight = 2;
    const len = finding.description.length;

    let contribution: number;
    if (len > 200) {
        contribution = 2;
    } else if (len >= 50) {
        contribution = 1;
    } else {
        contribution = 0;
    }

    return {
        signal: 'descriptionQuality',
        rawValue: len,
        weight,
        contribution,
    };
}

/**
 * Feedback history signal: adjusts score based on historical user feedback.
 * Centered at 0: rejectionRate=0.5 → 0 contribution, below → bonus, above → penalty.
 * Only meaningful when feedbackTotalEntries >= MIN_FEEDBACK_ENTRIES.
 */
const MIN_FEEDBACK_ENTRIES = 5;

function scoreFeedbackHistory(rejectionRate: number): SignalBreakdown {
    const weight = 10;
    // rejectionRate 0 → +5, 0.5 → 0, 1.0 → -5
    const contribution = Math.round((0.5 - rejectionRate) * weight * 10) / 10;
    return {
        signal: 'feedbackHistory',
        rawValue: rejectionRate,
        weight,
        contribution,
    };
}

const ABSENCE_LANGUAGE_PATTERN =
    /\b(missing|lacks|doesn't check|no validation|not validated|doesn't handle|no error handling|absent|omitted|doesn't verify|no check|not checked)\b/i;

const CONCRETE_FAILURE_MECHANISMS_SET: ReadonlySet<string> = new Set(
    CONCRETE_FAILURE_MECHANISMS
);

function scoreAbsencePattern(finding: RecordedFinding): SignalBreakdown {
    const weight = 15;

    const hasAbsenceLanguage = ABSENCE_LANGUAGE_PATTERN.test(
        finding.description
    );

    if (!hasAbsenceLanguage) {
        return {
            signal: 'absencePattern',
            rawValue: 0,
            weight,
            contribution: 0,
        };
    }

    const hasConcreteFailure = CONCRETE_FAILURE_MECHANISMS_SET.has(
        finding.failureMechanism
    );

    if (hasConcreteFailure) {
        return {
            signal: 'absencePattern',
            rawValue: 0.5,
            weight,
            contribution: -5,
        };
    }

    return {
        signal: 'absencePattern',
        rawValue: 1,
        weight,
        contribution: -15,
    };
}

const SYMBOL_TOKEN_PATTERN = /\b([a-zA-Z_]\w{2,})\b/g;

const TOOL_ARG_SYMBOL_FIELDS: ReadonlySet<string> = new Set([
    'symbol',
    'symbol_name',
    'name',
    'name_path',
]);

function scoreAffectedComponentVerified(
    finding: RecordedFinding,
    toolCallRecords: ToolCallRecord[]
): SignalBreakdown {
    const weight = 15;
    const tokens = new Set<string>();
    for (const match of finding.affectedComponent.matchAll(
        SYMBOL_TOKEN_PATTERN
    )) {
        tokens.add(match[1]!);
    }

    if (tokens.size === 0) {
        return {
            signal: 'affectedComponentVerified',
            rawValue: 0,
            weight,
            contribution: 0,
        };
    }

    const verified = [...tokens].some((token) =>
        toolCallRecords.some((r) => {
            for (const [key, val] of Object.entries(r.arguments)) {
                if (!TOOL_ARG_SYMBOL_FIELDS.has(key)) {
                    continue;
                }
                if (typeof val === 'string' && val.includes(token)) {
                    return true;
                }
            }
            return false;
        })
    );

    return {
        signal: 'affectedComponentVerified',
        rawValue: verified ? 1 : 0,
        weight,
        contribution: verified ? 15 : -5,
    };
}

function scoreEvidenceAuditVerdict(finding: RecordedFinding): SignalBreakdown {
    const signal = 'evidenceAuditVerdict';
    const weight = 15;

    if (finding.evidenceVerdict === 'weak-evidence') {
        return { signal, rawValue: 1, weight, contribution: -weight };
    }
    if (finding.evidenceVerdict === 'downgrade') {
        return {
            signal,
            rawValue: 0.5,
            weight,
            contribution: -Math.round(weight * 0.5),
        };
    }
    return { signal, rawValue: 0, weight, contribution: 0 };
}

function scoreCrossFileEvidence(
    finding: RecordedFinding,
    toolCallRecords: ToolCallRecord[]
): SignalBreakdown {
    const weight = 10;

    const normalize = (p: string) => p.replace(/\\/g, '/');
    const distinctFiles = new Set<string>();
    distinctFiles.add(normalize(finding.file));

    for (const record of toolCallRecords) {
        for (const val of Object.values(record.arguments)) {
            if (typeof val !== 'string') {
                continue;
            }
            const norm = normalize(val);
            if (
                norm.includes('/') &&
                /\.\w+$/.test(norm) &&
                toolCallRecords.some((r) => toolCallMatchesFile(r, norm))
            ) {
                distinctFiles.add(norm);
            }
        }
    }

    let contribution: number;
    if (distinctFiles.size >= 3) {
        contribution = 10;
    } else if (distinctFiles.size === 2) {
        contribution = 5;
    } else {
        contribution = 0;
    }

    return {
        signal: 'crossFileEvidence',
        rawValue: distinctFiles.size,
        weight,
        contribution,
    };
}

function getRecommendationFromScore(
    score: number
): 'keep' | 'drop' | 'downgrade' {
    if (score < DROP_THRESHOLD) {
        return 'drop';
    }
    if (score < DOWNGRADE_THRESHOLD) {
        return 'downgrade';
    }
    return 'keep';
}

export function scoreFinding(
    finding: RecordedFinding,
    context: ScoringContext
): FindingScore {
    // Flatten nested calls so subagent-produced tool calls are included in scoring
    const flatRecords = flattenToolCalls(context.toolCallRecords);
    const signals: SignalBreakdown[] = [
        scoreInvestigationDepth(finding, flatRecords),
        scoreDisproofAttempted(finding),
        scoreLspValidation(finding),
        scoreModelBias(context.calibrationProfile),
        scoreCategoryRisk(finding),
        scoreDescriptionQuality(finding),
        scoreAbsencePattern(finding),
        scoreAffectedComponentVerified(finding, flatRecords),
        scoreCrossFileEvidence(finding, flatRecords),
        scoreEvidenceAuditVerdict(finding),
    ];

    if (
        context.feedbackRejectionRate !== undefined &&
        context.feedbackTotalEntries !== undefined &&
        context.feedbackTotalEntries >= MIN_FEEDBACK_ENTRIES
    ) {
        signals.push(scoreFeedbackHistory(context.feedbackRejectionRate));
    }

    const overallScore = signals.reduce((sum, s) => sum + s.contribution, 0);

    return {
        findingId: finding.id,
        overallScore,
        signals,
        recommendation: getRecommendationFromScore(overallScore),
    };
}

export function scoreAll(
    findings: RecordedFinding[],
    context: ScoringContext
): FindingScore[] {
    return findings.map((f) => scoreFinding(f, context));
}
