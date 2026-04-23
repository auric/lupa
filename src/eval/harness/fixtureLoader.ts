import path from 'node:path';
import fs from 'node:fs/promises';
import {
    FINDING_SEVERITIES,
    ALLOWED_FINDING_CATEGORIES,
    type FindingSeverity,
    type FindingCategory,
} from '../../types/findingTypes';
import {
    FIXTURE_LABELS_FILENAME,
    KIND_A_BASE_DIR,
    KIND_A_HEAD_DIR,
    REAL_ROOT,
    SYNTHETIC_ROOT,
} from './constants';
import { ensureCachedRepo } from './cloneCache';
import type {
    ExpectedFinding,
    FixtureKind,
    FixtureLabels,
    LoadedFixture,
    RealFixtureFile,
} from './types';

export async function loadFixtures(opts: {
    kinds: FixtureKind[];
    only?: string[];
}): Promise<LoadedFixture[]> {
    const onlySet =
        opts.only && opts.only.length > 0 ? new Set(opts.only) : null;
    const out: LoadedFixture[] = [];

    if (opts.kinds.includes('synthetic') && (await dirExists(SYNTHETIC_ROOT))) {
        const entries = await fs.readdir(SYNTHETIC_ROOT, {
            withFileTypes: true,
        });
        const names = entries
            .filter((e) => e.isDirectory())
            .map((e) => e.name)
            .sort();
        for (const name of names) {
            if (onlySet && !onlySet.has(name)) {
                continue;
            }
            const fixtureDir = path.resolve(SYNTHETIC_ROOT, name);
            const baseDir = path.resolve(fixtureDir, KIND_A_BASE_DIR);
            const headDir = path.resolve(fixtureDir, KIND_A_HEAD_DIR);
            const labelsPath = path.resolve(
                fixtureDir,
                FIXTURE_LABELS_FILENAME
            );
            if (
                !(await dirExists(baseDir)) ||
                !(await dirExists(headDir)) ||
                !(await fileExists(labelsPath))
            ) {
                throw new Error(
                    `Synthetic fixture ${name} is incomplete: expected ${KIND_A_BASE_DIR}/, ${KIND_A_HEAD_DIR}/, and ${FIXTURE_LABELS_FILENAME} under ${fixtureDir}`
                );
            }
            const raw = await readJson(labelsPath);
            const labels = validateFixtureLabels(raw, labelsPath);
            out.push({
                name,
                kind: 'synthetic',
                labels,
                workspaceRoot: fixtureDir,
                baseRef: 'dir:' + baseDir,
                headRef: 'dir:' + headDir,
                mergeRef: undefined,
            });
        }
    }

    if (opts.kinds.includes('real') && (await dirExists(REAL_ROOT))) {
        const entries = await fs.readdir(REAL_ROOT, { withFileTypes: true });
        const files = entries
            .filter((e) => e.isFile() && e.name.endsWith('.json'))
            .map((e) => e.name)
            .sort();
        for (const fileName of files) {
            const name = path.basename(fileName, '.json');
            if (onlySet && !onlySet.has(name)) {
                continue;
            }
            const fullPath = path.resolve(REAL_ROOT, fileName);
            const raw = await readJson(fullPath);
            const labels = validateRealFixture(raw, fullPath);
            const effectiveMergeSha = labels.mergeSha ?? labels.headSha;
            const cacheDir = await ensureCachedRepo(labels.repo, [
                labels.baseSha,
                labels.headSha,
                effectiveMergeSha,
            ]);
            out.push({
                name,
                kind: 'real',
                labels: {
                    intent: labels.intent,
                    expected_findings: labels.expected_findings,
                    minFilesExamined: labels.minFilesExamined,
                    maxFalsePositivesTolerated:
                        labels.maxFalsePositivesTolerated,
                },
                workspaceRoot: cacheDir,
                baseRef: 'sha:' + labels.baseSha,
                headRef: 'sha:' + labels.headSha,
                mergeRef: 'sha:' + effectiveMergeSha,
            });
        }
    }

    return out;
}

export function validateFixtureLabels(
    obj: unknown,
    source: string
): FixtureLabels {
    if (!isObject(obj)) {
        throw new Error(`${source}: expected object at top level`);
    }
    const intent = obj['intent'];
    if (typeof intent !== 'string' || intent.length === 0) {
        throw new Error(`${source}: 'intent' must be a non-empty string`);
    }
    const expectedRaw = obj['expected_findings'];
    if (!Array.isArray(expectedRaw)) {
        throw new Error(`${source}: 'expected_findings' must be an array`);
    }
    const expected_findings: ExpectedFinding[] = expectedRaw.map((entry, idx) =>
        validateExpected(entry, `${source}#expected_findings[${idx}]`)
    );
    const minFilesExamined = obj['minFilesExamined'];
    if (!isNonNegativeInt(minFilesExamined)) {
        throw new Error(
            `${source}: 'minFilesExamined' must be a non-negative integer`
        );
    }
    const maxFalsePositivesTolerated = obj['maxFalsePositivesTolerated'];
    if (!isNonNegativeInt(maxFalsePositivesTolerated)) {
        throw new Error(
            `${source}: 'maxFalsePositivesTolerated' must be a non-negative integer`
        );
    }
    return {
        intent,
        expected_findings,
        minFilesExamined,
        maxFalsePositivesTolerated,
    };
}

function validateRealFixture(obj: unknown, source: string): RealFixtureFile {
    const base = validateFixtureLabels(obj, source);
    const o = obj as Record<string, unknown>;
    const repo = o['repo'];
    const baseSha = o['baseSha'];
    const headSha = o['headSha'];
    const mergeSha = o['mergeSha'];
    if (typeof repo !== 'string' || repo.length === 0) {
        throw new Error(`${source}: 'repo' must be a non-empty string`);
    }
    if (typeof baseSha !== 'string' || baseSha.length === 0) {
        throw new Error(`${source}: 'baseSha' must be a non-empty string`);
    }
    if (typeof headSha !== 'string' || headSha.length === 0) {
        throw new Error(`${source}: 'headSha' must be a non-empty string`);
    }
    if (
        mergeSha !== undefined &&
        (typeof mergeSha !== 'string' || mergeSha.length === 0)
    ) {
        throw new Error(
            `${source}: 'mergeSha' must be a non-empty string when provided`
        );
    }
    return { ...base, repo, baseSha, headSha, mergeSha };
}

function validateExpected(entry: unknown, source: string): ExpectedFinding {
    if (!isObject(entry)) {
        throw new Error(`${source}: expected object`);
    }
    const severity = entry['severity'];
    if (
        typeof severity !== 'string' ||
        !(FINDING_SEVERITIES as readonly string[]).includes(severity)
    ) {
        throw new Error(
            `${source}: 'severity' must be one of ${FINDING_SEVERITIES.join(', ')}`
        );
    }
    const category = entry['category'];
    if (
        typeof category !== 'string' ||
        !(ALLOWED_FINDING_CATEGORIES as readonly string[]).includes(category)
    ) {
        throw new Error(
            `${source}: 'category' must be one of ${ALLOWED_FINDING_CATEGORIES.join(', ')}`
        );
    }
    const p = entry['path'];
    if (typeof p !== 'string' || p.length === 0) {
        throw new Error(`${source}: 'path' must be a non-empty string`);
    }
    const lineHint = entry['lineHint'];
    if (!Number.isInteger(lineHint) || (lineHint as number) <= 0) {
        throw new Error(`${source}: 'lineHint' must be a positive integer`);
    }
    const mustMentionRaw = entry['mustMention'];
    const resolvedByDefault = entry['resolvedByDefault'];
    if (
        !Array.isArray(mustMentionRaw) ||
        !mustMentionRaw.every((m) => typeof m === 'string')
    ) {
        throw new Error(`${source}: 'mustMention' must be a string[]`);
    }
    if (
        resolvedByDefault !== undefined &&
        typeof resolvedByDefault !== 'boolean'
    ) {
        throw new Error(`${source}: 'resolvedByDefault' must be a boolean`);
    }
    return {
        severity: severity as FindingSeverity,
        category: category as FindingCategory,
        path: p,
        lineHint: lineHint as number,
        mustMention: mustMentionRaw as string[],
        resolvedByDefault:
            typeof resolvedByDefault === 'boolean'
                ? resolvedByDefault
                : undefined,
    };
}

function isObject(x: unknown): x is Record<string, unknown> {
    return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isNonNegativeInt(x: unknown): x is number {
    return typeof x === 'number' && Number.isInteger(x) && x >= 0;
}

async function readJson(p: string): Promise<unknown> {
    const txt = await fs.readFile(p, 'utf8');
    try {
        return JSON.parse(txt);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`${p}: invalid JSON (${msg})`);
    }
}

async function dirExists(p: string): Promise<boolean> {
    try {
        return (await fs.stat(p)).isDirectory();
    } catch {
        return false;
    }
}

async function fileExists(p: string): Promise<boolean> {
    try {
        return (await fs.stat(p)).isFile();
    } catch {
        return false;
    }
}
