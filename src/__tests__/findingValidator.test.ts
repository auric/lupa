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
        category: 'logic_error',
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

    it('drops finding when file is deleted in diff', async () => {
        const findings = [createTestFinding({ file: 'src/foo.ts' })];
        const deletedDiff: DiffHunk = {
            ...createTestDiffHunk('src/foo.ts'),
            isDeletedFile: true,
        };

        const result = await validator.validate(findings, [deletedDiff], token);

        expect(result.dropped).toBe(1);
        expect(result.validated[0]!.verdict).toBe('drop');
        expect(result.validated[0]!.violations).toContain(
            'Finding targets a deleted file'
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

    it('keeps MEDIUM finding with empty supportingToolCalls (evidence check removed)', async () => {
        const findings = [
            createTestFinding({
                severity: 'MEDIUM',
                supportingToolCalls: [],
            }),
        ];
        const diff = [createTestDiffHunk('src/foo.ts')];

        const result = await validator.validate(findings, diff, token);

        expect(result.kept).toBe(1);
        expect(result.validated[0]!.verdict).toBe('keep');
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
            'No disproof attempted for CRITICAL/HIGH/MEDIUM finding'
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
        // File not in diff (drop)
        const findings = [
            createTestFinding({
                file: 'src/missing.ts',
            }),
        ];
        const diff = [createTestDiffHunk('src/foo.ts')];

        const result = await validator.validate(findings, diff, token);

        expect(result.dropped).toBe(1);
        expect(result.validated[0]!.verdict).toBe('drop');
        expect(result.validated[0]!.violations.length).toBeGreaterThanOrEqual(
            1
        );
    });

    it('returns correct counts (kept, dropped, downgraded)', async () => {
        const findings = [
            createTestFinding({ id: 'kept' }),
            createTestFinding({ id: 'dropped', file: 'src/missing.ts' }),
            createTestFinding({
                id: 'downgraded',
                severity: 'HIGH',
                disproof: { attempted: false, method: '', result: '' },
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

    it('skips LSP call when lspValidation is already refuted', async () => {
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
                lspValidation: {
                    status: 'refuted',
                    details: '0 verified, 1 refuted, 0 inconclusive',
                    claimResults: [
                        {
                            claimType: 'symbol_unused',
                            verified: false,
                            confidence: 'definitive',
                            evidence: 'Symbol is used in 5 files',
                            groundTruth: 'has references',
                        },
                    ],
                },
            }),
        ];
        const diff = [createTestDiffHunk('src/foo.ts')];

        const result = await validator.validate(findings, diff, token);

        expect(mockLspValidation.validate).not.toHaveBeenCalled();
        expect(result.dropped).toBe(1);
        expect(result.validated[0]!.verdict).toBe('drop');
    });

    it('skips LSP call when lspValidation is already verified', async () => {
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
                lspValidation: {
                    status: 'verified',
                    details: '1 verified, 0 refuted, 0 inconclusive',
                    claimResults: [
                        {
                            claimType: 'symbol_unused',
                            verified: true,
                            confidence: 'definitive',
                            evidence: 'No references found',
                            groundTruth: 'no references',
                        },
                    ],
                },
            }),
        ];
        const diff = [createTestDiffHunk('src/foo.ts')];

        const result = await validator.validate(findings, diff, token);

        expect(mockLspValidation.validate).not.toHaveBeenCalled();
        expect(result.kept).toBe(1);
        expect(result.validated[0]!.verdict).toBe('keep');
    });

    it('skips LSP call when lspValidation is already inconclusive', async () => {
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
                lspValidation: {
                    status: 'inconclusive',
                    details: '0 verified, 0 refuted, 1 inconclusive',
                    claimResults: [
                        {
                            claimType: 'type_mismatch',
                            verified: false,
                            confidence: 'inconclusive',
                            evidence: 'Could not determine',
                            groundTruth: 'unknown',
                        },
                    ],
                },
            }),
        ];
        const diff = [createTestDiffHunk('src/foo.ts')];

        const result = await validator.validate(findings, diff, token);

        expect(mockLspValidation.validate).not.toHaveBeenCalled();
        expect(result.kept).toBe(1);
        expect(result.validated[0]!.verdict).toBe('keep');
    });

    describe('post-processing FP filters', () => {
        it('drops finding with invalid category', async () => {
            const findings = [
                createTestFinding({
                    category: 'style_issue' as never,
                }),
            ];
            const diff = [createTestDiffHunk('src/foo.ts')];

            const result = await validator.validate(findings, diff, token);

            expect(result.dropped).toBe(1);
            expect(result.validated[0]!.violations[0]).toContain(
                'not in the allowed taxonomy'
            );
        });

        it('keeps finding with valid category', async () => {
            const findings = [
                createTestFinding({ category: 'security_vulnerability' }),
            ];
            const diff = [createTestDiffHunk('src/foo.ts')];

            const result = await validator.validate(findings, diff, token);

            expect(result.kept).toBe(1);
        });

        it('drops concurrency finding in single-threaded JS', async () => {
            const findings = [
                createTestFinding({
                    category: 'api_misuse',
                    title: 'Race condition in event handler',
                    description:
                        'Concurrent access to shared state may cause data corruption',
                }),
            ];
            const diff = [createTestDiffHunk('src/foo.ts')];

            const result = await validator.validate(findings, diff, token);

            expect(result.dropped).toBe(1);
            expect(result.validated[0]!.violations[0]).toContain(
                'single-threaded runtime'
            );
        });

        it('keeps concurrency finding when category is data_integrity', async () => {
            const findings = [
                createTestFinding({
                    category: 'data_integrity',
                    title: 'Race condition in async write',
                    description: 'Concurrent access may cause lost updates',
                }),
            ];
            const diff = [createTestDiffHunk('src/foo.ts')];

            const result = await validator.validate(findings, diff, token);

            expect(result.kept).toBe(1);
        });

        it('drops "missing tests" finding', async () => {
            const findings = [
                createTestFinding({
                    title: 'Missing unit tests for error paths',
                    description: 'No tests cover the error handling branches',
                }),
            ];
            const diff = [createTestDiffHunk('src/foo.ts')];

            const result = await validator.validate(findings, diff, token);

            expect(result.dropped).toBe(1);
            expect(result.validated[0]!.violations[0]).toContain(
                'Test coverage suggestions'
            );
        });

        it('drops "missing documentation" finding', async () => {
            const findings = [
                createTestFinding({
                    title: 'Missing API documentation for public method',
                    description: 'The method is undocumented and has no JSDoc',
                }),
            ];
            const diff = [createTestDiffHunk('src/foo.ts')];

            const result = await validator.validate(findings, diff, token);

            expect(result.dropped).toBe(1);
            expect(result.validated[0]!.violations[0]).toContain(
                'missing documentation'
            );
        });

        it('drops "runtime validation" finding on internal code', async () => {
            const findings = [
                createTestFinding({
                    category: 'api_misuse',
                    title: 'Missing input validation',
                    description:
                        'No runtime type validation for function parameters',
                }),
            ];
            const diff = [createTestDiffHunk('src/foo.ts')];

            const result = await validator.validate(findings, diff, token);

            expect(result.dropped).toBe(1);
            expect(result.validated[0]!.violations[0]).toContain(
                'Runtime validation'
            );
        });

        it('keeps "runtime validation" finding for security_vulnerability category', async () => {
            const findings = [
                createTestFinding({
                    category: 'security_vulnerability',
                    title: 'Missing input validation at API boundary',
                    description:
                        'No runtime type validation for user-provided data',
                }),
            ];
            const diff = [createTestDiffHunk('src/foo.ts')];

            const result = await validator.validate(findings, diff, token);

            expect(result.kept).toBe(1);
        });

        it('drops thread-safety finding', async () => {
            const findings = [
                createTestFinding({
                    category: 'logic_error',
                    title: 'Thread-unsafe map access',
                    description:
                        'Map is not thread-safe for concurrent reads and writes',
                }),
            ];
            const diff = [createTestDiffHunk('src/foo.ts')];

            const result = await validator.validate(findings, diff, token);

            expect(result.dropped).toBe(1);
            expect(result.validated[0]!.violations[0]).toContain(
                'single-threaded runtime'
            );
        });

        it('keeps concurrency finding in multi-threaded Java project', async () => {
            const findings = [
                createTestFinding({
                    file: 'src/Main.java',
                    category: 'data_integrity',
                    title: 'Race condition in shared HashMap',
                    description: 'Concurrent access without synchronization',
                }),
            ];
            const diff = [createTestDiffHunk('src/Main.java')];

            const result = await validator.validate(findings, diff, token);

            expect(result.kept).toBe(1);
        });

        it('keeps concurrency finding in Go project', async () => {
            const findings = [
                createTestFinding({
                    file: 'main.go',
                    category: 'logic_error',
                    title: 'Race condition in goroutine',
                    description: 'Concurrent access to shared map',
                }),
            ];
            const diff = [createTestDiffHunk('main.go')];

            const result = await validator.validate(findings, diff, token);

            expect(result.kept).toBe(1);
        });

        it('keeps runtime validation finding in Python project', async () => {
            const findings = [
                createTestFinding({
                    file: 'app/handler.py',
                    category: 'api_misuse',
                    title: 'Missing input validation',
                    description: 'No runtime type validation for request data',
                }),
            ];
            const diff = [createTestDiffHunk('app/handler.py')];

            const result = await validator.validate(findings, diff, token);

            expect(result.kept).toBe(1);
        });

        it('drops concurrency finding in Ruby project (single-threaded GVL)', async () => {
            const findings = [
                createTestFinding({
                    file: 'app/worker.rb',
                    category: 'logic_error',
                    title: 'Race condition in request handler',
                    description: 'Concurrent access to instance variable',
                }),
            ];
            const diff = [createTestDiffHunk('app/worker.rb')];

            const result = await validator.validate(findings, diff, token);

            expect(result.dropped).toBe(1);
            expect(result.validated[0]!.violations[0]).toContain(
                'single-threaded runtime'
            );
        });

        it('keeps concurrency finding in C++ project', async () => {
            const findings = [
                createTestFinding({
                    file: 'src/engine.cpp',
                    category: 'logic_error',
                    title: 'Race condition in thread pool',
                    description: 'Concurrent access to shared vector',
                }),
            ];
            const diff = [createTestDiffHunk('src/engine.cpp')];

            const result = await validator.validate(findings, diff, token);

            expect(result.kept).toBe(1);
        });
    });
});
