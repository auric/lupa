import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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
        } catch {
            // best-effort cleanup; tmp files are harmless if left behind
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
            modelId: 'gpt-4.1',
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
            modelId: 'gpt-4.1',
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
            modelId: 'gpt-4.1',
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
            modelId: 'gpt-5-mini',
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
            modelId: 'gpt-5-mini',
        });
        expect(runHeadlessResolutionJudge).toHaveBeenCalledTimes(1);
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
    }, 15_000);

    it('passes { persist: true } when LUPA_HEADLESS_MODE is not set', async () => {
        delete process.env.LUPA_HEADLESS_MODE;
        const { initSpy } = await runFoundationPhase();
        expect(initSpy).toHaveBeenCalledWith({ persist: true });
    }, 15_000);
});
