import * as child_process from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { IServiceRegistry } from '../services/serviceManager';
import { getErrorMessage } from '../utils/errorUtils';

const DIR_REF_PREFIX = 'dir:';
const SHA_REF_PREFIX = 'sha:';

export interface DiffResolveOptions {
    workspaceRoot: string;
    baseRef: string;
    headRef: string;
    timeoutMs?: number;
    cancellationToken?: vscode.CancellationToken;
}

const DEFAULT_DIFF_TIMEOUT_MS = 30_000;

/**
 * Resolve a raw unified diff between baseRef and headRef.
 *
 * Accepts three ref styles:
 *  - `dir:<path>` — filesystem directory (uses `git diff --no-index`)
 *  - `sha:<sha>` — explicit git SHA (prefix stripped)
 *  - plain ref — any git ref (branch, tag, SHA)
 *
 * Both refs must be the same style (both `dir:` or both git refs).
 *
 * Uses the `git` CLI directly in both modes rather than going through
 * `services.gitOperations`. The headless VS Code profile disables
 * `git.autoRepositoryDetection`, so vscode.git never registers the cache
 * directory as a repository and `gitOperations.initialize()` returns false
 * even when a perfectly valid .git exists on disk. The CLI path works
 * uniformly regardless of whether vscode.git knows about the repo.
 *
 * The `services` argument is retained for signature stability; it is
 * currently unused but kept to avoid churn in the caller.
 */
export async function resolveDiff(
    opts: DiffResolveOptions,
    _services: IServiceRegistry
): Promise<string> {
    if (opts.cancellationToken?.isCancellationRequested) {
        throw new vscode.CancellationError();
    }

    const baseIsDir = opts.baseRef.startsWith(DIR_REF_PREFIX);
    const headIsDir = opts.headRef.startsWith(DIR_REF_PREFIX);
    if (baseIsDir !== headIsDir) {
        throw new Error(
            'baseRef and headRef must both be directory paths (dir:) or both be git refs'
        );
    }

    if (baseIsDir && headIsDir) {
        return runGitDiffNoIndex(
            opts.workspaceRoot,
            opts.baseRef.slice(DIR_REF_PREFIX.length),
            opts.headRef.slice(DIR_REF_PREFIX.length),
            opts.timeoutMs ?? DEFAULT_DIFF_TIMEOUT_MS,
            opts.cancellationToken
        );
    }

    return runGitDiffRefs(
        opts.workspaceRoot,
        stripShaPrefix(opts.baseRef),
        stripShaPrefix(opts.headRef),
        opts.timeoutMs ?? DEFAULT_DIFF_TIMEOUT_MS,
        opts.cancellationToken
    );
}

function stripShaPrefix(ref: string): string {
    return ref.startsWith(SHA_REF_PREFIX)
        ? ref.slice(SHA_REF_PREFIX.length)
        : ref;
}

function spawnGit(
    cwd: string,
    args: string[],
    timeoutMs: number,
    cancellationToken?: vscode.CancellationToken
): Promise<string> {
    return new Promise((resolve, reject) => {
        const proc = child_process.spawn('git', args, { cwd });
        let stdout = '';
        let stderr = '';
        let settled = false;
        let cancellation: vscode.Disposable | undefined;
        const cleanup = () => {
            clearTimeout(timeoutHandle);
            cancellation?.dispose();
        };
        const timeoutHandle = setTimeout(() => {
            if (settled) {
                return;
            }
            settled = true;
            proc.kill('SIGKILL');
            cleanup();
            reject(
                new Error(
                    `git ${args.join(' ')} timed out after ${timeoutMs}ms`
                )
            );
        }, timeoutMs);

        cancellation = cancellationToken?.onCancellationRequested(() => {
            if (settled) {
                return;
            }
            settled = true;
            proc.kill('SIGKILL');
            cleanup();
            reject(new vscode.CancellationError());
        });
        proc.stdout.on('data', (d) => (stdout += d.toString()));
        proc.stderr.on('data', (d) => (stderr += d.toString()));
        proc.on('error', (error) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            reject(error);
        });
        // `git diff` exits 0 when the trees are identical, 1 when there are
        // differences, and anything else on real error. Treat 0 and 1 as
        // success so an empty-diff run doesn't fail the pipeline.
        proc.on('close', (code) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            if (code === 0 || code === 1) {
                resolve(stdout);
            } else {
                reject(
                    new Error(
                        `git ${args.join(' ')} failed (${code}): ${stderr || getErrorMessage(stdout)}`
                    )
                );
            }
        });
    });
}

/**
 * Compare two filesystem directories under `cwd`. The directories are
 * expected to live inside `cwd` (the Kind-A fixture layout is
 * `<fixture>/{base,head}`). Paths are converted to cwd-relative form
 * before being passed to git so header lines come back as
 * `diff --git a/base/... b/head/...` rather than the Windows-quoted
 * absolute-path form `diff --git "a/D:\..." "b/D:\..."` which `DiffUtils.
 * parseDiff`'s regex cannot match. The `base/`/`head/` fixture prefixes
 * are then stripped from header lines so produced findings carry
 * repository-relative paths matching the fixture's `expected.json`.
 */
async function runGitDiffNoIndex(
    cwd: string,
    basePath: string,
    headPath: string,
    timeoutMs: number,
    cancellationToken?: vscode.CancellationToken
): Promise<string> {
    const baseRel = toPosixRelative(cwd, basePath);
    const headRel = toPosixRelative(cwd, headPath);
    const stdout = await spawnGit(
        cwd,
        ['diff', '--no-index', '--', baseRel, headRel],
        timeoutMs,
        cancellationToken
    );
    return stripFixturePrefixes(stdout, baseRel, headRel);
}

async function runGitDiffRefs(
    cwd: string,
    base: string,
    compare: string,
    timeoutMs: number,
    cancellationToken?: vscode.CancellationToken
): Promise<string> {
    return spawnGit(cwd, ['diff', base, compare], timeoutMs, cancellationToken);
}

function toPosixRelative(cwd: string, target: string): string {
    const abs = path.isAbsolute(target) ? target : path.resolve(cwd, target);
    const rel = path.relative(cwd, abs);
    return rel.split(path.sep).join('/');
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripFixturePrefixes(
    diff: string,
    baseRel: string,
    headRel: string
): string {
    const b = escapeRegex(baseRel);
    const h = escapeRegex(headRel);
    return diff
        .replace(
            new RegExp(`^diff --git a/${b}/(\\S+) b/${h}/(\\S+)$`, 'gm'),
            'diff --git a/$1 b/$2'
        )
        .replace(new RegExp(`^--- a/${b}/`, 'gm'), '--- a/')
        .replace(new RegExp(`^\\+\\+\\+ b/${h}/`, 'gm'), '+++ b/');
}
