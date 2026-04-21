import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { CACHE_ROOT } from './constants';

interface GitResult {
    stdout: string;
    stderr: string;
    code: number;
}

/**
 * Ensure a shallow blobless clone of `repo` exists under the harness cache
 * and that each SHA in `requiredShas` is reachable locally. No worktree is
 * checked out — `gitOperations.compareBranches` diffs by SHA directly.
 * Returns the absolute path of the cache directory.
 */
export async function ensureCachedRepo(
    repo: string,
    requiredShas: readonly string[]
): Promise<string> {
    const repoUrl = toRepoUrl(repo);
    const slug = toCacheSlug(repo);
    const cacheDir = path.join(CACHE_ROOT, slug);

    await fs.mkdir(CACHE_ROOT, { recursive: true });

    if (!(await dirExists(cacheDir))) {
        process.stderr.write(`[harness] cloning ${repo} into ${cacheDir}...\n`);
        const clone = await runGit(
            ['clone', '--filter=blob:none', '--no-checkout', repoUrl, cacheDir],
            process.cwd()
        );
        if (clone.code !== 0) {
            throw new Error(
                `git clone ${repoUrl} failed (exit ${clone.code}): ${clone.stderr.trim()}`
            );
        }
    }

    for (const sha of requiredShas) {
        const check = await runGit(
            ['cat-file', '-e', `${sha}^{commit}`],
            cacheDir
        );
        if (check.code === 0) {
            continue;
        }
        process.stderr.write(`[harness] fetching ${sha}...\n`);
        const fetch = await runGit(['fetch', 'origin', sha], cacheDir);
        if (fetch.code !== 0) {
            const unshallow = await runGit(['fetch', '--unshallow'], cacheDir);
            if (unshallow.code !== 0) {
                throw new Error(
                    `git fetch for ${sha} failed: ${fetch.stderr.trim()} | ${unshallow.stderr.trim()}`
                );
            }
            const recheck = await runGit(
                ['cat-file', '-e', `${sha}^{commit}`],
                cacheDir
            );
            if (recheck.code !== 0) {
                throw new Error(
                    `SHA ${sha} not reachable in ${cacheDir} after fetch`
                );
            }
        }
    }

    return cacheDir;
}

function toRepoUrl(repo: string): string {
    if (/^https?:\/\//.test(repo)) {
        return repo;
    }
    return `https://github.com/${repo}.git`;
}

function toCacheSlug(repo: string): string {
    return repo
        .replace(/^https?:\/\//, '')
        .replace(/\.git$/, '')
        .replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function dirExists(p: string): Promise<boolean> {
    try {
        const stat = await fs.stat(p);
        return stat.isDirectory();
    } catch {
        return false;
    }
}

function runGit(args: string[], cwd: string): Promise<GitResult> {
    return new Promise((resolve, reject) => {
        const proc = spawn('git', args, { cwd, stdio: 'pipe' });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (d) => (stdout += d.toString()));
        proc.stderr.on('data', (d) => (stderr += d.toString()));
        proc.on('error', reject);
        proc.on('close', (code) => {
            resolve({ stdout, stderr, code: code ?? 1 });
        });
    });
}
