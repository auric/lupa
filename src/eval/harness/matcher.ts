import type { RecordedFinding } from '../../types/findingTypes';
import { LINE_HINT_TOLERANCE } from './constants';
import type { ExpectedFinding, MatchedPair, MatchResult } from './types';

type MatchReason = 'category' | 'severity' | 'both';

interface Candidate {
    index: number;
    finding: RecordedFinding;
    reason: MatchReason;
    distance: number;
}

/**
 * Greedy one-to-one matcher between expected findings and produced findings.
 * For each expected entry (in order) the best unmatched produced finding is
 * selected by (1) stronger match reason (both > category > severity),
 * (2) smaller line-hint distance, (3) lowest remaining index; `mustMention`
 * acts as a hard substring filter when non-empty. Precision/recall/F1 are
 * derived from the final matching.
 */
export function matchFindings(
    produced: readonly RecordedFinding[],
    expected: readonly ExpectedFinding[]
): MatchResult {
    const remaining: (RecordedFinding | null)[] = produced.slice();
    const matched: MatchedPair[] = [];
    const missedExpected: ExpectedFinding[] = [];

    for (const exp of expected) {
        const candidates: Candidate[] = [];
        for (let i = 0; i < remaining.length; i++) {
            const cand = remaining[i];
            if (!cand) {
                continue;
            }
            if (cand.file !== exp.path) {
                continue;
            }
            const distance = lineDistance(cand.lineRange, exp.lineHint);
            if (distance > LINE_HINT_TOLERANCE) {
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

    const falsePositives: RecordedFinding[] = remaining.filter(
        (r): r is RecordedFinding => r !== null
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

function lineDistance(
    range: readonly [number, number],
    lineHint: number
): number {
    const [start, end] = range;
    return Math.max(0, lineHint - end, start - lineHint);
}

function passesMustMention(
    finding: RecordedFinding,
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
