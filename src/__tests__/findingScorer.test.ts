import { describe, it, expect } from 'vitest';
import type { RecordedFinding } from '../types/findingTypes';
import type { ToolCallRecord } from '../types/toolCallTypes';
import { DEFAULT_PROFILE } from '../models/modelCalibration';
import {
    scoreFinding,
    scoreAll,
    DROP_THRESHOLD,
    DOWNGRADE_THRESHOLD,
    type ScoringContext,
} from '../services/findingScorer';

function makeFinding(
    overrides: Partial<RecordedFinding> = {}
): RecordedFinding {
    return {
        id: 'finding-1',
        agentId: 'root',
        timestamp: Date.now(),
        severity: 'HIGH',
        category: 'logic_error',
        title: 'Potential null reference',
        file: 'src/services/foo.ts',
        lineRange: [10, 15] as [number, number],
        description:
            'The function does not check for null before accessing .value property, which could cause a runtime crash.',
        affectedComponent: overrides.affectedComponent ?? 'getValue()',
        failureMechanism: overrides.failureMechanism ?? 'runtime_exception',
        verificationEvidence:
            'Verified by reading the diff and tracing the function',
        supportingToolCalls: [],
        disproof: {
            attempted: true,
            method: 'counter-search',
            result: 'Could not disprove — no null check found',
        },
        verifiableClaims: [],
        lspValidation: {
            status: 'verified',
            details: 'Symbol confirmed',
            claimResults: [],
        },
        ...overrides,
    };
}

function makeToolCallRecord(
    overrides: Partial<ToolCallRecord> = {}
): ToolCallRecord {
    return {
        id: 'call-1',
        toolName: 'get_file_diff',
        arguments: { file_path: 'src/services/foo.ts' },
        result: 'diff content',
        success: true,
        error: undefined,
        durationMs: 100,
        timestamp: Date.now(),
        ...overrides,
    };
}

function makeContext(overrides: Partial<ScoringContext> = {}): ScoringContext {
    return {
        toolCallRecords: [
            makeToolCallRecord({ id: 'call-1' }),
            makeToolCallRecord({
                id: 'call-2',
                toolName: 'read_file',
                arguments: { file_path: 'src/services/foo.ts' },
            }),
            makeToolCallRecord({
                id: 'call-3',
                toolName: 'find_symbol',
                arguments: { file_path: 'src/services/foo.ts' },
            }),
            makeToolCallRecord({
                id: 'call-4',
                toolName: 'read_file',
                arguments: { file_path: 'src/services/foo.ts' },
            }),
        ],
        calibrationProfile: DEFAULT_PROFILE,
        ...overrides,
    };
}

describe('findingScorer', () => {
    describe('scoreFinding', () => {
        it('should score a well-evidenced finding high', () => {
            const finding = makeFinding({
                description:
                    'The function reads .value from a potentially null object, resulting in TypeError at runtime when config input is undefined, as confirmed by symbol definitions and tracing through call analysis',
            });
            const context = makeContext({
                toolCallRecords: [
                    makeToolCallRecord({
                        id: 'call-1',
                        toolName: 'find_symbol',
                        arguments: {
                            symbol: 'getValue',
                            file_path: 'src/services/foo.ts',
                        },
                    }),
                    makeToolCallRecord({
                        id: 'call-2',
                        toolName: 'read_file',
                        arguments: { file_path: 'src/services/foo.ts' },
                    }),
                    makeToolCallRecord({
                        id: 'call-3',
                        toolName: 'find_usages',
                        arguments: {
                            symbol: 'getValue',
                            file_path: 'src/services/foo.ts',
                        },
                    }),
                    makeToolCallRecord({
                        id: 'call-4',
                        toolName: 'read_file',
                        arguments: { file_path: 'src/services/foo.ts' },
                    }),
                    makeToolCallRecord({
                        id: 'call-5',
                        toolName: 'read_file',
                        arguments: { file_path: 'src/models/bar.ts' },
                    }),
                    makeToolCallRecord({
                        id: 'call-6',
                        toolName: 'read_file',
                        arguments: { file_path: 'src/utils/helpers.ts' },
                    }),
                ],
            });
            const score = scoreFinding(finding, context);

            // investigationDepth: 4 matching calls = 20
            // disproofAttempted: true = 15
            // lspValidation: verified = 15
            // modelBias: balanced = 4
            // categoryRisk: logic_error = high = 5
            // descriptionQuality: >200 chars = 2
            // absencePattern: no absence language = 0
            // affectedComponentVerified: 'getValue' in symbol field = 15
            // crossFileEvidence: 3 files = 10
            // evidenceAuditVerdict: none = 0
            // Total = 86
            expect(score.overallScore).toBeGreaterThanOrEqual(80);
            expect(score.recommendation).toBe('keep');
            expect(score.signals).toHaveLength(10);
        });

        it('should give low score with no supporting evidence', () => {
            const finding = makeFinding({
                disproof: { attempted: false, method: '', result: '' },
                lspValidation: undefined,
            });
            const context = makeContext({ toolCallRecords: [] });
            const score = scoreFinding(finding, context);

            // investigationDepth: 0 matching = 0
            // disproofAttempted: false = 0
            // lspValidation: undefined = 5
            // modelBias: balanced = 4
            // categoryRisk: logic_error = 5
            // descriptionQuality: ~100 chars = 1
            // affectedComponentVerified: not found = -5
            // Total = 10
            expect(score.overallScore).toBeLessThan(DROP_THRESHOLD);
            expect(score.recommendation).toBe('drop');
        });

        it('should give dismissive model bonus over aggressive model', () => {
            const finding = makeFinding();

            const aggressiveContext = makeContext({
                calibrationProfile: {
                    ...DEFAULT_PROFILE,
                    findingBias: 'aggressive' as const,
                    name: 'test-aggressive',
                },
            });
            const dismissiveContext = makeContext({
                calibrationProfile: {
                    ...DEFAULT_PROFILE,
                    findingBias: 'dismissive' as const,
                    name: 'test-dismissive',
                },
            });

            const dismissiveScore = scoreFinding(finding, dismissiveContext);
            const aggressiveScore = scoreFinding(finding, aggressiveContext);

            const dismissiveBias = dismissiveScore.signals.find(
                (s) => s.signal === 'modelBias'
            )!;
            const aggressiveBias = aggressiveScore.signals.find(
                (s) => s.signal === 'modelBias'
            )!;

            expect(dismissiveBias.contribution).toBe(8);
            expect(aggressiveBias.contribution).toBe(0);
            expect(dismissiveScore.overallScore).toBeGreaterThan(
                aggressiveScore.overallScore
            );
        });

        it('should score LSP verified as high component', () => {
            const finding = makeFinding({
                lspValidation: {
                    status: 'verified',
                    details: 'Confirmed',
                    claimResults: [],
                },
            });
            const context = makeContext();
            const score = scoreFinding(finding, context);

            const lspSignal = score.signals.find(
                (s) => s.signal === 'lspValidation'
            )!;
            expect(lspSignal.contribution).toBe(15);
        });

        it('should score LSP refuted as 0', () => {
            const finding = makeFinding({
                lspValidation: {
                    status: 'refuted',
                    details: 'Not found',
                    claimResults: [],
                },
            });
            const context = makeContext();
            const score = scoreFinding(finding, context);

            const lspSignal = score.signals.find(
                (s) => s.signal === 'lspValidation'
            )!;
            expect(lspSignal.contribution).toBe(0);
        });

        it('should score short description as low quality', () => {
            const finding = makeFinding({ description: 'Bad code.' });
            const context = makeContext();
            const score = scoreFinding(finding, context);

            const descSignal = score.signals.find(
                (s) => s.signal === 'descriptionQuality'
            )!;
            expect(descSignal.contribution).toBe(0);
        });

        it('should give security category higher risk score', () => {
            const securityFinding = makeFinding({
                category: 'security_vulnerability',
            });
            const miscFinding = makeFinding({ category: 'api_misuse' });
            const context = makeContext();

            const secScore = scoreFinding(securityFinding, context);
            const miscScore = scoreFinding(miscFinding, context);

            const secCat = secScore.signals.find(
                (s) => s.signal === 'categoryRisk'
            )!;
            const miscCat = miscScore.signals.find(
                (s) => s.signal === 'categoryRisk'
            )!;

            expect(secCat.contribution).toBe(5);
            expect(miscCat.contribution).toBe(1);
        });

        it('should recommend drop for score below DROP_THRESHOLD', () => {
            const finding = makeFinding({
                supportingToolCalls: [],
                disproof: { attempted: false, method: '', result: '' },
                lspValidation: {
                    status: 'refuted',
                    details: '',
                    claimResults: [],
                },
                description: 'Bad.',
                category: 'api_misuse',
            });
            const context = makeContext({
                toolCallRecords: [],
                calibrationProfile: {
                    ...DEFAULT_PROFILE,
                    findingBias: 'aggressive' as const,
                    name: 'test-aggressive',
                },
            });
            const score = scoreFinding(finding, context);

            expect(score.overallScore).toBeLessThan(DROP_THRESHOLD);
            expect(score.recommendation).toBe('drop');
        });

        it('should recommend downgrade for score between DROP_THRESHOLD and DOWNGRADE_THRESHOLD', () => {
            const finding = makeFinding({
                disproof: {
                    attempted: true,
                    method: 'counter-search',
                    result: 'Could not disprove',
                },
                lspValidation: {
                    status: 'inconclusive',
                    details: 'Uncertain',
                    claimResults: [],
                },
                severity: 'MEDIUM',
                category: 'error_handling_gap',
                affectedComponent: 'unknownFunction()',
                description:
                    'The function returns incorrect value in some edge case scenarios that could cause issues',
            });
            const context = makeContext({
                toolCallRecords: [
                    makeToolCallRecord({
                        id: 'call-1',
                        toolName: 'read_file',
                        arguments: {
                            file_path: 'src/services/foo.ts',
                        },
                    }),
                    makeToolCallRecord({
                        id: 'call-2',
                        toolName: 'get_file_diff',
                        arguments: {
                            file_path: 'src/services/foo.ts',
                        },
                    }),
                    makeToolCallRecord({
                        id: 'call-3',
                        toolName: 'read_file',
                        arguments: { file_path: 'src/models/bar.ts' },
                    }),
                ],
                calibrationProfile: {
                    ...DEFAULT_PROFILE,
                    findingBias: 'aggressive' as const,
                    name: 'test-aggressive',
                },
            });
            const score = scoreFinding(finding, context);
            // investigationDepth: 2 calls match foo.ts = 10
            // disproofAttempted: true = 15
            // lspValidation: inconclusive = 8
            // modelBias: aggressive = 0
            // categoryRisk: error_handling_gap = medium = 3
            // descriptionQuality: ~86 chars = 1
            // absencePattern: 0
            // affectedComponentVerified: not found = -5
            // crossFileEvidence: 2 files = 5
            // evidenceAuditVerdict: 0
            // Total = 37
            expect(score.overallScore).toBeGreaterThanOrEqual(DROP_THRESHOLD);
            expect(score.overallScore).toBeLessThan(DOWNGRADE_THRESHOLD);
            expect(score.recommendation).toBe('downgrade');
        });
    });

    describe('scoreAll', () => {
        it('should process multiple findings', () => {
            const findings = [
                makeFinding({ id: 'f1' }),
                makeFinding({
                    id: 'f2',
                    severity: 'LOW',
                    category: 'api_misuse',
                }),
                makeFinding({ id: 'f3' }),
            ];
            const context = makeContext();
            const scores = scoreAll(findings, context);

            expect(scores).toHaveLength(3);
            expect(scores[0].findingId).toBe('f1');
            expect(scores[1].findingId).toBe('f2');
            expect(scores[2].findingId).toBe('f3');
            scores.forEach((s) => {
                expect(s.signals.length).toBeGreaterThanOrEqual(8);
                expect(typeof s.overallScore).toBe('number');
                expect(['keep', 'drop', 'downgrade']).toContain(
                    s.recommendation
                );
            });
        });
    });

    describe('absencePattern signal', () => {
        it('should penalize absence-only description without concrete failure mechanism', () => {
            const finding = makeFinding({
                description:
                    'The function lacks error handling for network failures',
                failureMechanism: 'missing_error_handling',
            });
            const context = makeContext();
            const score = scoreFinding(finding, context);

            const absenceSignal = score.signals.find(
                (s) => s.signal === 'absencePattern'
            )!;
            expect(absenceSignal).toBeDefined();
            expect(absenceSignal.contribution).toBe(-15);
        });

        it('should apply smaller penalty when absence language has concrete failure mechanism', () => {
            const finding = makeFinding({
                description:
                    'Missing null check causes runtime_exception when input is undefined',
                failureMechanism: 'runtime_exception',
            });
            const context = makeContext();
            const score = scoreFinding(finding, context);

            const absenceSignal = score.signals.find(
                (s) => s.signal === 'absencePattern'
            )!;
            expect(absenceSignal).toBeDefined();
            expect(absenceSignal.contribution).toBe(-5);
        });

        it('should not penalize findings without absence language', () => {
            const finding = makeFinding({
                description:
                    'The function returns incorrect value when array is empty',
                failureMechanism: 'wrong_return_value',
            });
            const context = makeContext();
            const score = scoreFinding(finding, context);

            const absenceSignal = score.signals.find(
                (s) => s.signal === 'absencePattern'
            )!;
            expect(absenceSignal).toBeDefined();
            expect(absenceSignal.contribution).toBe(0);
        });

        it('should reduce overall score for absence-pattern findings', () => {
            const normalFinding = makeFinding({
                description:
                    'The function returns null instead of throwing when ID is invalid',
                failureMechanism: 'wrong_return_value',
            });
            const absenceFinding = makeFinding({
                description:
                    "The function doesn't handle errors from the API call",
                failureMechanism: 'missing_handling',
            });
            const context = makeContext();

            const normalScore = scoreFinding(normalFinding, context);
            const absenceScore = scoreFinding(absenceFinding, context);

            expect(absenceScore.overallScore).toBeLessThan(
                normalScore.overallScore
            );
        });
    });

    describe('affectedComponentVerified signal', () => {
        it('should give bonus when affected component symbol is found in tool call args', () => {
            const finding = makeFinding({
                affectedComponent: 'parseConfig()',
            });
            const context = makeContext({
                toolCallRecords: [
                    makeToolCallRecord({
                        id: 'call-1',
                        toolName: 'find_symbol',
                        arguments: {
                            symbol: 'parseConfig',
                            file_path: 'src/services/foo.ts',
                        },
                    }),
                    makeToolCallRecord({
                        id: 'call-2',
                        toolName: 'read_file',
                        arguments: { file_path: 'src/services/foo.ts' },
                    }),
                ],
            });
            const score = scoreFinding(finding, context);

            const signal = score.signals.find(
                (s) => s.signal === 'affectedComponentVerified'
            )!;
            expect(signal).toBeDefined();
            expect(signal.contribution).toBe(15);
        });

        it('should penalize when affected component symbol is NOT in any tool call', () => {
            const finding = makeFinding({
                affectedComponent: 'handleUserSession()',
            });
            const context = makeContext({
                toolCallRecords: [
                    makeToolCallRecord({
                        id: 'call-1',
                        toolName: 'read_file',
                        arguments: { file_path: 'src/services/foo.ts' },
                    }),
                ],
            });
            const score = scoreFinding(finding, context);

            const signal = score.signals.find(
                (s) => s.signal === 'affectedComponentVerified'
            )!;
            expect(signal).toBeDefined();
            expect(signal.contribution).toBe(-5);
        });

        it('should not verify affected component via file path substring match', () => {
            const finding = makeFinding({
                affectedComponent: 'parseConfig()',
            });
            const context = makeContext({
                toolCallRecords: [
                    makeToolCallRecord({
                        id: 'call-1',
                        toolName: 'read_file',
                        arguments: {
                            file_path: 'src/parseConfig.ts',
                        },
                    }),
                ],
            });
            const score = scoreFinding(finding, context);

            const signal = score.signals.find(
                (s) => s.signal === 'affectedComponentVerified'
            )!;
            expect(signal).toBeDefined();
            expect(signal.contribution).toBe(-5);
        });

        it('should not verify affected component via query substring match', () => {
            const finding = makeFinding({
                affectedComponent: 'handleError()',
            });
            const context = makeContext({
                toolCallRecords: [
                    makeToolCallRecord({
                        id: 'call-1',
                        toolName: 'search_for_pattern',
                        arguments: {
                            query: 'handleError implementation',
                        },
                    }),
                ],
            });
            const score = scoreFinding(finding, context);

            const signal = score.signals.find(
                (s) => s.signal === 'affectedComponentVerified'
            )!;
            expect(signal).toBeDefined();
            expect(signal.contribution).toBe(-5);
        });
    });

    describe('crossFileEvidence signal', () => {
        it('should give max bonus for 3+ distinct files investigated', () => {
            const finding = makeFinding({
                file: 'src/services/foo.ts',
                affectedComponent: 'processData()',
            });
            const context = makeContext({
                toolCallRecords: [
                    makeToolCallRecord({
                        id: 'call-1',
                        toolName: 'read_file',
                        arguments: { file_path: 'src/services/foo.ts' },
                    }),
                    makeToolCallRecord({
                        id: 'call-2',
                        toolName: 'read_file',
                        arguments: { file_path: 'src/models/bar.ts' },
                    }),
                    makeToolCallRecord({
                        id: 'call-3',
                        toolName: 'read_file',
                        arguments: { file_path: 'src/utils/helpers.ts' },
                    }),
                ],
            });
            const score = scoreFinding(finding, context);

            const signal = score.signals.find(
                (s) => s.signal === 'crossFileEvidence'
            )!;
            expect(signal).toBeDefined();
            expect(signal.contribution).toBe(10);
            expect(signal.rawValue).toBeGreaterThanOrEqual(3);
        });

        it('should give no bonus for single-file investigation', () => {
            const finding = makeFinding({
                file: 'src/services/foo.ts',
            });
            const context = makeContext({
                toolCallRecords: [
                    makeToolCallRecord({
                        id: 'call-1',
                        toolName: 'read_file',
                        arguments: { file_path: 'src/services/foo.ts' },
                    }),
                ],
            });
            const score = scoreFinding(finding, context);

            const signal = score.signals.find(
                (s) => s.signal === 'crossFileEvidence'
            )!;
            expect(signal).toBeDefined();
            expect(signal.contribution).toBe(0);
            expect(signal.rawValue).toBe(1);
        });

        it('should give moderate bonus for 2-file investigation', () => {
            const finding = makeFinding({
                file: 'src/services/foo.ts',
                affectedComponent: 'validateInput()',
            });
            const context = makeContext({
                toolCallRecords: [
                    makeToolCallRecord({
                        id: 'call-1',
                        toolName: 'find_symbol',
                        arguments: {
                            symbol: 'validateInput',
                            file_path: 'src/services/foo.ts',
                        },
                    }),
                    makeToolCallRecord({
                        id: 'call-2',
                        toolName: 'read_file',
                        arguments: { file_path: 'src/models/schema.ts' },
                    }),
                ],
            });
            const score = scoreFinding(finding, context);

            const signal = score.signals.find(
                (s) => s.signal === 'crossFileEvidence'
            )!;
            expect(signal).toBeDefined();
            expect(signal.contribution).toBe(5);
            expect(signal.rawValue).toBe(2);
        });
    });

    describe('combined new signals: TP vs FP scenarios', () => {
        it('should score high for cross-module verified TP pattern', () => {
            const finding = makeFinding({
                file: 'src/services/auth.ts',
                affectedComponent: 'SessionManager.validateToken()',
                supportingToolCalls: ['call-1', 'call-2', 'call-3'],
            });
            const context = makeContext({
                toolCallRecords: [
                    makeToolCallRecord({
                        id: 'call-1',
                        toolName: 'find_symbol',
                        arguments: {
                            symbol: 'SessionManager',
                            file_path: 'src/services/auth.ts',
                        },
                    }),
                    makeToolCallRecord({
                        id: 'call-2',
                        toolName: 'read_file',
                        arguments: { file_path: 'src/models/session.ts' },
                    }),
                    makeToolCallRecord({
                        id: 'call-3',
                        toolName: 'read_file',
                        arguments: { file_path: 'src/utils/crypto.ts' },
                    }),
                ],
            });
            const score = scoreFinding(finding, context);

            const componentSignal = score.signals.find(
                (s) => s.signal === 'affectedComponentVerified'
            )!;
            const crossFileSignal = score.signals.find(
                (s) => s.signal === 'crossFileEvidence'
            )!;
            expect(componentSignal.contribution).toBe(15);
            expect(crossFileSignal.contribution).toBe(10);
        });

        it('should score low for single-file speculative FP pattern', () => {
            const finding = makeFinding({
                file: 'src/services/foo.ts',
                affectedComponent: 'unknownFunction()',
                supportingToolCalls: [],
                disproof: { attempted: false, method: '', result: '' },
                lspValidation: undefined,
                description: "The function doesn't check for null",
                failureMechanism: 'missing_null_check',
            });
            const context = makeContext({
                toolCallRecords: [
                    makeToolCallRecord({
                        id: 'call-1',
                        toolName: 'read_file',
                        arguments: { file_path: 'src/services/foo.ts' },
                    }),
                ],
            });
            const score = scoreFinding(finding, context);

            const componentSignal = score.signals.find(
                (s) => s.signal === 'affectedComponentVerified'
            )!;
            const crossFileSignal = score.signals.find(
                (s) => s.signal === 'crossFileEvidence'
            )!;
            expect(componentSignal.contribution).toBe(-5);
            expect(crossFileSignal.contribution).toBe(0);
            expect(score.recommendation).toBe('drop');
        });
    });

    describe('evidenceAuditVerdict signal', () => {
        it('should apply -15 penalty for weak-evidence verdict', () => {
            const finding = makeFinding({ evidenceVerdict: 'weak-evidence' });
            const context = makeContext();
            const score = scoreFinding(finding, context);

            const signal = score.signals.find(
                (s) => s.signal === 'evidenceAuditVerdict'
            )!;
            expect(signal).toBeDefined();
            expect(signal.contribution).toBe(-15);
        });

        it('should apply -8 penalty for downgrade verdict', () => {
            const finding = makeFinding({ evidenceVerdict: 'downgrade' });
            const context = makeContext();
            const score = scoreFinding(finding, context);

            const signal = score.signals.find(
                (s) => s.signal === 'evidenceAuditVerdict'
            )!;
            expect(signal).toBeDefined();
            expect(signal.contribution).toBe(-8);
        });

        it('should apply 0 contribution for keep verdict', () => {
            const finding = makeFinding({ evidenceVerdict: 'keep' });
            const context = makeContext();
            const score = scoreFinding(finding, context);

            const signal = score.signals.find(
                (s) => s.signal === 'evidenceAuditVerdict'
            )!;
            expect(signal).toBeDefined();
            expect(signal.contribution).toBe(0);
        });

        it('should apply 0 contribution when verdict is undefined', () => {
            const finding = makeFinding();
            const context = makeContext();
            const score = scoreFinding(finding, context);

            const signal = score.signals.find(
                (s) => s.signal === 'evidenceAuditVerdict'
            )!;
            expect(signal).toBeDefined();
            expect(signal.contribution).toBe(0);
        });

        it('should noticeably lower score for weak-evidence finding vs same finding without verdict', () => {
            const baseContext = makeContext();
            const withoutVerdict = scoreFinding(makeFinding(), baseContext);
            const withVerdict = scoreFinding(
                makeFinding({ evidenceVerdict: 'weak-evidence' }),
                baseContext
            );

            expect(withVerdict.overallScore).toBe(
                withoutVerdict.overallScore - 15
            );
        });
    });
});
