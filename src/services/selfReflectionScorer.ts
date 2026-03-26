import type { RecordedFinding } from '../types/findingTypes';
import type { DiffHunk } from '../types/contextTypes';
import type { ModelCalibrationProfile } from '../models/modelCalibration';
import type { ConversationManager } from '../models/conversationManager';
import type {
    ConversationRunner,
    ToolCallHandler,
} from '../models/conversationRunner';
import type { FindingStore } from '../sessions/findingStore';
import type * as vscode from 'vscode';
import { Log } from './loggingService';

const SELF_REFLECTION_BUDGET = 10;
const DIFF_SNIPPET_CONTEXT_LINES = 5;

export interface SelfReflectionScore {
    findingId: string;
    title: string;
    score: number;
    rationale: string;
}

export interface SelfReflectionResult {
    scores: SelfReflectionScore[];
    dropped: string[];
    kept: string[];
}

export interface SelfReflectionOptions {
    findingStore: FindingStore;
    parsedDiff: DiffHunk[];
    calibrationProfile: ModelCalibrationProfile;
    conversationManager: ConversationManager;
    conversationRunner: ConversationRunner;
    systemPrompt: string;
    token: vscode.CancellationToken;
    handler: ToolCallHandler;
}

export function buildSelfReflectionPrompt(
    findings: RecordedFinding[],
    parsedDiff: DiffHunk[],
    threshold: number
): string {
    const findingsList = findings
        .map((f, i) => {
            const diffSnippet = getDiffSnippetForFinding(f, parsedDiff);
            return (
                `--- Finding ${i + 1} ---\n` +
                `Title: ${f.title}\n` +
                `Severity: ${f.severity}\n` +
                `Category: ${f.category}\n` +
                `File: ${f.file}:${f.lineRange[0]}-${f.lineRange[1]}\n` +
                `Description: ${f.description}\n` +
                `Affected component: ${f.affectedComponent || 'N/A'}\n` +
                `Failure mechanism: ${f.failureMechanism || 'N/A'}\n` +
                `Evidence: ${f.disproof.attempted ? f.disproof.result : 'none recorded'}\n` +
                (diffSnippet ? `Relevant diff:\n${diffSnippet}\n` : '')
            );
        })
        .join('\n');

    return (
        `SELF-REFLECTION SCORING — You are re-evaluating your own code review findings.\n\n` +
        `For each finding, assign a confidence score from 1 to 10:\n` +
        `- 1-3: Almost certainly wrong (speculative, cosmetic, missing-feature complaints, hypothetical scenarios)\n` +
        `- 4-6: Possibly valid but weak evidence or unlikely scenario\n` +
        `- 7-8: Likely valid with concrete evidence from tool output\n` +
        `- 9-10: Verified critical issue backed by specific tool output showing the exact problem\n\n` +
        `SCORING CRITERIA:\n` +
        `1. Evidence grounding: Is the claim backed by specific tool output (file contents, symbol references, search results) or speculation?\n` +
        `2. Behavioral impact: Does this describe a concrete bug (wrong return value, crash, data corruption, security bypass) or a style concern?\n` +
        `3. Reproducibility: Could a developer write a test demonstrating this failure?\n` +
        `4. False positive signals — score LOW if any apply:\n` +
        `   - Claims about "missing" things without showing WHERE the failure occurs\n` +
        `   - Hypothetical scenarios ("if someone does X") without evidence X actually happens\n` +
        `   - Style or naming preferences disguised as bugs\n` +
        `   - Issues in the original code NOT introduced by this PR\n` +
        `   - Suggestions for adding tests/docs/validation (these are enhancements, not bugs)\n\n` +
        `Findings below score ${threshold} will be dropped from the review.\n\n` +
        `FINDINGS TO EVALUATE:\n\n${findingsList}\n\n` +
        `For EACH finding, output exactly one line in this format:\n` +
        `SCORE: <exact title> | <score 1-10> | <brief rationale>`
    );
}

export function getDiffSnippetForFinding(
    finding: RecordedFinding,
    parsedDiff: DiffHunk[]
): string | undefined {
    const normalizedFile = finding.file.replace(/\\/g, '/');
    const hunk = parsedDiff.find((d) => {
        const normalizedDiff = d.filePath.replace(/\\/g, '/');
        return (
            normalizedDiff === normalizedFile ||
            normalizedDiff.endsWith(normalizedFile) ||
            normalizedFile.endsWith(normalizedDiff)
        );
    });

    if (!hunk) {
        return undefined;
    }

    const targetLine = finding.lineRange[0];
    const lines: string[] = [];

    for (const h of hunk.hunks) {
        for (const pl of h.parsedLines) {
            if (pl.lineNumber === undefined) {
                continue;
            }
            const inRange =
                pl.lineNumber >= targetLine - DIFF_SNIPPET_CONTEXT_LINES &&
                pl.lineNumber <=
                    finding.lineRange[1] + DIFF_SNIPPET_CONTEXT_LINES;
            if (inRange) {
                const prefix =
                    pl.type === 'added'
                        ? '+'
                        : pl.type === 'removed'
                          ? '-'
                          : ' ';
                lines.push(`${prefix}${pl.content}`);
            }
        }
    }

    if (lines.length === 0) {
        return undefined;
    }
    return lines.slice(0, 30).join('\n');
}

const SCORE_LINE_PATTERN =
    /^SCORE:\s*"?(.+?)"?\s*\|\s*(\d+)(?:\/10)?\s*\|\s*(.+)$/i;

export function parseSelfReflectionResponse(
    response: string,
    findings: RecordedFinding[]
): SelfReflectionScore[] {
    const scores: SelfReflectionScore[] = [];
    if (!response) {
        return scores;
    }

    const lines = response.split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        const match = trimmed.match(SCORE_LINE_PATTERN);
        if (!match) {
            continue;
        }

        const title = match[1]!.trim();
        const scoreNum = parseInt(match[2]!, 10);
        const rationale = match[3]!.trim();

        if (isNaN(scoreNum) || scoreNum < 1 || scoreNum > 10) {
            continue;
        }

        const finding = findByFuzzyTitle(title, findings);
        if (!finding) {
            continue;
        }

        if (scores.some((s) => s.findingId === finding.id)) {
            continue;
        }

        scores.push({
            findingId: finding.id,
            title: finding.title,
            score: scoreNum,
            rationale,
        });
    }

    return scores;
}

function findByFuzzyTitle(
    title: string,
    findings: RecordedFinding[]
): RecordedFinding | undefined {
    const normalizedTitle = title.toLowerCase().trim();

    const exact = findings.find(
        (f) => f.title.toLowerCase().trim() === normalizedTitle
    );
    if (exact) {
        return exact;
    }

    const matches = findings.filter(
        (f) =>
            f.title.toLowerCase().trim().includes(normalizedTitle) ||
            normalizedTitle.includes(f.title.toLowerCase().trim())
    );

    if (matches.length === 0) {
        return undefined;
    }
    return matches.reduce((shortest, f) =>
        f.title.length < shortest.title.length ? f : shortest
    );
}

export async function runSelfReflection(
    options: SelfReflectionOptions
): Promise<SelfReflectionResult> {
    const findings = options.findingStore.getAll();
    if (findings.length === 0) {
        return { scores: [], dropped: [], kept: [] };
    }

    const threshold = options.calibrationProfile.selfReflectionThreshold;
    const prompt = buildSelfReflectionPrompt(
        findings,
        options.parsedDiff,
        threshold
    );

    options.conversationManager.addUserMessage(prompt);

    const response = await options.conversationRunner.run(
        {
            systemPrompt: options.systemPrompt,
            maxIterations: SELF_REFLECTION_BUDGET,
            tools: [],
            label: 'Self-Reflection Scoring',
        },
        options.conversationManager,
        options.token,
        options.handler
    );

    const scores = parseSelfReflectionResponse(response, findings);
    const dropped: string[] = [];
    const kept: string[] = [];

    for (const score of scores) {
        if (score.score < threshold) {
            const finding = options.findingStore.getById(score.findingId);
            if (finding && options.findingStore.remove(score.findingId)) {
                dropped.push(finding.title);
                Log.info(
                    `Self-reflection: dropped "${finding.title}" (score: ${score.score}/${threshold}, rationale: ${score.rationale})`
                );
            }
        } else {
            kept.push(score.title);
            Log.info(
                `Self-reflection: kept "${score.title}" (score: ${score.score}/${threshold})`
            );
        }
    }

    const scoredIds = new Set(scores.map((s) => s.findingId));
    for (const f of findings) {
        if (!scoredIds.has(f.id)) {
            kept.push(f.title);
            Log.info(
                `Self-reflection: kept "${f.title}" (no score received — fail-safe)`
            );
        }
    }

    Log.info(
        `Self-reflection scoring: ${dropped.length} dropped, ${kept.length} kept (threshold: ${threshold})`
    );

    return { scores, dropped, kept };
}
