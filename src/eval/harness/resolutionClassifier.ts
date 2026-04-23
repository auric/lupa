import { spawn } from 'node:child_process';
import type { FindingSource, RecordedFinding } from '../../types/findingTypes';
import { DiffUtils } from '../../utils/diffUtils';
import type {
    HarnessRecordedFinding,
    FindingResolution,
    LoadedFixture,
    MatchedPair,
    MatchResult,
    ResolutionBucket,
    ResolutionJudgePayload,
    ResolutionJudgeResult,
    ResolutionMetricStatus,
    ResolutionMethod,
    ResolutionSummary,
    ResolutionWarning,
} from './types';
import {
    isWorkspaceRelativePath,
    normalizeWorkspaceRelativePath,
    requireRemainingHeadlessBudgetMs,
} from '../headlessShared';

const GIT_DIFF_TIMEOUT_MS = 15_000;

export interface ResolutionJudgeClient {
    judge(payload: ResolutionJudgePayload): Promise<ResolutionJudgeResult>;
}

interface ClassifyResolutionOptions {
    fixture: LoadedFixture;
    produced: readonly HarnessRecordedFinding[];
    match: MatchResult;
    timeoutMs: number;
    deadlineAt?: number;
    judgeClient?: ResolutionJudgeClient;
}

interface LineCheckResult {
    verdict: 'resolved' | 'unresolved' | 'ambiguous';
    method: ResolutionMethod;
    reason: string;
    diffText: string;
    path: string;
    canonicalPath: string;
}

interface RenameStatusEntry {
    oldPath: string;
    newPath: string;
}

interface ResolvedDiffTarget {
    cachePath: string;
    gitPath: string | undefined;
    matchedPath: boolean;
    ambiguousSuffixMatches?: readonly string[];
}

interface ComparableSources {
    sources: FindingSource[];
    usedFallback: boolean;
    hadInvalidSources: boolean;
    allSourcesInvalid: boolean;
}

interface DiffLookupResult {
    diffText: string;
    renameCheckPath: string | undefined;
    ambiguityReason?: string;
}

type ClassificationOutcome =
    | { kind: 'classified'; resolution: FindingResolution }
    | { kind: 'warning'; warning: ResolutionWarning };

export async function classifyResolutionForRun(
    opts: ClassifyResolutionOptions
): Promise<ResolutionSummary> {
    const matchedPairByFindingId = new Map<string, MatchedPair>();
    for (const pair of opts.match.matched) {
        matchedPairByFindingId.set(pair.produced.id, pair);
    }

    const pathDiffCache = new Map<string, string>();
    const renameStatusCache = new Map<string, readonly RenameStatusEntry[]>();
    const changedPathsCache = new Map<string, readonly string[]>();
    const findingResolutions: FindingResolution[] = [];
    const warnings: ResolutionWarning[] = [];
    for (let index = 0; index < opts.produced.length; index++) {
        const finding = opts.produced[index]!;
        const matchedPair = matchedPairByFindingId.get(finding.id);
        try {
            if (opts.fixture.kind === 'synthetic') {
                findingResolutions.push(
                    classifySyntheticFinding(finding, matchedPair)
                );
                continue;
            }

            const outcome = await classifyRealFinding(
                opts.fixture,
                finding,
                matchedPair,
                pathDiffCache,
                renameStatusCache,
                changedPathsCache,
                opts.timeoutMs,
                opts.deadlineAt,
                opts.judgeClient
            );
            if (outcome.kind === 'classified') {
                findingResolutions.push(outcome.resolution);
            } else {
                warnings.push(outcome.warning);
            }
        } catch (error) {
            return summarizeResolution(
                findingResolutions,
                opts.produced.length,
                [
                    ...warnings,
                    ...createClassificationFailureWarnings(
                        opts.fixture,
                        opts.produced.slice(index),
                        error
                    ),
                ]
            );
        }
    }

    return summarizeResolution(
        findingResolutions,
        opts.produced.length,
        warnings
    );
}

function classifySyntheticFinding(
    finding: HarnessRecordedFinding,
    matchedPair: MatchedPair | undefined
): FindingResolution {
    const matchedExpected = matchedPair?.expected;
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

    const defaultOverride = getResolvedByDefaultOverride(matchedPair);
    const verdict = defaultOverride === false ? 'unresolved' : 'resolved';
    return {
        findingId: finding.id,
        severity: finding.severity,
        verdict,
        method:
            defaultOverride !== undefined
                ? 'label-override'
                : 'synthetic-match',
        path: normalizePath(finding.file),
        matchedLabelPath: normalizePath(matchedExpected.path),
        reason:
            defaultOverride !== undefined
                ? `Synthetic fixture label override forced verdict=${verdict}.`
                : 'Synthetic fixture finding matched an expected label.',
    };
}

async function classifyRealFinding(
    fixture: LoadedFixture,
    finding: HarnessRecordedFinding,
    matchedPair: MatchedPair | undefined,
    pathDiffCache: Map<string, string>,
    renameStatusCache: Map<string, readonly RenameStatusEntry[]>,
    changedPathsCache: Map<string, readonly string[]>,
    timeoutMs: number,
    deadlineAt: number | undefined,
    judgeClient: ResolutionJudgeClient | undefined
): Promise<ClassificationOutcome> {
    const matchedExpected = matchedPair?.expected;
    const defaultOverride = getResolvedByDefaultOverride(matchedPair);
    if (defaultOverride !== undefined) {
        return {
            kind: 'classified',
            resolution: {
                findingId: finding.id,
                severity: finding.severity,
                verdict: defaultOverride ? 'resolved' : 'unresolved',
                method: 'label-override',
                path: normalizePath(finding.file, fixture.workspaceRoot),
                matchedLabelPath: normalizePath(matchedPair!.expected.path),
                reason: `Fixture label override forced verdict=${defaultOverride ? 'resolved' : 'unresolved'}.`,
            },
        };
    }

    const comparable = getComparableSources(finding, fixture.workspaceRoot);
    const normalizedPath =
        comparable.sources[0]?.path ??
        normalizePath(finding.file, fixture.workspaceRoot);
    const sourceFallbackContext = comparable.allSourcesInvalid
        ? `All cited source ranges for finding '${finding.id}' were invalid, so resolution fell back to the finding's top-level file and lineRange. `
        : '';
    let lineCheck: LineCheckResult;
    try {
        lineCheck = await checkRealFindingPaths(
            fixture,
            comparable.sources,
            comparable.usedFallback,
            comparable.hadInvalidSources && !comparable.allSourcesInvalid,
            pathDiffCache,
            renameStatusCache,
            changedPathsCache,
            timeoutMs,
            deadlineAt,
            normalizedPath
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            kind: 'warning',
            warning: createResolutionWarning(
                finding,
                normalizedPath,
                'classification-failed',
                `${sourceFallbackContext}Resolution classification failed for finding '${finding.id}': ${message}. Excluding this finding from resolution metrics.`
            ),
        };
    }
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
                reason: sourceFallbackContext + lineCheck.reason,
            },
        };
    }

    if (!lineCheck.diffText.trim()) {
        return {
            kind: 'classified',
            resolution: {
                findingId: finding.id,
                severity: finding.severity,
                verdict: 'disputed',
                method: lineCheck.method,
                path: lineCheck.path,
                matchedLabelPath: matchedExpected
                    ? normalizePath(matchedExpected.path)
                    : undefined,
                reason:
                    sourceFallbackContext +
                    lineCheck.reason +
                    ' No follow-up diff was available for auxiliary judging, so this finding remains disputed.',
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
                sourceFallbackContext +
                    lineCheck.reason +
                    ' Auxiliary judge unavailable, excluding this finding from semantic resolution metrics.'
            ),
        };
    }

    try {
        const judged = await judgeClient.judge({
            finding: reorderSourcesForJudge(
                finding,
                comparable.sources,
                fixture.workspaceRoot,
                lineCheck.canonicalPath
            ),
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
        if ((error as any).code === 'JUDGE_UNAVAILABLE') {
            return {
                kind: 'warning',
                warning: createResolutionWarning(
                    finding,
                    lineCheck.path,
                    'judge-unavailable',
                    `${sourceFallbackContext}${lineCheck.reason} ${message.trim()} Excluding this finding from semantic resolution metrics.`
                ),
            };
        }
        return {
            kind: 'warning',
            warning: createResolutionWarning(
                finding,
                lineCheck.path,
                'judge-failed',
                `${sourceFallbackContext}${lineCheck.reason} Auxiliary judge failed for finding '${finding.id}': ${message}. Excluding this finding from semantic resolution metrics.`
            ),
        };
    }
}

function createClassificationFailureWarnings(
    fixture: LoadedFixture,
    remainingFindings: readonly HarnessRecordedFinding[],
    error: unknown
): ResolutionWarning[] {
    const message = error instanceof Error ? error.message : String(error);
    return remainingFindings.map((finding, index) => ({
        findingId: finding.id,
        severity: finding.severity,
        kind: 'classification-failed',
        path: getPrimaryFindingPath(finding, fixture.workspaceRoot),
        message:
            index === 0
                ? `Resolution classification aborted while processing finding '${finding.id}': ${message}. Earlier classifications were preserved, but this run's resolution metrics are invalid.`
                : `Resolution classification stopped before finding '${finding.id}' could be classified because an earlier classification step failed: ${message}. Earlier classifications were preserved, but this run's resolution metrics are invalid.`,
    }));
}

function createResolutionWarning(
    finding: HarnessRecordedFinding,
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

function getResolvedByDefaultOverride(
    matchedPair: MatchedPair | undefined
): boolean | undefined {
    if (!matchedPair) {
        return undefined;
    }

    if (matchedPair.expected.resolvedByDefault === undefined) {
        return undefined;
    }

    return matchedPair.matchReason === 'both'
        ? matchedPair.expected.resolvedByDefault
        : undefined;
}

async function checkRealFindingPaths(
    fixture: LoadedFixture,
    sources: readonly FindingSource[],
    usedFallback: boolean,
    hadInvalidSources: boolean,
    cache: Map<string, string>,
    renameStatusCache: Map<string, readonly RenameStatusEntry[]>,
    changedPathsCache: Map<string, readonly string[]>,
    timeoutMs: number,
    deadlineAt: number | undefined,
    defaultPath: string
): Promise<LineCheckResult> {
    const sourcesByPath = groupSourcesByPath(sources);
    const ambiguousResults: LineCheckResult[] = [];
    const touchedWithoutOverlap: string[] = [];

    const pathEntries = Array.from(sourcesByPath.entries());
    const diffPromises = pathEntries.map(([findingPath]) =>
        getDiffForPath(
            fixture,
            findingPath,
            cache,
            changedPathsCache,
            timeoutMs,
            deadlineAt
        )
    );
    const settledDiffs = await Promise.allSettled(diffPromises);
    const allRejected =
        settledDiffs.length > 0 &&
        settledDiffs.every((s) => s.status === 'rejected');
    if (allRejected) {
        const firstRejection = settledDiffs.find(
            (s): s is PromiseRejectedResult => s.status === 'rejected'
        );
        if (firstRejection) {
            throw firstRejection.reason;
        }
    }

    for (let i = 0; i < pathEntries.length; i++) {
        const entry = pathEntries[i];
        const settled = settledDiffs[i];
        if (
            entry === undefined ||
            settled === undefined ||
            settled.status === 'rejected'
        ) {
            continue;
        }
        const [findingPath, pathSources] = entry;
        const diffLookup = settled.value;

        if (diffLookup.ambiguityReason) {
            ambiguousResults.push({
                verdict: 'ambiguous',
                method: usedFallback ? 'line-range-fallback' : 'source-overlap',
                path: findingPath,
                canonicalPath:
                    diffLookup.renameCheckPath !== undefined
                        ? normalizePath(diffLookup.renameCheckPath)
                        : findingPath,
                reason: diffLookup.ambiguityReason,
                diffText: diffLookup.diffText,
            });
            continue;
        }
        if (
            await pathHasPureRenameOrMove(
                fixture,
                diffLookup.renameCheckPath,
                renameStatusCache,
                timeoutMs,
                deadlineAt
            )
        ) {
            ambiguousResults.push({
                verdict: 'ambiguous',
                method: usedFallback ? 'line-range-fallback' : 'source-overlap',
                path: findingPath,
                canonicalPath:
                    diffLookup.renameCheckPath !== undefined
                        ? normalizePath(diffLookup.renameCheckPath)
                        : findingPath,
                reason: `The follow-up change for ${findingPath} appears to be a pure rename or move without a semantic edit, so the proxy is ambiguous.`,
                diffText: diffLookup.diffText,
            });
            continue;
        }
        const lineCheck = checkLineOverlap(
            findingPath,
            diffLookup.renameCheckPath !== undefined
                ? normalizePath(diffLookup.renameCheckPath)
                : findingPath,
            pathSources,
            usedFallback,
            diffLookup.diffText,
            hadInvalidSources
        );
        if (lineCheck.verdict === 'resolved') {
            return lineCheck;
        }
        if (lineCheck.verdict === 'ambiguous') {
            ambiguousResults.push(lineCheck);
            continue;
        }
        if (diffLookup.diffText.trim()) {
            touchedWithoutOverlap.push(findingPath);
        }
    }

    if (ambiguousResults.length > 0) {
        return {
            verdict: 'ambiguous',
            method: ambiguousResults[0]!.method,
            path: ambiguousResults[0]!.path,
            canonicalPath: ambiguousResults[0]!.canonicalPath,
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
            canonicalPath: touchedWithoutOverlap[0]!,
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
        canonicalPath: defaultPath,
        reason: 'No changes touched the cited path between headSha and mergeSha.',
        diffText: '',
    };
}

function getComparableSources(
    finding: HarnessRecordedFinding
): ComparableSources;
function getComparableSources(
    finding: HarnessRecordedFinding,
    workspaceRoot: string | undefined
): ComparableSources;
function getComparableSources(
    finding: HarnessRecordedFinding,
    workspaceRoot?: string
): ComparableSources {
    const rawSources = Array.isArray(finding.sources) ? finding.sources : [];
    const normalizedSources = rawSources
        .map((source) => normalizeComparableSource(source, workspaceRoot))
        .filter((source): source is FindingSource => source !== undefined)
        .filter(isComparableSource);
    const sourceCount = rawSources.length;
    const hadInvalidSources = sourceCount > normalizedSources.length;
    if (normalizedSources.length > 0) {
        return {
            sources: normalizedSources,
            usedFallback: false,
            hadInvalidSources,
            allSourcesInvalid: false,
        };
    }

    return {
        sources: [
            {
                path: normalizePath(finding.file, workspaceRoot),
                lineStart: finding.lineRange[0],
                lineEnd: finding.lineRange[1],
            },
        ],
        usedFallback: true,
        hadInvalidSources,
        allSourcesInvalid: sourceCount > 0 && normalizedSources.length === 0,
    };
}

function getPrimaryFindingPath(
    finding: HarnessRecordedFinding,
    workspaceRoot: string | undefined
): string {
    return (
        getComparableSources(finding, workspaceRoot).sources[0]?.path ??
        normalizePath(finding.file, workspaceRoot)
    );
}

export function reorderSourcesForJudge(
    finding: HarnessRecordedFinding,
    comparableSources: readonly FindingSource[],
    workspaceRoot: string | undefined,
    judgedPath: string
): RecordedFinding {
    const normalizedFile = normalizePath(finding.file, workspaceRoot);
    const primarySource =
        comparableSources.find((source) =>
            pathsEqualForComparison(source.path, judgedPath)
        ) ??
        comparableSources.find((source) =>
            sourceMatchesJudgedPath(source.path, judgedPath)
        ) ??
        comparableSources[0];
    const orderedSources = primarySource
        ? [
              primarySource,
              ...comparableSources.filter((source) => source !== primarySource),
          ]
        : [...comparableSources];

    return {
        ...finding,
        file: judgedPath.length > 0 ? judgedPath : normalizedFile,
        lineRange: primarySource
            ? [primarySource.lineStart, primarySource.lineEnd]
            : finding.lineRange,
        sources: orderedSources.map((source) => ({
            path: source === primarySource ? judgedPath : source.path,
            lineStart: source.lineStart,
            lineEnd: source.lineEnd,
        })),
    };
}

function sourceMatchesJudgedPath(
    sourcePath: string,
    judgedPath: string
): boolean {
    return (
        pathsEqualForComparison(sourcePath, judgedPath) ||
        pathMatchesCitedSuffix(judgedPath, sourcePath)
    );
}

function normalizeComparableSource(
    source: unknown,
    workspaceRoot: string | undefined
): FindingSource | undefined {
    if (!source || typeof source !== 'object') {
        return undefined;
    }

    const candidate = source as Partial<Record<keyof FindingSource, unknown>>;
    return {
        path: normalizePath(
            typeof candidate.path === 'string' ? candidate.path : '',
            workspaceRoot
        ),
        lineStart:
            typeof candidate.lineStart === 'number'
                ? candidate.lineStart
                : Number.NaN,
        lineEnd:
            typeof candidate.lineEnd === 'number'
                ? candidate.lineEnd
                : Number.NaN,
    };
}

function checkLineOverlap(
    findingPath: string,
    canonicalPath: string,
    sources: readonly FindingSource[],
    usedFallback: boolean,
    diffText: string,
    hadInvalidSources: boolean
): LineCheckResult {
    if (!diffText.trim()) {
        return {
            verdict: 'unresolved',
            method: usedFallback ? 'line-range-fallback' : 'source-overlap',
            path: findingPath,
            canonicalPath,
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
            canonicalPath,
            reason: 'Diff exists for the cited path, but the parsed file header no longer matches it cleanly (possible rename or path normalization mismatch).',
            diffText,
        };
    }

    let hadInvalidSource = hadInvalidSources;
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
                canonicalPath,
                reason: `Cited old lines were removed or rewritten by deletion-only hunks in ${findingPath}, which generally indicates the finding was addressed.`,
                diffText,
            };
        }
        return {
            verdict: 'resolved',
            method: usedFallback ? 'line-range-fallback' : 'source-overlap',
            path: findingPath,
            canonicalPath,
            reason: `Cited lines overlapped a changed hunk in ${findingPath}.`,
            diffText,
        };
    }

    if (hadInvalidSource) {
        return {
            verdict: 'ambiguous',
            method: usedFallback ? 'line-range-fallback' : 'source-overlap',
            path: findingPath,
            canonicalPath,
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
            canonicalPath,
            reason: `The follow-up patch only inserted lines in ${findingPath}; additive fixes can resolve a finding without changing the cited old-line range, so the proxy is ambiguous.`,
            diffText,
        };
    }

    return {
        verdict: 'unresolved',
        method: usedFallback ? 'line-range-fallback' : 'source-overlap',
        path: findingPath,
        canonicalPath,
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

function isComparableSource(source: FindingSource): boolean {
    return source.path.length > 0 && isValidSource(source);
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
    cache: Map<string, string>,
    changedPathsCache: Map<string, readonly string[]>,
    timeoutMs: number,
    deadlineAt: number | undefined
): Promise<DiffLookupResult> {
    if (!fixture.mergeRef) {
        const cacheKey = `${fixture.headRef}::${fixture.mergeRef ?? 'none'}::${normalizedPath}`;
        cache.set(cacheKey, '');
        return {
            diffText: '',
            renameCheckPath: undefined,
        };
    }

    const diffTarget = await resolveDiffTarget(
        fixture,
        normalizedPath,
        changedPathsCache,
        timeoutMs,
        deadlineAt
    );
    const cacheKey = `${fixture.headRef}::${fixture.mergeRef ?? 'none'}::${diffTarget.cachePath}`;
    const cached = cache.get(cacheKey);
    if (cached !== undefined) {
        return {
            diffText: cached,
            renameCheckPath: diffTarget.gitPath,
            ambiguityReason: getSuffixAmbiguityReason(
                normalizedPath,
                diffTarget.ambiguousSuffixMatches
            ),
        };
    }

    if (!diffTarget.matchedPath) {
        if (!isWorkspaceRelativePath(normalizedPath)) {
            cache.set(cacheKey, '');
            return {
                diffText: '',
                renameCheckPath: undefined,
                ambiguityReason: getSuffixAmbiguityReason(
                    normalizedPath,
                    diffTarget.ambiguousSuffixMatches
                ),
            };
        }

        const fallbackDiff = await getDiffForOriginalPath(
            fixture,
            normalizedPath,
            cache,
            timeoutMs,
            deadlineAt
        );
        if (fallbackDiff.trim().length > 0) {
            return {
                diffText: fallbackDiff,
                renameCheckPath: normalizePath(normalizedPath),
            };
        }

        cache.set(cacheKey, '');
        return {
            diffText: '',
            renameCheckPath: undefined,
            ambiguityReason: getSuffixAmbiguityReason(
                normalizedPath,
                diffTarget.ambiguousSuffixMatches
            ),
        };
    }

    const diffText = await runGitDiffForPath(
        fixture.workspaceRoot,
        fixture.headRef,
        fixture.mergeRef,
        diffTarget.gitPath,
        getResolutionGitTimeoutMs(
            timeoutMs,
            deadlineAt,
            `during resolution classification git diff for ${normalizedPath}`
        )
    );
    cache.set(cacheKey, diffText);
    return {
        diffText,
        renameCheckPath: diffTarget.gitPath,
    };
}

function getSuffixAmbiguityReason(
    normalizedPath: string,
    ambiguousSuffixMatches: readonly string[] | undefined
): string | undefined {
    if (!ambiguousSuffixMatches || ambiguousSuffixMatches.length === 0) {
        return undefined;
    }

    return `Multiple changed paths matched the cited suffix '${normalizedPath}': ${ambiguousSuffixMatches.join(', ')}. The direct diff for '${normalizedPath}' was empty, so the proxy is ambiguous.`;
}

async function getDiffForOriginalPath(
    fixture: LoadedFixture,
    normalizedPath: string,
    cache: Map<string, string>,
    timeoutMs: number,
    deadlineAt: number | undefined
): Promise<string> {
    const gitPath = normalizePath(normalizedPath);
    if (!fixture.mergeRef || gitPath.length === 0) {
        return '';
    }

    const cacheKey = `${fixture.headRef}::${fixture.mergeRef ?? 'none'}::direct:${gitPath}`;
    const cached = cache.get(cacheKey);
    if (cached !== undefined) {
        return cached;
    }

    const diffText = await runGitDiffForPath(
        fixture.workspaceRoot,
        fixture.headRef,
        fixture.mergeRef,
        gitPath,
        getResolutionGitTimeoutMs(
            timeoutMs,
            deadlineAt,
            `during resolution classification direct git diff for ${normalizedPath}`
        )
    );
    cache.set(cacheKey, diffText);
    return diffText;
}

async function resolveDiffTarget(
    fixture: LoadedFixture,
    normalizedPath: string,
    cache: Map<string, readonly string[]>,
    timeoutMs: number,
    deadlineAt: number | undefined
): Promise<ResolvedDiffTarget> {
    const gitPath = normalizePath(normalizedPath);
    if (!fixture.mergeRef || gitPath.length === 0) {
        return {
            cachePath: gitPath,
            gitPath,
            matchedPath: gitPath.length > 0,
        };
    }

    const changedPaths = await getChangedPaths(
        fixture,
        cache,
        timeoutMs,
        deadlineAt
    );
    if (
        changedPaths.some((candidatePath) =>
            pathsEqualForComparison(candidatePath, gitPath)
        )
    ) {
        return {
            cachePath: gitPath,
            gitPath: changedPaths.find((candidatePath) =>
                pathsEqualForComparison(candidatePath, gitPath)
            )!,
            matchedPath: true,
        };
    }

    if (!isWorkspaceRelativePath(gitPath)) {
        return {
            cachePath: `unmatched:${gitPath}`,
            gitPath: undefined,
            matchedPath: false,
        };
    }

    const suffixMatches = changedPaths.filter((candidatePath) =>
        pathsMatchBySuffix(candidatePath, gitPath)
    );
    if (suffixMatches.length === 1) {
        return {
            cachePath: suffixMatches[0]!,
            gitPath: suffixMatches[0]!,
            matchedPath: true,
        };
    }

    if (suffixMatches.length > 1) {
        return {
            cachePath: `ambiguous:${gitPath}`,
            gitPath: undefined,
            matchedPath: false,
            ambiguousSuffixMatches: suffixMatches,
        };
    }

    return {
        cachePath: `unmatched:${gitPath}`,
        gitPath: undefined,
        matchedPath: false,
    };
}

async function getChangedPaths(
    fixture: LoadedFixture,
    cache: Map<string, readonly string[]>,
    timeoutMs: number,
    deadlineAt: number | undefined
): Promise<readonly string[]> {
    const cacheKey = `${fixture.headRef}::${fixture.mergeRef ?? 'none'}::changed-paths`;
    const cached = cache.get(cacheKey);
    if (cached !== undefined) {
        return cached;
    }

    if (!fixture.mergeRef) {
        cache.set(cacheKey, []);
        return [];
    }

    const stdout = await runGitDiffNameOnly(
        fixture.workspaceRoot,
        stripRefPrefix(fixture.headRef),
        stripRefPrefix(fixture.mergeRef),
        getResolutionGitTimeoutMs(
            timeoutMs,
            deadlineAt,
            'during resolution classification changed-path lookup'
        )
    );
    const changedPaths = stdout
        .split(/\r?\n/u)
        .map((line) => normalizePath(line))
        .filter((line) => line.length > 0);

    cache.set(cacheKey, changedPaths);
    return changedPaths;
}

function validateGitRef(ref: string, label: string): void {
    if (ref.startsWith('-')) {
        throw new Error(
            `Invalid ${label}: "${ref}" starts with '-', which is not allowed`
        );
    }
}

function runGitDiffForPath(
    workspaceRoot: string,
    headRef: string,
    mergeRef: string,
    repoPath: string | undefined,
    timeoutMs: number
): Promise<string> {
    const fromRef = stripRefPrefix(headRef);
    const toRef = stripRefPrefix(mergeRef);
    validateGitRef(fromRef, 'headRef');
    validateGitRef(toRef, 'mergeRef');
    const gitPath = repoPath ? normalizePath(repoPath) : undefined;
    const gitPathArg = gitPath
        ? pathRequiresLiteralGitPath(gitPath)
            ? `:(literal)${gitPath}`
            : gitPath
        : undefined;
    const args = gitPath
        ? ['diff', '--no-ext-diff', `${fromRef}..${toRef}`, '--', gitPathArg!]
        : ['diff', '--no-ext-diff', `${fromRef}..${toRef}`];
    const commandLabel = gitPath
        ? `git diff ${fromRef}..${toRef} -- ${gitPath}`
        : `git diff ${fromRef}..${toRef}`;
    return new Promise((resolve, reject) => {
        const proc = spawn('git', args, {
            cwd: workspaceRoot,
            stdio: 'pipe',
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const timeoutHandle = setTimeout(() => {
            if (settled) {
                return;
            }
            settled = true;
            proc.kill('SIGKILL');
            reject(new Error(`${commandLabel} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
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
                new Error(`${commandLabel} failed (${code}): ${stderr.trim()}`)
            );
        });
    });
}

function runGitDiffNameOnly(
    workspaceRoot: string,
    fromRef: string,
    toRef: string,
    timeoutMs: number
): Promise<string> {
    validateGitRef(fromRef, 'fromRef');
    validateGitRef(toRef, 'toRef');
    return new Promise((resolve, reject) => {
        const proc = spawn(
            'git',
            ['diff', '--no-ext-diff', '--name-only', `${fromRef}..${toRef}`],
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
                    `git diff --name-only ${fromRef}..${toRef} timed out after ${timeoutMs}ms`
                )
            );
        }, timeoutMs);
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
                    `git diff --name-only ${fromRef}..${toRef} failed (${code}): ${stderr.trim()}`
                )
            );
        });
    });
}

async function pathHasPureRenameOrMove(
    fixture: LoadedFixture,
    diffTargetPath: string | undefined,
    cache: Map<string, readonly RenameStatusEntry[]>,
    timeoutMs: number,
    deadlineAt: number | undefined
): Promise<boolean> {
    if (!fixture.mergeRef || !diffTargetPath) {
        return false;
    }

    const renameEntries = await getPureRenameEntries(
        fixture,
        cache,
        timeoutMs,
        deadlineAt
    );
    return hasResolvableRenameMatch(renameEntries, diffTargetPath);
}

async function getPureRenameEntries(
    fixture: LoadedFixture,
    cache: Map<string, readonly RenameStatusEntry[]>,
    timeoutMs: number,
    deadlineAt: number | undefined
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
        toRef,
        getResolutionGitTimeoutMs(
            timeoutMs,
            deadlineAt,
            'during resolution classification rename detection'
        )
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
    toRef: string,
    timeoutMs: number
): Promise<string> {
    validateGitRef(fromRef, 'fromRef');
    validateGitRef(toRef, 'toRef');
    return new Promise((resolve, reject) => {
        const proc = spawn(
            'git',
            [
                'diff',
                '--no-ext-diff',
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
                    `git diff --name-status --find-renames=100% ${fromRef}..${toRef} timed out after ${timeoutMs}ms`
                )
            );
        }, timeoutMs);
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

function normalizePath(filePath: string): string;
function normalizePath(
    filePath: string,
    workspaceRoot: string | undefined
): string;
function normalizePath(filePath: string, workspaceRoot?: string): string {
    return normalizeWorkspaceRelativePath(filePath, workspaceRoot);
}

function hasResolvableRenameMatch(
    entries: readonly RenameStatusEntry[],
    findingPath: string
): boolean {
    const normalizedFindingPath = normalizePath(findingPath);
    if (normalizedFindingPath.length === 0) {
        return false;
    }

    const exactMatches = entries.filter(
        (entry) =>
            pathsEqualForComparison(entry.oldPath, normalizedFindingPath) ||
            pathsEqualForComparison(entry.newPath, normalizedFindingPath)
    );
    if (exactMatches.length > 0) {
        return exactMatches.length === 1;
    }

    return (
        entries.filter((entry) =>
            renameEntryMatchesBySuffix(entry, normalizedFindingPath)
        ).length === 1
    );
}

function renameEntryMatchesBySuffix(
    entry: RenameStatusEntry,
    findingPath: string
): boolean {
    return [entry.oldPath, entry.newPath].some((candidatePath) =>
        pathMatchesCitedSuffix(candidatePath, findingPath)
    );
}

function pathsMatchBySuffix(leftPath: string, rightPath: string): boolean {
    const normalizedLeftPath = normalizePathComparisonKey(leftPath);
    const normalizedRightPath = normalizePathComparisonKey(rightPath);
    return (
        normalizedLeftPath === normalizedRightPath ||
        normalizedLeftPath.endsWith(`/${normalizedRightPath}`)
    );
}

function findMatchingDiffFile(
    parsed: Array<{ filePath: string; originalHeader: string }>,
    findingPath: string
):
    | {
          filePath: string;
          originalHeader: string;
          hunks: Array<{
              oldStart: number;
              oldLines: number;
              newLines: number;
              parsedLines: Array<{ type: 'added' | 'removed' | 'context' }>;
          }>;
      }
    | undefined {
    const normalizedFindingPath = normalizePath(findingPath);
    const exactMatches = parsed.filter((file) =>
        getDiffCandidatePaths(file).some((candidatePath) =>
            pathsEqualForComparison(candidatePath, normalizedFindingPath)
        )
    );
    if (exactMatches.length === 1) {
        return exactMatches[0] as {
            filePath: string;
            originalHeader: string;
            hunks: Array<{
                oldStart: number;
                oldLines: number;
                newLines: number;
                parsedLines: Array<{ type: 'added' | 'removed' | 'context' }>;
            }>;
        };
    }

    if (!isWorkspaceRelativePath(normalizedFindingPath)) {
        return undefined;
    }

    const suffixMatches = parsed.filter((file) => {
        return getDiffCandidatePaths(file).some((candidatePath) =>
            pathMatchesCitedSuffix(candidatePath, normalizedFindingPath)
        );
    });

    if (suffixMatches.length !== 1) {
        return undefined;
    }

    return suffixMatches[0] as {
        filePath: string;
        originalHeader: string;
        hunks: Array<{
            oldStart: number;
            oldLines: number;
            newLines: number;
            parsedLines: Array<{
                type: 'added' | 'removed' | 'context';
            }>;
        }>;
    };
}

function getDiffCandidatePaths(file: {
    filePath: string;
    originalHeader: string;
}): string[] {
    const candidates = new Set<string>([normalizePath(file.filePath)]);
    const headerMatch = /^diff --git a\/(.+) b\/(.+)$/.exec(
        file.originalHeader
    );
    if (!headerMatch) {
        return [...candidates];
    }

    const oldPath = headerMatch[1] ? normalizePath(headerMatch[1]) : '';
    const newPath = headerMatch[2] ? normalizePath(headerMatch[2]) : '';
    if (oldPath.length > 0) {
        candidates.add(oldPath);
    }
    if (newPath.length > 0) {
        candidates.add(newPath);
    }

    return [...candidates];
}

function pathsEqualForComparison(leftPath: string, rightPath: string): boolean {
    return (
        normalizePathComparisonKey(leftPath) ===
        normalizePathComparisonKey(rightPath)
    );
}

function pathMatchesCitedSuffix(
    candidatePath: string,
    citedPath: string
): boolean {
    return pathsMatchBySuffix(candidatePath, citedPath);
}

function pathRequiresLiteralGitPath(filePath: string): boolean {
    return (
        filePath.includes('*') ||
        filePath.includes('?') ||
        filePath.includes('[') ||
        filePath.includes('{') ||
        filePath.includes('}') ||
        filePath.includes('\\')
    );
}

function normalizePathComparisonKey(filePath: string): string {
    return process.platform === 'win32' ? filePath.toLowerCase() : filePath;
}

function summarizeResolution(
    findings: readonly FindingResolution[],
    attempted: number,
    warnings: readonly ResolutionWarning[]
): ResolutionSummary {
    const bySeverity: ResolutionSummary['bySeverity'] = {};
    let resolved = 0;
    let unresolved = 0;
    let disputed = 0;
    let noise = 0;

    for (const warning of warnings) {
        const bucket =
            bySeverity[warning.severity] ??
            (bySeverity[warning.severity] = emptyBucket());
        bucket.attempted++;
        bucket.skipped++;
    }

    for (const finding of findings) {
        const bucket =
            bySeverity[finding.severity] ??
            (bySeverity[finding.severity] = emptyBucket());
        bucket.attempted++;
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

    for (const bucket of Object.values(bySeverity)) {
        finalizeBucket(bucket);
    }

    const total = findings.length;
    const metricStatus = getResolutionMetricStatus(attempted, warnings.length);
    return {
        attempted,
        skipped: warnings.length,
        total,
        resolved,
        unresolved,
        disputed,
        noise,
        resolutionRate:
            metricStatus === 'valid' ? resolved / total : Number.NaN,
        metricStatus,
        bySeverity,
        findings: [...findings],
        warnings: [...warnings],
    };
}

function emptyBucket(): ResolutionBucket {
    return {
        attempted: 0,
        skipped: 0,
        total: 0,
        resolved: 0,
        unresolved: 0,
        disputed: 0,
        noise: 0,
        resolutionRate: Number.NaN,
        metricStatus: 'no-findings',
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

function finalizeBucket(bucket: ResolutionBucket): void {
    bucket.metricStatus = getResolutionMetricStatus(
        bucket.attempted,
        bucket.skipped
    );
    bucket.resolutionRate =
        bucket.metricStatus === 'valid'
            ? bucket.resolved / bucket.total
            : Number.NaN;
}

function getResolutionGitTimeoutMs(
    timeoutMs: number,
    deadlineAt: number | undefined,
    phase: string
): number {
    return Math.min(
        GIT_DIFF_TIMEOUT_MS,
        requireRemainingHeadlessBudgetMs(timeoutMs, deadlineAt, phase)
    );
}

function getResolutionMetricStatus(
    attempted: number,
    skipped: number
): ResolutionMetricStatus {
    if (attempted === 0) {
        return 'no-findings';
    }
    if (skipped > 0) {
        return 'invalid-skipped';
    }
    return 'valid';
}
