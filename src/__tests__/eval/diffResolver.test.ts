import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as child_process from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as vscode from 'vscode';
import { resolveDiff } from '../../eval/diffResolver';
import type { IServiceRegistry } from '../../services/serviceManager';

vi.mock('vscode');

vi.mock('node:child_process', async () => {
    const actual =
        await vi.importActual<typeof import('node:child_process')>(
            'node:child_process'
        );
    return { ...actual, spawn: vi.fn() };
});

const spawnMock = vi.mocked(child_process.spawn);

type MockChildProcess = EventEmitter & child_process.ChildProcess;

interface FakeGitRun {
    stdout: string;
    stderr?: string;
    exitCode: number;
}

function mockGitRun({ stdout, stderr = '', exitCode }: FakeGitRun): void {
    spawnMock.mockImplementationOnce(
        (
            _command: string,
            args?: readonly string[],
            _options?: unknown
        ): child_process.ChildProcess => {
            // Keep the args accessible for assertions without needing a
            // dedicated spy by piggybacking on spawnMock's call log.
            void args;
            const proc = new EventEmitter() as unknown as MockChildProcess;
            proc.stdout = new EventEmitter() as never;
            proc.stderr = new EventEmitter() as never;
            proc.kill = vi.fn().mockReturnValue(true) as never;
            queueMicrotask(() => {
                proc.stdout!.emit('data', Buffer.from(stdout));
                if (stderr) {
                    proc.stderr!.emit('data', Buffer.from(stderr));
                }
                proc.emit('close', exitCode);
            });
            return proc;
        }
    );
}

const services = {
    workspaceSettings: {} as any,
    logging: {} as any,
    statusBar: {} as any,
    copilotModelManager: {} as any,
    promptGenerator: {} as any,
    uiManager: {} as any,
    gitOperations: {} as any,
    toolTestingWebview: {} as any,
    chatParticipantService: {} as any,
    symbolExtractor: {} as any,
    lspValidation: {} as any,
    diffEnricher: {} as any,
    findingValidator: {} as any,
    toolRegistry: {} as any,
    toolExecutor: {} as any,
    conversationManager: {} as any,
    analysisEngine: {} as any,
    languageModelToolProvider: {} as any,
} as unknown as IServiceRegistry;

describe('resolveDiff', () => {
    beforeEach(() => {
        spawnMock.mockReset();
    });

    it('throws when baseRef is a dir: path but headRef is a git ref', async () => {
        await expect(
            resolveDiff(
                { workspaceRoot: '/w', baseRef: 'dir:a', headRef: 'main' },
                services
            )
        ).rejects.toThrow(
            /both be directory paths \(dir:\) or both be git refs/
        );
    });

    it('strips sha: prefix before invoking git diff', async () => {
        mockGitRun({ stdout: 'RAW_DIFF', exitCode: 1 });

        const diff = await resolveDiff(
            { workspaceRoot: '/w', baseRef: 'sha:abc', headRef: 'sha:def' },
            services
        );

        expect(diff).toBe('RAW_DIFF');
        const [cmd, args, opts] = spawnMock.mock.calls[0]!;
        expect(cmd).toBe('git');
        expect(args).toEqual(['diff', '--no-ext-diff', 'abc', 'def']);
        expect((opts as { cwd: string }).cwd).toBe('/w');
    });

    it('passes plain refs through unchanged', async () => {
        mockGitRun({ stdout: 'ABC_DIFF', exitCode: 1 });

        await resolveDiff(
            { workspaceRoot: '/w', baseRef: 'main', headRef: 'feature' },
            services
        );

        expect(spawnMock.mock.calls[0]![1]).toEqual([
            'diff',
            '--no-ext-diff',
            'main',
            'feature',
        ]);
    });

    it('rejects refs starting with "-" to prevent argument injection', async () => {
        await expect(
            resolveDiff(
                {
                    workspaceRoot: '/w',
                    baseRef: '--output=/evil',
                    headRef: 'main',
                },
                services
            )
        ).rejects.toThrow(/baseRef: starts with '-'/);

        await expect(
            resolveDiff(
                { workspaceRoot: '/w', baseRef: 'main', headRef: '-c' },
                services
            )
        ).rejects.toThrow(/headRef: starts with '-'/);
    });

    it('rejects sha:-prefixed refs whose body starts with "-"', async () => {
        await expect(
            resolveDiff(
                {
                    workspaceRoot: '/w',
                    baseRef: 'sha:--evil',
                    headRef: 'sha:abc',
                },
                services
            )
        ).rejects.toThrow(/baseRef: starts with '-'/);
    });

    it('rejects empty sha: refs', async () => {
        await expect(
            resolveDiff(
                {
                    workspaceRoot: '/w',
                    baseRef: 'sha:',
                    headRef: 'sha:abc',
                },
                services
            )
        ).rejects.toThrow(/baseRef: empty body after scheme — got 'sha:'/);
    });

    it('surfaces git errors', async () => {
        mockGitRun({ stdout: '', stderr: 'unknown revision', exitCode: 128 });

        await expect(
            resolveDiff(
                { workspaceRoot: '/w', baseRef: 'main', headRef: 'dev' },
                services
            )
        ).rejects.toThrow(/unknown revision/);
    });

    it('strips base/head prefixes and rewrites diff headers for dir: mode', async () => {
        const raw =
            'diff --git a/base/src/x.ts b/head/src/x.ts\n' +
            'index 111..222 100644\n' +
            '--- a/base/src/x.ts\n' +
            '+++ b/head/src/x.ts\n' +
            '@@ -1 +1 @@\n' +
            '-old\n' +
            '+new\n';
        mockGitRun({ stdout: raw, exitCode: 1 });

        const diff = await resolveDiff(
            {
                workspaceRoot: '/w',
                baseRef: 'dir:base',
                headRef: 'dir:head',
            },
            services
        );

        expect(diff).toContain('diff --git a/src/x.ts b/src/x.ts');
        expect(diff).toContain('--- a/src/x.ts');
        expect(diff).toContain('+++ b/src/x.ts');
        expect(diff).not.toContain('base/');
        expect(diff).not.toContain('head/');
        const args = spawnMock.mock.calls[0]![1]!;
        expect(args).toEqual(['diff', '--no-index', '--', 'base', 'head']);
    });

    it('rewrites dir: diff headers correctly when fixture paths contain spaces', async () => {
        const raw =
            'diff --git a/base dir/src/file with spaces.ts b/head dir/src/file with spaces.ts\n' +
            'index 111..222 100644\n' +
            '--- a/base dir/src/file with spaces.ts\n' +
            '+++ b/head dir/src/file with spaces.ts\n' +
            '@@ -1 +1 @@\n' +
            '-old\n' +
            '+new\n';
        mockGitRun({ stdout: raw, exitCode: 1 });

        const diff = await resolveDiff(
            {
                workspaceRoot: '/w',
                baseRef: 'dir:base dir',
                headRef: 'dir:head dir',
            },
            services
        );

        expect(diff).toContain(
            'diff --git a/src/file with spaces.ts b/src/file with spaces.ts'
        );
        expect(diff).toContain('--- a/src/file with spaces.ts');
        expect(diff).toContain('+++ b/src/file with spaces.ts');
        expect(diff).not.toContain('base dir/');
        expect(diff).not.toContain('head dir/');
        expect(spawnMock.mock.calls[0]![1]).toEqual([
            'diff',
            '--no-index',
            '--',
            'base dir',
            'head dir',
        ]);
    });

    it('normalizes real add-only no-index headers that repeat the head path on both sides', async () => {
        const raw =
            'diff --git a/head/src/new.ts b/head/src/new.ts\n' +
            'new file mode 100644\n' +
            '--- /dev/null\n' +
            '+++ b/head/src/new.ts\n' +
            '@@ -0,0 +1 @@\n' +
            '+new\n';
        mockGitRun({ stdout: raw, exitCode: 1 });

        const diff = await resolveDiff(
            {
                workspaceRoot: '/w',
                baseRef: 'dir:base',
                headRef: 'dir:head',
            },
            services
        );

        expect(diff).toContain('diff --git a/dev/null b/src/new.ts');
        expect(diff).toContain('--- /dev/null');
        expect(diff).toContain('+++ b/src/new.ts');
        expect(diff).not.toContain('head/');
    });

    it('normalizes real delete-only no-index headers that repeat the base path on both sides', async () => {
        const raw =
            'diff --git a/base/src/old.ts b/base/src/old.ts\n' +
            'deleted file mode 100644\n' +
            '--- a/base/src/old.ts\n' +
            '+++ /dev/null\n' +
            '@@ -1 +0,0 @@\n' +
            '-old\n';
        mockGitRun({ stdout: raw, exitCode: 1 });

        const diff = await resolveDiff(
            {
                workspaceRoot: '/w',
                baseRef: 'dir:base',
                headRef: 'dir:head',
            },
            services
        );

        expect(diff).toContain('diff --git a/src/old.ts b/dev/null');
        expect(diff).toContain('--- a/src/old.ts');
        expect(diff).toContain('+++ /dev/null');
        expect(diff).not.toContain('base/');
    });

    it('kills the git process when cancellation is requested', async () => {
        const proc = new EventEmitter() as unknown as MockChildProcess;
        proc.stdout = new EventEmitter() as never;
        proc.stderr = new EventEmitter() as never;
        proc.kill = vi.fn().mockReturnValue(true) as never;
        spawnMock.mockImplementationOnce(() => proc);

        const tokenSource = new vscode.CancellationTokenSource();
        const promise = resolveDiff(
            {
                workspaceRoot: '/w',
                baseRef: 'main',
                headRef: 'feature',
                cancellationToken: tokenSource.token,
            },
            services
        );

        tokenSource.cancel();

        await expect(promise).rejects.toBeInstanceOf(vscode.CancellationError);
        expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('kills the git process when diff resolution times out', async () => {
        vi.useFakeTimers();
        try {
            const proc = new EventEmitter() as unknown as MockChildProcess;
            proc.stdout = new EventEmitter() as never;
            proc.stderr = new EventEmitter() as never;
            proc.kill = vi.fn().mockReturnValue(true) as never;
            spawnMock.mockImplementationOnce(() => proc);

            const promise = resolveDiff(
                {
                    workspaceRoot: '/w',
                    baseRef: 'main',
                    headRef: 'feature',
                    timeoutMs: 250,
                },
                services
            );

            const rejectionAssertion = expect(promise).rejects.toThrow(
                /timed out after 250ms/
            );
            await vi.advanceTimersByTimeAsync(250);
            await rejectionAssertion;
            expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps retrying SIGKILL until a timed-out git child finally closes', async () => {
        vi.useFakeTimers();
        try {
            const proc = new EventEmitter() as unknown as MockChildProcess;
            proc.stdout = new EventEmitter() as never;
            proc.stderr = new EventEmitter() as never;
            const killSpy = vi.fn().mockReturnValue(true);
            proc.kill = killSpy as never;
            spawnMock.mockImplementationOnce(() => proc);

            const promise = resolveDiff(
                {
                    workspaceRoot: '/w',
                    baseRef: 'main',
                    headRef: 'feature',
                    timeoutMs: 250,
                },
                services
            );

            const rejectionAssertion = expect(promise).rejects.toThrow(
                /timed out after 250ms/
            );
            await vi.advanceTimersByTimeAsync(250);
            await rejectionAssertion;
            expect(proc.kill).toHaveBeenCalledWith('SIGKILL');

            await vi.advanceTimersByTimeAsync(5_000);
            expect(killSpy.mock.calls.length).toBeGreaterThan(1);

            const callCountAfterRetries = killSpy.mock.calls.length;
            proc.emit('close', 1);

            await vi.advanceTimersByTimeAsync(5_000);
            expect(killSpy.mock.calls).toHaveLength(callCountAfterRetries);
        } finally {
            vi.useRealTimers();
        }
    });

    it('rejects empty plain refs', async () => {
        await expect(
            resolveDiff(
                { workspaceRoot: '/w', baseRef: '', headRef: 'main' },
                services
            )
        ).rejects.toThrow(/baseRef: must be a non-empty string/);
    });

    it('rejects dir: refs that escape the workspace', async () => {
        await expect(
            resolveDiff(
                {
                    workspaceRoot: '/w',
                    baseRef: 'dir:base/../../etc',
                    headRef: 'dir:head',
                },
                services
            )
        ).rejects.toThrow(/dir: paths must not escape the workspace/);
    });
});
