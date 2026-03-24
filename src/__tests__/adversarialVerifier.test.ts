import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AdversarialVerifier } from '../services/adversarialVerifier';
import { FindingStore } from '../sessions/findingStore';
import { createMockCancellationToken } from './testUtils/mockFactories';
import type { RecordedFinding } from '../types/findingTypes';
import type { ModelCalibrationProfile } from '../models/modelCalibration';
import type { SubagentResult } from '../types/modelTypes';
import type { ToolCallRecord } from '../types/toolCallTypes';

function makeFinding(
    overrides: Partial<
        Omit<RecordedFinding, 'id' | 'timestamp' | 'lspValidation'>
    > = {}
): Omit<RecordedFinding, 'id' | 'timestamp' | 'lspValidation'> {
    return {
        agentId: 'root',
        severity: 'HIGH',
        category: 'logic_error',
        title: 'Potential null reference',
        file: 'src/services/foo.ts',
        lineRange: [10, 15] as [number, number],
        description: 'The function does not check for null',
        affectedComponent: 'getValue()',
        failureMechanism: 'runtime_exception',
        supportingToolCalls: ['call-1'],
        disproof: {
            attempted: true,
            method: 'counter-search',
            result: 'No counter-evidence found',
        },
        verifiableClaims: [],
        ...overrides,
    };
}

function makeSubagentResult(
    overrides: Partial<SubagentResult> = {}
): SubagentResult {
    return {
        success: true,
        response: 'VERDICT: CONFIRMED',
        toolCallsMade: 3,
        toolCalls: [],
        executionTimeMs: 1000,
        ...overrides,
    };
}

function makeProfile(
    overrides: Partial<ModelCalibrationProfile> = {}
): ModelCalibrationProfile {
    return {
        name: 'test',
        findingBias: 'balanced',
        challengeMode: 'devils-advocate',
        adversarialVerificationThreshold: 'LOW',
        adversarialBudget: 7,
        includeAgenticPreamble: false,
        disabledTools: [],
        maxSubagentsPerSession: 200,
        minToolCallsBeforeFirstFinding: 2,
        ...overrides,
    } as ModelCalibrationProfile;
}

describe('AdversarialVerifier', () => {
    let verifier: AdversarialVerifier;
    let store: FindingStore;
    let mockExecutor: { execute: ReturnType<typeof vi.fn> };
    let token: ReturnType<typeof createMockCancellationToken>;
    let profile: ModelCalibrationProfile;

    beforeEach(() => {
        verifier = new AdversarialVerifier();
        store = new FindingStore();
        mockExecutor = { execute: vi.fn() };
        token = createMockCancellationToken();
        profile = makeProfile();
    });

    describe('verify', () => {
        it('returns empty result when no findings match threshold', async () => {
            // Store has only LOW findings, threshold is HIGH
            store.record(makeFinding({ severity: 'LOW' }));
            const highProfile = makeProfile({
                adversarialVerificationThreshold: 'HIGH',
            });

            const result = await verifier.verify(
                store,
                highProfile,
                mockExecutor as never,
                undefined,
                token
            );

            expect(result).toEqual({
                confirmed: [],
                refuted: [],
                uncertain: [],
                toolCallRecords: [],
            });
            expect(mockExecutor.execute).not.toHaveBeenCalled();
        });

        it('returns empty result when store is empty', async () => {
            const result = await verifier.verify(
                store,
                profile,
                mockExecutor as never,
                undefined,
                token
            );

            expect(result).toEqual({
                confirmed: [],
                refuted: [],
                uncertain: [],
                toolCallRecords: [],
            });
        });

        it('confirms findings with CONFIRMED verdict', async () => {
            store.record(makeFinding({ title: 'Bug A' }));
            mockExecutor.execute.mockResolvedValue(
                makeSubagentResult({ response: 'VERDICT: CONFIRMED' })
            );

            const result = await verifier.verify(
                store,
                profile,
                mockExecutor as never,
                undefined,
                token
            );

            expect(result.confirmed).toEqual(['Bug A']);
            expect(result.refuted).toEqual([]);
            expect(result.uncertain).toEqual([]);
            expect(store.size).toBe(1);
        });

        it('removes refuted findings from store', async () => {
            store.record(makeFinding({ title: 'False Positive' }));
            mockExecutor.execute.mockResolvedValue(
                makeSubagentResult({ response: 'VERDICT: REFUTED' })
            );

            const result = await verifier.verify(
                store,
                profile,
                mockExecutor as never,
                undefined,
                token
            );

            expect(result.refuted).toEqual(['False Positive']);
            expect(result.confirmed).toEqual([]);
            expect(store.size).toBe(0);
        });

        it('keeps uncertain findings in store', async () => {
            store.record(makeFinding({ title: 'Ambiguous' }));
            mockExecutor.execute.mockResolvedValue(
                makeSubagentResult({
                    response: 'I could not determine the answer.',
                })
            );

            const result = await verifier.verify(
                store,
                profile,
                mockExecutor as never,
                undefined,
                token
            );

            expect(result.uncertain).toEqual(['Ambiguous']);
            expect(store.size).toBe(1);
        });

        it('handles mixed verdicts across multiple findings', async () => {
            store.record(
                makeFinding({ title: 'Real Bug', severity: 'CRITICAL' })
            );
            store.record(makeFinding({ title: 'Not a Bug', severity: 'HIGH' }));
            store.record(
                makeFinding({ title: 'Maybe Bug', severity: 'MEDIUM' })
            );

            mockExecutor.execute
                .mockResolvedValueOnce(
                    makeSubagentResult({ response: 'VERDICT: CONFIRMED' })
                )
                .mockResolvedValueOnce(
                    makeSubagentResult({ response: 'VERDICT: REFUTED' })
                )
                .mockResolvedValueOnce(
                    makeSubagentResult({ response: 'ambiguous result' })
                );

            const result = await verifier.verify(
                store,
                profile,
                mockExecutor as never,
                undefined,
                token
            );

            expect(result.confirmed).toEqual(['Real Bug']);
            expect(result.refuted).toEqual(['Not a Bug']);
            expect(result.uncertain).toEqual(['Maybe Bug']);
            expect(store.size).toBe(2);
        });

        it('treats executor errors as UNCERTAIN', async () => {
            store.record(makeFinding({ title: 'Error Case' }));
            mockExecutor.execute.mockRejectedValue(
                new Error('LLM API failure')
            );

            const result = await verifier.verify(
                store,
                profile,
                mockExecutor as never,
                undefined,
                token
            );

            expect(result.uncertain).toEqual(['Error Case']);
            expect(store.size).toBe(1);
        });

        it('calls progress callback at start and per finding', async () => {
            store.record(makeFinding({ title: 'A' }));
            store.record(makeFinding({ title: 'B' }));
            mockExecutor.execute.mockResolvedValue(
                makeSubagentResult({ response: 'VERDICT: CONFIRMED' })
            );
            const progress = vi.fn();

            await verifier.verify(
                store,
                profile,
                mockExecutor as never,
                undefined,
                token,
                progress
            );

            expect(progress).toHaveBeenCalledWith(
                'Adversarial verification of 2 finding(s) in parallel...'
            );
            expect(progress).toHaveBeenCalledWith('Adversarial: 1/2 verified');
            expect(progress).toHaveBeenCalledWith('Adversarial: 2/2 verified');
        });

        it('builds synthetic toolCallRecords with nested calls', async () => {
            store.record(
                makeFinding({
                    title: 'Test Finding',
                    severity: 'HIGH',
                    file: 'src/foo.ts',
                })
            );
            const nestedCalls: ToolCallRecord[] = [
                {
                    id: 'inner-1',
                    toolName: 'read_file',
                    arguments: { file: 'src/foo.ts' },
                    result: 'file content',
                    success: true,
                    error: undefined,
                    durationMs: 50,
                    timestamp: Date.now(),
                },
            ];
            mockExecutor.execute.mockResolvedValue(
                makeSubagentResult({
                    response: 'VERDICT: CONFIRMED',
                    toolCalls: nestedCalls,
                })
            );

            const result = await verifier.verify(
                store,
                profile,
                mockExecutor as never,
                undefined,
                token
            );

            expect(result.toolCallRecords).toHaveLength(1);
            const record = result.toolCallRecords[0]!;
            expect(record.toolName).toBe('adversarial_verification');
            expect(record.arguments).toEqual({
                finding_title: 'Test Finding',
                finding_severity: 'HIGH',
                finding_file: 'src/foo.ts',
            });
            expect(record.result).toContain('CONFIRMED');
            expect(record.nestedCalls).toBe(nestedCalls);
        });

        it('excludes record_finding and retract_finding from subagent tools', async () => {
            store.record(makeFinding());
            mockExecutor.execute.mockResolvedValue(
                makeSubagentResult({ response: 'VERDICT: CONFIRMED' })
            );

            await verifier.verify(
                store,
                profile,
                mockExecutor as never,
                undefined,
                token
            );

            const options = mockExecutor.execute.mock.calls[0]![3];
            expect(options.excludeTools).toEqual([
                'record_finding',
                'retract_finding',
            ]);
        });
    });

    describe('threshold selection', () => {
        it('verifies only CRITICAL when threshold is CRITICAL', async () => {
            store.record(makeFinding({ title: 'Crit', severity: 'CRITICAL' }));
            store.record(makeFinding({ title: 'High', severity: 'HIGH' }));
            store.record(makeFinding({ title: 'Med', severity: 'MEDIUM' }));

            mockExecutor.execute.mockResolvedValue(
                makeSubagentResult({ response: 'VERDICT: CONFIRMED' })
            );

            const critProfile = makeProfile({
                adversarialVerificationThreshold: 'CRITICAL',
            });
            const result = await verifier.verify(
                store,
                critProfile,
                mockExecutor as never,
                undefined,
                token
            );

            expect(mockExecutor.execute).toHaveBeenCalledTimes(1);
            expect(result.confirmed).toEqual(['Crit']);
        });

        it('verifies CRITICAL and HIGH when threshold is HIGH', async () => {
            store.record(makeFinding({ title: 'Crit', severity: 'CRITICAL' }));
            store.record(makeFinding({ title: 'High', severity: 'HIGH' }));
            store.record(makeFinding({ title: 'Low', severity: 'LOW' }));

            mockExecutor.execute.mockResolvedValue(
                makeSubagentResult({ response: 'VERDICT: CONFIRMED' })
            );

            const highProfile = makeProfile({
                adversarialVerificationThreshold: 'HIGH',
            });
            const result = await verifier.verify(
                store,
                highProfile,
                mockExecutor as never,
                undefined,
                token
            );

            expect(mockExecutor.execute).toHaveBeenCalledTimes(2);
            expect(result.confirmed).toContain('Crit');
            expect(result.confirmed).toContain('High');
        });

        it('verifies all severities when threshold is LOW', async () => {
            store.record(makeFinding({ title: 'Crit', severity: 'CRITICAL' }));
            store.record(makeFinding({ title: 'High', severity: 'HIGH' }));
            store.record(makeFinding({ title: 'Med', severity: 'MEDIUM' }));
            store.record(makeFinding({ title: 'Low', severity: 'LOW' }));

            mockExecutor.execute.mockResolvedValue(
                makeSubagentResult({ response: 'VERDICT: CONFIRMED' })
            );

            const result = await verifier.verify(
                store,
                profile,
                mockExecutor as never,
                undefined,
                token
            );

            expect(mockExecutor.execute).toHaveBeenCalledTimes(4);
            expect(result.confirmed).toHaveLength(4);
        });
    });

    describe('parseVerdict', () => {
        async function getVerdict(response: string): Promise<string> {
            const v = new AdversarialVerifier();
            const s = new FindingStore();
            s.record(makeFinding({ title: 'Test' }));
            const executor = {
                execute: vi
                    .fn()
                    .mockResolvedValue(makeSubagentResult({ response })),
            };

            const result = await v.verify(
                s,
                makeProfile(),
                executor as never,
                undefined,
                createMockCancellationToken()
            );

            if (result.confirmed.length > 0) {
                return 'CONFIRMED';
            }
            if (result.refuted.length > 0) {
                return 'REFUTED';
            }
            return 'UNCERTAIN';
        }

        it('parses "VERDICT: CONFIRMED"', async () => {
            expect(await getVerdict('VERDICT: CONFIRMED')).toBe('CONFIRMED');
        });

        it('parses "VERDICT:CONFIRMED" without space', async () => {
            expect(await getVerdict('VERDICT:CONFIRMED')).toBe('CONFIRMED');
        });

        it('parses "VERDICT: REFUTED"', async () => {
            expect(await getVerdict('VERDICT: REFUTED')).toBe('REFUTED');
        });

        it('parses "VERDICT:REFUTED" without space', async () => {
            expect(await getVerdict('VERDICT:REFUTED')).toBe('REFUTED');
        });

        it('parses "VERDICT: UNCERTAIN"', async () => {
            expect(await getVerdict('VERDICT: UNCERTAIN')).toBe('UNCERTAIN');
        });

        it('parses case-insensitive "verdict: confirmed"', async () => {
            expect(await getVerdict('verdict: confirmed')).toBe('CONFIRMED');
        });

        it('falls back to word boundary REFUTED', async () => {
            expect(
                await getVerdict(
                    'After analysis, the finding is REFUTED by the evidence.'
                )
            ).toBe('REFUTED');
        });

        it('falls back to word boundary CONFIRMED', async () => {
            expect(
                await getVerdict(
                    'The bug is CONFIRMED based on the code review.'
                )
            ).toBe('CONFIRMED');
        });

        it('returns UNCERTAIN when both CONFIRMED and REFUTED present', async () => {
            expect(
                await getVerdict(
                    'Some evidence is CONFIRMED but the main claim is REFUTED.'
                )
            ).toBe('UNCERTAIN');
        });

        it('returns UNCERTAIN for ambiguous text', async () => {
            expect(
                await getVerdict('The code looks fine but I am not sure.')
            ).toBe('UNCERTAIN');
        });

        it('prefers explicit VERDICT: over word boundary', async () => {
            expect(
                await getVerdict(
                    'I initially thought REFUTED but VERDICT: CONFIRMED.'
                )
            ).toBe('CONFIRMED');
        });
    });

    describe('cancellation', () => {
        it('throws CancellationError when token is pre-cancelled', async () => {
            store.record(makeFinding());
            const cancelledToken = createMockCancellationToken(true);

            await expect(
                verifier.verify(
                    store,
                    profile,
                    mockExecutor as never,
                    undefined,
                    cancelledToken
                )
            ).rejects.toThrow();
        });
    });
});
