import * as vscode from 'vscode';
import type { DiffHunk } from '../types/contextTypes';
import type {
    RecordedFinding,
    FindingSeverity,
    LspValidationStatus,
} from '../types/findingTypes';
import type {
    ClaimValidationRequest,
    ClaimValidationResult,
} from '../types/claimTypes';
import type { LspValidationService } from './lspValidationService';
import { isCancellationError } from '../utils/asyncUtils';
import { getErrorMessage } from '../utils/errorUtils';
import { Log } from './loggingService';

export type ValidationVerdict = 'keep' | 'drop' | 'downgrade';

export interface ValidatedFinding {
    finding: RecordedFinding;
    verdict: ValidationVerdict;
    downgradedSeverity: FindingSeverity | undefined;
    violations: string[];
}

export interface ValidationResult {
    validated: ValidatedFinding[];
    dropped: number;
    downgraded: number;
    kept: number;
}

const SEVERITY_REQUIRING_EVIDENCE = new Set([
    'CRITICAL',
    'HIGH',
    'MEDIUM',
] as FindingSeverity[]);
const SEVERITY_REQUIRING_DISPROOF = new Set([
    'CRITICAL',
    'HIGH',
] as FindingSeverity[]);

const SEVERITY_ORDER: FindingSeverity[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

function downgradeSeverity(severity: FindingSeverity): FindingSeverity {
    const idx = SEVERITY_ORDER.indexOf(severity);
    return SEVERITY_ORDER[Math.max(0, idx - 1)]!;
}

export class FindingValidator {
    constructor(private readonly lspValidation: LspValidationService) {}

    async validate(
        findings: RecordedFinding[],
        parsedDiff: DiffHunk[],
        token: vscode.CancellationToken
    ): Promise<ValidationResult> {
        const changedFiles = new Set(parsedDiff.map((d) => d.filePath));
        const validated: ValidatedFinding[] = [];

        for (const finding of findings) {
            if (token.isCancellationRequested) {
                throw new vscode.CancellationError();
            }

            const violations: string[] = [];
            let verdict: ValidationVerdict = 'keep';
            let downgradedSeverity: FindingSeverity | undefined;

            if (!this.checkFileInDiff(finding, changedFiles)) {
                violations.push('File not in changed files');
                verdict = 'drop';
            }

            if (!this.checkLineRange(finding)) {
                violations.push('Invalid line range');
                verdict = 'drop';
            }

            if (!this.checkEvidence(finding)) {
                violations.push('No supporting tool calls for MEDIUM+ finding');
                if (verdict !== 'drop') {
                    verdict = 'downgrade';
                    downgradedSeverity = 'LOW';
                }
            }

            if (!this.checkDisproof(finding)) {
                violations.push(
                    'No disproof attempted for CRITICAL/HIGH finding'
                );
                if (verdict !== 'drop') {
                    verdict = 'downgrade';
                    downgradedSeverity = downgradeSeverity(
                        downgradedSeverity ?? finding.severity
                    );
                }
            }

            if (verdict !== 'drop') {
                const lspResult = await this.runLspValidation(finding, token);
                if (lspResult) {
                    violations.push(lspResult);
                    verdict = 'drop';
                    downgradedSeverity = undefined;
                }
            }

            validated.push({
                finding,
                verdict,
                downgradedSeverity,
                violations,
            });
        }

        const dropped = validated.filter((v) => v.verdict === 'drop').length;
        const downgraded = validated.filter(
            (v) => v.verdict === 'downgrade'
        ).length;
        const kept = validated.filter((v) => v.verdict === 'keep').length;

        Log.info(
            `FindingValidator: ${kept} kept, ${downgraded} downgraded, ${dropped} dropped out of ${findings.length} findings`
        );

        return { validated, dropped, downgraded, kept };
    }

    private checkFileInDiff(
        finding: RecordedFinding,
        changedFiles: Set<string>
    ): boolean {
        return changedFiles.has(finding.file);
    }

    private checkLineRange(finding: RecordedFinding): boolean {
        const [start, end] = finding.lineRange;
        return start > 0 && start <= end;
    }

    private checkEvidence(finding: RecordedFinding): boolean {
        if (!SEVERITY_REQUIRING_EVIDENCE.has(finding.severity)) {
            return true;
        }
        return finding.supportingToolCalls.length > 0;
    }

    private checkDisproof(finding: RecordedFinding): boolean {
        if (!SEVERITY_REQUIRING_DISPROOF.has(finding.severity)) {
            return true;
        }
        return finding.disproof.attempted;
    }

    private async runLspValidation(
        finding: RecordedFinding,
        token: vscode.CancellationToken
    ): Promise<string | undefined> {
        if (finding.verifiableClaims.length === 0) {
            return undefined;
        }

        const needsValidation =
            finding.lspValidation === undefined ||
            finding.lspValidation.status === 'pending';
        if (!needsValidation) {
            return this.checkExistingLspResults(finding.lspValidation!);
        }

        try {
            const claimResults: ClaimValidationResult[] = [];
            for (const claim of finding.verifiableClaims) {
                if (token.isCancellationRequested) {
                    throw new vscode.CancellationError();
                }
                const request: ClaimValidationRequest = {
                    claimType: claim.claimType,
                    file: claim.file,
                    line: claim.line,
                    symbol: claim.symbol,
                    expectedValue: undefined,
                };
                const result = await this.lspValidation.validate(
                    request,
                    token
                );
                claimResults.push(result);
            }

            const hasDefinitiveRefutation = claimResults.some(
                (r) => !r.verified && r.confidence === 'definitive'
            );

            const status: LspValidationStatus['status'] =
                hasDefinitiveRefutation
                    ? 'refuted'
                    : claimResults.every((r) => r.verified)
                      ? 'verified'
                      : 'inconclusive';

            finding.lspValidation = {
                status,
                details: this.summarizeLspResults(claimResults),
                claimResults,
            };

            if (hasDefinitiveRefutation) {
                const refuted = claimResults.find(
                    (r) => !r.verified && r.confidence === 'definitive'
                )!;
                return `LSP refuted claim: ${refuted.evidence}`;
            }

            return undefined;
        } catch (error: unknown) {
            if (isCancellationError(error)) {
                throw error;
            }
            Log.warn(
                `FindingValidator: LSP validation failed for finding ${finding.id}: ${getErrorMessage(error)}`
            );
            return undefined;
        }
    }

    private checkExistingLspResults(
        lspValidation: LspValidationStatus
    ): string | undefined {
        if (lspValidation.status !== 'refuted') {
            return undefined;
        }
        const refuted = lspValidation.claimResults.find(
            (r) => !r.verified && r.confidence === 'definitive'
        );
        return refuted ? `LSP refuted claim: ${refuted.evidence}` : undefined;
    }

    private summarizeLspResults(results: ClaimValidationResult[]): string {
        const verified = results.filter((r) => r.verified).length;
        const refuted = results.filter(
            (r) => !r.verified && r.confidence === 'definitive'
        ).length;
        const inconclusive = results.length - verified - refuted;
        return `${verified} verified, ${refuted} refuted, ${inconclusive} inconclusive`;
    }
}
