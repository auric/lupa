import type { VerifiableClaim, ClaimValidationResult } from './claimTypes';

export const FINDING_SEVERITIES = [
    'CRITICAL',
    'HIGH',
    'MEDIUM',
    'LOW',
] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const ALLOWED_FINDING_CATEGORIES = [
    'logic_error',
    'security_vulnerability',
    'resource_leak',
    'api_misuse',
    'error_handling_gap',
    'data_integrity',
    'regression_risk',
] as const;
export type FindingCategory = (typeof ALLOWED_FINDING_CATEGORIES)[number];

export interface RecordedFinding {
    id: string;
    agentId: string;
    timestamp: number;
    severity: FindingSeverity;
    category: FindingCategory;
    title: string;
    file: string;
    lineRange: [number, number];
    description: string;
    verificationEvidence?: string;
    supportingToolCalls: string[];
    disproof: FindingDisproof;
    verifiableClaims: VerifiableClaim[];
    lspValidation: LspValidationStatus | undefined;
}

export interface FindingDisproof {
    attempted: boolean;
    method: string;
    result: string;
}

export interface LspValidationStatus {
    status: 'verified' | 'refuted' | 'inconclusive' | 'pending';
    details: string;
    claimResults: ClaimValidationResult[];
}

export interface FindingQuery {
    file: string | undefined;
    severity: FindingSeverity | undefined;
    agentId: string | undefined;
}
