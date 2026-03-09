export type ClaimType =
    | 'symbol_unused'
    | 'type_mismatch'
    | 'symbol_missing'
    | 'not_exported'
    | 'no_callers'
    | 'no_implementation';

export interface ClaimValidationRequest {
    claimType: ClaimType;
    file: string;
    line: number;
    symbol: string;
    expectedValue: string | undefined;
}

export interface ClaimValidationResult {
    claimType: ClaimType;
    verified: boolean;
    confidence: 'definitive' | 'probable' | 'inconclusive';
    evidence: string;
    groundTruth: string;
}

export interface VerifiableClaim {
    claimType: ClaimType;
    file: string;
    line: number;
    symbol: string;
    assertion: string;
}
