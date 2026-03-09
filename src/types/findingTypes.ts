import type { VerifiableClaim, ClaimValidationResult } from './claimTypes';

export type FindingSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface RecordedFinding {
    id: string;
    agentId: string;
    timestamp: number;
    severity: FindingSeverity;
    category: string;
    title: string;
    file: string;
    lineRange: [number, number];
    description: string;
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
