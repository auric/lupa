import path from 'node:path';
import { spawn } from 'node:child_process';
import type {
    FindingSeverity,
    FindingSource,
    RecordedFinding,
} from '../../types/findingTypes';
import { DiffUtils } from '../../utils/diffUtils';
import type {
    ExpectedFinding,
    FindingResolution,
    LoadedFixture,
    MatchResult,
    ResolutionBucket,
    ResolutionJudgePayload,
    ResolutionJudgeResult,
    ResolutionMethod,
    ResolutionSummary,
    ResolutionWarning,
} from './types';

const GIT_DIFF_TIMEOUT_MS = 15_000;

export interface ResolutionJudgeClient {
    judge(payload: ResolutionJudgePayload): Promise<ResolutionJudgeResult>;
}

interface ClassifyResolutionOptions {
    fixture: LoadedFixture;
    produced: readonly RecordedFinding[];
    match: MatchResult;
    judgeClient?: ResolutionJudgeClient;
}

interface LineCheckResult {
    verdict: 'resolved' | 'unresolved' | 'ambiguous';
    method: ResolutionMethod;
    reason: string;
    diffText: string;
    path: string;
}

interface RenameStatusEntry {
    oldPath: string;
    newPath: string;
}

type ClassificationOutcome =
    | { kind: 'classified'; resolution: FindingResolution }
    | { kind: 'warning'; warning: ResolutionWarning };

export async function classifyResolutionForRun(
    opts: ClassifyResolutionOptions
): Promise<ResolutionSummary> {
    const matchedExpectedByFindingId = new Map<string, ExpectedFinding>();
    for (const pair of opts.match.matched) {
        matchedExpectedByFindingId.set(pair.produced.id, pair.expected);
    }

    const pathDiffCache = new Map<string, string>();
    const renameStatusCache = new Map<string, readonly RenameStatusEntry[]>();
    const findingResolutions: FindingResolution[] = [];
    const warnings: ResolutionWarning[] = [];
    for (const finding of opts.produced) {
        const matchedExpected = matchedExpectedByFindingId.get(finding.id);
        if (opts.fixture.kind === 'synthetic') {
            findingResolutions.push(
                classifySyntheticFinding(finding, matchedExpected)
            );
            continue;
        }

        const outcome = await classifyRealFinding(
            opts.fixture,
            finding,
            matchedExpected,
            pathDiffCache,
            renameStatusCache,
            opts.judgeClient
        );
        if (outcome.kind === 'classified') {
            findingResolutions.push(outcome.resolution);
        } else {
            warnings.push(outcome.warning);
        }
    }

    return summarizeResolution(
        findingResolutions,
        opts.produced.length,
        warnings
    );
}

function classifySyntheticFinding(
    finding: RecordedFinding,
    matchedExpected: ExpectedFinding | undefined
): FindingResolution {
    if (!matchedExpected) {
        return {
            findingId: finding.id,
            severity: finding.severity,
            verdict: 'noise',
            method: 'synthetic-match',
            path: normalizePath(finding.file),
            reason: 'Synthetic fixture finding did not match any expected label and is treated as noise.',
        };
    }

    const verdict =
        matchedExpected.resolvedByDefault === false ? 'unresolved' : 'resolved';
    return {
        findingId: finding.id,
        severity: finding.severity,
        verdict,
        method:
            matchedExpected.resolvedByDefault !== undefined
                ? 'label-override'
                : 'synthetic-match',
        path: normalizePath(finding.file),
        matchedLabelPath: normalizePath(matchedExpected.path),
        reason:
            matchedExpected.resolvedByDefault !== undefined
                ? `Synthetic fixture label override forced verdict=${verdict}.`
                : 'Synthetic fixture finding matched an expected label.',
    };
}

async function classifyRealFinding(
    fixture: LoadedFixture,
    finding: RecordedFinding,
    matchedExpected: ExpectedFinding | undefined,
    pathDiffCache: Map<string, string>,
    renameStatusCache: Map<string, readonly RenameStatusEntry[]>,
    judgeClient: ResolutionJudgeClient | undefined
): Promise<ClassificationOutcome> {
    if (matchedExpected?.resolvedByDefault !== undefined) {
        return {
            kind: 'classified',
            resolution: {
                findingId: finding.id,
                severity: finding.severity,
                verdict: matchedExpected.resolvedByDefault
                    ? 'resolved'
                    : 'unresolved',
                method: 'label-override',
                path: normalizePath(finding.file),
                matchedLabelPath: normalizePath(matchedExpected.path),
                reason: `Fixture label override forced verdict=${matchedExpected.resolvedByDefault ? 'resolved' : 'unresolved'}.`,
            },
        };
    }

    const comparable = getComparableSources(finding);
    const normalizedPath =
        comparable.sources[0]?.path ?? normalizePath(finding.file);
    const lineCheck = await checkRealFindingPaths(
        fixture,
        comparable.sources,
        comparable.usedFallback,
        pathDiffCache,
        renameStatusCache,
        normalizedPath
    );
    if (
        lineCheck.verdict === 'resolved' ||
        lineCheck.verdict === 'unresolved'
    ) {
        return {
            kind: 'classified',
            resolution: {
                findingId: finding.id,
                severity: finding.severity,
                verdict: lineCheck.verdict,
                method: lineCheck.method,
                path: lineCheck.path,
                matchedLabelPath: matchedExpected
                    ? normalizePath(matchedExpected.path)
                    : undefined,
                reason: lineCheck.reason,
            },
        };
    }

    if (!judgeClient) {
        return {
            kind: 'warning',
            warning: createResolutionWarning(
                finding,
                lineCheck.path,
                'judge-unavailable',
                lineCheck.reason +
                    ' Auxiliary judge unavailable, excluding this finding from semantic resolution metrics.'
            ),
        };
    }

    try {
        const judged = await judgeClient.judge({
            finding,
            diffText: lineCheck.diffText,
        });
        return {
            kind: 'classified',
            resolution: {
                findingId: finding.id,
                severity: finding.severity,
                verdict: judged.verdict,
                method: 'judge',
                path: lineCheck.path,
                matchedLabelPath: matchedExpected
                    ? normalizePath(matchedExpected.path)
                    : undefined,
                judgeModelId: judged.modelId,
                reason: judged.reason,
            },
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            kind: 'warning',
            warning: createResolutionWarning(
                finding,
                lineCheck.path,
                'judge-failed',
                `${lineCheck.reason} Auxiliary judge failed for finding '${finding.id}': ${message}. Excluding this finding from semantic resolution metrics.`
            ),
        };
    }
}

function createResolutionWarning(
    finding: RecordedFinding,
    path: string,
    kind: ResolutionWarning['kind'],
    message: string
): ResolutionWarning {
    return {
        findingId: finding.id,
        severity: finding.severity,
        kind,
        path,
        message,
    };
}

async function checkRealFindingPaths(
    fixture: LoadedFixture,
    sources: readonly FindingSource[],
    usedFallback: boolean,
    cache: Map<string, string>,
    renameStatusCache: Map<string, readonly RenameStatusEntry[]>,
    defaultPath: string
): Promise<LineCheckResult> {
    const sourcesByPath = groupSourcesByPath(sources);
    const ambiguousResults: LineCheckResult[] = [];
    const touchedWithoutOverlap: string[] = [];

    for (const [findingPath, pathSources] of sourcesByPath.entries()) {
        const diffText = await getDiffForPath(fixture, findingPath, cache);
        if (
            await pathHasPureRenameOrMove(
                fixture,
                findingPath,
                renameStatusCache
            )
        ) {
            ambiguousResults.push({
                verdict: 'ambiguous',
                method: usedFallback ? 'line-range-fallback' : 'source-overlap',
                path: findingPath,
                reason: `The follow-up change for ${findingPath} appears to be a pure rename or move without a semantic edit, so the proxy is ambiguous.`,
                diffText,
            });
            continue;
        }
        const lineCheck = checkLineOverlap(
            findingPath,
            pathSources,
            usedFallback,
            diffText
        );
        if (lineCheck.verdict === 'resolved') {
            return lineCheck;
        }
        if (lineCheck.verdict === 'ambiguous') {
            ambiguousResults.push(lineCheck);
            continue;
        }
        if (diffText.trim()) {
            touchedWithoutOverlap.push(findingPath);
        }
    }

    if (ambiguousResults.length > 0) {
        return {
            verdict: 'ambiguous',
            method: ambiguousResults[0]!.method,
            path: ambiguousResults[0]!.path,
            reason: ambiguousResults.map((result) => result.reason).join(' '),
            diffText: ambiguousResults
                .map((result) => result.diffText)
                .filter((text) => text.trim().length > 0)
                .join('\n\n'),
        };
    }

    if (touchedWithoutOverlap.length > 0) {
        return {
            verdict: 'unresolved',
            method: usedFallback ? 'line-range-fallback' : 'source-overlap',
            path: touchedWithoutOverlap[0]!,
            reason:
                touchedWithoutOverlap.length === 1
                    ? `Cited lines did not overlap any changed hunk in ${touchedWithoutOverlap[0]}.`
                    : `Cited lines did not overlap any changed hunk in the touched source paths: ${touchedWithoutOverlap.join(', ')}.`,
            diffText: '',
        };
    }

    return {
        verdict: 'unresolved',
        method: usedFallback ? 'line-range-fallback' : 'source-overlap',
        path: defaultPath,
        reason: 'No changes touched the cited path between headSha and mergeSha.',
        diffText: '',
    };
}

function getComparableSources(finding: RecordedFinding): {
    sources: FindingSource[];
    usedFallback: boolean;
} {
    if (finding.sources && finding.sources.length > 0) {
        return {
            sources: finding.sources.map((source) => ({
                path: normalizePath(source.path),
                lineStart: source.lineStart,
                lineEnd: source.lineEnd,
            })),
            usedFallback: false,
        };
    }

    return {
        sources: [
            {
                path: normalizePath(finding.file),
                lineStart: finding.lineRange[0],
                lineEnd: finding.lineRange[1],
            },
        ],
        usedFallback: true,
    };
}

function checkLineOverlap(
    findingPath: string,
    sources: readonly FindingSource[],
    usedFallback: boolean,
    diffText: string
): LineCheckResult {
    if (!diffText.trim()) {
        return {
            verdict: 'unresolved',
            method: usedFallback ? 'line-range-fallback' : 'source-overlap',
            path: findingPath,
            reason: 'No changes touched the cited path between headSha and mergeSha.',
            diffText,
        };
    }

    const parsed = DiffUtils.parseDiff(diffText);
    const matchingFile = findMatchingDiffFile(parsed, findingPath);
    if (!matchingFile) {
        return {
            verdict: 'ambiguous',
            method: usedFallback ? 'line-range-fallback' : 'source-overlap',
            path: findingPath,
            reason: 'Diff exists for the cited path, but the parsed file header no longer matches it cleanly (possible rename or path normalization mismatch).',
            diffText,
        };
    }

    let hadInvalidSource = false;
    const validSources = sources.filter((source) => {
        if (isValidSource(source)) {
            return true;
        }
        hadInvalidSource = true;
        return false;
    });
    const overlappingHunks = matchingFile.hunks.filter((hunk) =>
        validSources.some((source) =>
            sourceOverlapsChangedOldLines(source, hunk)
        )
    );
    if (overlappingHunks.length > 0) {
        if (overlappingHunks.every((hunk) => !hunkContainsAnyAdditions(hunk))) {
            return {
                verdict: 'resolved',
                method: usedFallback ? 'line-range-fallback' : 'source-overlap',
                path: findingPath,
                reason: `Cited old lines were removed or rewritten by deletion-only hunks in ${findingPath}, which generally indicates the finding was addressed.`,
                diffText,
            };
        }
        return {
            verdict: 'resolved',
            method: usedFallback ? 'line-range-fallback' : 'source-overlap',
            path: findingPath,
            reason: `Cited lines overlapped a changed hunk in ${findingPath}.`,
            diffText,
        };
    }

    if (hadInvalidSource) {
        return {
            verdict: 'ambiguous',
            method: usedFallback ? 'line-range-fallback' : 'source-overlap',
            path: findingPath,
            reason: 'At least one cited source range was invalid, so the line-overlap proxy was inconclusive.',
            diffText,
        };
    }

    if (
        matchingFile.hunks.some(
            (hunk) =>
                hunkContainsAnyAdditions(hunk) &&
                validSources.some((source) =>
                    sourceIsNearInsertionHunk(
                        source,
                        hunk.oldStart,
                        hunk.oldLines
                    )
                )
        )
    ) {
        return {
            verdict: 'ambiguous',
            method: usedFallback ? 'line-range-fallback' : 'source-overlap',
            path: findingPath,
            reason: `The follow-up patch only inserted lines in ${findingPath}; additive fixes can resolve a finding without changing the cited old-line range, so the proxy is ambiguous.`,
            diffText,
        };
    }

    return {
        verdict: 'unresolved',
        method: usedFallback ? 'line-range-fallback' : 'source-overlap',
        path: findingPath,
        reason: `Cited lines did not overlap any changed hunk in ${findingPath}.`,
        diffText,
    };
}

function groupSourcesByPath(
    sources: readonly FindingSource[]
): Map<string, FindingSource[]> {
    const grouped = new Map<string, FindingSource[]>();
    for (const source of sources) {
        const bucket = grouped.get(source.path);
        if (bucket) {
            bucket.push(source);
        } else {
            grouped.set(source.path, [source]);
        }
    }
    return grouped;
}

function isValidSource(source: FindingSource): boolean {
    return (
        Number.isInteger(source.lineStart) &&
        Number.isInteger(source.lineEnd) &&
        source.lineStart > 0 &&
        source.lineEnd >= source.lineStart
    );
}

function sourceOverlapsOldRange(
    source: FindingSource,
    oldStart: number,
    oldLines: number
): boolean {
    if (oldLines <= 0) {
        return false;
    }
    const oldEnd = oldStart + oldLines - 1;
    return source.lineStart <= oldEnd && source.lineEnd >= oldStart;
}

function sourceOverlapsChangedOldLines(
    source: FindingSource,
    hunk: {
        oldStart: number;
        oldLines: number;
        parsedLines: Array<{ type: 'added' | 'removed' | 'context' }>;
    }
): boolean {
    if (hunk.oldLines <= 0) {
        return false;
    }
    if (!Array.isArray(hunk.parsedLines) || hunk.parsedLines.length === 0) {
        return sourceOverlapsOldRange(source, hunk.oldStart, hunk.oldLines);
    }

    let oldLine = hunk.oldStart;
    for (const line of hunk.parsedLines) {
        if (line.type === 'removed') {
            if (source.lineStart <= oldLine && source.lineEnd >= oldLine) {
                return true;
            }
            oldLine += 1;
            continue;
        }
        if (line.type === 'context') {
            oldLine += 1;
        }
    }

    return false;
}

function sourceIsNearInsertionHunk(
    source: FindingSource,
    oldStart: number,
    oldLines: number
): boolean {
    if (oldStart <= 0) {
        return false;
    }

    const oldAnchorStart = Math.max(1, oldStart - 3);
    const oldAnchorEnd = oldStart + Math.max(oldLines, 1) + 2;
    return source.lineStart <= oldAnchorEnd && source.lineEnd >= oldAnchorStart;
}

function hunkContainsAnyAdditions(hunk: {
    parsedLines: Array<{ type: 'added' | 'removed' | 'context' }>;
    newLines: number;
}): boolean {
    if (!Array.isArray(hunk.parsedLines) || hunk.parsedLines.length === 0) {
        return hunk.newLines > 0;
    }

    for (const line of hunk.parsedLines) {
        if (line.type === 'added') {
            return true;
        }
    }
    return false;
}

async function getDiffForPath(
    fixture: LoadedFixture,
    normalizedPath: string,
    cache: Map<string, string>
): Promise<string> {
    const cacheKey = `${fixture.headRef}::${fixture.mergeRef ?? 'none'}::${normalizedPath}`;
    const cached = cache.get(cacheKey);
    if (cached !== undefined) {
        return cached;
    }
    if (!fixture.mergeRef) {
        cache.set(cacheKey, '');
        return '';
    }

    const diffText = await runGitDiffForPath(
        fixture.workspaceRoot,
        fixture.headRef,
        fixture.mergeRef,
        normalizedPath
    );
    cache.set(cacheKey, diffText);
    return diffText;
}

function runGitDiffForPath(
    workspaceRoot: string,
    headRef: string,
    mergeRef: string,
    repoPath: string
): Promise<string> {
    const fromRef = stripRefPrefix(headRef);
    const toRef = stripRefPrefix(mergeRef);
    const gitPath = repoPath.split(path.sep).join('/');
    return new Promise((resolve, reject) => {
        const proc = spawn(
            'git',
            ['diff', `${fromRef}..${toRef}`, '--', gitPath],
            {
                cwd: workspaceRoot,
                stdio: 'pipe',
            }
        );
        let stdout = '';
        let stderr = '';
        let settled = false;
        const timeoutHandle = setTimeout(() => {
            if (settled) {
                return;
            }
            settled = true;
            proc.kill('SIGKILL');
            reject(
                new Error(
                    `git diff ${fromRef}..${toRef} -- ${gitPath} timed out after ${GIT_DIFF_TIMEOUT_MS}ms`
                )
            );
        }, GIT_DIFF_TIMEOUT_MS);
        proc.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
        });
        proc.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });
        proc.on('error', (error) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeoutHandle);
            reject(error);
        });
        proc.on('close', (code) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeoutHandle);
            if (code === 0 || code === 1) {
                resolve(stdout);
                return;
            }
            reject(
                new Error(
                    `git diff ${fromRef}..${toRef} -- ${gitPath} failed (${code}): ${stderr.trim()}`
                )
            );
        });
    });
}

async function pathHasPureRenameOrMove(
    fixture: LoadedFixture,
    findingPath: string,
    cache: Map<string, readonly RenameStatusEntry[]>
): Promise<boolean> {
    if (!fixture.mergeRef) {
        return false;
    }

    const renameEntries = await getPureRenameEntries(fixture, cache);
    return renameEntries.some(
        (entry) =>
            pathsPossiblyMatch(entry.oldPath, findingPath) ||
            pathsPossiblyMatch(entry.newPath, findingPath)
    );
}

async function getPureRenameEntries(
    fixture: LoadedFixture,
    cache: Map<string, readonly RenameStatusEntry[]>
): Promise<readonly RenameStatusEntry[]> {
    const cacheKey = `${fixture.headRef}::${fixture.mergeRef ?? 'none'}::rename-status`;
    const cached = cache.get(cacheKey);
    if (cached !== undefined) {
        return cached;
    }

    if (!fixture.mergeRef) {
        cache.set(cacheKey, []);
        return [];
    }

    const fromRef = stripRefPrefix(fixture.headRef);
    const toRef = stripRefPrefix(fixture.mergeRef);
    const stdout = await runGitDiffNameStatus(
        fixture.workspaceRoot,
        fromRef,
        toRef
    );
    const entries = stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.startsWith('R100\t'))
        .map((line) => line.split('\t'))
        .filter((parts) => parts.length >= 3)
        .map((parts) => ({
            oldPath: normalizePath(parts[1]!),
            newPath: normalizePath(parts[2]!),
        }));

    cache.set(cacheKey, entries);
    return entries;
}

function runGitDiffNameStatus(
    workspaceRoot: string,
    fromRef: string,
    toRef: string
): Promise<string> {
    return new Promise((resolve, reject) => {
        const proc = spawn(
            'git',
            [
                'diff',
                '--name-status',
                '--find-renames=100%',
                `${fromRef}..${toRef}`,
            ],
            {
                cwd: workspaceRoot,
                stdio: 'pipe',
            }
        );
        let stdout = '';
        let stderr = '';
        let settled = false;
        const timeoutHandle = setTimeout(() => {
            if (settled) {
                return;
            }
            settled = true;
            proc.kill('SIGKILL');
            reject(
                new Error(
                    `git diff --name-status --find-renames=100% ${fromRef}..${toRef} timed out after ${GIT_DIFF_TIMEOUT_MS}ms`
                )
            );
        }, GIT_DIFF_TIMEOUT_MS);
        proc.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
        });
        proc.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });
        proc.on('error', (error) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeoutHandle);
            reject(error);
        });
        proc.on('close', (code) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeoutHandle);
            if (code === 0 || code === 1) {
                resolve(stdout);
                return;
            }
            reject(
                new Error(
                    `git diff --name-status --find-renames=100% ${fromRef}..${toRef} failed (${code}): ${stderr.trim()}`
                )
            );
        });
    });
}

function stripRefPrefix(ref: string): string {
    return ref.startsWith('sha:') ? ref.slice('sha:'.length) : ref;
}

function normalizePath(filePath: string): string {
    return filePath.replace(/\\/g, '/');
}

function pathsPossiblyMatch(leftPath: string, rightPath: string): boolean {
    const normalizedLeft = normalizePath(leftPath);
    const normalizedRight = normalizePath(rightPath);
    return (
        normalizedLeft === normalizedRight ||
        normalizedLeft.endsWith(`/${normalizedRight}`) ||
        normalizedRight.endsWith(`/${normalizedLeft}`)
    );
}

function findMatchingDiffFile(
    parsed: Array<{ filePath: string }>,
    findingPath: string
):
    | {
          filePath: string;
          hunks: Array<{
              oldStart: number;
              oldLines: number;
              newLines: number;
              parsedLines: Array<{ type: 'added' | 'removed' | 'context' }>;
          }>;
      }
    | undefined {
    const normalizedFindingPath = normalizePath(findingPath);
    const exact = parsed.find(
        (file) => normalizePath(file.filePath) === normalizedFindingPath
    );
    if (exact) {
        return exact as {
            filePath: string;
            hunks: Array<{
                oldStart: number;
                oldLines: number;
                newLines: number;
                parsedLines: Array<{ type: 'added' | 'removed' | 'context' }>;
            }>;
        };
    }

    return parsed.find((file) => {
        const normalizedFilePath = normalizePath(file.filePath);
        return (
            normalizedFilePath.endsWith(`/${normalizedFindingPath}`) ||
            normalizedFindingPath.endsWith(`/${normalizedFilePath}`)
        );
    }) as
        | {
              filePath: string;
              hunks: Array<{
                  oldStart: number;
                  oldLines: number;
                  newLines: number;
                  parsedLines: Array<{
                      type: 'added' | 'removed' | 'context';
                  }>;
              }>;
          }
        | undefined;
}

function summarizeResolution(
    findings: readonly FindingResolution[],
    attempted: number,
    warnings: readonly ResolutionWarning[]
): ResolutionSummary {
    const bySeverity: ResolutionSummary['bySeverity'] = {};
    const severitiesWithSkipped = new Set<FindingSeverity>();
    let resolved = 0;
    let unresolved = 0;
    let disputed = 0;
    let noise = 0;

    for (const warning of warnings) {
        severitiesWithSkipped.add(warning.severity);
    }

    for (const finding of findings) {
        const bucket =
            bySeverity[finding.severity] ??
            (bySeverity[finding.severity] = emptyBucket());
        incrementBucket(bucket, finding.verdict);
        switch (finding.verdict) {
            case 'resolved':
                resolved++;
                break;
            case 'unresolved':
                unresolved++;
                break;
            case 'disputed':
                disputed++;
                break;
            case 'noise':
                noise++;
                break;
        }
    }

    for (const [severity, bucket] of Object.entries(bySeverity) as Array<
        [FindingSeverity, ResolutionBucket]
    >) {
        finalizeBucket(bucket, severitiesWithSkipped.has(severity));
    }

    const total = findings.length;
    return {
        attempted,
        skipped: warnings.length,
        total,
        resolved,
        unresolved,
        disputed,
        noise,
        resolutionRate:
            total === 0 || warnings.length > 0 ? Number.NaN : resolved / total,
        bySeverity,
        findings: [...findings],
        warnings: [...warnings],
    };
}

function emptyBucket(): ResolutionBucket {
    return {
        total: 0,
        resolved: 0,
        unresolved: 0,
        disputed: 0,
        noise: 0,
        resolutionRate: Number.NaN,
    };
}

function incrementBucket(
    bucket: ResolutionBucket,
    verdict: FindingResolution['verdict']
): void {
    bucket.total++;
    switch (verdict) {
        case 'resolved':
            bucket.resolved++;
            break;
        case 'unresolved':
            bucket.unresolved++;
            break;
        case 'disputed':
            bucket.disputed++;
            break;
        case 'noise':
            bucket.noise++;
            break;
    }
}

function finalizeBucket(
    bucket: ResolutionBucket,
    classificationIncomplete: boolean
): void {
    bucket.resolutionRate =
        classificationIncomplete || bucket.total === 0
            ? Number.NaN
            : bucket.resolved / bucket.total;
}
