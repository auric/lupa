import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as headlessArgs from '../../scripts/eval/headlessArgs';

// Hoisted mocks. __mocks__/vscode.js supplies the default vscode shape;
// runHeadless is mocked so the incomplete-exit branch can be exercised
// without spinning up the real AnalysisEngine.
vi.mock('vscode');
vi.mock('../eval/headlessRunner', () => ({
    runHeadless: vi.fn(),
}));
vi.mock('../eval/headlessJudge', () => ({
    runHeadlessResolutionJudge: vi.fn(),
}));

const ENV_KEYS = [
    'LUPA_HEADLESS_MODE',
    'LUPA_HEADLESS_ARGS',
    'LUPA_HEADLESS_SENTINEL',
] as const;

describe('runHeadlessFromEnv', () => {
    let tmpDir: string;
    let sentinelPath: string;
    let outPath: string;
    const originalEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lupa-headless-'));
        sentinelPath = path.join(tmpDir, 'sentinel.json');
        outPath = path.join(tmpDir, 'out.json');
        for (const key of ENV_KEYS) {
            originalEnv[key] = process.env[key];
            delete process.env[key];
        }
        // Reset the module cache so headlessEntry.ts's module-level
        // `headlessRunStarted` flag starts fresh for each test. vi.mock
        // registrations persist across resetModules.
        vi.resetModules();
    });

    afterEach(() => {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch (e) {
            // best-effort cleanup; tmp files are harmless if left behind
            console.error('cleanup failed', e);
        }
        for (const key of ENV_KEYS) {
            const prior = originalEnv[key];
            if (prior === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = prior;
            }
        }
    });

    it('writes sentinel exitCode:1 with a non-null error, --out with the partial result, and invokes workbench.action.quit when runHeadless reports incomplete', async () => {
        const args = {
            workspace: '/ws',
            base: 'main',
            head: 'feature/x',
            model: 'copilot/gpt-4.1',
            seed: 42,
            timeoutMs: 60_000,
            out: outPath,
            silent: true,
        };
        process.env.LUPA_HEADLESS_MODE = '1';
        process.env.LUPA_HEADLESS_ARGS = JSON.stringify(args);
        process.env.LUPA_HEADLESS_SENTINEL = sentinelPath;

        // Re-import after resetModules so we get the fresh module instances
        // that the dynamic headlessEntry import below will also bind to.
        const vscode = await import('vscode');
        const { runHeadless } = await import('../eval/headlessRunner');

        vi.mocked(vscode.lm.selectChatModels).mockReset();
        vi.mocked(vscode.commands.executeCommand).mockReset();
        vi.mocked(runHeadless).mockReset();
        vi.mocked(vscode.lm.selectChatModels).mockResolvedValue([
            {
                id: 'gpt-4.1',
                name: 'GPT-4.1',
                family: 'gpt-4',
                vendor: 'copilot',
                maxInputTokens: 128000,
            } as unknown as import('vscode').LanguageModelChat,
        ]);
        vi.mocked(vscode.commands.executeCommand).mockResolvedValue(
            undefined as never
        );

        const partialResult = {
            findings: [{ id: 'f1', title: 'example' }],
            narrative: 'partial narrative',
            telemetry: {
                iterations: 3,
                toolCalls: 5,
                promptTokens: 0,
                completionTokens: 0,
                durationMs: 1234,
                compactionsUsed: 0,
            },
            rawToolCallLog: [],
            modelId: 'copilot/gpt-4.1',
            seed: 42,
            completed: false,
        };
        vi.mocked(runHeadless).mockResolvedValue(partialResult as never);

        const coordinator = {
            waitForInitialization: vi.fn().mockResolvedValue({}),
        };

        const { runHeadlessFromEnv } = await import('../eval/headlessEntry');
        await runHeadlessFromEnv(coordinator as never);

        // Sentinel: exitCode 1, error is a non-null, non-empty string.
        expect(fs.existsSync(sentinelPath)).toBe(true);
        const sentinel = JSON.parse(fs.readFileSync(sentinelPath, 'utf8'));
        expect(sentinel.exitCode).toBe(1);
        expect(sentinel.error).not.toBeNull();
        expect(typeof sentinel.error).toBe('string');
        expect((sentinel.error as string).length).toBeGreaterThan(0);

        // --out: the partial result was written verbatim.
        expect(fs.existsSync(outPath)).toBe(true);
        const outJson = JSON.parse(fs.readFileSync(outPath, 'utf8'));
        expect(outJson.completed).toBe(false);
        expect(outJson.findings).toHaveLength(1);
        expect(outJson.narrative).toBe('partial narrative');

        // VS Code quit was requested so the launcher isn't left hanging.
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'workbench.action.quit'
        );
    });

    it('incomplete-exit error mentions --out path when provided and omits it otherwise', async () => {
        const baseArgs = {
            workspace: '/ws',
            base: 'main',
            head: 'feature/x',
            model: 'copilot/gpt-4.1',
            seed: 42,
            timeoutMs: 60_000,
            silent: true,
        };
        const partialResult = {
            findings: [],
            narrative: '',
            telemetry: {
                iterations: 0,
                toolCalls: 0,
                promptTokens: 0,
                completionTokens: 0,
                durationMs: 0,
                compactionsUsed: 0,
            },
            rawToolCallLog: [],
            modelId: 'copilot/gpt-4.1',
            seed: 42,
            completed: false,
        };

        async function runWithArgs(
            args: typeof baseArgs & { out: string | null }
        ): Promise<string> {
            vi.resetModules();
            process.env.LUPA_HEADLESS_MODE = '1';
            process.env.LUPA_HEADLESS_ARGS = JSON.stringify(args);
            process.env.LUPA_HEADLESS_SENTINEL = sentinelPath;

            const vscode = await import('vscode');
            const { runHeadless } = await import('../eval/headlessRunner');
            vi.mocked(vscode.lm.selectChatModels).mockResolvedValue([
                {
                    id: 'gpt-4.1',
                    name: 'GPT-4.1',
                    family: 'gpt-4',
                    vendor: 'copilot',
                    maxInputTokens: 128000,
                } as unknown as import('vscode').LanguageModelChat,
            ]);
            vi.mocked(vscode.commands.executeCommand).mockResolvedValue(
                undefined as never
            );
            vi.mocked(runHeadless).mockResolvedValue(partialResult as never);

            const coordinator = {
                waitForInitialization: vi.fn().mockResolvedValue({}),
            };
            const { runHeadlessFromEnv } =
                await import('../eval/headlessEntry');
            await runHeadlessFromEnv(coordinator as never);
            const sentinel = JSON.parse(fs.readFileSync(sentinelPath, 'utf8'));
            return sentinel.error as string;
        }

        const withOutError = await runWithArgs({ ...baseArgs, out: outPath });
        expect(withOutError).toContain(`see ${outPath} for partial result`);

        fs.rmSync(sentinelPath, { force: true });

        const withoutOutError = await runWithArgs({ ...baseArgs, out: null });
        expect(withoutOutError).toContain(
            'rerun with --out <path> to capture partial result'
        );
    });

    it('writes a complete sentinel and removes its .tmp after runHeadlessFromEnv', async () => {
        const args = {
            workspace: '/ws',
            base: 'main',
            head: 'feature/x',
            model: 'copilot/gpt-4.1',
            seed: 42,
            timeoutMs: 60_000,
            out: outPath,
            silent: true,
        };
        process.env.LUPA_HEADLESS_MODE = '1';
        process.env.LUPA_HEADLESS_ARGS = JSON.stringify(args);
        process.env.LUPA_HEADLESS_SENTINEL = sentinelPath;

        const vscode = await import('vscode');
        const { runHeadless } = await import('../eval/headlessRunner');

        vi.mocked(vscode.lm.selectChatModels).mockReset();
        vi.mocked(vscode.commands.executeCommand).mockReset();
        vi.mocked(runHeadless).mockReset();
        vi.mocked(vscode.lm.selectChatModels).mockResolvedValue([
            {
                id: 'gpt-4.1',
                name: 'GPT-4.1',
                family: 'gpt-4',
                vendor: 'copilot',
                maxInputTokens: 128000,
            } as unknown as import('vscode').LanguageModelChat,
        ]);
        vi.mocked(vscode.commands.executeCommand).mockResolvedValue(
            undefined as never
        );
        vi.mocked(runHeadless).mockResolvedValue({
            findings: [],
            narrative: '',
            telemetry: {
                iterations: 0,
                toolCalls: 0,
                promptTokens: 0,
                completionTokens: 0,
                durationMs: 0,
                compactionsUsed: 0,
            },
            rawToolCallLog: [],
            modelId: 'copilot/gpt-4.1',
            seed: 42,
            completed: false,
        } as never);

        const coordinator = {
            waitForInitialization: vi.fn().mockResolvedValue({}),
        };

        const { runHeadlessFromEnv } = await import('../eval/headlessEntry');
        await runHeadlessFromEnv(coordinator as never);

        expect(fs.existsSync(`${sentinelPath}.tmp`)).toBe(false);
        expect(fs.existsSync(sentinelPath)).toBe(true);
        // Final sentinel is complete, parseable JSON — not a half-written
        // partial that a concurrent reader could have observed.
        const parsed = JSON.parse(fs.readFileSync(sentinelPath, 'utf8'));
        expect(parsed).toHaveProperty('exitCode');
    });

    it('runs resolution-judge mode and writes a successful result JSON', async () => {
        const deadlineAt = Date.now() + 54_321;
        const args = {
            mode: 'resolution-judge',
            workspace: '/ws',
            model: 'copilot/gpt-5-mini',
            payload: path.join(tmpDir, 'payload.json'),
            timeoutMs: 60_000,
            deadlineAt,
            out: outPath,
            silent: true,
        };
        process.env.LUPA_HEADLESS_MODE = '1';
        process.env.LUPA_HEADLESS_ARGS = JSON.stringify(args);
        process.env.LUPA_HEADLESS_SENTINEL = sentinelPath;

        const vscode = await import('vscode');
        const { runHeadlessResolutionJudge } =
            await import('../eval/headlessJudge');

        vi.mocked(vscode.lm.selectChatModels).mockReset();
        vi.mocked(vscode.commands.executeCommand).mockReset();
        vi.mocked(runHeadlessResolutionJudge).mockReset();
        vi.mocked(vscode.lm.selectChatModels).mockResolvedValue([
            {
                id: 'gpt-5-mini',
                name: 'GPT-5 mini',
                family: 'gpt-5',
                vendor: 'copilot',
                maxInputTokens: 128000,
            } as unknown as import('vscode').LanguageModelChat,
        ]);
        vi.mocked(vscode.commands.executeCommand).mockResolvedValue(
            undefined as never
        );
        vi.mocked(runHeadlessResolutionJudge).mockResolvedValue({
            verdict: 'resolved',
            reason: 'Patch touched the cited lines.',
            modelId: 'copilot/gpt-5-mini',
        } as never);

        const coordinator = {
            waitForInitialization: vi.fn().mockResolvedValue({}),
        };

        const { runHeadlessFromEnv } = await import('../eval/headlessEntry');
        await runHeadlessFromEnv(coordinator as never);

        const sentinel = JSON.parse(fs.readFileSync(sentinelPath, 'utf8'));
        expect(sentinel.exitCode).toBe(0);
        expect(sentinel.error).toBeNull();

        const outJson = JSON.parse(fs.readFileSync(outPath, 'utf8'));
        expect(outJson).toMatchObject({
            verdict: 'resolved',
            modelId: 'copilot/gpt-5-mini',
        });
        expect(runHeadlessResolutionJudge).toHaveBeenCalledTimes(1);
        expect(runHeadlessResolutionJudge).toHaveBeenCalledWith(
            expect.objectContaining({
                deadlineAt,
                payloadPath: args.payload,
            }),
            expect.anything()
        );
    });

    it('writes a failing sentinel when resolution-judge mode throws', async () => {
        const args = {
            mode: 'resolution-judge',
            workspace: '/ws',
            model: 'copilot/gpt-5-mini',
            payload: path.join(tmpDir, 'payload.json'),
            timeoutMs: 60_000,
            out: outPath,
            silent: true,
        };
        process.env.LUPA_HEADLESS_MODE = '1';
        process.env.LUPA_HEADLESS_ARGS = JSON.stringify(args);
        process.env.LUPA_HEADLESS_SENTINEL = sentinelPath;

        const vscode = await import('vscode');
        const { runHeadlessResolutionJudge } =
            await import('../eval/headlessJudge');

        vi.mocked(vscode.lm.selectChatModels).mockReset();
        vi.mocked(vscode.commands.executeCommand).mockReset();
        vi.mocked(runHeadlessResolutionJudge).mockReset();
        vi.mocked(vscode.lm.selectChatModels).mockResolvedValue([
            {
                id: 'gpt-5-mini',
                name: 'GPT-5 mini',
                family: 'gpt-5',
                vendor: 'copilot',
                maxInputTokens: 128000,
            } as unknown as import('vscode').LanguageModelChat,
        ]);
        vi.mocked(vscode.commands.executeCommand).mockResolvedValue(
            undefined as never
        );
        vi.mocked(runHeadlessResolutionJudge).mockRejectedValue(
            new Error('judge boom') as never
        );

        const coordinator = {
            waitForInitialization: vi.fn().mockResolvedValue({}),
        };

        const { runHeadlessFromEnv } = await import('../eval/headlessEntry');
        await runHeadlessFromEnv(coordinator as never);

        const sentinel = JSON.parse(fs.readFileSync(sentinelPath, 'utf8'));
        expect(sentinel.exitCode).toBe(1);
        expect(sentinel.error).toContain('judge boom');
    });

    it('accepts parser-produced args when --deadline-at is omitted', async () => {
        const args = headlessArgs.parseHeadlessArgs([
            '--workspace',
            '/ws',
            '--base',
            'main',
            '--head',
            'feature/x',
            '--model',
            'copilot/gpt-4.1',
            '--timeout',
            '60000',
            '--out',
            outPath,
            '--silent',
        ]);
        process.env.LUPA_HEADLESS_MODE = '1';
        process.env.LUPA_HEADLESS_ARGS = JSON.stringify(args);
        process.env.LUPA_HEADLESS_SENTINEL = sentinelPath;

        const vscode = await import('vscode');
        const { runHeadless } = await import('../eval/headlessRunner');

        vi.mocked(vscode.lm.selectChatModels).mockResolvedValue([
            {
                id: 'gpt-4.1',
                name: 'GPT-4.1',
                family: 'gpt-4',
                vendor: 'copilot',
                maxInputTokens: 128000,
            } as unknown as import('vscode').LanguageModelChat,
        ]);
        vi.mocked(vscode.commands.executeCommand).mockResolvedValue(
            undefined as never
        );
        vi.mocked(runHeadless).mockResolvedValue({
            findings: [],
            narrative: 'complete narrative',
            telemetry: {
                iterations: 1,
                toolCalls: 2,
                promptTokens: 0,
                completionTokens: 0,
                durationMs: 123,
                compactionsUsed: 0,
            },
            rawToolCallLog: [],
            modelId: 'copilot/gpt-4.1',
            seed: 0,
            completed: true,
        } as never);

        const coordinator = {
            waitForInitialization: vi.fn().mockResolvedValue({}),
        };

        const { runHeadlessFromEnv } = await import('../eval/headlessEntry');
        await runHeadlessFromEnv(coordinator as never);

        const sentinel = JSON.parse(fs.readFileSync(sentinelPath, 'utf8'));
        expect(args.deadlineAt).toBeNull();
        expect(sentinel.exitCode).toBe(0);
        expect(sentinel.error).toBeNull();
        expect(runHeadless).toHaveBeenCalledWith(
            expect.objectContaining({
                timeoutMs: 60_000,
                deadlineAt: expect.any(Number),
            }),
            expect.anything()
        );

        const outJson = JSON.parse(fs.readFileSync(outPath, 'utf8'));
        expect(outJson).toMatchObject({
            completed: true,
            narrative: 'complete narrative',
        });
    });

    async function runWithRawArgs(rawArgs: string): Promise<{
        exitCode: number;
        error: string | null;
    }> {
        vi.resetModules();
        process.env.LUPA_HEADLESS_MODE = '1';
        process.env.LUPA_HEADLESS_ARGS = rawArgs;
        process.env.LUPA_HEADLESS_SENTINEL = sentinelPath;

        const vscode = await import('vscode');
        vi.mocked(vscode.commands.executeCommand).mockResolvedValue(
            undefined as never
        );

        const coordinator = {
            waitForInitialization: vi.fn().mockResolvedValue({}),
        };
        const { runHeadlessFromEnv } = await import('../eval/headlessEntry');
        await runHeadlessFromEnv(coordinator as never);
        return JSON.parse(fs.readFileSync(sentinelPath, 'utf8'));
    }

    async function advanceFakeTimersUntil(
        condition: () => boolean,
        failureMessage: string,
        maxElapsedMs: number
    ): Promise<number> {
        const startedAt = Date.now();
        vi.runAllTicks();
        await vi.waitFor(
            () => {
                if (!condition()) {
                    throw new Error(failureMessage);
                }
            },
            {
                timeout: maxElapsedMs,
                interval: 1,
            }
        );
        return Date.now() - startedAt;
    }

    it('writes sentinel exitCode:1 with a diagnostic error when LUPA_HEADLESS_ARGS has a field of the wrong type', async () => {
        const bad = JSON.stringify({
            workspace: 123,
            base: 'main',
            head: 'feature/x',
            model: 'copilot/gpt-4.1',
            timeoutMs: 60_000,
        });
        const sentinel = await runWithRawArgs(bad);
        expect(sentinel.exitCode).toBe(1);
        expect(sentinel.error).not.toBeNull();
        expect(sentinel.error).toContain('workspace');
    });

    it('writes sentinel exitCode:1 when LUPA_HEADLESS_ARGS is not valid JSON', async () => {
        const sentinel = await runWithRawArgs('not json');
        expect(sentinel.exitCode).toBe(1);
        expect(sentinel.error).not.toBeNull();
        expect(typeof sentinel.error).toBe('string');
        expect((sentinel.error as string).length).toBeGreaterThan(0);
    });

    it('fails fast on malformed slash-form model identifiers before initialization or model discovery starts', async () => {
        process.env.LUPA_HEADLESS_MODE = '1';
        process.env.LUPA_HEADLESS_ARGS = JSON.stringify({
            workspace: '/ws',
            base: 'main',
            head: 'feature/x',
            model: 'copilot/',
            seed: 42,
            timeoutMs: 60_000,
            out: outPath,
            silent: true,
        });
        process.env.LUPA_HEADLESS_SENTINEL = sentinelPath;

        const vscode = await import('vscode');
        vi.mocked(vscode.lm.selectChatModels).mockReset();
        vi.mocked(vscode.commands.executeCommand).mockResolvedValue(
            undefined as never
        );

        const coordinator = {
            waitForInitialization: vi.fn().mockResolvedValue({}),
        };

        const { runHeadlessFromEnv } = await import('../eval/headlessEntry');
        await runHeadlessFromEnv(coordinator as never);

        const sentinel = JSON.parse(fs.readFileSync(sentinelPath, 'utf8'));
        expect(sentinel.exitCode).toBe(1);
        expect(sentinel.error).toContain(
            "Malformed model identifier 'copilot/'"
        );
        expect(coordinator.waitForInitialization).not.toHaveBeenCalled();
        expect(vscode.lm.selectChatModels).not.toHaveBeenCalled();
    });

    it('reports malformed eval --models identifiers as CliError during CLI setup', async () => {
        const { CliError, normalizeCliModelIdentifiers, parseArgs } =
            await import('../../scripts/eval/run-eval.ts');

        expect(() =>
            normalizeCliModelIdentifiers(
                parseArgs(['--models', 'copilot/,copilot/gpt-5'])
            )
        ).toThrow(CliError);
        expect(() =>
            normalizeCliModelIdentifiers(
                parseArgs(['--models', 'copilot/,copilot/gpt-5'])
            )
        ).toThrow(/--models: Malformed model identifier 'copilot\/'/);
    });

    it('reports malformed eval --aux-model identifiers as CliError during CLI setup', async () => {
        const { CliError, normalizeCliModelIdentifiers, parseArgs } =
            await import('../../scripts/eval/run-eval.ts');

        expect(() =>
            normalizeCliModelIdentifiers(parseArgs(['--aux-model', 'copilot/']))
        ).toThrow(CliError);
        expect(() =>
            normalizeCliModelIdentifiers(parseArgs(['--aux-model', 'copilot/']))
        ).toThrow(/--aux-model: Malformed model identifier 'copilot\/'/);
    });

    it('returns null when the remaining auxiliary judge budget is below the minimum threshold', async () => {
        const { createAuxiliaryJudgeBudget } =
            await import('../../scripts/eval/run-eval.ts');
        const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(10_000);

        try {
            expect(createAuxiliaryJudgeBudget(19_999)).toBeNull();
        } finally {
            nowSpy.mockRestore();
        }
    });

    it('returns the minimum auxiliary judge budget when the remaining budget exactly matches the threshold', async () => {
        const { createAuxiliaryJudgeBudget, MIN_AUXILIARY_JUDGE_TIMEOUT_MS } =
            await import('../../scripts/eval/run-eval.ts');
        const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(10_000);

        try {
            expect(
                createAuxiliaryJudgeBudget(
                    10_000 + MIN_AUXILIARY_JUDGE_TIMEOUT_MS
                )
            ).toEqual({
                timeoutMs: MIN_AUXILIARY_JUDGE_TIMEOUT_MS,
                deadlineAt: 10_000 + MIN_AUXILIARY_JUDGE_TIMEOUT_MS,
            });
        } finally {
            nowSpy.mockRestore();
        }
    });

    it('clamps the auxiliary judge budget to the configured maximum', async () => {
        const { createAuxiliaryJudgeBudget, MAX_AUXILIARY_JUDGE_TIMEOUT_MS } =
            await import('../../scripts/eval/run-eval.ts');
        const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(10_000);

        try {
            expect(createAuxiliaryJudgeBudget(300_000)).toEqual({
                timeoutMs: MAX_AUXILIARY_JUDGE_TIMEOUT_MS,
                deadlineAt: 10_000 + MAX_AUXILIARY_JUDGE_TIMEOUT_MS,
            });
        } finally {
            nowSpy.mockRestore();
        }
    });

    it('detects the documented vite-node argv shape as direct CLI execution without treating test imports as direct runs', async () => {
        const { getCliArgs, isDirectExecution } =
            await import('../../scripts/eval/run-eval.ts');
        const runEvalPath = path.resolve('scripts/eval/run-eval.ts');

        expect(
            isDirectExecution([
                process.execPath,
                path.resolve('node_modules/vite-node/dist/cli.mjs'),
                runEvalPath,
                '--models',
                'copilot/gpt-5',
            ])
        ).toBe(true);
        expect(
            getCliArgs([
                process.execPath,
                path.resolve('node_modules/vite-node/dist/cli.mjs'),
                runEvalPath,
                '--models',
                'copilot/gpt-5',
            ])
        ).toEqual(['--models', 'copilot/gpt-5']);
        expect(
            getCliArgs([
                process.execPath,
                path.resolve('node_modules/vite-node/dist/cli.mjs'),
                runEvalPath,
                '--',
                '--help',
            ])
        ).toEqual(['--help']);

        expect(
            isDirectExecution([
                process.execPath,
                path.resolve('node_modules/vitest/vitest.mjs'),
                path.resolve('src/__tests__/headlessEntry.test.ts'),
            ])
        ).toBe(false);
    });

    it('caps exact-model preflight at the dedicated max even when more run budget remains', async () => {
        const {
            EXACT_MODEL_PREFLIGHT_MAX_MS,
            getExactModelPreflightTimeoutMs,
        } = await import('../eval/headlessEntry');

        expect(
            getExactModelPreflightTimeoutMs(
                60_000,
                70_000,
                'copilot/gpt-4.1',
                10_000
            )
        ).toBe(EXACT_MODEL_PREFLIGHT_MAX_MS);
    });

    it('reports an exact-model preflight miss at the capped budget before the overall run timeout expires', async () => {
        vi.useFakeTimers();
        const { EXACT_MODEL_PREFLIGHT_MAX_MS } =
            await import('../eval/headlessEntry');
        const args = {
            workspace: '/ws',
            base: 'main',
            head: 'feature/x',
            model: 'copilot/gpt-4.1',
            seed: 42,
            timeoutMs: EXACT_MODEL_PREFLIGHT_MAX_MS + 30_000,
            out: outPath,
            silent: true,
        };
        process.env.LUPA_HEADLESS_MODE = '1';
        process.env.LUPA_HEADLESS_ARGS = JSON.stringify(args);
        process.env.LUPA_HEADLESS_SENTINEL = sentinelPath;

        const vscode = await import('vscode');
        const { runHeadless } = await import('../eval/headlessRunner');
        vi.mocked(runHeadless).mockReset();
        vi.mocked(vscode.lm.selectChatModels).mockReset();
        vi.mocked(vscode.lm.onDidChangeChatModels).mockReset();
        vi.mocked(vscode.commands.executeCommand).mockResolvedValue(
            undefined as never
        );
        vi.mocked(vscode.lm.selectChatModels).mockResolvedValue([
            {
                id: 'gpt-5-mini',
                name: 'GPT-5 mini',
                family: 'gpt-5',
                vendor: 'copilot',
                maxInputTokens: 128000,
            } as unknown as import('vscode').LanguageModelChat,
        ]);
        vi.mocked(vscode.lm.onDidChangeChatModels).mockReturnValue({
            dispose: vi.fn(),
        } as never);

        const coordinator = {
            waitForInitialization: vi.fn().mockResolvedValue({}),
        };

        try {
            const { runHeadlessFromEnv } =
                await import('../eval/headlessEntry');
            const runPromise = runHeadlessFromEnv(coordinator as never);

            await vi.advanceTimersByTimeAsync(EXACT_MODEL_PREFLIGHT_MAX_MS);
            await runPromise;
        } finally {
            vi.useRealTimers();
        }

        const sentinel = JSON.parse(fs.readFileSync(sentinelPath, 'utf8'));
        expect(sentinel.exitCode).toBe(1);
        expect(sentinel.error).toContain(
            `Model discovery timed out (${EXACT_MODEL_PREFLIGHT_MAX_MS}ms)`
        );
        expect(sentinel.error).not.toContain(
            `Headless run exceeded timeout (${args.timeoutMs}ms)`
        );
        expect(runHeadless).not.toHaveBeenCalled();
    });

    it('keeps polling until the exact model appears just before the preflight deadline', async () => {
        vi.useFakeTimers();
        const deadlineAt = Date.now() + 2_500;
        const args = {
            workspace: '/ws',
            base: 'main',
            head: 'feature/x',
            model: 'copilot/gpt-4.1',
            seed: 42,
            timeoutMs: 60_000,
            deadlineAt,
            out: outPath,
            silent: true,
        };
        process.env.LUPA_HEADLESS_MODE = '1';
        process.env.LUPA_HEADLESS_ARGS = JSON.stringify(args);
        process.env.LUPA_HEADLESS_SENTINEL = sentinelPath;

        const vscode = await import('vscode');
        const { runHeadless } = await import('../eval/headlessRunner');
        const { runHeadlessFromEnv } = await import('../eval/headlessEntry');

        vi.mocked(vscode.lm.selectChatModels).mockReset();
        vi.mocked(vscode.lm.onDidChangeChatModels).mockReset();
        vi.mocked(vscode.commands.executeCommand).mockReset();
        vi.mocked(runHeadless).mockReset();
        let exactModelAvailable = false;
        vi.mocked(vscode.lm.selectChatModels).mockImplementation(async () =>
            exactModelAvailable
                ? [
                      {
                          id: 'gpt-5-mini',
                          name: 'GPT-5 mini',
                          family: 'gpt-5',
                          vendor: 'copilot',
                          maxInputTokens: 128000,
                      } as unknown as import('vscode').LanguageModelChat,
                      {
                          id: 'gpt-4.1',
                          name: 'GPT-4.1',
                          family: 'gpt-4',
                          vendor: 'copilot',
                          maxInputTokens: 128000,
                      } as unknown as import('vscode').LanguageModelChat,
                  ]
                : [
                      {
                          id: 'gpt-5-mini',
                          name: 'GPT-5 mini',
                          family: 'gpt-5',
                          vendor: 'copilot',
                          maxInputTokens: 128000,
                      } as unknown as import('vscode').LanguageModelChat,
                  ]
        );
        vi.mocked(vscode.lm.onDidChangeChatModels).mockReturnValue({
            dispose: vi.fn(),
        } as never);
        vi.mocked(vscode.commands.executeCommand).mockResolvedValue(
            undefined as never
        );
        vi.mocked(runHeadless).mockResolvedValue({
            findings: [],
            narrative: 'complete narrative',
            telemetry: {
                iterations: 1,
                toolCalls: 0,
                promptTokens: 0,
                completionTokens: 0,
                durationMs: 123,
                compactionsUsed: 0,
            },
            rawToolCallLog: [],
            modelId: 'copilot/gpt-4.1',
            seed: 42,
            completed: true,
        } as never);

        const coordinator = {
            waitForInitialization: vi.fn().mockResolvedValue({}),
        };

        try {
            const runPromise = runHeadlessFromEnv(coordinator as never);

            await vi.advanceTimersByTimeAsync(1_999);
            expect(fs.existsSync(sentinelPath)).toBe(false);
            expect(runHeadless).not.toHaveBeenCalled();

            exactModelAvailable = true;
            await vi.advanceTimersByTimeAsync(1);

            await vi.waitFor(
                () => {
                    expect(runHeadless).toHaveBeenCalledTimes(1);
                },
                {
                    timeout: 50,
                    interval: 1,
                }
            );

            await runPromise;
        } finally {
            vi.useRealTimers();
        }

        const sentinel = JSON.parse(fs.readFileSync(sentinelPath, 'utf8'));
        expect(sentinel.exitCode).toBe(0);
        expect(sentinel.error).toBeNull();
        expect(runHeadless).toHaveBeenCalledTimes(1);
        expect(
            vi.mocked(vscode.lm.selectChatModels).mock.calls.length
        ).toBeGreaterThan(1);
    });

    it('retries the initial exact-model preflight after a transient selectChatModels error', async () => {
        vi.useFakeTimers();
        const deadlineAt = Date.now() + 2_500;
        const args = {
            workspace: '/ws',
            base: 'main',
            head: 'feature/x',
            model: 'copilot/gpt-4.1',
            seed: 42,
            timeoutMs: 60_000,
            deadlineAt,
            out: outPath,
            silent: true,
        };
        process.env.LUPA_HEADLESS_MODE = '1';
        process.env.LUPA_HEADLESS_ARGS = JSON.stringify(args);
        process.env.LUPA_HEADLESS_SENTINEL = sentinelPath;

        const vscode = await import('vscode');
        const { runHeadless } = await import('../eval/headlessRunner');
        const { runHeadlessFromEnv } = await import('../eval/headlessEntry');

        vi.mocked(vscode.lm.selectChatModels).mockReset();
        vi.mocked(vscode.lm.onDidChangeChatModels).mockReset();
        vi.mocked(vscode.commands.executeCommand).mockReset();
        vi.mocked(runHeadless).mockReset();

        let exactModelAvailable = false;
        let selectCalls = 0;
        vi.mocked(vscode.lm.selectChatModels).mockImplementation(async () => {
            selectCalls += 1;
            if (selectCalls === 1) {
                throw new Error('transient selectChatModels error');
            }
            return exactModelAvailable
                ? [
                      {
                          id: 'gpt-4.1',
                          name: 'GPT-4.1',
                          family: 'gpt-4',
                          vendor: 'copilot',
                          maxInputTokens: 128000,
                      } as unknown as import('vscode').LanguageModelChat,
                  ]
                : [];
        });
        vi.mocked(vscode.lm.onDidChangeChatModels).mockReturnValue({
            dispose: vi.fn(),
        } as never);
        vi.mocked(vscode.commands.executeCommand).mockResolvedValue(
            undefined as never
        );
        vi.mocked(runHeadless).mockResolvedValue({
            findings: [],
            narrative: 'complete narrative',
            telemetry: {
                iterations: 1,
                toolCalls: 0,
                promptTokens: 0,
                completionTokens: 0,
                durationMs: 123,
                compactionsUsed: 0,
            },
            rawToolCallLog: [],
            modelId: 'copilot/gpt-4.1',
            seed: 42,
            completed: true,
        } as never);

        const coordinator = {
            waitForInitialization: vi.fn().mockResolvedValue({}),
        };

        try {
            const runPromise = runHeadlessFromEnv(coordinator as never);

            await vi.advanceTimersByTimeAsync(999);
            expect(fs.existsSync(sentinelPath)).toBe(false);
            expect(runHeadless).not.toHaveBeenCalled();

            exactModelAvailable = true;
            await vi.advanceTimersByTimeAsync(1);

            await vi.waitFor(
                () => {
                    expect(runHeadless).toHaveBeenCalledTimes(1);
                },
                {
                    timeout: 50,
                    interval: 1,
                }
            );

            await runPromise;
        } finally {
            vi.useRealTimers();
        }

        const sentinel = JSON.parse(fs.readFileSync(sentinelPath, 'utf8'));
        expect(sentinel.exitCode).toBe(0);
        expect(sentinel.error).toBeNull();
        expect(selectCalls).toBeGreaterThan(1);
    });

    it('does not report a transient exact-model probe failure after later probes succeed but still find no exact match', async () => {
        vi.useFakeTimers();
        const args = {
            workspace: '/ws',
            base: 'main',
            head: 'feature/x',
            model: 'copilot/gpt-4.1',
            seed: 42,
            timeoutMs: 2_000,
            out: outPath,
            silent: true,
        };
        process.env.LUPA_HEADLESS_MODE = '1';
        process.env.LUPA_HEADLESS_ARGS = JSON.stringify(args);
        process.env.LUPA_HEADLESS_SENTINEL = sentinelPath;

        const vscode = await import('vscode');
        vi.mocked(vscode.lm.selectChatModels).mockReset();
        vi.mocked(vscode.lm.onDidChangeChatModels).mockReset();
        vi.mocked(vscode.commands.executeCommand).mockResolvedValue(
            undefined as never
        );

        let selectCalls = 0;
        vi.mocked(vscode.lm.selectChatModels).mockImplementation(async () => {
            selectCalls += 1;
            if (selectCalls === 1) {
                throw new Error('transient selectChatModels error');
            }
            return [
                {
                    id: 'gpt-5-mini',
                    name: 'GPT-5 mini',
                    family: 'gpt-5',
                    vendor: 'copilot',
                    maxInputTokens: 128000,
                } as unknown as import('vscode').LanguageModelChat,
            ];
        });
        vi.mocked(vscode.lm.onDidChangeChatModels).mockReturnValue({
            dispose: vi.fn(),
        } as never);

        const coordinator = {
            waitForInitialization: vi.fn().mockResolvedValue({}),
        };

        try {
            const { runHeadlessFromEnv } =
                await import('../eval/headlessEntry');
            const runPromise = runHeadlessFromEnv(coordinator as never);

            await vi.advanceTimersByTimeAsync(2_000);
            await runPromise;
        } finally {
            vi.useRealTimers();
        }

        const sentinel = JSON.parse(fs.readFileSync(sentinelPath, 'utf8'));
        expect(sentinel.exitCode).toBe(1);
        expect(sentinel.error).toContain(
            'Headless run exceeded timeout (2000ms) while waiting for copilot/gpt-4.1.'
        );
        expect(sentinel.error).not.toContain(
            'Exact-model preflight failed for copilot/gpt-4.1: transient selectChatModels error'
        );
        expect(selectCalls).toBeGreaterThan(1);
    });

    it('surfaces the last persistent exact-model preflight error instead of reporting model-unavailable', async () => {
        vi.useFakeTimers();
        const { EXACT_MODEL_PREFLIGHT_MAX_MS } =
            await import('../eval/headlessEntry');
        const args = {
            workspace: '/ws',
            base: 'main',
            head: 'feature/x',
            model: 'copilot/gpt-4.1',
            seed: 42,
            timeoutMs: EXACT_MODEL_PREFLIGHT_MAX_MS + 1_000,
            out: outPath,
            silent: true,
        };
        process.env.LUPA_HEADLESS_MODE = '1';
        process.env.LUPA_HEADLESS_ARGS = JSON.stringify(args);
        process.env.LUPA_HEADLESS_SENTINEL = sentinelPath;

        const vscode = await import('vscode');
        vi.mocked(vscode.lm.selectChatModels).mockReset();
        vi.mocked(vscode.lm.onDidChangeChatModels).mockReset();
        vi.mocked(vscode.commands.executeCommand).mockResolvedValue(
            undefined as never
        );
        vi.mocked(vscode.lm.selectChatModels).mockRejectedValue(
            new Error('copilot auth unavailable') as never
        );
        vi.mocked(vscode.lm.onDidChangeChatModels).mockReturnValue({
            dispose: vi.fn(),
        } as never);

        const coordinator = {
            waitForInitialization: vi.fn().mockResolvedValue({}),
        };

        try {
            const { runHeadlessFromEnv } =
                await import('../eval/headlessEntry');
            const runPromise = runHeadlessFromEnv(coordinator as never);
            await vi.advanceTimersByTimeAsync(EXACT_MODEL_PREFLIGHT_MAX_MS);
            await runPromise;
        } finally {
            vi.useRealTimers();
        }

        const sentinel = JSON.parse(fs.readFileSync(sentinelPath, 'utf8'));
        expect(sentinel.exitCode).toBe(1);
        expect(sentinel.error).toContain(
            'Exact-model preflight failed for copilot/gpt-4.1: copilot auth unavailable'
        );
        expect(sentinel.error).not.toContain(
            'was not available during exact-model preflight'
        );
    });

    it('uses only the remaining timeout budget while waiting for models after initialization completes', async () => {
        vi.useFakeTimers();
        const args = {
            workspace: '/ws',
            base: 'main',
            head: 'feature/x',
            model: 'copilot/gpt-4.1',
            seed: 42,
            timeoutMs: 1_000,
            out: outPath,
            silent: true,
        };
        process.env.LUPA_HEADLESS_MODE = '1';
        process.env.LUPA_HEADLESS_ARGS = JSON.stringify(args);
        process.env.LUPA_HEADLESS_SENTINEL = sentinelPath;

        const vscode = await import('vscode');
        const eventDisposable = { dispose: vi.fn() };

        vi.mocked(vscode.lm.selectChatModels).mockReset();
        vi.mocked(vscode.lm.onDidChangeChatModels).mockReset();
        vi.mocked(vscode.lm.selectChatModels).mockResolvedValue([]);
        vi.mocked(vscode.lm.onDidChangeChatModels).mockReturnValue(
            eventDisposable as never
        );
        vi.mocked(vscode.commands.executeCommand).mockResolvedValue(
            undefined as never
        );

        const coordinator = {
            waitForInitialization: vi.fn().mockImplementation(
                () =>
                    new Promise((resolve) => {
                        setTimeout(() => resolve({}), 700);
                    })
            ),
        };

        try {
            const { runHeadlessFromEnv } =
                await import('../eval/headlessEntry');
            const runPromise = runHeadlessFromEnv(coordinator as never);

            await vi.advanceTimersByTimeAsync(999);
            expect(fs.existsSync(sentinelPath)).toBe(false);

            await vi.advanceTimersByTimeAsync(1);
            await runPromise;
        } finally {
            vi.useRealTimers();
        }

        const sentinel = JSON.parse(fs.readFileSync(sentinelPath, 'utf8'));
        expect(sentinel.exitCode).toBe(1);
        expect(sentinel.error).toContain(
            'Headless run exceeded timeout (1000ms) while waiting for copilot/gpt-4.1.'
        );
        expect(vscode.lm.selectChatModels).toHaveBeenCalledTimes(1);
        expect(eventDisposable.dispose).toHaveBeenCalledTimes(1);
    });

    it('recovers when the first exact-model probe hangs but a later probe finds the requested model', async () => {
        vi.useFakeTimers();
        const args = {
            workspace: '/ws',
            base: 'main',
            head: 'feature/x',
            model: 'copilot/gpt-4.1',
            seed: 42,
            timeoutMs: 5_000,
            out: outPath,
            silent: true,
        };
        process.env.LUPA_HEADLESS_MODE = '1';
        process.env.LUPA_HEADLESS_ARGS = JSON.stringify(args);
        process.env.LUPA_HEADLESS_SENTINEL = sentinelPath;

        const vscode = await import('vscode');
        const { runHeadless } = await import('../eval/headlessRunner');
        const { runHeadlessFromEnv } = await import('../eval/headlessEntry');
        let onDidChangeChatModels: (() => void) | undefined;
        vi.mocked(vscode.lm.selectChatModels).mockReset();
        vi.mocked(vscode.lm.onDidChangeChatModels).mockReset();
        vi.mocked(runHeadless).mockReset();
        vi.mocked(vscode.commands.executeCommand).mockResolvedValue(
            undefined as never
        );
        let selectCalls = 0;
        vi.mocked(vscode.lm.selectChatModels).mockImplementation(async () => {
            selectCalls += 1;
            if (selectCalls === 1) {
                return (await new Promise(() => {})) as never;
            }

            return [
                {
                    id: 'gpt-4.1',
                    name: 'GPT-4.1',
                    family: 'gpt-4',
                    vendor: 'copilot',
                    maxInputTokens: 128000,
                } as unknown as import('vscode').LanguageModelChat,
            ];
        });
        vi.mocked(vscode.lm.onDidChangeChatModels).mockImplementation(
            (listener) => {
                onDidChangeChatModels = listener;
                return {
                    dispose: vi.fn(),
                } as never;
            }
        );
        vi.mocked(runHeadless).mockResolvedValue({
            findings: [],
            narrative: 'complete narrative',
            telemetry: {
                iterations: 1,
                toolCalls: 0,
                promptTokens: 0,
                completionTokens: 0,
                durationMs: 123,
                compactionsUsed: 0,
            },
            rawToolCallLog: [],
            modelId: 'copilot/gpt-4.1',
            seed: 42,
            completed: true,
        } as never);

        const coordinator = {
            waitForInitialization: vi.fn().mockResolvedValue({}),
        };

        try {
            const runPromise = runHeadlessFromEnv(coordinator as never);

            await vi.advanceTimersByTimeAsync(3_000);
            onDidChangeChatModels?.();
            await vi.runAllTicks();

            await vi.waitFor(
                () => {
                    expect(runHeadless).toHaveBeenCalledTimes(1);
                },
                {
                    timeout: 50,
                    interval: 1,
                }
            );

            await runPromise;
        } finally {
            vi.useRealTimers();
        }

        const sentinel = JSON.parse(fs.readFileSync(sentinelPath, 'utf8'));
        expect(sentinel.exitCode).toBe(0);
        expect(sentinel.error).toBeNull();
        expect(runHeadless).toHaveBeenCalledTimes(1);
        expect(selectCalls).toBeGreaterThan(1);
    });

    it('does not surface a stale exact-model probe error when a newer probe is still hanging at timeout', async () => {
        vi.useFakeTimers();
        const args = {
            workspace: '/ws',
            base: 'main',
            head: 'feature/x',
            model: 'copilot/gpt-4.1',
            seed: 42,
            timeoutMs: 2_000,
            out: outPath,
            silent: true,
        };
        process.env.LUPA_HEADLESS_MODE = '1';
        process.env.LUPA_HEADLESS_ARGS = JSON.stringify(args);
        process.env.LUPA_HEADLESS_SENTINEL = sentinelPath;

        const vscode = await import('vscode');
        vi.mocked(vscode.lm.selectChatModels).mockReset();
        vi.mocked(vscode.lm.onDidChangeChatModels).mockReset();
        vi.mocked(vscode.commands.executeCommand).mockResolvedValue(
            undefined as never
        );

        let selectCalls = 0;
        vi.mocked(vscode.lm.selectChatModels).mockImplementation(async () => {
            selectCalls += 1;
            if (selectCalls === 1) {
                throw new Error('transient selectChatModels error');
            }
            return (await new Promise(() => {})) as never;
        });
        vi.mocked(vscode.lm.onDidChangeChatModels).mockReturnValue({
            dispose: vi.fn(),
        } as never);

        const coordinator = {
            waitForInitialization: vi.fn().mockResolvedValue({}),
        };

        try {
            const { runHeadlessFromEnv } =
                await import('../eval/headlessEntry');
            const runPromise = runHeadlessFromEnv(coordinator as never);

            await vi.advanceTimersByTimeAsync(2_000);
            await runPromise;
        } finally {
            vi.useRealTimers();
        }

        const sentinel = JSON.parse(fs.readFileSync(sentinelPath, 'utf8'));
        expect(sentinel.exitCode).toBe(1);
        expect(sentinel.error).toContain(
            'Headless run exceeded timeout (2000ms) while waiting for copilot/gpt-4.1.'
        );
        expect(sentinel.error).not.toContain(
            'Exact-model preflight failed for copilot/gpt-4.1: transient selectChatModels error'
        );
        expect(selectCalls).toBe(2);
    });

    it('times out during initialization before attempting model discovery', async () => {
        vi.useFakeTimers();
        const args = {
            workspace: '/ws',
            base: 'main',
            head: 'feature/x',
            model: 'copilot/gpt-4.1',
            seed: 42,
            timeoutMs: 1_000,
            out: outPath,
            silent: true,
        };
        process.env.LUPA_HEADLESS_MODE = '1';
        process.env.LUPA_HEADLESS_ARGS = JSON.stringify(args);
        process.env.LUPA_HEADLESS_SENTINEL = sentinelPath;

        const vscode = await import('vscode');
        vi.mocked(vscode.lm.selectChatModels).mockReset();
        vi.mocked(vscode.lm.selectChatModels).mockResolvedValue([]);
        vi.mocked(vscode.commands.executeCommand).mockResolvedValue(
            undefined as never
        );

        const coordinator = {
            waitForInitialization: vi.fn().mockImplementation(
                () =>
                    new Promise((resolve) => {
                        setTimeout(() => resolve({}), 1_500);
                    })
            ),
        };

        try {
            const { runHeadlessFromEnv } =
                await import('../eval/headlessEntry');
            const runPromise = runHeadlessFromEnv(coordinator as never);

            await vi.advanceTimersByTimeAsync(999);
            expect(fs.existsSync(sentinelPath)).toBe(false);

            await vi.advanceTimersByTimeAsync(1);
            await runPromise;
        } finally {
            vi.useRealTimers();
        }

        const sentinel = JSON.parse(fs.readFileSync(sentinelPath, 'utf8'));
        expect(sentinel.exitCode).toBe(1);
        expect(sentinel.error).toContain(
            'Headless run exceeded timeout (1000ms) before initialization completed.'
        );
        expect(vscode.lm.selectChatModels).not.toHaveBeenCalled();
    });

    it('times out while runHeadless is still pending', async () => {
        vi.useFakeTimers();
        const args = {
            workspace: '/ws',
            base: 'main',
            head: 'feature/x',
            model: 'copilot/gpt-4.1',
            seed: 42,
            timeoutMs: 1_000,
            out: outPath,
            silent: true,
        };
        process.env.LUPA_HEADLESS_MODE = '1';
        process.env.LUPA_HEADLESS_ARGS = JSON.stringify(args);
        process.env.LUPA_HEADLESS_SENTINEL = sentinelPath;

        const vscode = await import('vscode');
        const { runHeadless } = await import('../eval/headlessRunner');
        let analysisStarted = false;

        vi.mocked(vscode.lm.selectChatModels).mockResolvedValue([
            {
                id: 'gpt-4.1',
                name: 'GPT-4.1',
                family: 'gpt-4',
                vendor: 'copilot',
                maxInputTokens: 128000,
            } as unknown as import('vscode').LanguageModelChat,
        ]);
        vi.mocked(vscode.commands.executeCommand).mockResolvedValue(
            undefined as never
        );
        vi.mocked(runHeadless).mockImplementation(() => {
            analysisStarted = true;
            return new Promise(() => {}) as never;
        });

        const coordinator = {
            waitForInitialization: vi.fn().mockResolvedValue({}),
        };

        try {
            const { runHeadlessFromEnv } =
                await import('../eval/headlessEntry');
            const runPromise = runHeadlessFromEnv(coordinator as never);

            const elapsedBeforeAnalysis = await advanceFakeTimersUntil(
                () => analysisStarted,
                'runHeadless did not start before advancing fake timers.',
                50
            );

            await vi.advanceTimersByTimeAsync(
                args.timeoutMs - elapsedBeforeAnalysis - 1
            );
            expect(fs.existsSync(sentinelPath)).toBe(false);

            await vi.advanceTimersByTimeAsync(1);
            await runPromise;
        } finally {
            vi.useRealTimers();
        }

        const sentinel = JSON.parse(fs.readFileSync(sentinelPath, 'utf8'));
        expect(sentinel.exitCode).toBe(1);
        expect(sentinel.error).toContain(
            'Headless run exceeded timeout (1000ms) during analysis for main..feature/x.'
        );
        expect(runHeadless).toHaveBeenCalled();
    });

    it('times out while runHeadlessResolutionJudge is still pending', async () => {
        vi.useFakeTimers();
        const args = {
            mode: 'resolution-judge',
            workspace: '/ws',
            model: 'copilot/gpt-5-mini',
            payload: path.join(tmpDir, 'payload.json'),
            timeoutMs: 1_000,
            out: outPath,
            silent: true,
        };
        process.env.LUPA_HEADLESS_MODE = '1';
        process.env.LUPA_HEADLESS_ARGS = JSON.stringify(args);
        process.env.LUPA_HEADLESS_SENTINEL = sentinelPath;

        const vscode = await import('vscode');
        const { runHeadlessResolutionJudge } =
            await import('../eval/headlessJudge');
        let judgeStarted = false;

        vi.mocked(vscode.lm.selectChatModels).mockResolvedValue([
            {
                id: 'gpt-5-mini',
                name: 'GPT-5 mini',
                family: 'gpt-5',
                vendor: 'copilot',
                maxInputTokens: 128000,
            } as unknown as import('vscode').LanguageModelChat,
        ]);
        vi.mocked(vscode.commands.executeCommand).mockResolvedValue(
            undefined as never
        );
        vi.mocked(runHeadlessResolutionJudge).mockImplementation(() => {
            judgeStarted = true;
            return new Promise(() => {}) as never;
        });

        const coordinator = {
            waitForInitialization: vi.fn().mockResolvedValue({}),
        };

        try {
            const { runHeadlessFromEnv } =
                await import('../eval/headlessEntry');
            const runPromise = runHeadlessFromEnv(coordinator as never);

            const elapsedBeforeJudge = await advanceFakeTimersUntil(
                () => judgeStarted,
                'runHeadlessResolutionJudge did not start before advancing fake timers.',
                50
            );

            await vi.advanceTimersByTimeAsync(
                args.timeoutMs - elapsedBeforeJudge - 1
            );
            expect(fs.existsSync(sentinelPath)).toBe(false);

            await vi.advanceTimersByTimeAsync(1);
            await runPromise;
        } finally {
            vi.useRealTimers();
        }

        const sentinel = JSON.parse(fs.readFileSync(sentinelPath, 'utf8'));
        expect(sentinel.exitCode).toBe(1);
        expect(sentinel.error).toContain(
            'Headless run exceeded timeout (1000ms) during resolution judging.'
        );
        expect(runHeadlessResolutionJudge).toHaveBeenCalled();
    });

    it('rejects base refs starting with -', async () => {
        const sentinel = await runWithRawArgs(
            JSON.stringify({
                workspace: '/ws',
                base: '--force',
                head: 'feature/x',
                model: 'copilot/gpt-4.1',
                timeoutMs: 60_000,
            })
        );
        expect(sentinel.exitCode).toBe(1);
        expect(sentinel.error).toContain('base');
        expect(sentinel.error).toContain("starts with '-'");
    });

    it('rejects head refs starting with -', async () => {
        const sentinel = await runWithRawArgs(
            JSON.stringify({
                workspace: '/ws',
                base: 'main',
                head: '-malicious',
                model: 'copilot/gpt-4.1',
                timeoutMs: 60_000,
            })
        );
        expect(sentinel.exitCode).toBe(1);
        expect(sentinel.error).toContain('head');
        expect(sentinel.error).toContain("starts with '-'");
    });

    it('rejects sha: refs with invalid SHA format', async () => {
        const sentinel = await runWithRawArgs(
            JSON.stringify({
                workspace: '/ws',
                base: 'sha:12345678901234567890123456789012345678901',
                head: 'feature/x',
                model: 'copilot/gpt-4.1',
                timeoutMs: 60_000,
            })
        );
        expect(sentinel.exitCode).toBe(1);
        expect(sentinel.error).toContain('base');
        expect(sentinel.error).toContain('invalid SHA format');
    });
});

describe('assertSafeFilePath', () => {
    it('rejects relative paths', async () => {
        const { assertSafeFilePath } = await import('../eval/headlessEntry');
        expect(() =>
            assertSafeFilePath('sentinel.json', 'sentinelPath', [
                '/workspace',
                '/tmp',
            ])
        ).toThrow('sentinelPath must be an absolute path, got: sentinel.json');
    });

    it('rejects paths containing .. segments', async () => {
        const { assertSafeFilePath } = await import('../eval/headlessEntry');
        const malicious =
            path.sep === '\\' ? '\\tmp\\..\\etc\\passwd' : '/tmp/../etc/passwd';
        expect(() =>
            assertSafeFilePath(malicious, 'args.out', ['/workspace', '/tmp'])
        ).toThrow(`args.out contains forbidden '..' segment: ${malicious}`);
    });

    it('rejects paths outside allowed roots', async () => {
        const { assertSafeFilePath } = await import('../eval/headlessEntry');
        const outsidePath = path.join('/', 'etc', 'passwd');
        expect(() =>
            assertSafeFilePath(outsidePath, 'args.out', ['/workspace', '/tmp'])
        ).toThrow(
            `args.out must be within allowed directories (/workspace, /tmp), got: ${outsidePath}`
        );
    });
});

// Regression for round-3 review blocker: ServiceManager.initializeFoundationServices
// invokes gitOperations.initialize() on extension activation, BEFORE the headless
// runner gets a chance to pass { persist: false } in diffResolver. Without a guard
// at this seam the auto-selected repository path is written to the analyzed repo's
// .vscode/lupa.json.
describe('ServiceManager foundation init — headless persistence guard', () => {
    const originalHeadless = process.env.LUPA_HEADLESS_MODE;

    beforeEach(() => {
        vi.resetModules();
    });

    afterEach(() => {
        if (originalHeadless === undefined) {
            delete process.env.LUPA_HEADLESS_MODE;
        } else {
            process.env.LUPA_HEADLESS_MODE = originalHeadless;
        }
    });

    async function runFoundationPhase(): Promise<{
        initSpy: ReturnType<typeof vi.fn>;
    }> {
        const initSpy = vi.fn().mockResolvedValue(true);

        // Vitest 4 requires 'function' syntax for constructor mocks used
        // with `new` — arrow callbacks are rejected with a warning and yield
        // an undefined instance.
        vi.doMock('../services/gitOperationsManager', () => ({
            GitOperationsManager: vi.fn(function (
                this: Record<string, unknown>
            ) {
                this.initialize = initSpy;
                this.getRepository = () => undefined;
                this.dispose = vi.fn();
            }),
        }));
        vi.doMock('../services/workspaceSettingsService', () => ({
            WorkspaceSettingsService: vi.fn(function (
                this: Record<string, unknown>
            ) {
                this.setSelectedRepositoryPath = vi.fn();
                this.getSelectedRepositoryPath = () => undefined;
                this.dispose = vi.fn();
            }),
        }));
        vi.doMock('../services/uiManager', () => ({
            UIManager: vi.fn(function (this: Record<string, unknown>) {
                this.dispose = vi.fn();
            }),
        }));
        vi.doMock('../services/loggingService', () => ({
            LoggingService: {
                getInstance: () => ({
                    initialize: vi.fn(),
                    dispose: vi.fn(),
                }),
            },
            Log: {
                info: vi.fn(),
                warn: vi.fn(),
                error: vi.fn(),
                debug: vi.fn(),
            },
        }));
        vi.doMock('../services/statusBarService', () => ({
            StatusBarService: {
                getInstance: () => ({ dispose: vi.fn() }),
            },
        }));

        const { ServiceManager } = await import('../services/serviceManager');
        const sm = new ServiceManager({ subscriptions: [] } as never);
        // Phases 2/3 aren't mocked; we only need Phase 1 behavior. Swallow
        // any downstream error so the assertion below still runs.
        await sm.initialize().catch(() => {});
        return { initSpy };
    }

    // Coverage split: this test pins the ServiceManager → GitOperationsManager
    // seam (the option is threaded correctly). The downstream contract that
    // { persist: false } actually skips the setSelectedRepositoryPath write
    // is pinned in gitServiceGetDefaultBranch.test.ts.
    it('passes { persist: false } when LUPA_HEADLESS_MODE=1', async () => {
        process.env.LUPA_HEADLESS_MODE = '1';
        const { initSpy } = await runFoundationPhase();
        expect(initSpy).toHaveBeenCalledWith({ persist: false });
    });

    it('passes { persist: true } when LUPA_HEADLESS_MODE is not set', async () => {
        delete process.env.LUPA_HEADLESS_MODE;
        const { initSpy } = await runFoundationPhase();
        expect(initSpy).toHaveBeenCalledWith({ persist: true });
    });
});
