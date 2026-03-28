import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    buildSelfReflectionPrompt,
    getDiffSnippetForFinding,
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

    it('includes finding IDs', () => {
        const store = new FindingStore();
        const f = store.record(makeFinding({ title: 'Some bug' }));

        const prompt = buildSelfReflectionPrompt([f], [], 5);

        expect(prompt).toContain(`ID: ${f.id}`);
    });

    it('includes threshold value in the prompt', () => {
        const prompt = buildSelfReflectionPrompt([], [], 7);
        expect(prompt).toContain('score 7');
    });

    it('instructs to call score_finding tool', () => {
        const prompt = buildSelfReflectionPrompt([], [], 5);
        expect(prompt).toContain('call the score_finding tool');
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

    it('includes disproof result labeled as disproof attempt', () => {
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

        expect(prompt).toContain(
            'Disproof attempt: Found explicit null check at line 42'
        );
    });

    it('shows "none attempted" when disproof was not attempted', () => {
        const store = new FindingStore();
        const f = store.record(
            makeFinding({
                disproof: { attempted: false, method: '', result: '' },
            })
        );

        const prompt = buildSelfReflectionPrompt([f], [], 5);

        expect(prompt).toContain('Disproof attempt: none attempted');
    });

    it('includes verification evidence when present', () => {
        const store = new FindingStore();
        const f = store.record(
            makeFinding({
                verificationEvidence: 'Symbol lookup confirmed missing return',
            })
        );

        const prompt = buildSelfReflectionPrompt([f], [], 5);

        expect(prompt).toContain(
            'Verification evidence: Symbol lookup confirmed missing return'
        );
    });

    it('shows "none recorded" when verification evidence is absent', () => {
        const store = new FindingStore();
        const f = store.record(
            makeFinding({ verificationEvidence: undefined })
        );

        const prompt = buildSelfReflectionPrompt([f], [], 5);

        expect(prompt).toContain('Verification evidence: none recorded');
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

describe('runSelfReflection', () => {
    let store: FindingStore;
    let token: ReturnType<typeof createMockCancellationToken>;
    let profile: ModelCalibrationProfile;
    let mockConversationManager: { addUserMessage: ReturnType<typeof vi.fn> };
    let mockConversationRunner: { run: ReturnType<typeof vi.fn> };
    let mockHandler: {
        onToolCallStart?: ReturnType<typeof vi.fn>;
        onToolCallComplete?: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
        store = new FindingStore();
        token = createMockCancellationToken();
        profile = makeProfile({ selfReflectionThreshold: 5 });
        mockConversationManager = { addUserMessage: vi.fn() };
        mockConversationRunner = { run: vi.fn().mockResolvedValue('') };
        mockHandler = {
            onToolCallStart: vi.fn(),
            onToolCallComplete: vi.fn(),
        };
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
            handler: mockHandler as never,
            ...overrides,
        });
    }

    it('returns empty result for empty finding store', async () => {
        const result = await runWithDefaults();

        expect(result).toEqual({ scores: [], dropped: [], kept: [] });
        expect(mockConversationManager.addUserMessage).not.toHaveBeenCalled();
        expect(mockConversationRunner.run).not.toHaveBeenCalled();
    });

    it('drops findings below threshold via tool call', async () => {
        const f = store.record(makeFinding({ title: 'Weak finding' }));
        mockConversationRunner.run.mockImplementation(
            async (_config: any, _cm: any, _token: any, handler: any) => {
                handler.onToolCallComplete(
                    'call-1',
                    'score_finding',
                    { finding_id: f.id, score: 3, rationale: 'Speculative' },
                    'ok',
                    true,
                    undefined,
                    100,
                    undefined
                );
                return '';
            }
        );

        const result = await runWithDefaults();

        expect(result.dropped).toContain('Weak finding');
        expect(result.kept).not.toContain('Weak finding');
        expect(store.getById(f.id)).toBeUndefined();
    });

    it('keeps findings at or above threshold', async () => {
        const f = store.record(makeFinding({ title: 'Strong finding' }));
        mockConversationRunner.run.mockImplementation(
            async (_config: any, _cm: any, _token: any, handler: any) => {
                handler.onToolCallComplete(
                    'call-1',
                    'score_finding',
                    { finding_id: f.id, score: 7, rationale: 'Solid evidence' },
                    'ok',
                    true,
                    undefined,
                    100,
                    undefined
                );
                return '';
            }
        );

        const result = await runWithDefaults();

        expect(result.kept).toContain('Strong finding');
        expect(result.dropped).not.toContain('Strong finding');
        expect(store.size).toBe(1);
    });

    it('keeps findings at exact threshold', async () => {
        const f = store.record(makeFinding({ title: 'Borderline finding' }));
        mockConversationRunner.run.mockImplementation(
            async (_config: any, _cm: any, _token: any, handler: any) => {
                handler.onToolCallComplete(
                    'call-1',
                    'score_finding',
                    { finding_id: f.id, score: 5, rationale: 'Just enough' },
                    'ok',
                    true,
                    undefined,
                    100,
                    undefined
                );
                return '';
            }
        );

        const result = await runWithDefaults();

        expect(result.kept).toContain('Borderline finding');
        expect(result.dropped).toHaveLength(0);
    });

    it('keeps findings with no score from model (fail-safe)', async () => {
        store.record(makeFinding({ title: 'Unscored finding' }));
        // Runner resolves without calling onToolCallComplete for score_finding

        const result = await runWithDefaults();

        expect(result.kept).toContain('Unscored finding');
        expect(result.dropped).toHaveLength(0);
        expect(store.size).toBe(1);
    });

    it('calls conversationManager.addUserMessage with prompt', async () => {
        store.record(makeFinding({ title: 'Test finding' }));

        await runWithDefaults();

        expect(mockConversationManager.addUserMessage).toHaveBeenCalledOnce();
        const prompt = mockConversationManager.addUserMessage.mock
            .calls[0]![0] as string;
        expect(prompt).toContain('Test finding');
        expect(prompt).toContain('SELF-REFLECTION SCORING');
    });

    it('calls conversationRunner.run with score_finding tool in config', async () => {
        store.record(makeFinding());

        await runWithDefaults();

        expect(mockConversationRunner.run).toHaveBeenCalledOnce();
        const config = mockConversationRunner.run.mock.calls[0]![0];
        expect(config).toMatchObject({
            tools: [expect.objectContaining({ name: 'score_finding' })],
            label: 'Self-Reflection Scoring',
            systemPrompt: 'You are a code reviewer.',
        });
    });

    it('uses calibrationProfile.selfReflectionThreshold', async () => {
        const highThreshold = makeProfile({ selfReflectionThreshold: 8 });
        const f = store.record(makeFinding({ title: 'Decent finding' }));
        mockConversationRunner.run.mockImplementation(
            async (_config: any, _cm: any, _token: any, handler: any) => {
                handler.onToolCallComplete(
                    'call-1',
                    'score_finding',
                    {
                        finding_id: f.id,
                        score: 7,
                        rationale: 'Good but not enough',
                    },
                    'ok',
                    true,
                    undefined,
                    100,
                    undefined
                );
                return '';
            }
        );

        const result = await runWithDefaults({
            calibrationProfile: highThreshold,
        });

        expect(result.dropped).toContain('Decent finding');
        expect(result.kept).toHaveLength(0);
    });

    it('handles mixed kept, dropped, and unscored findings', async () => {
        const f1 = store.record(makeFinding({ title: 'Good finding' }));
        const f2 = store.record(makeFinding({ title: 'Bad finding' }));
        store.record(makeFinding({ title: 'Unscored finding' }));

        mockConversationRunner.run.mockImplementation(
            async (_config: any, _cm: any, _token: any, handler: any) => {
                handler.onToolCallComplete(
                    'call-1',
                    'score_finding',
                    {
                        finding_id: f1.id,
                        score: 8,
                        rationale: 'Strong evidence',
                    },
                    'ok',
                    true,
                    undefined,
                    100,
                    undefined
                );
                handler.onToolCallComplete(
                    'call-2',
                    'score_finding',
                    {
                        finding_id: f2.id,
                        score: 2,
                        rationale: 'Pure speculation',
                    },
                    'ok',
                    true,
                    undefined,
                    100,
                    undefined
                );
                return '';
            }
        );

        const result = await runWithDefaults();

        expect(result.kept).toContain('Good finding');
        expect(result.kept).toContain('Unscored finding');
        expect(result.dropped).toContain('Bad finding');
        expect(result.scores).toHaveLength(2);
        expect(store.size).toBe(2);
    });

    it('passes token and conversation manager to runner', async () => {
        store.record(makeFinding());

        await runWithDefaults();

        const callArgs = mockConversationRunner.run.mock.calls[0]!;
        expect(callArgs[1]).toBe(mockConversationManager);
        expect(callArgs[2]).toBe(token);
    });

    it('passes a wrapped handler that delegates to original', async () => {
        const f = store.record(makeFinding({ title: 'Test' }));
        mockConversationRunner.run.mockImplementation(
            async (_config: any, _cm: any, _token: any, handler: any) => {
                handler.onToolCallComplete(
                    'call-1',
                    'score_finding',
                    { finding_id: f.id, score: 7, rationale: 'Good' },
                    'ok',
                    true,
                    undefined,
                    100,
                    undefined
                );
                return '';
            }
        );

        await runWithDefaults();

        // The wrapped handler should delegate onToolCallComplete to the original
        expect(mockHandler.onToolCallComplete).toHaveBeenCalledWith(
            'call-1',
            'score_finding',
            { finding_id: f.id, score: 7, rationale: 'Good' },
            'ok',
            true,
            undefined,
            100,
            undefined
        );
    });

    it('ignores score_finding calls with success=false', async () => {
        const f = store.record(makeFinding({ title: 'Failed score' }));
        mockConversationRunner.run.mockImplementation(
            async (_config: any, _cm: any, _token: any, handler: any) => {
                handler.onToolCallComplete(
                    'call-1',
                    'score_finding',
                    { finding_id: f.id, score: 3, rationale: 'Bad' },
                    'error',
                    false,
                    undefined,
                    100,
                    undefined
                );
                return '';
            }
        );

        const result = await runWithDefaults();

        // No score recorded — finding kept via fail-safe
        expect(result.scores).toHaveLength(0);
        expect(result.kept).toContain('Failed score');
    });

    it('deduplicates same finding scored twice, keeping first', async () => {
        const f = store.record(makeFinding({ title: 'Dup finding' }));
        mockConversationRunner.run.mockImplementation(
            async (_config: any, _cm: any, _token: any, handler: any) => {
                handler.onToolCallComplete(
                    'call-1',
                    'score_finding',
                    { finding_id: f.id, score: 8, rationale: 'First' },
                    'ok',
                    true,
                    undefined,
                    100,
                    undefined
                );
                handler.onToolCallComplete(
                    'call-2',
                    'score_finding',
                    { finding_id: f.id, score: 2, rationale: 'Revised' },
                    'ok',
                    true,
                    undefined,
                    100,
                    undefined
                );
                return '';
            }
        );

        const result = await runWithDefaults();

        expect(result.scores).toHaveLength(1);
        expect(result.scores[0]!.score).toBe(8);
        expect(result.scores[0]!.rationale).toBe('First');
    });
});
