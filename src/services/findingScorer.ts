import type {
    RecordedFinding,
    FindingCategory,
    FindingSeverity,
} from '../types/findingTypes';
import type { ToolCallRecord } from '../types/toolCallTypes';
import type { ModelCalibrationProfile } from '../models/modelCalibration';

export interface ScoringContext {
    toolCallRecords: ToolCallRecord[];
    calibrationProfile: ModelCalibrationProfile;
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

const SEVERITY_EVIDENCE_REQUIREMENTS: Record<FindingSeverity, number> = {
    CRITICAL: 3,
    HIGH: 2,
    MEDIUM: 1,
    LOW: 0,
};

function toolCallMatchesFile(record: ToolCallRecord, file: string): boolean {
    const normalizedFile = file.replace(/\\/g, '/');
    const args = JSON.stringify(record.arguments).replace(/\\/g, '/');
    const fileName = normalizedFile.split('/').pop()!;
    return args.includes(normalizedFile) || args.includes(fileName);
}

function scoreSupportingToolCalls(
    finding: RecordedFinding,
    toolCallRecords: ToolCallRecord[]
): SignalBreakdown {
    const weight = 25;
    const claimed = finding.supportingToolCalls;
    if (claimed.length === 0) {
        return {
            signal: 'supportingToolCalls',
            rawValue: 0,
            weight,
            contribution: 0,
        };
    }

    const recordIds = new Set(toolCallRecords.map((r) => r.id));
    const verified = claimed.filter((id) => recordIds.has(id)).length;
    const rawValue = verified / claimed.length;
    return {
        signal: 'supportingToolCalls',
        rawValue,
        weight,
        contribution: rawValue * weight,
    };
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

function scoreSeverityEvidenceRatio(
    finding: RecordedFinding,
    toolCallRecords: ToolCallRecord[]
): SignalBreakdown {
    const weight = 10;
    const required = SEVERITY_EVIDENCE_REQUIREMENTS[finding.severity];

    if (required === 0) {
        return {
            signal: 'severityEvidenceRatio',
            rawValue: 1,
            weight,
            contribution: 10,
        };
    }

    const recordIds = new Set(toolCallRecords.map((r) => r.id));
    const verifiedCount = finding.supportingToolCalls.filter((id) =>
        recordIds.has(id)
    ).length;

    let contribution: number;
    if (verifiedCount >= required) {
        contribution = 10;
    } else if (verifiedCount >= required - 1 && verifiedCount > 0) {
        contribution = 5;
    } else {
        contribution = 0;
    }

    return {
        signal: 'severityEvidenceRatio',
        rawValue: verifiedCount,
        weight,
        contribution,
    };
}

function scoreModelBias(
    calibrationProfile: ModelCalibrationProfile
): SignalBreakdown {
    const weight = 8;
    const bias = calibrationProfile.findingBias;

    let contribution: number;
    if (bias === 'dismissive') {
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

function getRecommendation(score: number): 'keep' | 'drop' | 'downgrade' {
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
    const signals: SignalBreakdown[] = [
        scoreSupportingToolCalls(finding, context.toolCallRecords),
        scoreInvestigationDepth(finding, context.toolCallRecords),
        scoreDisproofAttempted(finding),
        scoreLspValidation(finding),
        scoreSeverityEvidenceRatio(finding, context.toolCallRecords),
        scoreModelBias(context.calibrationProfile),
        scoreCategoryRisk(finding),
        scoreDescriptionQuality(finding),
    ];

    const overallScore = signals.reduce((sum, s) => sum + s.contribution, 0);

    return {
        findingId: finding.id,
        overallScore,
        signals,
        recommendation: getRecommendation(overallScore),
    };
}

export function scoreAll(
    findings: RecordedFinding[],
    context: ScoringContext
): FindingScore[] {
    return findings.map((f) => scoreFinding(f, context));
}
