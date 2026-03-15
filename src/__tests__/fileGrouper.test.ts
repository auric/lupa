import { describe, it, expect } from 'vitest';
import type { DiffHunk } from '../types/contextTypes';
import { groupFilesForReview } from '../services/fileGrouper';

function makeDiffHunk(filePath: string, changedLines = 10): DiffHunk {
    return {
        filePath,
        hunks: [
            {
                oldStart: 1,
                oldLines: changedLines,
                newStart: 1,
                newLines: changedLines,
                parsedLines: Array.from({ length: changedLines }, (_, i) => ({
                    type: 'added' as const,
                    content: `line ${i}`,
                    lineNumber: i + 1,
                })),
                hunkId: `${filePath}-1`,
                hunkHeader: '@@ -1,10 +1,10 @@',
            },
        ],
        isNewFile: false,
        isDeletedFile: false,
        originalHeader: `diff --git a/${filePath} b/${filePath}`,
    };
}

describe('groupFilesForReview', () => {
    it('returns empty array for empty diff', () => {
        expect(groupFilesForReview([])).toEqual([]);
    });

    it('returns single group for single file', () => {
        const result = groupFilesForReview([
            makeDiffHunk('src/services/foo.ts'),
        ]);
        expect(result).toHaveLength(1);
        expect(result[0].files).toEqual(['src/services/foo.ts']);
        expect(result[0].complexity).toBe('source');
    });

    it('groups multiple source files in the same directory', () => {
        const result = groupFilesForReview([
            makeDiffHunk('src/services/foo.ts'),
            makeDiffHunk('src/services/bar.ts'),
            makeDiffHunk('src/services/baz.ts'),
        ]);
        const serviceGroup = result.find((g) => g.label === 'src/services');
        expect(serviceGroup).toBeDefined();
        expect(serviceGroup!.files).toHaveLength(3);
        expect(serviceGroup!.complexity).toBe('source');
        expect(serviceGroup!.priority).toBe(3);
    });

    it('pairs test files with their source group', () => {
        const result = groupFilesForReview([
            makeDiffHunk('src/services/foo.ts'),
            makeDiffHunk('src/__tests__/foo.test.ts'),
        ]);
        // Test should be merged into source group
        const sourceGroup = result.find((g) =>
            g.files.includes('src/services/foo.ts')
        );
        expect(sourceGroup).toBeDefined();
        expect(sourceGroup!.files).toContain('src/__tests__/foo.test.ts');
    });

    it('puts unmatched tests in a separate Tests group', () => {
        const result = groupFilesForReview([
            makeDiffHunk('src/services/foo.ts'),
            makeDiffHunk('src/__tests__/orphan.test.ts'),
        ]);
        const testGroup = result.find((g) => g.label === 'Tests');
        expect(testGroup).toBeDefined();
        expect(testGroup!.files).toContain('src/__tests__/orphan.test.ts');
        expect(testGroup!.complexity).toBe('test');
        expect(testGroup!.priority).toBe(2);
    });

    it('classifies config files correctly', () => {
        const result = groupFilesForReview([
            makeDiffHunk('package.json', 5),
            makeDiffHunk('tsconfig.json', 3),
            makeDiffHunk('.gitignore', 2),
            makeDiffHunk('src/services/foo.ts'),
        ]);
        const configGroup = result.find((g) => g.label === 'Configuration');
        expect(configGroup).toBeDefined();
        expect(configGroup!.files).toHaveLength(3);
        expect(configGroup!.complexity).toBe('config');
        expect(configGroup!.priority).toBe(1);
    });

    it('does not classify large config-extension files as config', () => {
        const result = groupFilesForReview([makeDiffHunk('package.json', 25)]);
        expect(result[0].complexity).toBe('source');
    });

    it('splits groups exceeding maxFilesPerGroup', () => {
        const result = groupFilesForReview(
            [
                makeDiffHunk('src/services/a.ts'),
                makeDiffHunk('src/services/b.ts'),
                makeDiffHunk('src/services/c.ts'),
                makeDiffHunk('src/services/d.ts'),
                makeDiffHunk('src/services/e.ts'),
                makeDiffHunk('src/services/f.ts'),
            ],
            { maxFilesPerGroup: 3 }
        );
        const splitGroups = result.filter((g) =>
            g.label.includes('src/services')
        );
        expect(splitGroups).toHaveLength(2);
        expect(splitGroups[0].label).toContain('1 of 2');
        expect(splitGroups[1].label).toContain('2 of 2');
    });

    it('groups root directory files as "Root files"', () => {
        const result = groupFilesForReview([
            makeDiffHunk('main.ts'),
            makeDiffHunk('index.ts'),
        ]);
        const rootGroup = result.find((g) => g.label === 'Root files');
        expect(rootGroup).toBeDefined();
        expect(rootGroup!.files).toHaveLength(2);
    });

    it('stays within maxGroups for large PRs', () => {
        const diffs: DiffHunk[] = [];
        for (let i = 0; i < 25; i++) {
            diffs.push(makeDiffHunk(`src/dir${i}/file.ts`));
        }
        const result = groupFilesForReview(diffs, { maxGroups: 10 });
        expect(result.length).toBeLessThanOrEqual(10);
        // All files should still be present
        const allFiles = result.flatMap((g) => g.files);
        expect(allFiles).toHaveLength(25);
    });

    it('handles mixed directory depths', () => {
        const result = groupFilesForReview([
            makeDiffHunk('src/a.ts'),
            makeDiffHunk('src/services/b.ts'),
            makeDiffHunk('src/services/utils/c.ts'),
            makeDiffHunk('lib/d.ts'),
        ]);
        // Each unique directory gets its own group (or merged if tiny)
        const allFiles = result.flatMap((g) => g.files);
        expect(allFiles).toHaveLength(4);
        expect(allFiles).toContain('src/a.ts');
        expect(allFiles).toContain('src/services/b.ts');
        expect(allFiles).toContain('src/services/utils/c.ts');
        expect(allFiles).toContain('lib/d.ts');
    });

    it('handles all-config PR', () => {
        const result = groupFilesForReview([
            makeDiffHunk('package.json', 5),
            makeDiffHunk('.env', 2),
            makeDiffHunk('config/settings.yaml', 3),
        ]);
        expect(result).toHaveLength(1);
        expect(result[0].label).toBe('Configuration');
        expect(result[0].files).toHaveLength(3);
    });

    it('classifies files in config/ directory as config when small', () => {
        const result = groupFilesForReview([
            makeDiffHunk('src/config/defaults.ts', 10),
            makeDiffHunk('src/services/foo.ts'),
        ]);
        const configGroup = result.find((g) => g.label === 'Configuration');
        expect(configGroup).toBeDefined();
        expect(configGroup!.files).toContain('src/config/defaults.ts');
    });

    it('sorts groups by priority descending', () => {
        const result = groupFilesForReview([
            makeDiffHunk('package.json', 3),
            makeDiffHunk('src/__tests__/orphan.test.ts'),
            makeDiffHunk('src/services/foo.ts'),
        ]);
        expect(result[0].priority).toBeGreaterThanOrEqual(
            result[result.length - 1].priority
        );
    });
});
