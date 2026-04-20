import { describe, it, expect } from 'vitest';
import { matchFindings } from '../../eval/harness/matcher';
import type { ExpectedFinding, MatchResult } from '../../eval/harness/types';
import type { RecordedFinding } from '../../types/findingTypes';

function makeProduced(
    overrides: Partial<RecordedFinding> = {}
): RecordedFinding {
    return {
        id: 'f1',
        agentId: 'primary',
        timestamp: 0,
        severity: 'HIGH',
        category: 'logic_error',
        title: 'Off-by-one in loop',
        file: 'src/a.ts',
        lineRange: [10, 10],
        description: 'i <= items.length allows out of bounds access',
        affectedComponent: 'paginate',
        failureMechanism: 'wrong_return_value',
        supportingToolCalls: [],
        disproof: { attempted: false, method: '', result: '' },
        verifiableClaims: [],
        lspValidation: undefined,
        ...overrides,
    };
}

function makeExpected(
    overrides: Partial<ExpectedFinding> = {}
): ExpectedFinding {
    return {
        severity: 'HIGH',
        category: 'logic_error',
        path: 'src/a.ts',
        lineHint: 10,
        mustMention: [],
        ...overrides,
    };
}

function metrics(result: MatchResult) {
    return {
        matched: result.matched.length,
        missed: result.missedExpected.length,
        falsePositives: result.falsePositives.length,
    };
}

describe('matchFindings', () => {
    describe('single-pair semantics', () => {
        it('produces a perfect match when all axes agree', () => {
            const result = matchFindings([makeProduced()], [makeExpected()]);
            expect(result.matched).toHaveLength(1);
            expect(result.matched[0]!.matchReason).toBe('both');
            expect(result.missedExpected).toEqual([]);
            expect(result.falsePositives).toEqual([]);
            expect(result.precision).toBeCloseTo(1, 3);
            expect(result.recall).toBeCloseTo(1, 3);
            expect(result.f1).toBeCloseTo(1, 3);
        });

        it('matches on category alone when severity differs', () => {
            const result = matchFindings(
                [makeProduced({ severity: 'LOW' })],
                [makeExpected({ severity: 'HIGH' })]
            );
            expect(result.matched).toHaveLength(1);
            expect(result.matched[0]!.matchReason).toBe('category');
            expect(result.precision).toBeCloseTo(1, 3);
            expect(result.recall).toBeCloseTo(1, 3);
            expect(result.f1).toBeCloseTo(1, 3);
        });

        it('matches on severity alone when category differs', () => {
            const result = matchFindings(
                [makeProduced({ category: 'security_vulnerability' })],
                [makeExpected({ category: 'logic_error' })]
            );
            expect(result.matched).toHaveLength(1);
            expect(result.matched[0]!.matchReason).toBe('severity');
        });

        it('prefers a both-axis match over a single-axis match at the same location', () => {
            const bothMatch = makeProduced({ id: 'p-both' });
            const severityOnly = makeProduced({
                id: 'p-sev',
                category: 'security_vulnerability',
            });
            const result = matchFindings(
                [severityOnly, bothMatch],
                [makeExpected()]
            );
            expect(result.matched).toHaveLength(1);
            expect(result.matched[0]!.produced.id).toBe('p-both');
            expect(result.matched[0]!.matchReason).toBe('both');
            expect(result.falsePositives.map((f) => f.id)).toEqual(['p-sev']);
        });
    });

    describe('line and path gating', () => {
        it('rejects a candidate whose line distance exceeds the tolerance', () => {
            const result = matchFindings(
                [makeProduced({ lineRange: [16, 16] })],
                [makeExpected({ lineHint: 10 })]
            );
            expect(metrics(result)).toEqual({
                matched: 0,
                missed: 1,
                falsePositives: 1,
            });
        });

        it('treats a line hint inside the produced range as zero distance', () => {
            const result = matchFindings(
                [makeProduced({ lineRange: [10, 20] })],
                [makeExpected({ lineHint: 15 })]
            );
            expect(result.matched).toHaveLength(1);
            expect(result.matched[0]!.matchReason).toBe('both');
        });

        it('refuses to match when paths differ', () => {
            const result = matchFindings(
                [makeProduced({ file: 'src/b.ts' })],
                [makeExpected({ path: 'src/a.ts' })]
            );
            expect(metrics(result)).toEqual({
                matched: 0,
                missed: 1,
                falsePositives: 1,
            });
        });
    });

    describe('mustMention filter', () => {
        it('rejects a candidate that does not contain any required substring', () => {
            const result = matchFindings(
                [
                    makeProduced({
                        title: 'loop bug',
                        description: 'loop iterates one past end',
                    }),
                ],
                [makeExpected({ mustMention: ['off-by-one'] })]
            );
            expect(metrics(result)).toEqual({
                matched: 0,
                missed: 1,
                falsePositives: 1,
            });
        });

        it('matches when the required substring appears with different casing', () => {
            const result = matchFindings(
                [
                    makeProduced({
                        title: 'Classic Off-By-One bug',
                        description: 'index overflow',
                    }),
                ],
                [makeExpected({ mustMention: ['off-by-one'] })]
            );
            expect(result.matched).toHaveLength(1);
        });
    });

    describe('greedy pairing', () => {
        it('pairs expected to produced in iteration order on equal-rank candidates', () => {
            const p1 = makeProduced({ id: 'p1', description: 'alpha beta' });
            const p2 = makeProduced({ id: 'p2', description: 'alpha beta' });
            const a = makeExpected({ mustMention: ['alpha'] });
            const b = makeExpected({ mustMention: ['beta'] });

            const forward = matchFindings([p1, p2], [a, b]);
            expect(forward.matched).toHaveLength(2);
            expect(forward.matched[0]!.produced.id).toBe('p1');
            expect(forward.matched[1]!.produced.id).toBe('p2');

            const reversed = matchFindings([p1, p2], [b, a]);
            expect(reversed.matched).toHaveLength(2);
            expect(reversed.matched[0]!.produced.id).toBe('p1');
            expect(reversed.matched[1]!.produced.id).toBe('p2');
            expect(reversed.matched[0]!.expected).toEqual(b);
            expect(reversed.matched[1]!.expected).toEqual(a);
        });

        it('breaks ties by lowest remaining produced index', () => {
            const p1 = makeProduced({ id: 'p1' });
            const p2 = makeProduced({ id: 'p2' });
            const result = matchFindings([p1, p2], [makeExpected()]);
            expect(result.matched).toHaveLength(1);
            expect(result.matched[0]!.produced.id).toBe('p1');
            expect(result.falsePositives.map((f) => f.id)).toEqual(['p2']);
        });
    });

    describe('metrics under imbalance', () => {
        it('counts unmatched produced findings as false positives', () => {
            const produced = [
                makeProduced({ id: 'match' }),
                makeProduced({
                    id: 'extra1',
                    file: 'src/other.ts',
                    category: 'data_integrity',
                    severity: 'LOW',
                }),
                makeProduced({
                    id: 'extra2',
                    file: 'src/another.ts',
                    category: 'resource_leak',
                    severity: 'MEDIUM',
                }),
            ];
            const result = matchFindings(produced, [makeExpected()]);
            expect(result.matched).toHaveLength(1);
            expect(result.matched[0]!.produced.id).toBe('match');
            expect(result.falsePositives.map((f) => f.id).sort()).toEqual([
                'extra1',
                'extra2',
            ]);
            expect(result.precision).toBeCloseTo(1 / 3, 3);
            expect(result.recall).toBeCloseTo(1, 3);
            expect(result.f1).toBeCloseTo(0.5, 3);
        });

        it('counts unmatched expected findings as missed', () => {
            const produced = [makeProduced()];
            const expected = [
                makeExpected(),
                makeExpected({ path: 'src/elsewhere.ts', lineHint: 99 }),
            ];
            const result = matchFindings(produced, expected);
            expect(result.matched).toHaveLength(1);
            expect(result.missedExpected).toHaveLength(1);
            expect(result.missedExpected[0]!.path).toBe('src/elsewhere.ts');
            expect(result.precision).toBeCloseTo(1, 3);
            expect(result.recall).toBeCloseTo(0.5, 3);
            expect(result.f1).toBeCloseTo(2 / 3, 3);
        });
    });

    describe('empty-input semantics', () => {
        it('returns perfect scores when both sides are empty', () => {
            const result = matchFindings([], []);
            expect(result.matched).toEqual([]);
            expect(result.missedExpected).toEqual([]);
            expect(result.falsePositives).toEqual([]);
            expect(result.precision).toBeCloseTo(1, 3);
            expect(result.recall).toBeCloseTo(1, 3);
            expect(result.f1).toBeCloseTo(1, 3);
        });

        it('returns zero precision, recall, and f1 when produced is empty but expected is not', () => {
            const result = matchFindings([], [makeExpected()]);
            expect(result.precision).toBeCloseTo(0, 3);
            expect(result.recall).toBeCloseTo(0, 3);
            expect(result.f1).toBeCloseTo(0, 3);
            expect(result.missedExpected).toHaveLength(1);
        });

        it('returns zero precision and zero f1 when expected is empty but produced is not', () => {
            const result = matchFindings([makeProduced()], []);
            expect(result.precision).toBeCloseTo(0, 3);
            expect(result.recall).toBeCloseTo(1, 3);
            expect(result.f1).toBeCloseTo(0, 3);
            expect(result.falsePositives).toHaveLength(1);
            expect(result.matched).toEqual([]);
        });
    });
});
