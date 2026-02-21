import { describe, it, expect } from 'vitest';
import { ListChangedFilesTool } from '../tools/listChangedFilesTool';
import { createMockExecutionContext } from './testUtils/mockFactories';
import type { DiffHunk } from '../types/contextTypes';

function createTestDiff(): DiffHunk[] {
    return [
        {
            filePath: 'src/services/auth.ts',
            isNewFile: false,
            isDeletedFile: false,
            originalHeader:
                'diff --git a/src/services/auth.ts b/src/services/auth.ts',
            hunks: [
                {
                    oldStart: 10,
                    oldLines: 5,
                    newStart: 10,
                    newLines: 8,
                    hunkId: 'src/services/auth.ts:10',
                    hunkHeader: '@@ -10,5 +10,8 @@',
                    parsedLines: [
                        {
                            type: 'context',
                            content: 'import { hash } from "crypto";',
                            lineNumber: 10,
                        },
                        {
                            type: 'removed',
                            content: 'const secret = "old";',
                            lineNumber: 11,
                        },
                        {
                            type: 'added',
                            content: 'const secret = process.env.SECRET;',
                            lineNumber: 11,
                        },
                        {
                            type: 'added',
                            content:
                                'if (!secret) throw new Error("Missing SECRET");',
                            lineNumber: 12,
                        },
                        { type: 'added', content: '', lineNumber: 13 },
                        {
                            type: 'context',
                            content: 'export function authenticate() {',
                            lineNumber: 14,
                        },
                    ],
                },
            ],
        },
        {
            filePath: 'src/utils/helpers.ts',
            isNewFile: true,
            isDeletedFile: false,
            originalHeader:
                'diff --git a/src/utils/helpers.ts b/src/utils/helpers.ts',
            hunks: [
                {
                    oldStart: 0,
                    oldLines: 0,
                    newStart: 1,
                    newLines: 3,
                    hunkId: 'src/utils/helpers.ts:1',
                    hunkHeader: '@@ -0,0 +1,3 @@',
                    parsedLines: [
                        {
                            type: 'added',
                            content: 'export function helper() {',
                            lineNumber: 1,
                        },
                        {
                            type: 'added',
                            content: '  return true;',
                            lineNumber: 2,
                        },
                        { type: 'added', content: '}', lineNumber: 3 },
                    ],
                },
            ],
        },
        {
            filePath: 'src/old/legacy.ts',
            isNewFile: false,
            isDeletedFile: true,
            originalHeader:
                'diff --git a/src/old/legacy.ts b/src/old/legacy.ts',
            hunks: [
                {
                    oldStart: 1,
                    oldLines: 2,
                    newStart: 0,
                    newLines: 0,
                    hunkId: 'src/old/legacy.ts:0',
                    hunkHeader: '@@ -1,2 +0,0 @@',
                    parsedLines: [
                        {
                            type: 'removed',
                            content: 'export const old = true;',
                            lineNumber: undefined,
                        },
                        {
                            type: 'removed',
                            content: 'export const legacy = true;',
                            lineNumber: undefined,
                        },
                    ],
                },
            ],
        },
    ];
}

describe('ListChangedFilesTool', () => {
    const tool = new ListChangedFilesTool();

    it('has correct name and description', () => {
        expect(tool.name).toBe('list_changed_files');
        expect(tool.description).toContain('changed');
    });

    it('returns error when no diff data in context', async () => {
        const context = createMockExecutionContext();
        const result = await tool.execute({}, context);
        expect(result.success).toBe(false);
        expect(result.error).toContain('No diff data available');
    });

    it('returns error for empty diff', async () => {
        const context = createMockExecutionContext({ parsedDiff: [] });
        const result = await tool.execute({}, context);
        expect(result.success).toBe(false);
        expect(result.error).toContain('No diff data available');
    });

    it('lists all changed files with stats by default', async () => {
        const context = createMockExecutionContext({
            parsedDiff: createTestDiff(),
        });
        const result = await tool.execute({}, context);

        expect(result.success).toBe(true);
        expect(result.data).toContain('Changed files: 3');
        expect(result.data).toContain('src/services/auth.ts [modified]');
        expect(result.data).toContain('src/utils/helpers.ts [added]');
        expect(result.data).toContain('src/old/legacy.ts [deleted]');
        // Should include stats
        expect(result.data).toContain('+3 -1');
        expect(result.data).toContain('+3 -0');
        expect(result.data).toContain('+0 -2');
        // Total
        expect(result.data).toContain('Total: +6 -3');
    });

    it('lists files without stats when include_stats is false', async () => {
        const context = createMockExecutionContext({
            parsedDiff: createTestDiff(),
        });
        const result = await tool.execute({ include_stats: false }, context);

        expect(result.success).toBe(true);
        expect(result.data).toContain('src/services/auth.ts [modified]');
        expect(result.data).not.toContain('Total:');
        expect(result.data).not.toContain('hunk');
    });

    it('shows correct hunk counts', async () => {
        const context = createMockExecutionContext({
            parsedDiff: createTestDiff(),
        });
        const result = await tool.execute({}, context);

        expect(result.success).toBe(true);
        expect(result.data).toContain('1 hunk)');
    });

    it('uses plural for multiple hunks', async () => {
        const diff = createTestDiff();
        // Add a second hunk to the first file
        diff[0].hunks.push({
            oldStart: 30,
            oldLines: 3,
            newStart: 33,
            newLines: 4,
            hunkId: 'src/services/auth.ts:33',
            hunkHeader: '@@ -30,3 +33,4 @@',
            parsedLines: [
                { type: 'added', content: 'new line', lineNumber: 33 },
            ],
        });

        const context = createMockExecutionContext({ parsedDiff: diff });
        const result = await tool.execute({}, context);

        expect(result.success).toBe(true);
        expect(result.data).toContain('2 hunks)');
    });
});
