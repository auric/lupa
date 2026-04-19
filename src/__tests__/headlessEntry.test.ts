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
            wasCancelled: false,
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
});
