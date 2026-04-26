import { LINE_HINT_TOLERANCE } from './constants';
import { normalizeWorkspaceRelativePath } from '../headlessShared';
import { pathsEqualForComparison } from './pathUtils';
import type {
    ExpectedFinding,
    HarnessRecordedFinding,
    MatchedPair,
    MatchResult,
} from './types';

type MatchReason = 'category' | 'severity' | 'both';

interface Candidate {
    index: number;
    finding: HarnessRecordedFinding;
    reason: MatchReason;
    distance: number;
}

/**
 * Greedy one-to-one pairing of produced findings with expected findings (per Quest 8.1).
 *
 * A candidate produced finding matches an expected one when:
 *   - `produced.file === expected.path` (exact)
 *   - line distance between `produced.lineRange` and `expected.lineHint` ≤ LINE_HINT_TOLERANCE (±5)
 *   - `produced.category === expected.category` OR `produced.severity === expected.severity`
 *   - if `expected.mustMention` is non-empty: at least one substring (case-insensitive) appears
 *     somewhere in `produced.title + ' ' + produced.description`
 *
 * Expected findings are iterated in input order; each is paired with its best remaining candidate,
 * ranked by (1) 'both'-axis match over single-axis, (2) smaller line distance, (3) lower array index.
 * Returns matched pairs, unmatched expected (missed bugs), unmatched produced (false positives),
 * and precision/recall/F1 where empty-both yields 1/1/1 and empty-produced-with-expected yields 0/0/0.
 */
export function matchFindings(
    produced: readonly HarnessRecordedFinding[],
    expected: readonly ExpectedFinding[],
    workspaceRoot?: string
): MatchResult {
    const remaining: (HarnessRecordedFinding | null)[] = produced.slice();
    const matched: MatchedPair[] = [];
    const missedExpected: ExpectedFinding[] = [];

    for (const exp of expected) {
        const normalizedExpectedPath = normalizeWorkspaceRelativePath(
            exp.path,
            workspaceRoot
        );
        const candidates: Candidate[] = [];
        for (let i = 0; i < remaining.length; i++) {
            const cand = remaining[i];
            if (!cand) {
                continue;
            }
            if (
                !pathsEqualForComparison(
                    normalizeWorkspaceRelativePath(cand.file, workspaceRoot),
                    normalizedExpectedPath
                )
            ) {
                continue;
            }
            const distance = lineDistance(cand.lineRange, exp.lineHint);
            if (!Number.isFinite(distance) || distance > LINE_HINT_TOLERANCE) {
                continue;
            }
            const categoryMatch = cand.category === exp.category;
            const severityMatch = cand.severity === exp.severity;
            if (!categoryMatch && !severityMatch) {
                continue;
            }
            if (!passesMustMention(cand, exp.mustMention)) {
                continue;
            }
            const reason: MatchReason =
                categoryMatch && severityMatch
                    ? 'both'
                    : categoryMatch
                      ? 'category'
                      : 'severity';
            candidates.push({ index: i, finding: cand, reason, distance });
        }

        if (candidates.length === 0) {
            missedExpected.push(exp);
            continue;
        }

        candidates.sort(compareCandidates);
        const best = candidates[0]!;
        matched.push({
            expected: exp,
            produced: best.finding,
            matchReason: best.reason,
        });
        remaining[best.index] = null;
    }

    const falsePositives: HarnessRecordedFinding[] = remaining.filter(
        (r): r is HarnessRecordedFinding => r !== null
    );

    const producedCount = produced.length;
    const matchedCount = matched.length;
    const expectedCount = expected.length;

    const precision =
        producedCount === 0
            ? expectedCount === 0
                ? 1
                : 0
            : matchedCount / producedCount;
    const recall = expectedCount === 0 ? 1 : matchedCount / expectedCount;
    const f1 =
        precision + recall === 0
            ? 0
            : (2 * precision * recall) / (precision + recall);

    return { matched, missedExpected, falsePositives, precision, recall, f1 };
}

/**
 * Distance from a line hint to a line range.
 * Returns 0 when `lineHint` falls inside `[start, end]`; otherwise the distance to the nearest edge.
 */
function lineDistance(
    range: readonly [number, number],
    lineHint: number
): number {
    const [start, end] = range;
    return Math.max(0, lineHint - end, start - lineHint);
}

function passesMustMention(
    finding: HarnessRecordedFinding,
    mustMention: readonly string[]
): boolean {
    if (mustMention.length === 0) {
        return true;
    }
    const haystack = (finding.title + ' ' + finding.description).toLowerCase();
    for (const needle of mustMention) {
        if (haystack.includes(needle.toLowerCase())) {
            return true;
        }
    }
    return false;
}

function reasonRank(reason: MatchReason): number {
    switch (reason) {
        case 'both':
            return 0;
        case 'category':
            return 1;
        case 'severity':
            return 2;
    }
}

function compareCandidates(a: Candidate, b: Candidate): number {
    const rankDiff = reasonRank(a.reason) - reasonRank(b.reason);
    if (rankDiff !== 0) {
        return rankDiff;
    }
    if (a.distance !== b.distance) {
        return a.distance - b.distance;
    }
    return a.index - b.index;
}
