import path from 'path';
import type { DiffHunk } from '../types/contextTypes';
import type { RecordedFinding } from '../types/findingTypes';

export interface FileGroup {
    /** Human-readable label for the group (e.g., "src/services", "Configuration") */
    label: string;
    /** DiffHunk file paths in this group */
    files: string[];
    /** File classification */
    complexity: 'source' | 'test' | 'config';
    /** Higher priority = review first */
    priority: number;
}

export interface FileGrouperOptions {
    /** Max files per group (default 5) */
    maxFilesPerGroup?: number;
    /** Max number of groups to produce (default 15) */
    maxGroups?: number;
}

const DEFAULT_MAX_FILES_PER_GROUP = 5;
const DEFAULT_MAX_GROUPS = 15;

const CONFIG_EXTENSIONS = new Set([
    '.json',
    '.yaml',
    '.yml',
    '.toml',
    '.env',
    '.md',
    '.txt',
    '.lock',
    '.gitignore',
    '.editorconfig',
]);

const CONFIG_LINE_THRESHOLD = 20;

const PRIORITY_SOURCE = 3;
const PRIORITY_TEST = 2;
const PRIORITY_CONFIG = 1;

type FileClassification = 'source' | 'test' | 'config';

function getChangedLineCount(diff: DiffHunk): number {
    return diff.hunks.reduce((sum, hunk) => sum + hunk.parsedLines.length, 0);
}

function classifyFile(diff: DiffHunk): FileClassification {
    const filePath = diff.filePath;
    const ext = path.posix.extname(filePath);
    const baseName = path.posix.basename(filePath);
    const changedLines = getChangedLineCount(diff);

    const isConfigExtension =
        CONFIG_EXTENSIONS.has(ext) || CONFIG_EXTENSIONS.has(baseName);
    const isConfigPath = filePath.includes('config/');
    if (
        (isConfigExtension || isConfigPath) &&
        changedLines < CONFIG_LINE_THRESHOLD
    ) {
        return 'config';
    }

    const testPatterns = [
        '__tests__/',
        'test/',
        'tests/',
        '.test.',
        '.spec.',
        '_test.',
        '_spec.',
    ];
    if (testPatterns.some((pattern) => filePath.includes(pattern))) {
        return 'test';
    }

    return 'source';
}

function stripTestPattern(fileName: string): string {
    return fileName
        .replace(/\.test\./, '.')
        .replace(/\.spec\./, '.')
        .replace(/_test\./, '.')
        .replace(/_spec\./, '.');
}

function getDirectoryLabel(dirPath: string): string {
    if (dirPath === '.' || dirPath === '') {
        return 'Root files';
    }
    return dirPath;
}

function splitOversizedGroups(
    groups: FileGroup[],
    maxFiles: number
): FileGroup[] {
    const result: FileGroup[] = [];
    for (const group of groups) {
        if (group.files.length <= maxFiles) {
            result.push(group);
            continue;
        }
        const totalParts = Math.ceil(group.files.length / maxFiles);
        for (let i = 0; i < totalParts; i++) {
            const start = i * maxFiles;
            const end = start + maxFiles;
            result.push({
                label: `${group.label} (${i + 1} of ${totalParts})`,
                files: group.files.slice(start, end),
                complexity: group.complexity,
                priority: group.priority,
            });
        }
    }
    return result;
}

function getGrandparentDir(filePath: string): string {
    const dir = path.posix.dirname(filePath);
    return path.posix.dirname(dir);
}

function mergeTinyGroups(groups: FileGroup[]): FileGroup[] {
    const tinyGroups: FileGroup[] = [];
    const normalGroups: FileGroup[] = [];

    for (const group of groups) {
        if (group.files.length === 1) {
            tinyGroups.push(group);
        } else {
            normalGroups.push(group);
        }
    }

    if (tinyGroups.length <= 1) {
        return groups;
    }

    const grandparentMap = new Map<string, FileGroup[]>();
    for (const group of tinyGroups) {
        const firstFile = group.files[0];
        if (!firstFile) {
            continue;
        }
        const grandparent = getGrandparentDir(firstFile);
        const key = `${grandparent}::${group.complexity}`;
        const existing = grandparentMap.get(key) ?? [];
        existing.push(group);
        grandparentMap.set(key, existing);
    }

    for (const [key, mergeable] of grandparentMap) {
        if (mergeable.length > 1) {
            const grandparent = key.split('::')[0] ?? '';
            const mergedLabel = getDirectoryLabel(grandparent);
            const mergedFiles = mergeable.flatMap((g) => g.files);
            const mergedPriority = Math.max(
                ...mergeable.map((g) => g.priority)
            );
            const mergedComplexity = mergeable.some(
                (g) => g.complexity === 'source'
            )
                ? ('source' as const)
                : mergeable.some((g) => g.complexity === 'test')
                  ? ('test' as const)
                  : ('config' as const);
            normalGroups.push({
                label: mergedLabel,
                files: mergedFiles,
                complexity: mergedComplexity,
                priority: mergedPriority,
            });
        } else if (mergeable[0]) {
            normalGroups.push(mergeable[0]);
        }
    }

    return normalGroups;
}

function capGroups(groups: FileGroup[], maxGroups: number): FileGroup[] {
    if (groups.length <= maxGroups) {
        return groups;
    }

    const sorted = [...groups].sort((a, b) => a.files.length - b.files.length);

    while (sorted.length > maxGroups && sorted.length > 1) {
        const smallest = sorted.shift()!;
        const target = sorted[0]!;
        target.files.push(...smallest.files);
        target.label = `${target.label}, ${smallest.label}`;
        target.priority = Math.max(target.priority, smallest.priority);
        if (
            smallest.complexity === 'source' ||
            target.complexity === 'source'
        ) {
            target.complexity = 'source';
        }
    }

    return sorted;
}

export function groupFilesForReview(
    parsedDiff: DiffHunk[],
    options?: FileGrouperOptions
): FileGroup[] {
    if (parsedDiff.length === 0) {
        return [];
    }

    const maxFilesPerGroup =
        options?.maxFilesPerGroup ?? DEFAULT_MAX_FILES_PER_GROUP;
    const maxGroups = options?.maxGroups ?? DEFAULT_MAX_GROUPS;

    // Step 1: Classify files
    const classified = parsedDiff.map((diff) => ({
        filePath: diff.filePath,
        classification: classifyFile(diff),
    }));

    const sourceFiles = classified.filter((f) => f.classification === 'source');
    const testFiles = classified.filter((f) => f.classification === 'test');
    const configFiles = classified.filter((f) => f.classification === 'config');

    // Step 2: Group source files by directory
    const dirGroups = new Map<string, string[]>();
    for (const file of sourceFiles) {
        const dir = path.posix.dirname(file.filePath);
        const label = getDirectoryLabel(dir);
        const existing = dirGroups.get(label) ?? [];
        existing.push(file.filePath);
        dirGroups.set(label, existing);
    }

    const sourceGroupList: FileGroup[] = [];
    for (const [label, files] of dirGroups) {
        sourceGroupList.push({
            label,
            files,
            complexity: 'source',
            priority: PRIORITY_SOURCE,
        });
    }

    // Step 3: Pair tests with source groups
    const unmatchedTests: string[] = [];
    for (const testFile of testFiles) {
        const testBaseName = path.posix.basename(testFile.filePath);
        const sourceBaseName = stripTestPattern(testBaseName);
        let matched = false;

        for (const group of sourceGroupList) {
            if (
                group.files.some(
                    (f) => path.posix.basename(f) === sourceBaseName
                )
            ) {
                group.files.push(testFile.filePath);
                matched = true;
                break;
            }
        }

        if (!matched) {
            unmatchedTests.push(testFile.filePath);
        }
    }

    if (unmatchedTests.length > 0) {
        sourceGroupList.push({
            label: 'Tests',
            files: unmatchedTests,
            complexity: 'test',
            priority: PRIORITY_TEST,
        });
    }

    // Step 4: Bundle config files
    if (configFiles.length > 0) {
        sourceGroupList.push({
            label: 'Configuration',
            files: configFiles.map((f) => f.filePath),
            complexity: 'config',
            priority: PRIORITY_CONFIG,
        });
    }

    // Step 5: Split oversized groups
    let groups = splitOversizedGroups(sourceGroupList, maxFilesPerGroup);

    // Step 6: Merge tiny groups
    groups = mergeTinyGroups(groups);

    // Step 7: Cap groups
    groups = capGroups(groups, maxGroups);

    // Step 8: Sort by priority descending
    groups.sort((a, b) => b.priority - a.priority);

    return groups;
}

export function buildSynthesisPrompt(
    findings: RecordedFinding[],
    groups: FileGroup[],
    totalFiles: number
): string {
    const groupSummary = groups
        .map((g) => `• ${g.label}: ${g.files.join(', ')}`)
        .join('\n');

    if (findings.length === 0) {
        return (
            `Investigation subagents have examined all ${totalFiles} changed files across ${groups.length} groups:\n${groupSummary}\n\n` +
            'No issues were found during investigation. ' +
            'Write a brief approval review acknowledging the investigation was thorough, then call submit_review.'
        );
    }

    const findingList = findings
        .map(
            (f) =>
                `[${f.id}] ${f.severity} — ${f.title}\n  File: ${f.file}:${f.lineRange[0]}-${f.lineRange[1]}\n  ${f.description}`
        )
        .join('\n\n');

    return (
        `Investigation subagents have examined all ${totalFiles} changed files across ${groups.length} groups:\n${groupSummary}\n\n` +
        `They recorded ${findings.length} finding(s):\n\n${findingList}\n\n` +
        'Write a structured code review based on these findings. ' +
        'Each finding MUST appear in your review — do NOT silently drop any. ' +
        'If you disagree with a finding, call retract_finding with your reason. ' +
        'Then call submit_review.'
    );
}
