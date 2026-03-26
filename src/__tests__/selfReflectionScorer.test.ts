import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    buildSelfReflectionPrompt,
    getDiffSnippetForFinding,
    parseSelfReflectionResponse,
    runSelfReflection,
} from '../services/selfReflectionScorer';
import { FindingStore } from '../sessions/findingStore';
import { createMockCancellationToken } from './testUtils/mockFactories';
import type { RecordedFinding } from '../types/findingTypes';
import type { ModelCalibrationProfile } from '../models/modelCalibration';
import type {
    DiffHunk,
    DiffHunkLine,
    ParsedDiffLine,
} from '../types/contextTypes';

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
        selfReflectionThreshold: 5,
        ...overrides,
    } as ModelCalibrationProfile;
}

function makeDiffHunk(
    filePath: string,
    parsedLines: ParsedDiffLine[],
    newStart = 1
): DiffHunk {
    return {
        filePath,
        hunks: [
            {
                oldStart: 1,
                oldLines: parsedLines.length,
                newStart,
                newLines: parsedLines.length,
                parsedLines,
                hunkId: 'hunk-1',
                hunkHeader: '@@ -1,10 +1,10 @@',
            } as DiffHunkLine,
        ],
        isNewFile: false,
        isDeletedFile: false,
        originalHeader: 'diff --git a/file b/file',
    };
}

function makeParsedLines(
    startLine: number,
    count: number,
    type: 'added' | 'removed' | 'context' = 'context'
): ParsedDiffLine[] {
    return Array.from({ length: count }, (_, i) => ({
        type,
        content: `line ${startLine + i} content`,
        lineNumber: startLine + i,
    }));
}

describe('buildSelfReflectionPrompt', () => {
    it('includes finding titles, severities, categories, and descriptions', () => {
        const store = new FindingStore();
        const f = store.record(
            makeFinding({
                title: 'Null deref bug',
                severity: 'CRITICAL',
                category: 'logic_error',
                description: 'Crashes on null input',
            })
        );

        const prompt = buildSelfReflectionPrompt([f], [], 5);

        expect(prompt).toContain('Null deref bug');
        expect(prompt).toContain('CRITICAL');
        expect(prompt).toContain('logic_error');
        expect(prompt).toContain('Crashes on null input');
    });

    it('includes threshold value in the prompt', () => {
        const prompt = buildSelfReflectionPrompt([], [], 7);
        expect(prompt).toContain('score 7');
    });

    it('includes diff snippets when available', () => {
        const store = new FindingStore();
        const f = store.record(
            makeFinding({ file: 'src/services/foo.ts', lineRange: [5, 5] })
        );
        const diff = makeDiffHunk(
            'src/services/foo.ts',
            makeParsedLines(1, 15)
        );

        const prompt = buildSelfReflectionPrompt([f], [diff], 5);

        expect(prompt).toContain('Relevant diff:');
        expect(prompt).toContain('line 5 content');
    });

    it('handles findings without matching diffs gracefully', () => {
        const store = new FindingStore();
        const f = store.record(makeFinding({ file: 'src/unrelated.ts' }));
        const diff = makeDiffHunk('src/other.ts', makeParsedLines(1, 5));

        const prompt = buildSelfReflectionPrompt([f], [diff], 5);

        expect(prompt).not.toContain('Relevant diff:');
        expect(prompt).toContain('Potential null reference');
    });

    it('handles empty findings array', () => {
        const prompt = buildSelfReflectionPrompt([], [], 5);

        expect(prompt).toContain('FINDINGS TO EVALUATE');
        expect(prompt).toContain('score 5');
    });

    it('includes affected component and failure mechanism', () => {
        const store = new FindingStore();
        const f = store.record(
            makeFinding({
                affectedComponent: 'parseInput()',
                failureMechanism: 'data_corruption',
            })
        );

        const prompt = buildSelfReflectionPrompt([f], [], 5);

        expect(prompt).toContain('parseInput()');
        expect(prompt).toContain('data_corruption');
    });

    it('includes evidence from disproof result', () => {
        const store = new FindingStore();
        const f = store.record(
            makeFinding({
                disproof: {
                    attempted: true,
                    method: 'counter-search',
                    result: 'Found explicit null check at line 42',
                },
            })
        );

        const prompt = buildSelfReflectionPrompt([f], [], 5);

        expect(prompt).toContain('Found explicit null check at line 42');
    });

    it('shows "none recorded" when disproof was not attempted', () => {
        const store = new FindingStore();
        const f = store.record(
            makeFinding({
                disproof: { attempted: false, method: '', result: '' },
            })
        );

        const prompt = buildSelfReflectionPrompt([f], [], 5);

        expect(prompt).toContain('none recorded');
    });
});

describe('getDiffSnippetForFinding', () => {
    it('returns diff snippet for exact file match', () => {
        const store = new FindingStore();
        const f = store.record(
            makeFinding({ file: 'src/foo.ts', lineRange: [5, 5] })
        );
        const diff = makeDiffHunk('src/foo.ts', makeParsedLines(1, 15));

        const snippet = getDiffSnippetForFinding(f, [diff]);

        expect(snippet).toBeDefined();
        expect(snippet).toContain('line 5 content');
    });

    it('returns diff snippet with path normalization (backslashes)', () => {
        const store = new FindingStore();
        const f = store.record(
            makeFinding({ file: 'src\\services\\foo.ts', lineRange: [5, 5] })
        );
        const diff = makeDiffHunk(
            'src/services/foo.ts',
            makeParsedLines(1, 15)
        );

        const snippet = getDiffSnippetForFinding(f, [diff]);

        expect(snippet).toBeDefined();
        expect(snippet).toContain('line 5 content');
    });

    it('returns undefined when no matching diff', () => {
        const store = new FindingStore();
        const f = store.record(
            makeFinding({ file: 'src/unrelated.ts', lineRange: [5, 5] })
        );
        const diff = makeDiffHunk('src/other.ts', makeParsedLines(1, 15));

        const snippet = getDiffSnippetForFinding(f, [diff]);

        expect(snippet).toBeUndefined();
    });

    it('limits snippet length to 30 lines', () => {
        const store = new FindingStore();
        const f = store.record(
            makeFinding({ file: 'src/foo.ts', lineRange: [1, 50] })
        );
        const diff = makeDiffHunk('src/foo.ts', makeParsedLines(1, 60));

        const snippet = getDiffSnippetForFinding(f, [diff]);

        expect(snippet).toBeDefined();
        const lineCount = snippet!.split('\n').length;
        expect(lineCount).toBeLessThanOrEqual(30);
    });

    it('returns context lines around the finding line range', () => {
        const store = new FindingStore();
        const f = store.record(
            makeFinding({ file: 'src/foo.ts', lineRange: [10, 12] })
        );
        const diff = makeDiffHunk('src/foo.ts', makeParsedLines(1, 25));

        const snippet = getDiffSnippetForFinding(f, [diff]);

        expect(snippet).toBeDefined();
        // DIFF_SNIPPET_CONTEXT_LINES = 5, so range is [5, 17]
        expect(snippet).toContain('line 5 content');
        expect(snippet).toContain('line 17 content');
        expect(snippet).not.toContain('line 4 content');
        expect(snippet).not.toContain('line 18 content');
    });

    it('prefixes added lines with +', () => {
        const store = new FindingStore();
        const f = store.record(
            makeFinding({ file: 'src/foo.ts', lineRange: [2, 2] })
        );
        const lines: ParsedDiffLine[] = [
            { type: 'added', content: 'new line', lineNumber: 2 },
        ];
        const diff = makeDiffHunk('src/foo.ts', lines);

        const snippet = getDiffSnippetForFinding(f, [diff]);

        expect(snippet).toBe('+new line');
    });

    it('prefixes removed lines with -', () => {
        const store = new FindingStore();
        const f = store.record(
            makeFinding({ file: 'src/foo.ts', lineRange: [3, 3] })
        );
        const lines: ParsedDiffLine[] = [
            { type: 'removed', content: 'old line', lineNumber: 3 },
        ];
        const diff = makeDiffHunk('src/foo.ts', lines);

        const snippet = getDiffSnippetForFinding(f, [diff]);

        expect(snippet).toBe('-old line');
    });

    it('returns undefined when matching hunk has no lines in range', () => {
        const store = new FindingStore();
        const f = store.record(
            makeFinding({ file: 'src/foo.ts', lineRange: [100, 105] })
        );
        const diff = makeDiffHunk('src/foo.ts', makeParsedLines(1, 10));

        const snippet = getDiffSnippetForFinding(f, [diff]);

        expect(snippet).toBeUndefined();
    });

    it('matches when diff path ends with finding file path', () => {
        const store = new FindingStore();
        const f = store.record(
            makeFinding({ file: 'services/foo.ts', lineRange: [3, 3] })
        );
        const diff = makeDiffHunk(
            'a/src/services/foo.ts',
            makeParsedLines(1, 10)
        );

        const snippet = getDiffSnippetForFinding(f, [diff]);

        expect(snippet).toBeDefined();
    });
});

describe('parseSelfReflectionResponse', () => {
    let store: FindingStore;
    let findings: RecordedFinding[];

    beforeEach(() => {
        store = new FindingStore();
        findings = [
            store.record(makeFinding({ title: 'Bug in parser' })),
            store.record(makeFinding({ title: 'Missing null check' })),
        ];
    });

    it('parses clean SCORE lines', () => {
        const response =
            'SCORE: Bug in parser | 7 | Solid evidence from tool output';
        const scores = parseSelfReflectionResponse(response, findings);

        expect(scores).toHaveLength(1);
        expect(scores[0]!.title).toBe('Bug in parser');
        expect(scores[0]!.score).toBe(7);
        expect(scores[0]!.rationale).toBe('Solid evidence from tool output');
        expect(scores[0]!.findingId).toBe(findings[0]!.id);
    });

    it('parses quoted titles', () => {
        const response = 'SCORE: "Bug in parser" | 8 | Well supported';
        const scores = parseSelfReflectionResponse(response, findings);

        expect(scores).toHaveLength(1);
        expect(scores[0]!.title).toBe('Bug in parser');
        expect(scores[0]!.score).toBe(8);
    });

    it('parses 7/10 format', () => {
        const response = 'SCORE: Bug in parser | 7/10 | Good evidence';
        const scores = parseSelfReflectionResponse(response, findings);

        expect(scores).toHaveLength(1);
        expect(scores[0]!.score).toBe(7);
    });

    it('handles multiple findings', () => {
        const response = [
            'SCORE: Bug in parser | 8 | Strong evidence',
            'SCORE: Missing null check | 3 | Speculative',
        ].join('\n');

        const scores = parseSelfReflectionResponse(response, findings);

        expect(scores).toHaveLength(2);
        expect(scores[0]!.title).toBe('Bug in parser');
        expect(scores[1]!.title).toBe('Missing null check');
    });

    it('ignores non-SCORE lines', () => {
        const response = [
            'Let me evaluate each finding:',
            '',
            'SCORE: Bug in parser | 7 | Evidence based',
            '',
            'Overall the findings are reasonable.',
        ].join('\n');

        const scores = parseSelfReflectionResponse(response, findings);

        expect(scores).toHaveLength(1);
        expect(scores[0]!.title).toBe('Bug in parser');
    });

    it('ignores scores below 1', () => {
        const response = 'SCORE: Bug in parser | 0 | Invalid';
        const scores = parseSelfReflectionResponse(response, findings);
        expect(scores).toHaveLength(0);
    });

    it('ignores scores above 10', () => {
        const response = 'SCORE: Bug in parser | 11 | Invalid';
        const scores = parseSelfReflectionResponse(response, findings);
        expect(scores).toHaveLength(0);
    });

    it('skips unrecognized titles', () => {
        const response = 'SCORE: Nonexistent finding | 7 | Some rationale';
        const scores = parseSelfReflectionResponse(response, findings);
        expect(scores).toHaveLength(0);
    });

    it('handles empty response', () => {
        const scores = parseSelfReflectionResponse('', findings);
        expect(scores).toHaveLength(0);
    });

    it('deduplicates same finding scored twice, keeping first', () => {
        const response = [
            'SCORE: Bug in parser | 8 | First assessment',
            'SCORE: Bug in parser | 3 | Revised assessment',
        ].join('\n');

        const scores = parseSelfReflectionResponse(response, findings);

        expect(scores).toHaveLength(1);
        expect(scores[0]!.score).toBe(8);
        expect(scores[0]!.rationale).toBe('First assessment');
    });

    it('fuzzy matches by substring (response title is substring of finding title)', () => {
        const response = 'SCORE: null check | 6 | Partial match';
        const scores = parseSelfReflectionResponse(response, findings);

        expect(scores).toHaveLength(1);
        expect(scores[0]!.title).toBe('Missing null check');
    });

    it('fuzzy matches by substring (finding title is substring of response title)', () => {
        const response =
            'SCORE: Bug in parser function handling | 6 | Extended title match';
        const scores = parseSelfReflectionResponse(response, findings);

        expect(scores).toHaveLength(1);
        expect(scores[0]!.title).toBe('Bug in parser');
    });

    it('prefers exact match over fuzzy match', () => {
        const localStore = new FindingStore();
        const localFindings = [
            localStore.record(makeFinding({ title: 'null check' })),
            localStore.record(makeFinding({ title: 'Missing null check' })),
        ];

        const response = 'SCORE: null check | 9 | Exact match preferred';
        const scores = parseSelfReflectionResponse(response, localFindings);

        expect(scores).toHaveLength(1);
        expect(scores[0]!.title).toBe('null check');
    });

    it('is case-insensitive for title matching', () => {
        const response = 'SCORE: BUG IN PARSER | 7 | Case insensitive';
        const scores = parseSelfReflectionResponse(response, findings);

        expect(scores).toHaveLength(1);
        expect(scores[0]!.title).toBe('Bug in parser');
    });

    it('picks the most specific match when multiple findings match fuzzily', () => {
        const localStore = new FindingStore();
        const localFindings = [
            localStore.record(
                makeFinding({ title: 'Missing null check in handler' })
            ),
            localStore.record(makeFinding({ title: 'Missing null check' })),
        ];
        const response = 'SCORE: null check | 8 | valid';
        const scores = parseSelfReflectionResponse(response, localFindings);
        expect(scores).toHaveLength(1);
        expect(scores[0]!.findingId).toBe(localFindings[1]!.id);
    });
});

describe('runSelfReflection', () => {
    let store: FindingStore;
    let token: ReturnType<typeof createMockCancellationToken>;
    let profile: ModelCalibrationProfile;
    let mockConversationManager: { addUserMessage: ReturnType<typeof vi.fn> };
    let mockConversationRunner: { run: ReturnType<typeof vi.fn> };
    let mockHandler: Record<string, unknown>;

    beforeEach(() => {
        store = new FindingStore();
        token = createMockCancellationToken();
        profile = makeProfile({ selfReflectionThreshold: 5 });
        mockConversationManager = { addUserMessage: vi.fn() };
        mockConversationRunner = { run: vi.fn().mockResolvedValue('') };
        mockHandler = {};
    });

    function runWithDefaults(overrides: Record<string, unknown> = {}) {
        return runSelfReflection({
            findingStore: store,
            parsedDiff: [],
            calibrationProfile: profile,
            conversationManager: mockConversationManager as never,
            conversationRunner: mockConversationRunner as never,
            systemPrompt: 'You are a code reviewer.',
            token,
            handler: mockHandler,
            ...overrides,
        });
    }

    it('returns empty result for empty finding store', async () => {
        const result = await runWithDefaults();

        expect(result).toEqual({ scores: [], dropped: [], kept: [] });
        expect(mockConversationManager.addUserMessage).not.toHaveBeenCalled();
        expect(mockConversationRunner.run).not.toHaveBeenCalled();
    });

    it('drops findings below threshold', async () => {
        const f = store.record(makeFinding({ title: 'Weak finding' }));
        mockConversationRunner.run.mockResolvedValue(
            'SCORE: Weak finding | 3 | Speculative with no evidence'
        );

        const result = await runWithDefaults();

        expect(result.dropped).toContain('Weak finding');
        expect(result.kept).not.toContain('Weak finding');
        expect(store.getById(f.id)).toBeUndefined();
    });

    it('keeps findings at or above threshold', async () => {
        store.record(makeFinding({ title: 'Strong finding' }));
        mockConversationRunner.run.mockResolvedValue(
            'SCORE: Strong finding | 7 | Solid evidence'
        );

        const result = await runWithDefaults();

        expect(result.kept).toContain('Strong finding');
        expect(result.dropped).not.toContain('Strong finding');
        expect(store.size).toBe(1);
    });

    it('keeps findings at exact threshold', async () => {
        store.record(makeFinding({ title: 'Borderline finding' }));
        mockConversationRunner.run.mockResolvedValue(
            'SCORE: Borderline finding | 5 | Just enough evidence'
        );

        const result = await runWithDefaults();

        expect(result.kept).toContain('Borderline finding');
        expect(result.dropped).toHaveLength(0);
    });

    it('keeps findings with no score from model (fail-safe)', async () => {
        store.record(makeFinding({ title: 'Unscored finding' }));
        mockConversationRunner.run.mockResolvedValue(
            'I could not evaluate the findings properly.'
        );

        const result = await runWithDefaults();

        expect(result.kept).toContain('Unscored finding');
        expect(result.dropped).toHaveLength(0);
        expect(store.size).toBe(1);
    });

    it('calls conversationManager.addUserMessage with prompt', async () => {
        store.record(makeFinding({ title: 'Test finding' }));
        mockConversationRunner.run.mockResolvedValue('');

        await runWithDefaults();

        expect(mockConversationManager.addUserMessage).toHaveBeenCalledOnce();
        const prompt = mockConversationManager.addUserMessage.mock
            .calls[0]![0] as string;
        expect(prompt).toContain('Test finding');
        expect(prompt).toContain('SELF-REFLECTION SCORING');
    });

    it('calls conversationRunner.run with correct config', async () => {
        store.record(makeFinding());
        mockConversationRunner.run.mockResolvedValue('');

        await runWithDefaults();

        expect(mockConversationRunner.run).toHaveBeenCalledOnce();
        const config = mockConversationRunner.run.mock.calls[0]![0];
        expect(config).toMatchObject({
            tools: [],
            label: 'Self-Reflection Scoring',
            systemPrompt: 'You are a code reviewer.',
        });
    });

    it('uses calibrationProfile.selfReflectionThreshold', async () => {
        const highThreshold = makeProfile({ selfReflectionThreshold: 8 });
        store.record(makeFinding({ title: 'Decent finding' }));
        mockConversationRunner.run.mockResolvedValue(
            'SCORE: Decent finding | 7 | Good evidence but not enough'
        );

        const result = await runWithDefaults({
            calibrationProfile: highThreshold,
        });

        expect(result.dropped).toContain('Decent finding');
        expect(result.kept).toHaveLength(0);
    });

    it('handles mixed kept, dropped, and unscored findings', async () => {
        store.record(makeFinding({ title: 'Good finding' }));
        store.record(makeFinding({ title: 'Bad finding' }));
        store.record(makeFinding({ title: 'Unscored finding' }));

        mockConversationRunner.run.mockResolvedValue(
            [
                'SCORE: Good finding | 8 | Strong evidence',
                'SCORE: Bad finding | 2 | Pure speculation',
            ].join('\n')
        );

        const result = await runWithDefaults();

        expect(result.kept).toContain('Good finding');
        expect(result.kept).toContain('Unscored finding');
        expect(result.dropped).toContain('Bad finding');
        expect(result.scores).toHaveLength(2);
        expect(store.size).toBe(2);
    });

    it('passes token and handler to conversationRunner.run', async () => {
        store.record(makeFinding());
        mockConversationRunner.run.mockResolvedValue('');

        await runWithDefaults();

        const callArgs = mockConversationRunner.run.mock.calls[0]!;
        expect(callArgs[1]).toBe(mockConversationManager);
        expect(callArgs[2]).toBe(token);
        expect(callArgs[3]).toBe(mockHandler);
    });
});
