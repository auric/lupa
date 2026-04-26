import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';
const { mockedSpawn, mockedExecSync, mockedExecFile } = vi.hoisted(() => ({
    mockedSpawn: vi.fn(),
    mockedExecSync: vi.fn(),
    mockedExecFile: vi.fn(),
}));

vi.mock('node:child_process', () => ({
    spawn: mockedSpawn,
    execSync: mockedExecSync,
    execFile: mockedExecFile,
}));

import { matchFindings } from '../../eval/harness/matcher';
import {
    classifyResolutionForRun,
    reorderSourcesForJudge,
} from '../../eval/harness/resolutionClassifier';
import { aggregate } from '../../eval/harness/metrics';
import { renderMarkdown } from '../../eval/harness/reporter';
import {
    getCheckoutPostKillWaitMs,
    getHarnessSigtermGraceMs,
    getResolutionJudgeWatchdogMs,
    invokeHeadless,
    invokeResolutionJudge,
} from '../../eval/harness/runnerInvoker';
import { validateRef } from '../../eval/headlessShared';
import type {
    ExpectedFinding,
    HarnessReport,
    MatchResult,
    SingleRun,
} from '../../eval/harness/types';
import type { RecordedFinding } from '../../types/findingTypes';

function asRecordedFindingSources(
    value: unknown[]
): RecordedFinding['sources'] {
    return value as unknown as RecordedFinding['sources'];
}

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

async function classifyResolution(
    opts: Omit<Parameters<typeof classifyResolutionForRun>[0], 'timeoutMs'> & {
        timeoutMs?: number;
    }
) {
    return classifyResolutionForRun({
        timeoutMs: 60_000,
        ...opts,
    });
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

        it('matches canonical-equivalent produced paths after normalization', () => {
            const workspaceRoot = '/tmp/workspace';

            expect(
                matchFindings(
                    [makeProduced({ file: './src/a.ts' })],
                    [makeExpected({ path: 'src/a.ts' })],
                    workspaceRoot
                ).matched
            ).toHaveLength(1);

            expect(
                matchFindings(
                    [makeProduced({ file: '/tmp/workspace/src/a.ts' })],
                    [makeExpected({ path: 'src/a.ts' })],
                    workspaceRoot
                ).matched
            ).toHaveLength(1);

            expect(
                matchFindings(
                    [makeProduced({ file: 'src\\a.ts' })],
                    [makeExpected({ path: 'src/a.ts' })],
                    workspaceRoot
                ).matched
            ).toHaveLength(1);
        });

        it('matches Windows case-variant paths as canonical equivalents', () => {
            const originalPlatform = process.platform;
            Object.defineProperty(process, 'platform', {
                value: 'win32',
            });

            try {
                expect(
                    matchFindings(
                        [makeProduced({ file: 'src\\A.ts' })],
                        [makeExpected({ path: 'src/a.ts' })],
                        'C:\\tmp\\workspace'
                    ).matched
                ).toHaveLength(1);
            } finally {
                Object.defineProperty(process, 'platform', {
                    value: originalPlatform,
                });
            }
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

describe('classifyResolutionForRun', () => {
    beforeEach(() => {
        mockedSpawn.mockReset();
        mockedExecSync.mockReset();
        mockedExecFile.mockReset();
    });

    it('forwards the absolute deadline to the analysis launcher', async () => {
        const deadlineAt = Date.now() + 98_765;
        let spawnedArgs: readonly string[] = [];
        mockedSpawn.mockImplementation(
            (_cmd: string, args: readonly string[]) => {
                spawnedArgs = args;
                const outIndex = args.indexOf('--out');
                const outPath = args[outIndex + 1];
                fs.writeFileSync(
                    outPath,
                    JSON.stringify({
                        findings: [],
                        narrative: 'complete result',
                        telemetry: {
                            iterations: 1,
                            toolCalls: 0,
                            promptTokens: 0,
                            completionTokens: 0,
                            durationMs: 25,
                            compactionsUsed: 0,
                        },
                        rawToolCallLog: [],
                        modelId: 'copilot/gpt-5-mini',
                        seed: 7,
                        completed: true,
                    })
                );
                return createMockLauncherProcess(0);
            }
        );

        const result = await invokeHeadless({
            workspaceRoot: '/tmp/workspace',
            baseRef: 'main',
            headRef: 'feature/x',
            model: 'copilot/gpt-5-mini',
            seed: 7,
            timeoutMs: 60_000,
            deadlineAt,
            bailOnError: false,
        });

        expect(result).toMatchObject({
            ok: true,
            result: {
                completed: true,
            },
        });
        expect(spawnedArgs).toContain('--deadline-at');
        expect(spawnedArgs[spawnedArgs.indexOf('--deadline-at') + 1]).toBe(
            String(deadlineAt)
        );
    });

    it('forwards the absolute deadline to the resolution-judge launcher', async () => {
        const deadlineAt = Date.now() + 123_456;
        let spawnedArgs: readonly string[] = [];
        mockedSpawn.mockImplementation(
            (_cmd: string, args: readonly string[]) => {
                spawnedArgs = args;
                const outIndex = args.indexOf('--out');
                const outPath = args[outIndex + 1];
                fs.writeFileSync(
                    outPath,
                    JSON.stringify({
                        verdict: 'unresolved',
                        reason: 'Touched code still leaves the finding unresolved.',
                        modelId: 'copilot/gpt-5-mini',
                    })
                );
                return createMockLauncherProcess(0);
            }
        );

        const result = await invokeResolutionJudge({
            workspaceRoot: '/tmp/workspace',
            model: 'copilot/gpt-5-mini',
            payload: {
                finding: makeProduced(),
                diffText: 'diff --git a/src/a.ts b/src/a.ts',
            },
            timeoutMs: 60_000,
            deadlineAt,
        });

        expect(result.result).toMatchObject({
            verdict: 'unresolved',
            modelId: 'copilot/gpt-5-mini',
        });
        expect(spawnedArgs).toContain('--deadline-at');
        expect(spawnedArgs[spawnedArgs.indexOf('--deadline-at') + 1]).toBe(
            String(deadlineAt)
        );
    });

    it('returns a failed run when the analysis deadline already elapsed before pre-launch work begins', async () => {
        const result = await invokeHeadless({
            workspaceRoot: '/tmp/workspace',
            baseRef: 'main',
            headRef: 'feature/x',
            model: 'copilot/gpt-5-mini',
            seed: 7,
            timeoutMs: 60_000,
            deadlineAt: Date.now() - 1,
            bailOnError: false,
        });

        expect(result).toMatchObject({
            ok: false,
            result: null,
        });
        expect(result.ok).toBe(false);
        if (result.ok) {
            throw new Error(
                'Expected invokeHeadless to return a failure result'
            );
        }
        expect(result.error).toContain('before pre-launch checkout');
        expect(mockedSpawn).not.toHaveBeenCalled();
    });

    it('throws when the analysis deadline already elapsed before pre-launch work begins and bailOnError is true', async () => {
        await expect(
            invokeHeadless({
                workspaceRoot: '/tmp/workspace',
                baseRef: 'main',
                headRef: 'feature/x',
                model: 'copilot/gpt-5-mini',
                seed: 7,
                timeoutMs: 60_000,
                deadlineAt: Date.now() - 1,
                bailOnError: true,
            })
        ).rejects.toThrow(/before pre-launch checkout/i);

        expect(mockedSpawn).not.toHaveBeenCalled();
    });

    it('gives the resolution-judge harness watchdog cleanup headroom beyond the child deadline', () => {
        expect(getResolutionJudgeWatchdogMs(60_000, 12_500, 10_000)).toBe(
            122_500
        );
    });

    it('throws before spawning the resolution-judge launcher when the deadline already elapsed', async () => {
        await expect(
            invokeResolutionJudge({
                workspaceRoot: '/tmp/workspace',
                model: 'copilot/gpt-5-mini',
                payload: {
                    finding: makeProduced(),
                    diffText: 'diff --git a/src/a.ts b/src/a.ts',
                },
                timeoutMs: 60_000,
                deadlineAt: Date.now() - 1,
            })
        ).rejects.toThrow(/deadline elapsed before the launcher started/i);

        expect(mockedSpawn).not.toHaveBeenCalled();
    });

    it('preserves a parsed analysis result as error context when the launcher exits non-zero during teardown', async () => {
        mockedSpawn.mockImplementation(
            (_cmd: string, args: readonly string[]) => {
                const outIndex = args.indexOf('--out');
                const outPath = args[outIndex + 1];
                fs.writeFileSync(
                    outPath,
                    JSON.stringify({
                        findings: [],
                        narrative: 'usable result',
                        telemetry: {
                            iterations: 1,
                            toolCalls: 0,
                            promptTokens: 0,
                            completionTokens: 0,
                            durationMs: 25,
                            compactionsUsed: 0,
                        },
                        rawToolCallLog: [],
                        modelId: 'copilot/gpt-5-mini',
                        seed: 7,
                        completed: true,
                    })
                );
                return createMockLauncherProcess(1);
            }
        );

        const result = await invokeHeadless({
            workspaceRoot: '/tmp/workspace',
            baseRef: 'main',
            headRef: 'feature/x',
            model: 'copilot/gpt-5-mini',
            seed: 7,
            timeoutMs: 60_000,
            bailOnError: false,
        });

        expect(result).toMatchObject({
            ok: false,
            result: {
                narrative: 'usable result',
                modelId: 'copilot/gpt-5-mini',
                completed: true,
            },
        });
        expect(result.ok).toBe(false);
        if (result.ok) {
            throw new Error('Expected invokeHeadless to return an error');
        }
        expect(result.error).toContain(
            'exited 1 after writing a completed analysis result'
        );
    });

    it('rejects a parsed resolution-judge result when the launcher exits non-zero during teardown', async () => {
        mockedSpawn.mockImplementation(
            (_cmd: string, args: readonly string[]) => {
                const outIndex = args.indexOf('--out');
                const outPath = args[outIndex + 1];
                fs.writeFileSync(
                    outPath,
                    JSON.stringify({
                        verdict: 'resolved',
                        reason: 'Usable judge result written before teardown failed.',
                        modelId: 'copilot/gpt-5-mini',
                    })
                );
                return createMockLauncherProcess(1);
            }
        );

        await expect(
            invokeResolutionJudge({
                workspaceRoot: '/tmp/workspace',
                model: 'copilot/gpt-5-mini',
                payload: {
                    finding: makeProduced(),
                    diffText: 'diff --git a/src/a.ts b/src/a.ts',
                },
                timeoutMs: 60_000,
            })
        ).rejects.toThrow(/exited 1 after writing a valid result payload/i);
    });

    it('rejects malformed resolution-judge JSON even when it is parseable and the launcher exits zero', async () => {
        mockedSpawn.mockImplementation(
            (_cmd: string, args: readonly string[]) => {
                const outIndex = args.indexOf('--out');
                const outPath = args[outIndex + 1];
                fs.writeFileSync(
                    outPath,
                    JSON.stringify({
                        verdict: 'resolved',
                    })
                );
                return createMockLauncherProcess(0);
            }
        );

        await expect(
            invokeResolutionJudge({
                workspaceRoot: '/tmp/workspace',
                model: 'copilot/gpt-5-mini',
                payload: {
                    finding: makeProduced(),
                    diffText: 'diff --git a/src/a.ts b/src/a.ts',
                },
                timeoutMs: 60_000,
            })
        ).rejects.toThrow(/result\.reason must be a non-empty string/i);
    });

    it('rejects malformed analysis JSON even when it is parseable and the launcher exits zero', async () => {
        mockedSpawn.mockImplementation(
            (_cmd: string, args: readonly string[]) => {
                const outIndex = args.indexOf('--out');
                const outPath = args[outIndex + 1];
                fs.writeFileSync(
                    outPath,
                    JSON.stringify({
                        findings: [],
                        narrative: 'usable-looking result',
                        telemetry: {
                            iterations: 1,
                            toolCalls: 0,
                            promptTokens: 0,
                            completionTokens: 0,
                            durationMs: 25,
                            compactionsUsed: 0,
                        },
                        rawToolCallLog: [],
                        modelId: 'copilot/gpt-5-mini',
                        seed: 7,
                    })
                );
                return createMockLauncherProcess(0);
            }
        );

        const result = await invokeHeadless({
            workspaceRoot: '/tmp/workspace',
            baseRef: 'main',
            headRef: 'feature/x',
            model: 'copilot/gpt-5-mini',
            seed: 7,
            timeoutMs: 60_000,
            bailOnError: false,
        });

        expect(result.ok).toBe(false);
        if (result.ok) {
            throw new Error(
                'Expected invokeHeadless to return a failure result'
            );
        }
        expect(result.result).toBeNull();
        expect(result.error).toContain('result.completed must be a boolean');
    });

    it('accepts malformed optional finding.sources entries in analysis JSON as raw harness data so later per-finding sanitization can handle them', async () => {
        mockedSpawn.mockImplementation(
            (_cmd: string, args: readonly string[]) => {
                const outIndex = args.indexOf('--out');
                const outPath = args[outIndex + 1];
                fs.writeFileSync(
                    outPath,
                    JSON.stringify({
                        findings: [
                            {
                                ...makeProduced(),
                                sources: [
                                    null,
                                    {
                                        path: 'src/a.ts',
                                        lineStart: 0,
                                        lineEnd: 0,
                                    },
                                ],
                            },
                        ],
                        narrative: 'usable-looking result',
                        telemetry: {
                            iterations: 1,
                            toolCalls: 0,
                            promptTokens: 0,
                            completionTokens: 0,
                            durationMs: 25,
                            compactionsUsed: 0,
                        },
                        rawToolCallLog: [],
                        modelId: 'copilot/gpt-5-mini',
                        seed: 7,
                        completed: true,
                    })
                );
                return createMockLauncherProcess(0);
            }
        );

        const result = await invokeHeadless({
            workspaceRoot: '/tmp/workspace',
            baseRef: 'main',
            headRef: 'feature/x',
            model: 'copilot/gpt-5-mini',
            seed: 7,
            timeoutMs: 60_000,
            bailOnError: false,
        });

        expect(result.ok).toBe(true);
        if (!result.ok) {
            throw new Error('Expected invokeHeadless to accept the result');
        }
        expect(result.result.findings[0]?.sources).toEqual([
            null,
            { path: 'src/a.ts', lineStart: 0, lineEnd: 0 },
        ]);
    });

    it('returns the parsed incomplete analysis result as an error when the launcher exits non-zero', async () => {
        mockedSpawn.mockImplementation(
            (_cmd: string, args: readonly string[]) => {
                const outIndex = args.indexOf('--out');
                const outPath = args[outIndex + 1];
                fs.writeFileSync(
                    outPath,
                    JSON.stringify({
                        findings: [],
                        narrative: 'partial result',
                        telemetry: {
                            iterations: 1,
                            toolCalls: 0,
                            promptTokens: 0,
                            completionTokens: 0,
                            durationMs: 25,
                            compactionsUsed: 0,
                        },
                        rawToolCallLog: [],
                        modelId: 'copilot/gpt-5-mini',
                        seed: 7,
                        completed: false,
                    })
                );
                return createMockLauncherProcess(1);
            }
        );

        const result = await invokeHeadless({
            workspaceRoot: '/tmp/workspace',
            baseRef: 'main',
            headRef: 'feature/x',
            model: 'copilot/gpt-5-mini',
            seed: 7,
            timeoutMs: 60_000,
            bailOnError: false,
        });

        expect(result).toMatchObject({
            ok: false,
            result: {
                narrative: 'partial result',
                completed: false,
            },
        });
        expect(result.ok).toBe(false);
        if (result.ok) {
            throw new Error('Expected invokeHeadless to return an error');
        }
        expect(result.error).toContain('incomplete analysis result');
    });

    it('treats matched synthetic findings as resolved by default and respects overrides', async () => {
        const resolvedFinding = makeProduced({ id: 'resolved' });
        const overriddenFinding = makeProduced({
            id: 'overridden',
            file: 'src/b.ts',
            lineRange: [20, 20],
        });
        const produced = [resolvedFinding, overriddenFinding];
        const expected = [
            makeExpected({ path: 'src/a.ts', lineHint: 10 }),
            makeExpected({
                path: 'src/b.ts',
                lineHint: 20,
                resolvedByDefault: false,
            }),
        ];
        const match = matchFindings(produced, expected);

        const summary = await classifyResolution({
            fixture: {
                name: 'synthetic-case',
                kind: 'synthetic',
                labels: {
                    intent: 'test synthetic resolution',
                    expected_findings: expected,
                    minFilesExamined: 1,
                    maxFalsePositivesTolerated: 0,
                },
                workspaceRoot: '/tmp/workspace',
                baseRef: 'dir:base',
                headRef: 'dir:head',
                mergeRef: undefined,
            },
            produced,
            match,
        });

        expect(summary.total).toBe(2);
        expect(summary.resolved).toBe(1);
        expect(summary.unresolved).toBe(1);
        expect(summary.resolutionRate).toBeCloseTo(0.5, 3);
        expect(summary.findings).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    findingId: 'resolved',
                    verdict: 'resolved',
                    method: 'synthetic-match',
                }),
                expect.objectContaining({
                    findingId: 'overridden',
                    verdict: 'unresolved',
                    method: 'label-override',
                }),
            ])
        );
    });

    it('ignores resolvedByDefault overrides for weak synthetic matches', async () => {
        const produced = [
            makeProduced({
                id: 'weak-override',
                category: 'security_vulnerability',
            }),
        ];
        const expected = [
            makeExpected({
                category: 'logic_error',
                severity: 'HIGH',
                resolvedByDefault: false,
            }),
        ];
        const match = matchFindings(produced, expected);

        const summary = await classifyResolution({
            fixture: {
                name: 'synthetic-weak-override',
                kind: 'synthetic',
                labels: {
                    intent: 'test weak override gating',
                    expected_findings: expected,
                    minFilesExamined: 1,
                    maxFalsePositivesTolerated: 0,
                },
                workspaceRoot: '/tmp/workspace',
                baseRef: 'dir:base',
                headRef: 'dir:head',
                mergeRef: undefined,
            },
            produced,
            match,
        });

        expect(summary.findings).toEqual([
            expect.objectContaining({
                findingId: 'weak-override',
                verdict: 'resolved',
                method: 'synthetic-match',
            }),
        ]);
    });

    it('checks all cited source paths for real fixtures before marking unresolved', async () => {
        mockedSpawn.mockImplementation(
            (_cmd: string, args: readonly string[]) => {
                if (args.includes('--name-only')) {
                    return createMockGitDiffProcess('src/a.ts\nsrc/b.ts\n');
                }
                if (args.includes('--name-status')) {
                    return createMockGitDiffProcess('');
                }
                const gitPath = args[args.length - 1];
                if (gitPath === 'src/a.ts') {
                    return createMockGitDiffProcess('');
                }
                return createMockGitDiffProcess(`diff --git a/src/b.ts b/src/b.ts
index 1234567..89abcde 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -20,1 +20,2 @@
-dangerous();
+safe();
+return;
`);
            }
        );

        const produced = [
            makeProduced({
                id: 'multi-source',
                file: 'src/a.ts',
                sources: [
                    { path: 'src/a.ts', lineStart: 10, lineEnd: 10 },
                    { path: 'src/b.ts', lineStart: 20, lineEnd: 20 },
                ],
            }),
        ];

        const summary = await classifyResolution({
            fixture: makeRealFixture(),
            produced,
            match: emptyMatch(),
        });

        expect(summary.resolved).toBe(1);
        expect(summary.findings[0]).toMatchObject({
            findingId: 'multi-source',
            verdict: 'resolved',
            path: 'src/b.ts',
            method: 'source-overlap',
        });
    });

    it('falls back to the finding file and lineRange when all provided sources are invalid', async () => {
        mockedSpawn.mockImplementation(
            (_cmd: string, args: readonly string[]) => {
                if (args.includes('--name-only')) {
                    return createMockGitDiffProcess('src/a.ts\n');
                }
                if (args.includes('--name-status')) {
                    return createMockGitDiffProcess('');
                }
                const gitPath = args[args.length - 1];
                if (gitPath !== 'src/a.ts') {
                    throw new Error(`Unexpected git path: ${gitPath}`);
                }
                return createMockGitDiffProcess(`diff --git a/src/a.ts b/src/a.ts
index 1234567..89abcde 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,1 +10,2 @@
-dangerous();
+safe();
+return;
`);
            }
        );

        const summary = await classifyResolution({
            fixture: makeRealFixture(),
            produced: [
                makeProduced({
                    id: 'fallback-invalid-sources',
                    file: './src/a.ts',
                    sources: [
                        { path: './src/a.ts', lineStart: 0, lineEnd: 0 },
                        { path: './src/a.ts', lineStart: 12, lineEnd: 10 },
                    ],
                }),
            ],
            match: emptyMatch(),
        });

        expect(summary.total).toBe(1);
        expect(summary.skipped).toBe(0);
        expect(summary.findings).toEqual([
            expect.objectContaining({
                findingId: 'fallback-invalid-sources',
                verdict: 'resolved',
                method: 'line-range-fallback',
                path: 'src/a.ts',
                reason: expect.stringContaining(
                    "fell back to the finding's top-level file and lineRange"
                ),
            }),
        ]);
    });

    it('treats all-invalid-source fallback non-overlap as unresolved instead of ambiguous', async () => {
        mockedSpawn.mockImplementation(
            (_cmd: string, args: readonly string[]) => {
                if (args.includes('--name-only')) {
                    return createMockGitDiffProcess('src/a.ts\n');
                }
                if (args.includes('--name-status')) {
                    return createMockGitDiffProcess('');
                }
                const gitPath = args[args.length - 1];
                if (gitPath !== 'src/a.ts') {
                    throw new Error(`Unexpected git path: ${gitPath}`);
                }
                return createMockGitDiffProcess(`diff --git a/src/a.ts b/src/a.ts
index 1234567..89abcde 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -30,1 +30,1 @@
-legacy();
+replacement();
`);
            }
        );

        const summary = await classifyResolution({
            fixture: makeRealFixture(),
            produced: [
                makeProduced({
                    id: 'fallback-invalid-sources-non-overlap',
                    file: './src/a.ts',
                    lineRange: [10, 10],
                    sources: [
                        { path: './src/a.ts', lineStart: 0, lineEnd: 0 },
                        { path: './src/a.ts', lineStart: 12, lineEnd: 10 },
                    ],
                }),
            ],
            match: emptyMatch(),
        });

        expect(summary.skipped).toBe(0);
        expect(summary.findings).toEqual([
            expect.objectContaining({
                findingId: 'fallback-invalid-sources-non-overlap',
                verdict: 'unresolved',
                method: 'line-range-fallback',
                path: 'src/a.ts',
                reason: expect.stringContaining(
                    "fell back to the finding's top-level file and lineRange"
                ),
            }),
        ]);
    });

    it('canonicalizes absolute and dot-prefixed finding paths before diffing', async () => {
        mockedSpawn.mockImplementation(
            (_cmd: string, args: readonly string[]) => {
                if (args.includes('--name-only')) {
                    return createMockGitDiffProcess('src/a.ts\n');
                }
                if (args.includes('--name-status')) {
                    return createMockGitDiffProcess('');
                }
                const gitPath = args[args.length - 1];
                if (gitPath !== 'src/a.ts') {
                    throw new Error(`Unexpected git path: ${gitPath}`);
                }
                return createMockGitDiffProcess(`diff --git a/src/a.ts b/src/a.ts
index 1234567..89abcde 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,1 +10,2 @@
-dangerous();
+safe();
+return;
`);
            }
        );

        const summary = await classifyResolution({
            fixture: makeRealFixture(),
            produced: [
                makeProduced({
                    id: 'canonical-paths',
                    file: '/tmp/workspace/src/a.ts',
                    sources: [
                        {
                            path: '/tmp/workspace/src/a.ts',
                            lineStart: 10,
                            lineEnd: 10,
                        },
                        {
                            path: './src/a.ts',
                            lineStart: 10,
                            lineEnd: 10,
                        },
                    ],
                }),
            ],
            match: emptyMatch(),
        });

        expect(summary.findings[0]).toMatchObject({
            findingId: 'canonical-paths',
            verdict: 'resolved',
            path: 'src/a.ts',
            method: 'source-overlap',
        });
        expect(
            mockedSpawn.mock.calls.some(
                (call) => call[1]?.includes('--name-only') === true
            )
        ).toBe(true);
        expect(
            mockedSpawn.mock.calls.some(
                (call) => call[1]?.[call[1].length - 1] === 'src/a.ts'
            )
        ).toBe(true);
    });

    it('treats bracketed workspace-relative file names as valid literal git paths', async () => {
        mockedSpawn.mockImplementation(
            (_cmd: string, args: readonly string[]) => {
                if (args.includes('--name-only')) {
                    return createMockGitDiffProcess('src/app/[id]/page.tsx\n');
                }
                if (args.includes('--name-status')) {
                    return createMockGitDiffProcess('');
                }

                const gitPath = args[args.length - 1];
                if (gitPath !== ':(literal)src/app/[id]/page.tsx') {
                    throw new Error(`Unexpected git path: ${gitPath}`);
                }

                return createMockGitDiffProcess(`diff --git a/src/app/[id]/page.tsx b/src/app/[id]/page.tsx
index 1234567..89abcde 100644
--- a/src/app/[id]/page.tsx
+++ b/src/app/[id]/page.tsx
@@ -10,1 +10,2 @@
-dangerous();
+safe();
+return;
`);
            }
        );

        const summary = await classifyResolution({
            fixture: makeRealFixture(),
            produced: [
                makeProduced({
                    id: 'bracketed-route-path',
                    file: 'src/app/[id]/page.tsx',
                    lineRange: [10, 10],
                }),
            ],
            match: emptyMatch(),
        });

        expect(summary.findings[0]).toMatchObject({
            findingId: 'bracketed-route-path',
            verdict: 'resolved',
            path: 'src/app/[id]/page.tsx',
        });
    });

    it('resolves bracketed workspace-relative suffix paths before diffing', async () => {
        mockedSpawn.mockImplementation(
            (_cmd: string, args: readonly string[]) => {
                if (args.includes('--name-only')) {
                    return createMockGitDiffProcess('src/app/[id]/page.tsx\n');
                }
                if (args.includes('--name-status')) {
                    return createMockGitDiffProcess('');
                }

                const gitPath = args[args.length - 1];
                if (gitPath !== ':(literal)src/app/[id]/page.tsx') {
                    throw new Error(`Unexpected git path: ${gitPath}`);
                }

                return createMockGitDiffProcess(`diff --git a/src/app/[id]/page.tsx b/src/app/[id]/page.tsx
index 1234567..89abcde 100644
--- a/src/app/[id]/page.tsx
+++ b/src/app/[id]/page.tsx
@@ -10,1 +10,2 @@
-dangerous();
+safe();
+return;
`);
            }
        );

        const summary = await classifyResolution({
            fixture: makeRealFixture(),
            produced: [
                makeProduced({
                    id: 'bracketed-route-suffix-path',
                    file: 'app/[id]/page.tsx',
                    lineRange: [10, 10],
                }),
            ],
            match: emptyMatch(),
        });

        expect(summary.findings[0]).toMatchObject({
            findingId: 'bracketed-route-suffix-path',
            verdict: 'resolved',
            path: 'app/[id]/page.tsx',
        });
    });

    it('resolves a unique suffix path to a repo-relative candidate before diffing', async () => {
        mockedSpawn.mockImplementation(
            (_cmd: string, args: readonly string[]) => {
                if (args.includes('--name-only')) {
                    return createMockGitDiffProcess(
                        'packages/feature/src/a.ts\n'
                    );
                }
                if (args.includes('--name-status')) {
                    return createMockGitDiffProcess('');
                }

                const gitPath = args[args.length - 1];
                if (gitPath === 'src/other.ts') {
                    return createMockGitDiffProcess('');
                }
                if (gitPath !== 'packages/feature/src/a.ts') {
                    throw new Error(`Unexpected git path: ${gitPath}`);
                }

                return createMockGitDiffProcess(`diff --git a/packages/feature/src/a.ts b/packages/feature/src/a.ts
index 1234567..89abcde 100644
--- a/packages/feature/src/a.ts
+++ b/packages/feature/src/a.ts
@@ -10,1 +10,2 @@
-dangerous();
+safe();
+return;
`);
            }
        );

        const summary = await classifyResolution({
            fixture: makeRealFixture(),
            produced: [
                makeProduced({
                    id: 'unique-suffix-path',
                    file: 'a.ts',
                    sources: [{ path: 'a.ts', lineStart: 10, lineEnd: 10 }],
                }),
            ],
            match: emptyMatch(),
        });

        expect(summary.findings[0]).toMatchObject({
            findingId: 'unique-suffix-path',
            verdict: 'resolved',
            method: 'source-overlap',
        });
        expect(
            mockedSpawn.mock.calls.some(
                (call) =>
                    call[1]?.[0] === 'diff' &&
                    call[1]?.[call[1].length - 1] ===
                        'packages/feature/src/a.ts'
            )
        ).toBe(true);
    });

    it('keeps outside-workspace absolute paths per-finding and never falls back to a direct git diff pathspec', async () => {
        mockedSpawn.mockImplementation(
            (_cmd: string, args: readonly string[]) => {
                if (args.includes('--name-only')) {
                    return createMockGitDiffProcess('src/b.ts\n');
                }
                if (args.includes('--name-status')) {
                    return createMockGitDiffProcess('');
                }

                const gitPath = args[args.length - 1];
                if (gitPath === '/outside/src/a.ts') {
                    throw new Error(
                        'Outside-workspace absolute paths must not be diffed directly.'
                    );
                }

                if (gitPath !== 'src/b.ts') {
                    throw new Error(`Unexpected git path: ${gitPath}`);
                }

                return createMockGitDiffProcess(`diff --git a/src/b.ts b/src/b.ts
index 1234567..89abcde 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -20,1 +20,2 @@
-dangerous();
+safe();
+return;
`);
            }
        );

        const summary = await classifyResolution({
            fixture: makeRealFixture(),
            produced: [
                makeProduced({
                    id: 'outside-workspace-path',
                    file: '/outside/src/a.ts',
                    sources: [
                        {
                            path: '/outside/src/a.ts',
                            lineStart: 10,
                            lineEnd: 10,
                        },
                    ],
                }),
                makeProduced({
                    id: 'workspace-path',
                    file: 'src/b.ts',
                    lineRange: [20, 20],
                }),
            ],
            match: emptyMatch(),
        });

        expect(summary.findings).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    findingId: 'outside-workspace-path',
                    verdict: 'unresolved',
                    path: '/outside/src/a.ts',
                }),
                expect.objectContaining({
                    findingId: 'workspace-path',
                    verdict: 'resolved',
                    path: 'src/b.ts',
                }),
            ])
        );
        expect(
            mockedSpawn.mock.calls.some(
                (call) => call[1]?.[3] === '/outside/src/a.ts'
            )
        ).toBe(false);
    });

    it('treats URI-like, drive-prefixed, and colon-prefixed git-pathspec-like finding paths as outside-workspace inputs', async () => {
        mockedSpawn.mockImplementation(
            (_cmd: string, args: readonly string[]) => {
                if (args.includes('--name-only')) {
                    return createMockGitDiffProcess('src/b.ts\n');
                }
                if (args.includes('--name-status')) {
                    return createMockGitDiffProcess('');
                }

                const gitPath = args[args.length - 1];
                if (gitPath !== 'src/b.ts') {
                    throw new Error(`Unexpected git path: ${gitPath}`);
                }

                return createMockGitDiffProcess(`diff --git a/src/b.ts b/src/b.ts
index 1234567..89abcde 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -20,1 +20,2 @@
-dangerous();
+safe();
+return;
`);
            }
        );

        const summary = await classifyResolution({
            fixture: makeRealFixture(),
            produced: [
                makeProduced({
                    id: 'uri-like-path',
                    file: 'file:///outside/src/a.ts',
                    sources: [
                        {
                            path: 'file:///outside/src/a.ts',
                            lineStart: 10,
                            lineEnd: 10,
                        },
                    ],
                }),
                makeProduced({
                    id: 'drive-like-path',
                    file: 'C:outside\\src\\a.ts',
                    sources: [
                        {
                            path: 'C:outside\\src\\a.ts',
                            lineStart: 10,
                            lineEnd: 10,
                        },
                    ],
                }),
                makeProduced({
                    id: 'pathspec-like-path',
                    file: ':(glob)**/*.ts',
                    sources: [
                        {
                            path: ':(glob)**/*.ts',
                            lineStart: 10,
                            lineEnd: 10,
                        },
                    ],
                }),
                makeProduced({
                    id: 'workspace-path',
                    file: 'src/b.ts',
                    lineRange: [20, 20],
                }),
            ],
            match: emptyMatch(),
        });

        expect(summary.findings).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    findingId: 'uri-like-path',
                    verdict: 'unresolved',
                    path: 'file:/outside/src/a.ts',
                }),
                expect.objectContaining({
                    findingId: 'drive-like-path',
                    verdict: 'unresolved',
                    path: 'C:outside/src/a.ts',
                }),
                expect.objectContaining({
                    findingId: 'pathspec-like-path',
                    verdict: 'unresolved',
                    path: ':(glob)**/*.ts',
                }),
                expect.objectContaining({
                    findingId: 'workspace-path',
                    verdict: 'resolved',
                    path: 'src/b.ts',
                }),
            ])
        );
        expect(
            mockedSpawn.mock.calls.some((call) =>
                [
                    'file:/outside/src/a.ts',
                    'C:outside/src/a.ts',
                    ':(glob)**/*.ts',
                ].includes(String(call[1]?.[3]))
            )
        ).toBe(false);
    });

    it('matches Windows case-variant changed paths during resolution classification', async () => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', {
            value: 'win32',
        });

        mockedSpawn.mockImplementation(
            (_cmd: string, args: readonly string[]) => {
                if (args.includes('--name-only')) {
                    return createMockGitDiffProcess('SRC/A.ts\n');
                }
                if (args.includes('--name-status')) {
                    return createMockGitDiffProcess('');
                }

                const gitPath = args[args.length - 1];
                if (gitPath !== 'SRC/A.ts') {
                    throw new Error(`Unexpected git path: ${gitPath}`);
                }

                return createMockGitDiffProcess(`diff --git a/SRC/A.ts b/SRC/A.ts
index 1234567..89abcde 100644
--- a/SRC/A.ts
+++ b/SRC/A.ts
@@ -10,1 +10,2 @@
-dangerous();
+safe();
+return;
`);
            }
        );

        try {
            const summary = await classifyResolution({
                fixture: makeRealFixture(),
                produced: [
                    makeProduced({
                        id: 'windows-case-exact-path',
                        file: 'src/a.ts',
                        lineRange: [10, 10],
                    }),
                ],
                match: emptyMatch(),
            });

            expect(summary.findings[0]).toMatchObject({
                findingId: 'windows-case-exact-path',
                verdict: 'resolved',
            });
        } finally {
            Object.defineProperty(process, 'platform', {
                value: originalPlatform,
            });
        }
    });

    it('matches Windows case-variant suffix paths during resolution classification', async () => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', {
            value: 'win32',
        });

        mockedSpawn.mockImplementation(
            (_cmd: string, args: readonly string[]) => {
                if (args.includes('--name-only')) {
                    return createMockGitDiffProcess(
                        'Packages/Feature/SRC/A.ts\n'
                    );
                }
                if (args.includes('--name-status')) {
                    return createMockGitDiffProcess('');
                }

                const gitPath = args[args.length - 1];
                if (gitPath !== 'Packages/Feature/SRC/A.ts') {
                    throw new Error(`Unexpected git path: ${gitPath}`);
                }

                return createMockGitDiffProcess(`diff --git a/Packages/Feature/SRC/A.ts b/Packages/Feature/SRC/A.ts
index 1234567..89abcde 100644
--- a/Packages/Feature/SRC/A.ts
+++ b/Packages/Feature/SRC/A.ts
@@ -10,1 +10,2 @@
-dangerous();
+safe();
+return;
`);
            }
        );

        try {
            const summary = await classifyResolution({
                fixture: makeRealFixture(),
                produced: [
                    makeProduced({
                        id: 'windows-case-suffix-path',
                        file: 'a.ts',
                        sources: [
                            {
                                path: 'a.ts',
                                lineStart: 10,
                                lineEnd: 10,
                            },
                        ],
                    }),
                ],
                match: emptyMatch(),
            });

            expect(summary.findings[0]).toMatchObject({
                findingId: 'windows-case-suffix-path',
                verdict: 'resolved',
            });
        } finally {
            Object.defineProperty(process, 'platform', {
                value: originalPlatform,
            });
        }
    });

    it('preserves unmatched suffix ambiguity across cache hits so repeated findings stay disputed', async () => {
        mockedSpawn.mockImplementation(
            (_cmd: string, args: readonly string[]) => {
                if (args.includes('--name-only')) {
                    return createMockGitDiffProcess(
                        'packages/one/src/a.ts\npackages/two/src/a.ts\n'
                    );
                }
                if (args.includes('--name-status')) {
                    return createMockGitDiffProcess('');
                }

                const gitPath = args[args.length - 1];
                if (gitPath === 'a.ts') {
                    return createMockGitDiffProcess('');
                }

                throw new Error(`Unexpected git invocation: ${args.join(' ')}`);
            }
        );

        const summary = await classifyResolution({
            fixture: makeRealFixture(),
            produced: [
                makeProduced({
                    id: 'ambiguous-suffix-first',
                    file: 'a.ts',
                    sources: [{ path: 'a.ts', lineStart: 10, lineEnd: 10 }],
                }),
                makeProduced({
                    id: 'ambiguous-suffix-second',
                    file: 'a.ts',
                    lineRange: [30, 30],
                    sources: [{ path: 'a.ts', lineStart: 30, lineEnd: 30 }],
                }),
            ],
            match: emptyMatch(),
        });

        expect(summary.total).toBe(2);
        expect(summary.skipped).toBe(0);
        expect(summary.findings).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    findingId: 'ambiguous-suffix-first',
                    verdict: 'disputed',
                    path: 'a.ts',
                    reason: expect.stringContaining(
                        "Multiple changed paths matched the cited suffix 'a.ts'"
                    ),
                }),
                expect.objectContaining({
                    findingId: 'ambiguous-suffix-second',
                    verdict: 'disputed',
                    path: 'a.ts',
                    reason: expect.stringContaining(
                        "Multiple changed paths matched the cited suffix 'a.ts'"
                    ),
                }),
            ])
        );
        expect(
            mockedSpawn.mock.calls.filter(
                (call) =>
                    call[1]?.[0] === 'diff' &&
                    call[1]?.[call[1].length - 1] === 'a.ts' &&
                    !call[1]?.includes('--name-only') &&
                    !call[1]?.includes('--name-status')
            )
        ).toHaveLength(1);
    });

    it('passes the resolved canonical path to the auxiliary judge after unique-suffix path resolution', async () => {
        mockedSpawn.mockImplementation(
            (_cmd: string, args: readonly string[]) => {
                if (args.includes('--name-only')) {
                    return createMockGitDiffProcess(
                        'packages/feature/src/a.ts\n'
                    );
                }
                if (args.includes('--name-status')) {
                    return createMockGitDiffProcess('');
                }

                const gitPath = args[args.length - 1];
                if (gitPath !== 'packages/feature/src/a.ts') {
                    throw new Error(`Unexpected git path: ${gitPath}`);
                }

                return createMockGitDiffProcess(`diff --git a/packages/feature/src/a.ts b/packages/feature/src/a.ts
index 1234567..89abcde 100644
--- a/packages/feature/src/a.ts
+++ b/packages/feature/src/a.ts
@@ -9,0 +10,2 @@
+if (!value) {
+}
`);
            }
        );
        const judge = vi.fn().mockResolvedValue({
            verdict: 'resolved',
            reason: 'Canonical path payload matched the diff path.',
            modelId: 'copilot/gpt-5-mini',
        });

        await classifyResolution({
            fixture: makeRealFixture(),
            produced: [
                makeProduced({
                    id: 'canonical-judge-path',
                    file: 'a.ts',
                    sources: [{ path: 'a.ts', lineStart: 10, lineEnd: 10 }],
                }),
            ],
            match: emptyMatch(),
            judgeClient: { judge },
        });

        expect(judge).toHaveBeenCalledWith(
            expect.objectContaining({
                finding: expect.objectContaining({
                    file: 'packages/feature/src/a.ts',
                    sources: [
                        {
                            path: 'packages/feature/src/a.ts',
                            lineStart: 10,
                            lineEnd: 10,
                        },
                    ],
                }),
            })
        );
    });

    it('chooses the canonicalized matching source for the judge payload when another source appears first', () => {
        const sanitized = reorderSourcesForJudge(
            makeProduced({
                id: 'canonical-judge-primary-source',
                file: 'a.ts',
                sources: [
                    { path: 'src/other.ts', lineStart: 50, lineEnd: 50 },
                    { path: 'a.ts', lineStart: 10, lineEnd: 10 },
                ],
            }),
            [
                { path: 'src/other.ts', lineStart: 50, lineEnd: 50 },
                { path: 'a.ts', lineStart: 10, lineEnd: 10 },
            ],
            '/tmp/workspace',
            'packages/feature/src/a.ts'
        );

        expect(sanitized).toMatchObject({
            file: 'packages/feature/src/a.ts',
            lineRange: [10, 10],
            sources: [
                {
                    path: 'packages/feature/src/a.ts',
                    lineStart: 10,
                    lineEnd: 10,
                },
                {
                    path: 'src/other.ts',
                    lineStart: 50,
                    lineEnd: 50,
                },
            ],
        });
    });

    it('prefers an exact canonical source match over an earlier weaker suffix match for judge payloads', () => {
        const sanitized = reorderSourcesForJudge(
            makeProduced({
                id: 'canonical-exact-source-preferred',
                file: 'a.ts',
                sources: [
                    { path: 'a.ts', lineStart: 50, lineEnd: 50 },
                    {
                        path: 'packages/feature/src/a.ts',
                        lineStart: 10,
                        lineEnd: 10,
                    },
                ],
            }),
            [
                { path: 'a.ts', lineStart: 50, lineEnd: 50 },
                {
                    path: 'packages/feature/src/a.ts',
                    lineStart: 10,
                    lineEnd: 10,
                },
            ],
            '/tmp/workspace',
            'packages/feature/src/a.ts'
        );

        expect(sanitized).toMatchObject({
            file: 'packages/feature/src/a.ts',
            lineRange: [10, 10],
            sources: [
                {
                    path: 'packages/feature/src/a.ts',
                    lineStart: 10,
                    lineEnd: 10,
                },
                {
                    path: 'a.ts',
                    lineStart: 50,
                    lineEnd: 50,
                },
            ],
        });
    });

    it('converts a per-path git diff error into a warning and continues classifying remaining findings', async () => {
        mockedSpawn.mockImplementation(
            (_cmd: string, args: readonly string[]) => {
                if (args.includes('--name-only')) {
                    return createMockGitDiffProcess(
                        'src/resolved.ts\nsrc/broken.ts\nsrc/skipped.ts\n'
                    );
                }
                if (args.includes('--name-status')) {
                    return createMockGitDiffProcess('');
                }

                const gitPath = args[args.length - 1];
                if (gitPath === 'src/resolved.ts') {
                    return createMockGitDiffProcess(`diff --git a/src/resolved.ts b/src/resolved.ts
index 1234567..89abcde 100644
--- a/src/resolved.ts
+++ b/src/resolved.ts
@@ -10,1 +10,2 @@
-dangerous();
+safe();
+return;
`);
                }

                if (gitPath === 'src/broken.ts') {
                    const proc = new EventEmitter() as EventEmitter & {
                        stdout: EventEmitter;
                        stderr: EventEmitter;
                    };
                    proc.stdout = new EventEmitter();
                    proc.stderr = new EventEmitter();
                    queueMicrotask(() => {
                        proc.emit('error', new Error('git exploded'));
                    });
                    return proc;
                }

                if (gitPath === 'src/skipped.ts') {
                    return createMockGitDiffProcess('');
                }

                throw new Error(`Unexpected git path: ${gitPath}`);
            }
        );

        const summary = await classifyResolution({
            fixture: makeRealFixture(),
            produced: [
                makeProduced({
                    id: 'resolved-before-error',
                    file: 'src/resolved.ts',
                    lineRange: [10, 10],
                }),
                makeProduced({
                    id: 'failed-during-error',
                    file: 'src/broken.ts',
                    lineRange: [30, 30],
                }),
                makeProduced({
                    id: 'processed-after-error',
                    file: 'src/skipped.ts',
                    lineRange: [40, 40],
                }),
            ],
            match: emptyMatch(),
        });

        expect(summary.total).toBe(2);
        expect(summary.resolved).toBe(1);
        expect(summary.unresolved).toBe(1);
        expect(summary.skipped).toBe(1);
        expect(summary.metricStatus).toBe('invalid-skipped');
        expect(summary.findings).toEqual([
            expect.objectContaining({
                findingId: 'resolved-before-error',
                verdict: 'resolved',
            }),
            expect.objectContaining({
                findingId: 'processed-after-error',
                verdict: 'unresolved',
            }),
        ]);
        expect(summary.warnings).toEqual([
            expect.objectContaining({
                findingId: 'failed-during-error',
                kind: 'classification-failed',
            }),
        ]);
        expect(summary.resolutionRate).toBeNaN();
    });

    it('treats insertion-only follow-up patches as ambiguous and escalates to the judge', async () => {
        mockedSpawn.mockImplementation(
            (_cmd: string, args: readonly string[]) => {
                if (args.includes('--name-only')) {
                    return createMockGitDiffProcess('src/a.ts\n');
                }
                if (args.includes('--name-status')) {
                    return createMockGitDiffProcess('');
                }
                return createMockGitDiffProcess(`diff --git a/src/a.ts b/src/a.ts
index 1234567..89abcde 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -9,0 +10,3 @@
+if (!value) {
+    return;
+}
`);
            }
        );
        const judge = vi.fn().mockResolvedValue({
            verdict: 'resolved',
            reason: 'Added guard likely resolves the finding.',
            modelId: 'copilot/gpt-5-mini',
        });

        const summary = await classifyResolution({
            fixture: makeRealFixture(),
            produced: [makeProduced({ id: 'insertion-fix' })],
            match: emptyMatch(),
            judgeClient: { judge },
        });

        expect(judge).toHaveBeenCalledTimes(1);
        expect(summary.findings[0]).toMatchObject({
            findingId: 'insertion-fix',
            verdict: 'resolved',
            method: 'judge',
        });
    });

    it('passes a sanitized finding to the auxiliary judge after invalid sources are discarded', async () => {
        mockedSpawn.mockImplementation(
            (_cmd: string, args: readonly string[]) => {
                if (args.includes('--name-only')) {
                    return createMockGitDiffProcess('src/a.ts\n');
                }
                if (args.includes('--name-status')) {
                    return createMockGitDiffProcess('');
                }
                return createMockGitDiffProcess(`diff --git a/src/a.ts b/src/a.ts
index 1234567..89abcde 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -9,0 +10,2 @@
+if (!value) {
+}
`);
            }
        );
        const judge = vi.fn().mockResolvedValue({
            verdict: 'resolved',
            reason: 'Sanitized payload looked correct.',
            modelId: 'copilot/gpt-5-mini',
        });

        await classifyResolution({
            fixture: makeRealFixture(),
            produced: [
                makeProduced({
                    id: 'sanitized-judge-payload',
                    file: './src/a.ts',
                    sources: [
                        { path: './src/a.ts', lineStart: 10, lineEnd: 10 },
                        { path: './src/a.ts', lineStart: 0, lineEnd: 0 },
                        { path: './src/a.ts', lineStart: 12, lineEnd: 10 },
                    ],
                }),
            ],
            match: emptyMatch(),
            judgeClient: { judge },
        });

        expect(judge).toHaveBeenCalledWith(
            expect.objectContaining({
                finding: expect.objectContaining({
                    file: 'src/a.ts',
                    sources: [
                        {
                            path: 'src/a.ts',
                            lineStart: 10,
                            lineEnd: 10,
                        },
                    ],
                }),
            })
        );
    });

    it('skips malformed source entries during resolution classification without crashing path normalization', async () => {
        mockedSpawn.mockImplementation(
            (_cmd: string, args: readonly string[]) => {
                if (args.includes('--name-only')) {
                    return createMockGitDiffProcess('src/a.ts\n');
                }
                if (args.includes('--name-status')) {
                    return createMockGitDiffProcess('');
                }
                return createMockGitDiffProcess(`diff --git a/src/a.ts b/src/a.ts
index 1234567..89abcde 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,1 +10,2 @@
-dangerous();
+safe();
+return;
`);
            }
        );

        const summary = await classifyResolution({
            fixture: makeRealFixture(),
            produced: [
                makeProduced({
                    id: 'malformed-sources-sanitized',
                    sources: asRecordedFindingSources([
                        null,
                        { path: 42, lineStart: 10, lineEnd: 10 },
                        { path: 'src/a.ts', lineStart: 10, lineEnd: 10 },
                    ]),
                }),
            ],
            match: emptyMatch(),
        });

        expect(summary.findings).toEqual([
            expect.objectContaining({
                findingId: 'malformed-sources-sanitized',
                verdict: 'resolved',
                path: 'src/a.ts',
                method: 'source-overlap',
            }),
        ]);
    });

    it('treats an overlapping deletion-only hunk as resolved even when another hunk in the file adds lines elsewhere', async () => {
        mockedSpawn.mockImplementation(
            (_cmd: string, args: readonly string[]) => {
                if (args.includes('--name-only')) {
                    return createMockGitDiffProcess('src/a.ts\n');
                }
                if (args.includes('--name-status')) {
                    return createMockGitDiffProcess('');
                }
                return createMockGitDiffProcess(`diff --git a/src/a.ts b/src/a.ts
index 1234567..89abcde 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,1 +10,0 @@
-dangerous();
@@ -100,0 +100,1 @@
+const unrelated = true;
`);
            }
        );

        const summary = await classifyResolution({
            fixture: makeRealFixture(),
            produced: [makeProduced({ id: 'deletion-only-overlap' })],
            match: emptyMatch(),
        });

        expect(summary.findings[0]).toMatchObject({
            findingId: 'deletion-only-overlap',
            verdict: 'resolved',
            method: 'line-range-fallback',
        });
    });

    it('skips ambiguous real-fixture findings when the auxiliary judge is unavailable', async () => {
        mockedSpawn.mockImplementation(
            (_cmd: string, args: readonly string[]) => {
                if (args.includes('--name-only')) {
                    return createMockGitDiffProcess('src/a.ts\n');
                }
                if (args.includes('--name-status')) {
                    return createMockGitDiffProcess('');
                }
                return createMockGitDiffProcess(`diff --git a/src/a.ts b/src/a.ts
index 1234567..89abcde 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -9,0 +10,2 @@
+if (!value) {
+}
`);
            }
        );

        const summary = await classifyResolution({
            fixture: makeRealFixture(),
            produced: [makeProduced({ id: 'judge-unavailable' })],
            match: emptyMatch(),
        });

        expect(summary.total).toBe(0);
        expect(summary.attempted).toBe(1);
        expect(summary.skipped).toBe(1);
        expect(summary.findings).toEqual([]);
        expect(summary.warnings).toEqual([
            expect.objectContaining({
                findingId: 'judge-unavailable',
                kind: 'judge-unavailable',
                path: 'src/a.ts',
            }),
        ]);
        expect(Number.isNaN(summary.resolutionRate)).toBe(true);
    });

    it('treats explicit auxiliary-judge-unavailable rejections as judge-unavailable warnings', async () => {
        mockedSpawn.mockImplementation(
            (_cmd: string, args: readonly string[]) => {
                if (args.includes('--name-only')) {
                    return createMockGitDiffProcess('src/a.ts\n');
                }
                if (args.includes('--name-status')) {
                    return createMockGitDiffProcess('');
                }
                return createMockGitDiffProcess(`diff --git a/src/a.ts b/src/a.ts
index 1234567..89abcde 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -9,0 +10,2 @@
+if (!value) {
+}
`);
            }
        );

        const summary = await classifyResolution({
            fixture: makeRealFixture(),
            produced: [makeProduced({ id: 'judge-unavailable-prefix' })],
            match: emptyMatch(),
            judgeClient: {
                judge: vi.fn().mockRejectedValue(
                    Object.assign(new Error('deadline budget too small.'), {
                        code: 'JUDGE_UNAVAILABLE',
                    })
                ),
            },
        });

        expect(summary.total).toBe(0);
        expect(summary.skipped).toBe(1);
        expect(summary.warnings).toEqual([
            expect.objectContaining({
                findingId: 'judge-unavailable-prefix',
                kind: 'judge-unavailable',
                message: expect.stringContaining('deadline budget too small.'),
            }),
        ]);
    });

    it('treats mixed valid and invalid sources as inconclusive when the valid ranges do not overlap a touched hunk', async () => {
        mockedSpawn.mockImplementation(
            (_cmd: string, args: readonly string[]) => {
                if (args.includes('--name-only')) {
                    return createMockGitDiffProcess('src/a.ts\n');
                }
                if (args.includes('--name-status')) {
                    return createMockGitDiffProcess('');
                }
                return createMockGitDiffProcess(`diff --git a/src/a.ts b/src/a.ts
index 1234567..89abcde 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -30,1 +30,1 @@
-legacy();
+replacement();
`);
            }
        );

        const summary = await classifyResolution({
            fixture: makeRealFixture(),
            produced: [
                makeProduced({
                    id: 'mixed-invalid-sources',
                    sources: [
                        { path: 'src/a.ts', lineStart: 10, lineEnd: 10 },
                        { path: 'src/a.ts', lineStart: 0, lineEnd: 0 },
                    ],
                }),
            ],
            match: emptyMatch(),
        });

        expect(summary.total).toBe(0);
        expect(summary.skipped).toBe(1);
        expect(summary.warnings).toEqual([
            expect.objectContaining({
                findingId: 'mixed-invalid-sources',
                kind: 'judge-unavailable',
                message: expect.stringContaining(
                    'At least one cited source range was invalid'
                ),
            }),
        ]);
    });

    it('preserves classified findings when one ambiguous judge call fails', async () => {
        mockedSpawn.mockImplementation(
            (_cmd: string, args: readonly string[]) => {
                if (args.includes('--name-only')) {
                    return createMockGitDiffProcess(
                        'src/resolved.ts\nsrc/ambiguous.ts\n'
                    );
                }
                if (args.includes('--name-status')) {
                    return createMockGitDiffProcess('');
                }
                const gitPath = args[args.length - 1];
                if (gitPath === 'src/resolved.ts') {
                    return createMockGitDiffProcess(`diff --git a/src/resolved.ts b/src/resolved.ts
index 1234567..89abcde 100644
--- a/src/resolved.ts
+++ b/src/resolved.ts
@@ -10,1 +10,2 @@
-dangerous();
+safe();
+return;
`);
                }

                return createMockGitDiffProcess(`diff --git a/src/ambiguous.ts b/src/ambiguous.ts
index 1234567..89abcde 100644
--- a/src/ambiguous.ts
+++ b/src/ambiguous.ts
@@ -29,0 +30,2 @@
+if (!value) {
+}
`);
            }
        );

        const summary = await classifyResolution({
            fixture: makeRealFixture(),
            produced: [
                makeProduced({
                    id: 'resolved',
                    file: 'src/resolved.ts',
                    lineRange: [10, 10],
                }),
                makeProduced({
                    id: 'judge-failure',
                    file: 'src/ambiguous.ts',
                    lineRange: [30, 30],
                }),
            ],
            match: emptyMatch(),
            judgeClient: {
                judge: vi
                    .fn()
                    .mockRejectedValue(new Error('judge unavailable')),
            },
        });

        expect(summary.attempted).toBe(2);
        expect(summary.total).toBe(1);
        expect(summary.resolved).toBe(1);
        expect(summary.skipped).toBe(1);
        expect(summary.findings).toEqual([
            expect.objectContaining({
                findingId: 'resolved',
                verdict: 'resolved',
                method: 'line-range-fallback',
            }),
        ]);
        expect(summary.warnings).toEqual([
            expect.objectContaining({
                findingId: 'judge-failure',
                kind: 'judge-failed',
            }),
        ]);
        expect(Number.isNaN(summary.resolutionRate)).toBe(true);
        expect(
            Number.isNaN(summary.bySeverity.HIGH?.resolutionRate ?? Number.NaN)
        ).toBe(true);
    });

    it('marks an old-path deletion-only diff as ambiguous only when a pure rename/move is detected for that diff target', async () => {
        mockedSpawn.mockImplementation(
            (_cmd: string, args: readonly string[]) => {
                if (args.includes('--name-only')) {
                    return createMockGitDiffProcess('src/moved/a.ts\n');
                }
                if (args.includes('--name-status')) {
                    return createMockGitDiffProcess(
                        'R100\tsrc/a.ts\tsrc/moved/a.ts\n'
                    );
                }
                return createMockGitDiffProcess(`diff --git a/src/a.ts b/src/a.ts
deleted file mode 100644
index 1234567..0000000
--- a/src/a.ts
+++ /dev/null
@@ -10,1 +0,0 @@
-dangerous();
`);
            }
        );
        const judge = vi.fn().mockResolvedValue({
            verdict: 'disputed',
            reason: 'Pure rename/move is ambiguous for proxy resolution.',
            modelId: 'copilot/gpt-5-mini',
        });

        const summary = await classifyResolution({
            fixture: makeRealFixture(),
            produced: [makeProduced({ id: 'rename-only' })],
            match: emptyMatch(),
            judgeClient: { judge },
        });

        expect(judge).toHaveBeenCalledTimes(1);
        expect(summary.findings[0]).toMatchObject({
            findingId: 'rename-only',
            verdict: 'disputed',
            method: 'judge',
        });
    });

    it('uses the actual resolved diff target path for rename-only ambiguity detection', async () => {
        const judge = vi.fn();
        mockedSpawn.mockImplementation(
            (_cmd: string, args: readonly string[]) => {
                if (args.includes('--name-only')) {
                    return createMockGitDiffProcess(
                        'packages/feature/src/a.ts\n'
                    );
                }
                if (args.includes('--name-status')) {
                    return createMockGitDiffProcess(
                        'R100\tpackages/one/src/a.ts\tpackages/one/src/a-renamed.ts\n' +
                            'R100\tpackages/two/src/a.ts\tpackages/two/src/a-renamed.ts\n'
                    );
                }

                const gitPath = args[args.length - 1];
                if (gitPath !== 'packages/feature/src/a.ts') {
                    throw new Error(`Unexpected git path: ${gitPath}`);
                }

                return createMockGitDiffProcess(`diff --git a/packages/feature/src/a.ts b/packages/feature/src/a.ts
index 1234567..89abcde 100644
--- a/packages/feature/src/a.ts
+++ b/packages/feature/src/a.ts
@@ -10,1 +10,2 @@
-dangerous();
+safe();
+return;
`);
            }
        );

        const summary = await classifyResolution({
            fixture: makeRealFixture(),
            produced: [
                makeProduced({
                    id: 'resolved-diff-target-rename-check',
                    file: 'src/a.ts',
                    lineRange: [10, 10],
                }),
            ],
            match: emptyMatch(),
            judgeClient: { judge },
        });

        expect(judge).not.toHaveBeenCalled();
        expect(summary.findings[0]).toMatchObject({
            findingId: 'resolved-diff-target-rename-check',
            verdict: 'resolved',
            method: 'line-range-fallback',
            path: 'src/a.ts',
        });
    });

    it('uses a targeted diff for the original path when rename+edit changes are missing from --name-only', async () => {
        const judge = vi.fn();
        mockedSpawn.mockImplementation(
            (_cmd: string, args: readonly string[]) => {
                if (args.includes('--name-only')) {
                    return createMockGitDiffProcess('src/new-name.ts\n');
                }
                if (args.includes('--name-status')) {
                    return createMockGitDiffProcess('');
                }

                const gitPath = args[args.length - 1];
                if (gitPath !== 'src/old-name.ts') {
                    throw new Error(`Unexpected git path: ${gitPath}`);
                }

                return createMockGitDiffProcess(`diff --git a/src/old-name.ts b/src/new-name.ts
index 1234567..89abcde 100644
--- a/src/old-name.ts
+++ b/src/new-name.ts
@@ -10,1 +10,2 @@
-dangerous();
+safe();
+return;
`);
            }
        );

        const summary = await classifyResolution({
            fixture: makeRealFixture(),
            produced: [
                makeProduced({
                    id: 'rename-edit-old-path',
                    file: 'src/old-name.ts',
                    sources: [
                        {
                            path: 'src/old-name.ts',
                            lineStart: 10,
                            lineEnd: 10,
                        },
                    ],
                }),
            ],
            match: emptyMatch(),
            judgeClient: { judge },
        });

        expect(judge).not.toHaveBeenCalled();
        expect(summary.findings[0]).toMatchObject({
            findingId: 'rename-edit-old-path',
            verdict: 'resolved',
            method: 'source-overlap',
            path: 'src/old-name.ts',
        });
    });

    it('kills a hung per-path git diff when classification times out', async () => {
        vi.useFakeTimers();
        try {
            const kill = vi.fn();
            mockedSpawn.mockImplementation(
                (_cmd: string, args: readonly string[]) => {
                    if (args.includes('--name-only')) {
                        return createMockGitDiffProcess('src/a.ts\n');
                    }
                    if (args.includes('--name-status')) {
                        return createMockGitDiffProcess('');
                    }
                    const proc = new EventEmitter() as EventEmitter & {
                        stdout: EventEmitter;
                        stderr: EventEmitter;
                        kill: typeof kill;
                    };
                    proc.stdout = new EventEmitter();
                    proc.stderr = new EventEmitter();
                    proc.kill = kill;
                    return proc;
                }
            );

            const summaryPromise = classifyResolution({
                fixture: makeRealFixture(),
                produced: [makeProduced({ id: 'git-timeout' })],
                match: emptyMatch(),
                deadlineAt: Date.now() + 500,
            });

            await vi.advanceTimersByTimeAsync(500);

            await expect(summaryPromise).resolves.toMatchObject({
                metricStatus: 'invalid-skipped',
                skipped: 1,
                findings: [],
                warnings: [
                    expect.objectContaining({
                        findingId: 'git-timeout',
                        kind: 'classification-failed',
                    }),
                ],
            });
            expect(kill).toHaveBeenCalledWith('SIGKILL');
        } finally {
            vi.useRealTimers();
        }
    });

    it('clears the git diff timeout once the child process settles', async () => {
        vi.useFakeTimers();
        try {
            const kill = vi.fn();
            mockedSpawn.mockImplementation(
                (_cmd: string, args: readonly string[]) => {
                    if (args.includes('--name-only')) {
                        return createMockGitDiffProcess('src/a.ts\n');
                    }
                    if (args.includes('--name-status')) {
                        return createMockGitDiffProcess('');
                    }

                    const proc = new EventEmitter() as EventEmitter & {
                        stdout: EventEmitter;
                        stderr: EventEmitter;
                        kill: typeof kill;
                    };
                    proc.stdout = new EventEmitter();
                    proc.stderr = new EventEmitter();
                    proc.kill = kill;

                    queueMicrotask(() => {
                        proc.emit('close', 0);
                    });

                    return proc;
                }
            );

            const summaryPromise = classifyResolution({
                fixture: makeRealFixture(),
                produced: [makeProduced({ id: 'timeout-cleanup' })],
                match: emptyMatch(),
                deadlineAt: Date.now() + 5_000,
            });

            await expect(summaryPromise).resolves.toMatchObject({
                unresolved: 1,
            });

            await vi.advanceTimersByTimeAsync(15_001);
            expect(kill).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('kills a hung pre-launch git checkout when only the remaining deadline budget is available', async () => {
        vi.useFakeTimers();
        const processKillSpy =
            process.platform === 'win32'
                ? undefined
                : vi
                      .spyOn(process, 'kill')
                      .mockImplementation(() => true as never);
        try {
            const kill = vi.fn();
            let checkoutProc:
                | (EventEmitter & {
                      stdout: EventEmitter;
                      stderr: EventEmitter;
                      kill: typeof kill;
                      pid: number;
                  })
                | undefined;
            mockedSpawn.mockImplementation((cmd: string) => {
                if (cmd !== 'git') {
                    throw new Error(`Unexpected command: ${cmd}`);
                }

                const proc = new EventEmitter() as EventEmitter & {
                    stdout: EventEmitter;
                    stderr: EventEmitter;
                    kill: typeof kill;
                    pid: number;
                };
                proc.stdout = new EventEmitter();
                proc.stderr = new EventEmitter();
                proc.kill = kill;
                proc.pid = 123;
                checkoutProc = proc;
                return proc;
            });

            const resultPromise = invokeHeadless({
                workspaceRoot: '/tmp/workspace',
                baseRef: 'main',
                headRef: 'sha:deadbeef',
                model: 'copilot/gpt-5-mini',
                seed: 7,
                timeoutMs: 60_000,
                deadlineAt: Date.now() + 500,
                bailOnError: false,
            });
            let settled = false;
            resultPromise.finally(() => {
                settled = true;
            });

            await vi.advanceTimersByTimeAsync(500);

            expect(settled).toBe(false);

            checkoutProc?.emit('close', 1);

            const result = await resultPromise;
            expect(result).toMatchObject({
                ok: false,
                result: null,
            });
            expect(result.ok).toBe(false);
            if (result.ok) {
                throw new Error(
                    'Expected invokeHeadless to return a failure result'
                );
            }
            expect(mockedSpawn).toHaveBeenCalledWith(
                'git',
                ['checkout', '--force', 'deadbeef'],
                expect.objectContaining({
                    cwd: '/tmp/workspace',
                    stdio: ['ignore', 'ignore', 'pipe'],
                    detached: process.platform !== 'win32',
                })
            );
            if (process.platform === 'win32') {
                expect(mockedExecFile).toHaveBeenCalledWith(
                    'taskkill',
                    ['/F', '/T', '/PID', '123'],
                    {
                        windowsHide: true,
                        timeout: 10_000,
                        killSignal: 'SIGKILL',
                    },
                    expect.any(Function)
                );
                expect(kill).not.toHaveBeenCalled();
            } else {
                expect(processKillSpy).toHaveBeenCalledWith(-123, 'SIGTERM');
                await vi.advanceTimersByTimeAsync(getHarnessSigtermGraceMs());
                expect(processKillSpy).not.toHaveBeenCalledWith(
                    -123,
                    'SIGKILL'
                );
                expect(kill).not.toHaveBeenCalled();
            }
            expect(result.error).toContain(
                'Headless run exceeded timeout (500ms) during pre-launch checkout.'
            );
            expect(mockedSpawn).toHaveBeenCalledTimes(1);
        } finally {
            processKillSpy?.mockRestore();
            vi.useRealTimers();
        }
    });

    it('returns checkout-timeout failure after a bounded post-kill wait when the checkout process never exits', async () => {
        vi.useFakeTimers();
        const processKillSpy =
            process.platform === 'win32'
                ? undefined
                : vi
                      .spyOn(process, 'kill')
                      .mockImplementation(() => true as never);

        try {
            const kill = vi.fn();
            mockedSpawn.mockImplementation((cmd: string) => {
                if (cmd !== 'git') {
                    throw new Error(`Unexpected command: ${cmd}`);
                }

                const proc = new EventEmitter() as EventEmitter & {
                    stdout: EventEmitter;
                    stderr: EventEmitter;
                    kill: typeof kill;
                    pid: number;
                };
                proc.stdout = new EventEmitter();
                proc.stderr = new EventEmitter();
                proc.kill = kill;
                proc.pid = 456;
                return proc;
            });

            const resultPromise = invokeHeadless({
                workspaceRoot: '/tmp/workspace',
                baseRef: 'main',
                headRef: 'sha:deadbeef',
                model: 'copilot/gpt-5-mini',
                seed: 7,
                timeoutMs: 60_000,
                deadlineAt: Date.now() + 500,
                bailOnError: false,
            });
            let settled = false;
            resultPromise.finally(() => {
                settled = true;
            });

            await vi.advanceTimersByTimeAsync(500);
            await vi.advanceTimersByTimeAsync(getCheckoutPostKillWaitMs() - 1);
            expect(settled).toBe(false);

            await vi.advanceTimersByTimeAsync(1);
            await vi.runOnlyPendingTimersAsync();

            const result = await resultPromise;
            expect(result.ok).toBe(false);
            if (result.ok) {
                throw new Error(
                    'Expected invokeHeadless to return a failure result'
                );
            }
            expect(result.error).toContain(
                `Git checkout did not exit within ${getCheckoutPostKillWaitMs()}ms after termination was requested.`
            );
        } finally {
            processKillSpy?.mockRestore();
            vi.useRealTimers();
        }
    }, 15_000);

    it('falls back to killing the launcher pid when POSIX process-group cleanup returns ESRCH', async () => {
        vi.useFakeTimers();
        const originalPlatform = process.platform;
        const processKillSpy = vi
            .spyOn(process, 'kill')
            .mockImplementation(() => {
                const error = new Error(
                    'process group not found'
                ) as NodeJS.ErrnoException;
                error.code = 'ESRCH';
                throw error;
            });

        try {
            Object.defineProperty(process, 'platform', {
                value: 'linux',
            });
            const childKill = vi.fn();
            let checkoutProc:
                | (EventEmitter & {
                      stdout: EventEmitter;
                      stderr: EventEmitter;
                      kill: typeof childKill;
                      pid: number;
                  })
                | undefined;
            mockedSpawn.mockImplementation((cmd: string) => {
                if (cmd !== 'git') {
                    throw new Error(`Unexpected command: ${cmd}`);
                }

                const proc = new EventEmitter() as EventEmitter & {
                    stdout: EventEmitter;
                    stderr: EventEmitter;
                    kill: typeof childKill;
                    pid: number;
                };
                proc.stdout = new EventEmitter();
                proc.stderr = new EventEmitter();
                proc.kill = childKill;
                proc.pid = 321;
                checkoutProc = proc;
                return proc;
            });

            const resultPromise = invokeHeadless({
                workspaceRoot: '/tmp/workspace',
                baseRef: 'main',
                headRef: 'sha:deadbeef',
                model: 'copilot/gpt-5-mini',
                seed: 7,
                timeoutMs: 60_000,
                deadlineAt: Date.now() + 500,
                bailOnError: false,
            });

            await vi.advanceTimersByTimeAsync(500);

            checkoutProc?.emit('close', 1);

            const result = await resultPromise;
            expect(result).toMatchObject({
                ok: false,
                result: null,
            });
            expect(processKillSpy).toHaveBeenCalledWith(-321, 'SIGTERM');
            expect(childKill).toHaveBeenCalledWith('SIGTERM');

            await vi.advanceTimersByTimeAsync(getHarnessSigtermGraceMs());

            expect(processKillSpy).not.toHaveBeenCalledWith(-321, 'SIGKILL');
            expect(childKill).not.toHaveBeenCalledWith('SIGKILL');
        } finally {
            processKillSpy.mockRestore();
            Object.defineProperty(process, 'platform', {
                value: originalPlatform,
            });
            vi.useRealTimers();
        }
    });

    it('separates resolution-only warnings from failures and renders invalid severity metrics distinctly from no-findings severities', () => {
        const noFindingsRun: SingleRun = {
            fixture: 'fixture-no-findings',
            kind: 'real',
            model: 'copilot/gpt-5-mini',
            seed: 0,
            durationMs: 100,
            ok: true,
            errorMessage: null,
            resolutionWarning: null,
            result: {
                findings: [],
                narrative: 'clean',
                telemetry: {
                    iterations: 1,
                    toolCalls: 0,
                    promptTokens: 0,
                    completionTokens: 0,
                    durationMs: 100,
                    compactionsUsed: 0,
                },
                rawToolCallLog: [],
                modelId: 'copilot/gpt-5-mini',
                seed: 0,
                completed: true,
            },
            match: emptyMatch(),
            resolution: {
                attempted: 0,
                skipped: 0,
                total: 0,
                resolved: 0,
                unresolved: 0,
                disputed: 0,
                noise: 0,
                resolutionRate: Number.NaN,
                metricStatus: 'no-findings',
                bySeverity: {},
                findings: [],
                warnings: [],
            },
        };
        const invalidHighRun: SingleRun = {
            fixture: 'fixture-invalid',
            kind: 'real',
            model: 'copilot/gpt-5-mini',
            seed: 1,
            durationMs: 120,
            ok: true,
            errorMessage: null,
            resolutionWarning:
                'Resolution proxy unavailable: remaining budget exhausted',
            result: {
                findings: [makeProduced({ id: 'high-only', severity: 'HIGH' })],
                narrative: 'warning',
                telemetry: {
                    iterations: 1,
                    toolCalls: 0,
                    promptTokens: 0,
                    completionTokens: 0,
                    durationMs: 120,
                    compactionsUsed: 0,
                },
                rawToolCallLog: [],
                modelId: 'copilot/gpt-5-mini',
                seed: 1,
                completed: true,
            },
            match: emptyMatch(),
            resolution: null,
        };

        const runs = [noFindingsRun, invalidHighRun];
        const { perFixture, perModel } = aggregate(runs);
        const report: HarnessReport = {
            generatedAt: '2026-04-22T00:00:00.000Z',
            gitSha: 'abcdef0123456789',
            models: ['copilot/gpt-5-mini'],
            seeds: 1,
            fixtures: ['fixture-no-findings', 'fixture-invalid'],
            perFixture,
            perModel,
            rawRuns: runs,
        };

        const markdown = renderMarkdown('2026-04-22_00-00-00', report);

        expect(perModel[0]?.resolutionRateBySeverity.HIGH).toMatchObject({
            invalidCount: 1,
        });
        expect(perModel[0]?.resolutionRateBySeverity.LOW).toMatchObject({
            count: 0,
            invalidCount: 0,
        });
        expect(markdown).toContain('| copilot/gpt-5-mini | HIGH | ⚠ |');
        expect(markdown).toContain('| copilot/gpt-5-mini | LOW | — |');
        expect(markdown).toContain(
            'Resolution proxy unavailable: remaining budget exhausted'
        );
        expect(markdown).toContain('## Failures\n\n(none)');
    });

    it('treats a resolution warning with null result as no-findings for all severities', () => {
        const nullResultWarningRun: SingleRun = {
            fixture: 'fixture-null-warning',
            kind: 'real',
            model: 'copilot/gpt-5-mini',
            seed: 2,
            durationMs: 100,
            ok: true,
            errorMessage: null,
            resolutionWarning: 'Resolution proxy unavailable: null result',
            result: null,
            match: emptyMatch(),
            resolution: null,
        };

        const runs = [nullResultWarningRun];
        const { perModel } = aggregate(runs);

        for (const severity of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const) {
            expect(
                perModel[0]?.resolutionRateBySeverity[severity]
            ).toMatchObject({
                invalidCount: 0,
                noFindingsCount: 1,
            });
        }
    });

    it('keeps the harness POSIX SIGKILL grace longer than the launcher grace it depends on', async () => {
        const { WATCHDOG_SIGTERM_GRACE_MS } =
            await import('../../../scripts/eval/launchHeadless.js');

        expect(getHarnessSigtermGraceMs()).toBeGreaterThan(
            WATCHDOG_SIGTERM_GRACE_MS
        );
    });
});

describe('validateRef', () => {
    it('rejects empty refs', () => {
        expect(() => validateRef('', 'baseRef')).toThrow(
            /baseRef: must be a non-empty string/
        );
    });

    it('rejects sha: with empty body', () => {
        expect(() => validateRef('sha:', 'headRef')).toThrow(
            /headRef: empty body after scheme/
        );
    });

    it('rejects sha: with non-hex characters', () => {
        expect(() => validateRef('sha:zzz', 'headRef')).toThrow(
            /headRef: invalid SHA format/
        );
    });

    it('accepts sha: with short length (1 char)', () => {
        expect(() => validateRef('sha:1', 'headRef')).not.toThrow();
    });

    it('rejects sha: with wrong length (too long)', () => {
        expect(() =>
            validateRef(
                'sha:12345678901234567890123456789012345678901234567890123456789012345',
                'headRef'
            )
        ).toThrow(/headRef: invalid SHA format/);
    });

    it('rejects refs with whitespace', () => {
        expect(() => validateRef('feature branch', 'baseRef')).toThrow(
            /baseRef: contains whitespace or control characters/
        );
    });

    it('rejects refs with control characters', () => {
        expect(() => validateRef('feature\tbranch', 'baseRef')).toThrow(
            /baseRef: contains whitespace or control characters/
        );
    });

    it('rejects refs starting with -', () => {
        expect(() => validateRef('--force', 'baseRef')).toThrow(
            /baseRef: starts with '-', which is not allowed/
        );
    });
});

function emptyMatch(): MatchResult {
    return {
        matched: [],
        missedExpected: [],
        falsePositives: [],
        precision: 0,
        recall: 0,
        f1: 0,
    };
}

function makeRealFixture() {
    return {
        name: 'real-case',
        kind: 'real' as const,
        labels: {
            intent: 'test real resolution',
            expected_findings: [],
            minFilesExamined: 1,
            maxFalsePositivesTolerated: 0,
        },
        workspaceRoot: '/tmp/workspace',
        baseRef: 'sha:base',
        headRef: 'sha:head',
        mergeRef: 'sha:merge',
    };
}

function createMockGitDiffProcess(stdoutText: string) {
    const proc = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
    };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    queueMicrotask(() => {
        if (stdoutText.length > 0) {
            proc.stdout.emit('data', Buffer.from(stdoutText));
        }
        proc.emit('close', 0);
    });
    return proc;
}

function createMockLauncherProcess(exitCode: number, exitDelayMs: number = 0) {
    const proc = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
    };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    if (exitDelayMs > 0) {
        setTimeout(() => {
            proc.emit('exit', exitCode);
        }, exitDelayMs);
    } else {
        queueMicrotask(() => {
            proc.emit('exit', exitCode);
        });
    }
    return proc;
}
