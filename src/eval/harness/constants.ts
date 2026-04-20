import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Walk up from this module's source location until a directory containing
 * `package.json` is found. Falls back to `process.cwd()` if none is found
 * within a reasonable number of hops.
 */
function resolveRepoRoot(): string {
    const hereFile = fileURLToPath(import.meta.url);
    let dir = path.dirname(hereFile);
    for (let i = 0; i < 12; i++) {
        if (fs.existsSync(path.join(dir, 'package.json'))) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            break;
        }
        dir = parent;
    }
    return process.cwd();
}

export const REPO_ROOT = resolveRepoRoot();

export const FIXTURES_ROOT = path.resolve(REPO_ROOT, 'eval', 'fixtures');
export const SYNTHETIC_ROOT = path.resolve(FIXTURES_ROOT, 'synthetic');
export const REAL_ROOT = path.resolve(FIXTURES_ROOT, 'real');

export const RESULTS_ROOT = path.resolve(REPO_ROOT, 'eval', 'results');
export const CACHE_ROOT = path.resolve(REPO_ROOT, 'eval', '.cache');

export const DEFAULT_SEEDS = 3;
export const DEFAULT_MODELS = [
    'copilot/gpt-4.1',
    'copilot/gpt-5-mini',
] as const;
export const DEFAULT_TIMEOUT_MS = 600_000;

export const LINE_HINT_TOLERANCE = 5;

export const LAUNCHER_SCRIPT = path.resolve(
    REPO_ROOT,
    'scripts/eval/launchHeadless.js'
);

export const FIXTURE_LABELS_FILENAME = 'expected.json';
export const KIND_A_BASE_DIR = 'base';
export const KIND_A_HEAD_DIR = 'head';
