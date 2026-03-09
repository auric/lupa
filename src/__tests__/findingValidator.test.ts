import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { FindingValidator } from '../services/findingValidator';
import type { LspValidationService } from '../services/lspValidationService';
import type { RecordedFinding } from '../types/findingTypes';
import type { DiffHunk } from '../types/contextTypes';
import type { ClaimValidationResult } from '../types/claimTypes';
import { createMockCancellationTokenSource } from './testUtils/mockFactories';

function createTestFinding(
    overrides: Partial<RecordedFinding> = {}
): RecordedFinding {
    return {
        id: 'f1',
        agentId: 'agent1',
        timestamp: Date.now(),
        severity: 'HIGH',
        category: 'bug',
        title: 'Test finding',
        file: 'src/foo.ts',
        lineRange: [10, 20],
        description: 'Some issue',
        supportingToolCalls: ['find_usages', 'read_file'],
        disproof: {
            attempted: true,
            method: 'Checked callers',
            result: 'Not disproved',
        },
        verifiableClaims: [],
        lspValidation: undefined,
        ...overrides,
    };
}

function createTestDiffHunk(filePath: string): DiffHunk {
    return {
        filePath,
        hunks: [
            {
                oldStart: 1,
                oldLines: 10,
                newStart: 1,
                newLines: 15,
                parsedLines: [],
                hunkId: 'h1',
                hunkHeader: '',
            },
        ],
        isNewFile: false,
        isDeletedFile: false,
        originalHeader: '',
    };
}

describe('FindingValidator', () => {
    let validator: FindingValidator;
    let mockLspValidation: LspValidationService;
    let token: vscode.CancellationToken;

    beforeEach(() => {
        mockLspValidation = {
            validate: vi.fn(),
        } as unknown as LspValidationService;
        validator = new FindingValidator(mockLspValidation);
        token = createMockCancellationTokenSource().token;
    });

    it('returns all kept when findings are valid', async () => {
        const findings = [createTestFinding()];
        const diff = [createTestDiffHunk('src/foo.ts')];

        const result = await validator.validate(findings, diff, token);

        expect(result.kept).toBe(1);
        expect(result.dropped).toBe(0);
        expect(result.downgraded).toBe(0);
        expect(result.validated[0]!.verdict).toBe('keep');
    });

    it('drops finding when file not in diff', async () => {
        const findings = [createTestFinding({ file: 'src/bar.ts' })];
        const diff = [createTestDiffHunk('src/foo.ts')];

        const result = await validator.validate(findings, diff, token);

        expect(result.dropped).toBe(1);
        expect(result.validated[0]!.verdict).toBe('drop');
        expect(result.validated[0]!.violations).toContain(
            'File not in changed files'
        );
    });

    it('drops finding when line range start > end', async () => {
        const findings = [createTestFinding({ lineRange: [20, 10] })];
        const diff = [createTestDiffHunk('src/foo.ts')];

        const result = await validator.validate(findings, diff, token);

        expect(result.dropped).toBe(1);
        expect(result.validated[0]!.violations).toContain('Invalid line range');
    });

    it('drops finding when line range start < 1', async () => {
        const findings = [createTestFinding({ lineRange: [0, 10] })];
        const diff = [createTestDiffHunk('src/foo.ts')];

        const result = await validator.validate(findings, diff, token);

        expect(result.dropped).toBe(1);
        expect(result.validated[0]!.violations).toContain('Invalid line range');
    });

    it('downgrades MEDIUM+ finding with empty supportingToolCalls', async () => {
        const findings = [
            createTestFinding({
                severity: 'MEDIUM',
                supportingToolCalls: [],
            }),
        ];
        const diff = [createTestDiffHunk('src/foo.ts')];

        const result = await validator.validate(findings, diff, token);

        expect(result.downgraded).toBe(1);
        expect(result.validated[0]!.verdict).toBe('downgrade');
        expect(result.validated[0]!.downgradedSeverity).toBe('LOW');
        expect(result.validated[0]!.violations).toContain(
            'No supporting tool calls for MEDIUM+ finding'
        );
    });

    it('does not downgrade LOW finding with empty supportingToolCalls', async () => {
        const findings = [
            createTestFinding({
                severity: 'LOW',
                supportingToolCalls: [],
            }),
        ];
        const diff = [createTestDiffHunk('src/foo.ts')];

        const result = await validator.validate(findings, diff, token);

        expect(result.kept).toBe(1);
        expect(result.validated[0]!.verdict).toBe('keep');
    });

    it('downgrades CRITICAL/HIGH finding with disproof.attempted = false', async () => {
        const findings = [
            createTestFinding({
                severity: 'CRITICAL',
                disproof: { attempted: false, method: '', result: '' },
            }),
        ];
        const diff = [createTestDiffHunk('src/foo.ts')];

        const result = await validator.validate(findings, diff, token);

        expect(result.downgraded).toBe(1);
        expect(result.validated[0]!.verdict).toBe('downgrade');
        expect(result.validated[0]!.violations).toContain(
            'No disproof attempted for CRITICAL/HIGH finding'
        );
    });

    it('drops finding when LSP refutes a verifiable claim', async () => {
        const refutedResult: ClaimValidationResult = {
            claimType: 'symbol_unused',
            verified: false,
            confidence: 'definitive',
            evidence: 'Symbol is used in 3 files',
            groundTruth: 'has references',
        };
        vi.mocked(mockLspValidation.validate).mockResolvedValue(refutedResult);

        const findings = [
            createTestFinding({
                verifiableClaims: [
                    {
                        claimType: 'symbol_unused',
                        file: 'src/foo.ts',
                        line: 15,
                        symbol: 'myFunc',
                        assertion: 'myFunc is unused',
                    },
                ],
            }),
        ];
        const diff = [createTestDiffHunk('src/foo.ts')];

        const result = await validator.validate(findings, diff, token);

        expect(result.dropped).toBe(1);
        expect(result.validated[0]!.verdict).toBe('drop');
        expect(result.validated[0]!.violations).toContain(
            'LSP refuted claim: Symbol is used in 3 files'
        );
    });

    it('keeps finding when LSP verifies claims', async () => {
        const verifiedResult: ClaimValidationResult = {
            claimType: 'symbol_unused',
            verified: true,
            confidence: 'definitive',
            evidence: 'No references found',
            groundTruth: 'no references',
        };
        vi.mocked(mockLspValidation.validate).mockResolvedValue(verifiedResult);

        const findings = [
            createTestFinding({
                verifiableClaims: [
                    {
                        claimType: 'symbol_unused',
                        file: 'src/foo.ts',
                        line: 15,
                        symbol: 'myFunc',
                        assertion: 'myFunc is unused',
                    },
                ],
            }),
        ];
        const diff = [createTestDiffHunk('src/foo.ts')];

        const result = await validator.validate(findings, diff, token);

        expect(result.kept).toBe(1);
        expect(result.validated[0]!.verdict).toBe('keep');
    });

    it('handles finding with inconclusive LSP result — keeps it', async () => {
        const inconclusiveResult: ClaimValidationResult = {
            claimType: 'type_mismatch',
            verified: false,
            confidence: 'inconclusive',
            evidence: 'Could not determine',
            groundTruth: 'unknown',
        };
        vi.mocked(mockLspValidation.validate).mockResolvedValue(
            inconclusiveResult
        );

        const findings = [
            createTestFinding({
                verifiableClaims: [
                    {
                        claimType: 'type_mismatch',
                        file: 'src/foo.ts',
                        line: 15,
                        symbol: 'myVar',
                        assertion: 'type mismatch',
                    },
                ],
            }),
        ];
        const diff = [createTestDiffHunk('src/foo.ts')];

        const result = await validator.validate(findings, diff, token);

        expect(result.kept).toBe(1);
        expect(result.validated[0]!.verdict).toBe('keep');
    });

    it('multiple violations — strictest verdict wins (drop > downgrade)', async () => {
        // File not in diff (drop) + no evidence (downgrade)
        const findings = [
            createTestFinding({
                file: 'src/missing.ts',
                supportingToolCalls: [],
            }),
        ];
        const diff = [createTestDiffHunk('src/foo.ts')];

        const result = await validator.validate(findings, diff, token);

        expect(result.dropped).toBe(1);
        expect(result.validated[0]!.verdict).toBe('drop');
        expect(result.validated[0]!.violations.length).toBeGreaterThanOrEqual(
            2
        );
    });

    it('returns correct counts (kept, dropped, downgraded)', async () => {
        const findings = [
            createTestFinding({ id: 'kept' }),
            createTestFinding({ id: 'dropped', file: 'src/missing.ts' }),
            createTestFinding({
                id: 'downgraded',
                severity: 'MEDIUM',
                supportingToolCalls: [],
            }),
        ];
        const diff = [createTestDiffHunk('src/foo.ts')];

        const result = await validator.validate(findings, diff, token);

        expect(result.kept).toBe(1);
        expect(result.dropped).toBe(1);
        expect(result.downgraded).toBe(1);
        expect(result.validated).toHaveLength(3);
    });

    it('empty findings returns empty result', async () => {
        const result = await validator.validate([], [], token);

        expect(result.kept).toBe(0);
        expect(result.dropped).toBe(0);
        expect(result.downgraded).toBe(0);
        expect(result.validated).toHaveLength(0);
    });
});
