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

const services = {} as IServiceRegistry;

describe('resolveDiff', () => {
    beforeEach(() => {
        spawnMock.mockReset();
    });

    it('throws when baseRef is a dir: path but headRef is a git ref', async () => {
        await expect(
            resolveDiff(
                { workspaceRoot: '/w', baseRef: 'dir:/a', headRef: 'main' },
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
        expect(args).toEqual(['diff', 'abc', 'def']);
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
            'main',
            'feature',
        ]);
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
                baseRef: 'dir:/w/base',
                headRef: 'dir:/w/head',
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

            await vi.advanceTimersByTimeAsync(250);

            await expect(promise).rejects.toThrow(/timed out after 250ms/);
            expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
        } finally {
            vi.useRealTimers();
        }
    });
});
