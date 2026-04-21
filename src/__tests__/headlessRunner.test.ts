import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { runHeadless } from '../eval/headlessRunner';
import { createMockAnalysisEngineResult } from './testUtils/mockFactories';
import type { IServiceRegistry } from '../services/serviceManager';
import * as headlessArgs from '../../scripts/eval/headlessArgs';

vi.mock('vscode');

vi.mock('../eval/diffResolver', () => ({
    resolveDiff: vi.fn(),
}));
import { resolveDiff } from '../eval/diffResolver';

vi.mock('../services/loggingService', () => ({
    Log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}));

const SAMPLE_DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1234567..abcdefg 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 const x = 1;
+const y = 2;
 const z = 3;
`;

interface MakeServicesOptions {
    diffText?: string;
    analyzeResult?: ReturnType<typeof createMockAnalysisEngineResult>;
    analyzeSpy?: ReturnType<typeof vi.fn>;
    selectedModel?: {
        id: string;
        name: string;
        family: string;
        vendor: string;
        maxInputTokens: number;
    };
}

function makeServices(options: MakeServicesOptions): IServiceRegistry {
    const analyze =
        options.analyzeSpy ??
        vi
            .fn()
            .mockResolvedValue(
                options.analyzeResult ?? createMockAnalysisEngineResult()
            );
    return {
        gitOperations: {
            initialize: vi.fn().mockResolvedValue(true),
        },
        copilotModelManager: {
            selectModel: vi.fn().mockResolvedValue(
                options.selectedModel ?? {
                    id: 'gpt-4.1',
                    name: 'GPT-4.1',
                    family: 'gpt-4',
                    vendor: 'copilot',
                    maxInputTokens: 128000,
                }
            ),
        },
        analysisEngine: { analyze },
    } as unknown as IServiceRegistry;
}

describe('parseHeadlessArgs', () => {
    it('parses all flags with defaults', () => {
        const args = headlessArgs.parseHeadlessArgs([
            '--workspace',
            '/w',
            '--base',
            'main',
            '--head',
            'dev',
            '--model',
            'copilot/gpt-4.1',
        ]);
        expect(args).toMatchObject({
            mode: 'analysis',
            workspace: '/w',
            base: 'main',
            head: 'dev',
            model: 'copilot/gpt-4.1',
            seed: 0,
            silent: false,
            out: null,
        });
        expect(args.timeoutMs).toBeGreaterThan(0);
    });

    it('parses resolution-judge mode without analysis refs', () => {
        const args = headlessArgs.parseHeadlessArgs([
            '--mode',
            'resolution-judge',
            '--workspace',
            '/w',
            '--model',
            'copilot/gpt-5-mini',
            '--payload',
            '/tmp/payload.json',
        ]);
        expect(args).toMatchObject({
            mode: 'resolution-judge',
            workspace: '/w',
            model: 'copilot/gpt-5-mini',
            payload: '/tmp/payload.json',
        });
        expect(args).not.toHaveProperty('base', '/w');
    });

    it('requires --payload in resolution-judge mode', () => {
        expect(() =>
            headlessArgs.parseHeadlessArgs([
                '--mode',
                'resolution-judge',
                '--workspace',
                '/w',
                '--model',
                'copilot/gpt-5-mini',
            ])
        ).toThrow(/Missing required --payload/);
    });

    it('throws on missing required flag', () => {
        expect(() =>
            headlessArgs.parseHeadlessArgs(['--workspace', '/w'])
        ).toThrow(headlessArgs.HeadlessArgError);
    });

    it('throws on unknown flag', () => {
        expect(() => headlessArgs.parseHeadlessArgs(['--bogus', 'x'])).toThrow(
            /Unknown argument/
        );
    });

    it('throws on non-integer --seed', () => {
        expect(() =>
            headlessArgs.parseHeadlessArgs([
                '--workspace',
                '/w',
                '--base',
                'a',
                '--head',
                'b',
                '--model',
                'm',
                '--seed',
                'nope',
            ])
        ).toThrow(/must be an integer/);
    });

    it('rejects non-positive --timeout', () => {
        expect(() =>
            headlessArgs.parseHeadlessArgs([
                '--workspace',
                '/w',
                '--base',
                'a',
                '--head',
                'b',
                '--model',
                'm',
                '--timeout',
                '0',
            ])
        ).toThrow(/positive integer/);
    });
});

describe('runHeadless', () => {
    function baseOpts() {
        return {
            workspaceRoot: '/ws',
            baseRef: 'main',
            headRef: 'feature/x',
            modelIdentifier: 'copilot/gpt-4.1',
            seed: 42,
            timeoutMs: 60_000,
            cancellationToken: new vscode.CancellationTokenSource().token,
        };
    }

    it('returns a result matching the HeadlessAnalysisResult shape', async () => {
        vi.mocked(resolveDiff).mockResolvedValue(SAMPLE_DIFF);
        const services = makeServices({
            analyzeResult: createMockAnalysisEngineResult({
                analysisText: 'ok',
                iterationsUsed: 4,
                toolCallRecords: [
                    {
                        id: '1',
                        toolName: 'read_file',
                        arguments: {},
                        result: 'x',
                        success: true,
                        durationMs: 10,
                        timestamp: 0,
                    } as any,
                ],
                findings: [],
            }),
        });

        const result = await runHeadless(baseOpts(), services);

        expect(result.findings).toEqual([]);
        expect(result.narrative).toBe('ok');
        expect(result.modelId).toBe('gpt-4.1');
        expect(result.seed).toBe(42);
        expect(result.completed).toBe(true);
        expect(result.rawToolCallLog).toHaveLength(1);
        expect(result.telemetry).toMatchObject({
            iterations: 4,
            toolCalls: 1,
            promptTokens: 0,
            completionTokens: 0,
            compactionsUsed: 0,
        });
        expect(result.telemetry.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('throws when the engine reports an error', async () => {
        vi.mocked(resolveDiff).mockResolvedValue(SAMPLE_DIFF);
        const services = makeServices({
            analyzeResult: createMockAnalysisEngineResult({
                error: 'boom',
                completed: false,
            }),
        });
        await expect(runHeadless(baseOpts(), services)).rejects.toThrow(/boom/);
    });

    it('throws when the analysis is cancelled', async () => {
        vi.mocked(resolveDiff).mockResolvedValue(SAMPLE_DIFF);
        const services = makeServices({
            analyzeResult: createMockAnalysisEngineResult({
                wasCancelled: true,
                completed: false,
                error: undefined,
            }),
        });
        await expect(runHeadless(baseOpts(), services)).rejects.toThrow(
            /Analysis cancelled/
        );
    });

    it('returns the result as-is when the engine reports incomplete without error or cancellation', async () => {
        // runHeadless MUST stay pure on the incomplete-but-not-errored path
        // so that runHeadlessFromEnv can still write --out with the partial
        // result before surfacing the non-zero exit. See headlessEntry.ts.
        vi.mocked(resolveDiff).mockResolvedValue(SAMPLE_DIFF);
        const services = makeServices({
            analyzeResult: createMockAnalysisEngineResult({
                completed: false,
                wasCancelled: false,
                error: undefined,
                analysisText: 'partial',
                findings: [],
            }),
        });

        const result = await runHeadless(baseOpts(), services);

        expect(result.completed).toBe(false);
        expect(result.narrative).toBe('partial');
    });

    it('throws when no diff is produced', async () => {
        vi.mocked(resolveDiff).mockResolvedValue('   \n');
        const services = makeServices({});
        await expect(runHeadless(baseOpts(), services)).rejects.toThrow(
            /No diff produced/
        );
    });

    it('throws when the selected model identifier does not match the request', async () => {
        // Guards against CopilotModelManager's silent fallback to the first
        // available chat model — which on a Pro install can be a premium
        // model (Claude Sonnet, gpt-5) and consume paid quota.
        vi.mocked(resolveDiff).mockResolvedValue(SAMPLE_DIFF);
        const services = makeServices({
            selectedModel: {
                id: 'claude-sonnet-4',
                name: 'Claude Sonnet 4',
                family: 'claude-sonnet-4',
                vendor: 'copilot',
                maxInputTokens: 200000,
            },
        });
        await expect(runHeadless(baseOpts(), services)).rejects.toThrow(
            /not available.*fell back to 'copilot\/claude-sonnet-4'/
        );
    });

    it('does not invoke analysisEngine.analyze when the model mismatches', async () => {
        vi.mocked(resolveDiff).mockResolvedValue(SAMPLE_DIFF);
        const analyzeSpy = vi.fn();
        const services = makeServices({
            analyzeSpy,
            selectedModel: {
                id: 'gpt-5',
                name: 'GPT-5',
                family: 'gpt-5',
                vendor: 'copilot',
                maxInputTokens: 200000,
            },
        });
        await expect(runHeadless(baseOpts(), services)).rejects.toThrow();
        expect(analyzeSpy).not.toHaveBeenCalled();
    });

    it('invokes analysisEngine.analyze with the shared input shape', async () => {
        vi.mocked(resolveDiff).mockResolvedValue(SAMPLE_DIFF);
        const analyzeSpy = vi
            .fn()
            .mockResolvedValue(createMockAnalysisEngineResult());
        const services = makeServices({ analyzeSpy });

        await runHeadless(baseOpts(), services);

        expect(analyzeSpy).toHaveBeenCalledTimes(1);
        const [input, output] = analyzeSpy.mock.calls[0];
        // Architectural reuse: headless MUST pass exactly the same input
        // keys as the webview and chat entry points (AnalysisEngineInput).
        expect(Object.keys(input).sort()).toEqual(
            [
                'chatHandler',
                'llmClient',
                'model',
                'parsedDiff',
                'token',
                'userPromptSuffix',
            ].sort()
        );
        expect(input.llmClient).toBe(services.copilotModelManager);
        expect(input.model).toMatchObject({
            family: 'gpt-4',
            id: 'gpt-4.1',
            maxInputTokens: 128000,
        });
        expect(input.chatHandler).toBeUndefined();
        expect(input.userPromptSuffix).toBeUndefined();
        expect(typeof output.onProgress).toBe('function');
    });

    it('throws when the requested model is unavailable and a fallback is selected', async () => {
        // See the model-mismatch tests above: the headless path must refuse
        // to run on any model other than the requested one.
        vi.mocked(resolveDiff).mockResolvedValue(SAMPLE_DIFF);
        const services = makeServices({
            selectedModel: {
                id: 'gpt-4o-mini',
                name: 'GPT-4o mini',
                family: 'gpt-4o',
                vendor: 'copilot',
                maxInputTokens: 64000,
            },
        });

        await expect(runHeadless(baseOpts(), services)).rejects.toThrow(
            /copilot\/gpt-4\.1.*copilot\/gpt-4o-mini/
        );
    });
});

describe('headlessRunner architectural reuse', () => {
    it('does not import prompt assembly or tool registration modules', () => {
        const source = fs.readFileSync(
            path.resolve(__dirname, '../eval/headlessRunner.ts'),
            'utf8'
        );
        // Quest 8.3 forbids duplicating prompt assembly, tool registration,
        // or post-analysis pipeline in the headless runner. All of those
        // must flow through AnalysisEngine.analyze().
        expect(source).not.toMatch(/from ['"]\.\.\/prompts\//);
        expect(source).not.toMatch(/from ['"]\.\.\/tools\//);
        expect(source).not.toMatch(/postAnalysisPipeline/i);
        expect(source).not.toMatch(/toolRegistry/i);
        expect(source).not.toMatch(/promptGenerator/i);
        // It MUST go through the shared AnalysisEngine seam.
        expect(source).toMatch(/analysisEngine\.analyze\(/);
    });
});
