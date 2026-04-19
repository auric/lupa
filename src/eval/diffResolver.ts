import * as child_process from 'node:child_process';
import { GitService } from '../services/gitService';
import type { IServiceRegistry } from '../services/serviceManager';
import { getErrorMessage } from '../utils/errorUtils';

const DIR_REF_PREFIX = 'dir:';
const SHA_REF_PREFIX = 'sha:';

export interface DiffResolveOptions {
    workspaceRoot: string;
    baseRef: string;
    headRef: string;
}

/**
 * Resolve a raw unified diff between baseRef and headRef.
 *
 * Accepts three ref styles:
 *  - `dir:<path>` — filesystem directory (uses `git diff --no-index`)
 *  - `sha:<sha>` — explicit git SHA (prefix stripped)
 *  - plain ref — any git ref (branch, tag, SHA)
 *
 * Both refs must be the same style (both `dir:` or both git refs).
 */
export async function resolveDiff(
    opts: DiffResolveOptions,
    services: IServiceRegistry
): Promise<string> {
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
            opts.headRef.slice(DIR_REF_PREFIX.length)
        );
    }

    // persist: false — don't persist the auto-selected repository path into
    // the target workspace's .vscode/lupa.json (treat the analyzed repo as
    // read-only), mirroring the selectModel({ persist: false }) pattern.
    const gitAvailable = await services.gitOperations.initialize({
        persist: false,
    });
    if (!gitAvailable) {
        throw new Error(
            `Git extension unavailable for workspace ${opts.workspaceRoot}`
        );
    }
    const base = stripShaPrefix(opts.baseRef);
    const compare = stripShaPrefix(opts.headRef);
    const { diffText, error } = await GitService.getInstance().compareBranches({
        base,
        compare,
    });
    if (error) {
        throw new Error(`Failed to compare ${base}..${compare}: ${error}`);
    }
    return diffText;
}

function stripShaPrefix(ref: string): string {
    return ref.startsWith(SHA_REF_PREFIX)
        ? ref.slice(SHA_REF_PREFIX.length)
        : ref;
}

function runGitDiffNoIndex(
    cwd: string,
    basePath: string,
    headPath: string
): Promise<string> {
    return new Promise((resolve, reject) => {
        const proc = child_process.spawn(
            'git',
            ['diff', '--no-index', '--', basePath, headPath],
            { cwd }
        );
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (d) => (stdout += d.toString()));
        proc.stderr.on('data', (d) => (stderr += d.toString()));
        proc.on('error', reject);
        // `git diff --no-index` exits 1 when differences are found; treat
        // 0 and 1 as success, anything else as a real failure.
        proc.on('close', (code) => {
            if (code === 0 || code === 1) {
                resolve(stdout);
            } else {
                reject(
                    new Error(
                        `git diff --no-index failed (${code}): ${stderr || getErrorMessage(stdout)}`
                    )
                );
            }
        });
    });
}
