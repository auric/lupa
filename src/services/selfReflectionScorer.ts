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
import { ScoreFindingTool } from '../tools/scoreFindingTool';
import { Log } from './loggingService';

const SELF_REFLECTION_BUDGET = 10;
const DIFF_SNIPPET_CONTEXT_LINES = 5;
const SCORE_FINDING_TOOL_NAME = 'score_finding';

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
                `ID: ${f.id}\n` +
                `Title: ${f.title}\n` +
                `Severity: ${f.severity}\n` +
                `Category: ${f.category}\n` +
                `File: ${f.file}:${f.lineRange[0]}-${f.lineRange[1]}\n` +
                `Description: ${f.description}\n` +
                `Affected component: ${f.affectedComponent || 'N/A'}\n` +
                `Failure mechanism: ${f.failureMechanism || 'N/A'}\n` +
                `Verification evidence: ${f.verificationEvidence || 'none recorded'}\n` +
                `Disproof attempt: ${f.disproof.attempted ? f.disproof.result : 'none attempted'}\n` +
                (diffSnippet ? `Relevant diff:\n${diffSnippet}\n` : '')
            );
        })
        .join('\n');

    return (
        `SELF-REFLECTION SCORING — You are re-evaluating your own code review findings.\n\n` +
        `For each finding, call the score_finding tool with your confidence score from 1 to 10:\n` +
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
        `Call score_finding for EACH finding above. Use the exact finding ID shown.`
    );
}

export function getDiffSnippetForFinding(
    finding: RecordedFinding,
    parsedDiff: DiffHunk[]
): string | undefined {
    const normalizedFile = finding.file.replace(/\\/g, '/').toLowerCase();
    const hunk = parsedDiff.find((d) => {
        const normalizedDiff = d.filePath.replace(/\\/g, '/').toLowerCase();
        return (
            normalizedDiff === normalizedFile ||
            normalizedDiff.endsWith('/' + normalizedFile) ||
            normalizedFile.endsWith('/' + normalizedDiff)
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

function collectScoresFromHandler(
    findingStore: FindingStore,
    handler: ToolCallHandler | undefined
): { scoringHandler: ToolCallHandler; getScores: () => SelfReflectionScore[] } {
    const scores: SelfReflectionScore[] = [];
    const scoredIds = new Set<string>();

    const scoringHandler: ToolCallHandler = {
        onToolCallStart: handler?.onToolCallStart?.bind(handler),
        onToolCallComplete: (
            callId,
            toolName,
            args,
            result,
            success,
            error,
            duration,
            metadata
        ) => {
            handler?.onToolCallComplete?.(
                callId,
                toolName,
                args,
                result,
                success,
                error,
                duration,
                metadata
            );

            if (toolName === SCORE_FINDING_TOOL_NAME && success) {
                const findingId = String(args.finding_id ?? '');
                const score = Number(args.score);
                const rationale = String(args.rationale ?? '');

                if (!findingId || isNaN(score) || scoredIds.has(findingId)) {
                    return;
                }

                const finding = findingStore.getById(findingId);
                if (!finding) {
                    return;
                }

                scoredIds.add(findingId);
                scores.push({
                    findingId,
                    title: finding.title,
                    score,
                    rationale,
                });
            }
        },
        getContextStatusSuffix: handler?.getContextStatusSuffix?.bind(handler),
        onIterationStart: handler?.onIterationStart?.bind(handler),
    };

    return { scoringHandler, getScores: () => scores };
}

export async function runSelfReflection(
    options: SelfReflectionOptions
): Promise<SelfReflectionResult> {
    const findings = options.findingStore.getAll();
    if (findings.length === 0) {
        return { scores: [], dropped: [], kept: [] };
    }

    const scoreFindingTool = new ScoreFindingTool();

    const threshold = options.calibrationProfile.selfReflectionThreshold;
    const prompt = buildSelfReflectionPrompt(
        findings,
        options.parsedDiff,
        threshold
    );

    const { scoringHandler, getScores } = collectScoresFromHandler(
        options.findingStore,
        options.handler
    );

    options.conversationManager.addUserMessage(prompt);

    await options.conversationRunner.run(
        {
            systemPrompt: options.systemPrompt,
            maxIterations: SELF_REFLECTION_BUDGET,
            tools: [scoreFindingTool],
            label: 'Self-Reflection Scoring',
            restrictToLocalTools: true,
        },
        options.conversationManager,
        options.token,
        scoringHandler
    );

    const scores = getScores();
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
