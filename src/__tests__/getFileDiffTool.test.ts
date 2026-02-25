import { describe, it, expect } from 'vitest';
import { GetFileDiffTool } from '../tools/getFileDiffTool';
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
                        },
                        {
                            type: 'removed',
                            content: 'export const legacy = true;',
                        },
                    ],
                },
            ],
        },
    ];
}

describe('GetFileDiffTool', () => {
    const tool = new GetFileDiffTool();

    it('has correct name and description', () => {
        expect(tool.name).toBe('get_file_diff');
        expect(tool.description).toContain('diff');
    });

    it('returns error when no diff data in context', async () => {
        const context = createMockExecutionContext();
        const result = await tool.execute(
            { file_paths: ['src/services/auth.ts'] },
            context
        );
        expect(result.success).toBe(false);
        expect(result.error).toContain('No diff data available');
    });

    it('returns error for empty diff', async () => {
        const context = createMockExecutionContext({ parsedDiff: [] });
        const result = await tool.execute(
            { file_paths: ['src/services/auth.ts'] },
            context
        );
        expect(result.success).toBe(false);
        expect(result.error).toContain('No diff data available');
    });

    it('returns diff for a specific file', async () => {
        const context = createMockExecutionContext({
            parsedDiff: createTestDiff(),
        });
        const result = await tool.execute(
            { file_paths: ['src/services/auth.ts'] },
            context
        );

        expect(result.success).toBe(true);
        expect(result.data).toContain('=== src/services/auth.ts ===');
        expect(result.data).toContain('@@ -10,5 +10,8 @@');
        expect(result.data).toContain('+const secret = process.env.SECRET;');
        expect(result.data).toContain('-const secret = "old";');
        expect(result.data).toContain(' import { hash } from "crypto";');
    });

    it('returns diff for a new file', async () => {
        const context = createMockExecutionContext({
            parsedDiff: createTestDiff(),
        });
        const result = await tool.execute(
            { file_paths: ['src/utils/helpers.ts'] },
            context
        );

        expect(result.success).toBe(true);
        expect(result.data).toContain(
            '=== src/utils/helpers.ts (new file) ==='
        );
        expect(result.data).toContain('+export function helper() {');
    });

    it('returns diff for a deleted file', async () => {
        const context = createMockExecutionContext({
            parsedDiff: createTestDiff(),
        });
        const result = await tool.execute(
            { file_paths: ['src/old/legacy.ts'] },
            context
        );

        expect(result.success).toBe(true);
        expect(result.data).toContain('=== src/old/legacy.ts (deleted) ===');
        expect(result.data).toContain('-export const old = true;');
    });

    it('returns diff for multiple files', async () => {
        const context = createMockExecutionContext({
            parsedDiff: createTestDiff(),
        });
        const result = await tool.execute(
            { file_paths: ['src/services/auth.ts', 'src/utils/helpers.ts'] },
            context
        );

        expect(result.success).toBe(true);
        expect(result.data).toContain('=== src/services/auth.ts ===');
        expect(result.data).toContain(
            '=== src/utils/helpers.ts (new file) ==='
        );
    });

    it('returns error when no files match', async () => {
        const context = createMockExecutionContext({
            parsedDiff: createTestDiff(),
        });
        const result = await tool.execute(
            { file_paths: ['nonexistent.ts'] },
            context
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('No matching files found');
        expect(result.error).toContain('nonexistent.ts');
    });

    it('matches partial file paths with path separator boundary', async () => {
        const context = createMockExecutionContext({
            parsedDiff: createTestDiff(),
        });
        const result = await tool.execute(
            { file_paths: ['services/auth.ts'] },
            context
        );

        expect(result.success).toBe(true);
        expect(result.data).toContain('=== src/services/auth.ts ===');
    });

    it('rejects ambiguous partial path matches', async () => {
        const ambiguousDiff: DiffHunk[] = [
            {
                filePath: 'src/components/Button.tsx',
                isNewFile: false,
                isDeletedFile: false,
                originalHeader:
                    'diff --git a/src/components/Button.tsx b/src/components/Button.tsx',
                hunks: [
                    {
                        oldStart: 1,
                        oldLines: 1,
                        newStart: 1,
                        newLines: 1,
                        hunkId: 'src/components/Button.tsx:1',
                        hunkHeader: '@@ -1,1 +1,1 @@',
                        parsedLines: [
                            { type: 'added', content: 'export const A = 1;' },
                        ],
                    },
                ],
            },
            {
                filePath: 'src/utils/Button.tsx',
                isNewFile: false,
                isDeletedFile: false,
                originalHeader:
                    'diff --git a/src/utils/Button.tsx b/src/utils/Button.tsx',
                hunks: [
                    {
                        oldStart: 1,
                        oldLines: 1,
                        newStart: 1,
                        newLines: 1,
                        hunkId: 'src/utils/Button.tsx:1',
                        hunkHeader: '@@ -1,1 +1,1 @@',
                        parsedLines: [
                            { type: 'added', content: 'export const B = 2;' },
                        ],
                    },
                ],
            },
        ];

        const context = createMockExecutionContext({
            parsedDiff: ambiguousDiff,
        });
        const result = await tool.execute(
            { file_paths: ['Button.tsx'] },
            context
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('ambiguous');
    });

    it('returns partial success when mixing valid and ambiguous paths', async () => {
        const mixedDiff: DiffHunk[] = [
            {
                filePath: 'src/components/Button.tsx',
                isNewFile: false,
                isDeletedFile: false,
                originalHeader:
                    'diff --git a/src/components/Button.tsx b/src/components/Button.tsx',
                hunks: [
                    {
                        oldStart: 1,
                        oldLines: 1,
                        newStart: 1,
                        newLines: 1,
                        hunkId: 'src/components/Button.tsx:1',
                        hunkHeader: '@@ -1,1 +1,1 @@',
                        parsedLines: [
                            { type: 'added', content: 'export const A = 1;' },
                        ],
                    },
                ],
            },
            {
                filePath: 'src/utils/Button.tsx',
                isNewFile: false,
                isDeletedFile: false,
                originalHeader:
                    'diff --git a/src/utils/Button.tsx b/src/utils/Button.tsx',
                hunks: [
                    {
                        oldStart: 1,
                        oldLines: 1,
                        newStart: 1,
                        newLines: 1,
                        hunkId: 'src/utils/Button.tsx:1',
                        hunkHeader: '@@ -1,1 +1,1 @@',
                        parsedLines: [
                            { type: 'added', content: 'export const B = 2;' },
                        ],
                    },
                ],
            },
        ];

        const context = createMockExecutionContext({
            parsedDiff: mixedDiff,
        });
        // 'src/components/Button.tsx' is a valid full path; 'Button.tsx' is ambiguous
        const result = await tool.execute(
            {
                file_paths: ['src/components/Button.tsx', 'Button.tsx'],
            },
            context
        );

        expect(result.success).toBe(true);
        expect(result.data).toContain('=== src/components/Button.tsx ===');
        expect(result.data).toContain('ambiguous');
    });

    it('includes not-found note when some files match and some do not', async () => {
        const context = createMockExecutionContext({
            parsedDiff: createTestDiff(),
        });
        const result = await tool.execute(
            { file_paths: ['src/services/auth.ts', 'nonexistent.ts'] },
            context
        );

        expect(result.success).toBe(true);
        expect(result.data).toContain('=== src/services/auth.ts ===');
        expect(result.data).toContain(
            'Note: No diff found for: nonexistent.ts'
        );
    });

    it('excludes context lines when context_lines is false', async () => {
        const context = createMockExecutionContext({
            parsedDiff: createTestDiff(),
        });
        const result = await tool.execute(
            { file_paths: ['src/services/auth.ts'], context_lines: false },
            context
        );

        expect(result.success).toBe(true);
        expect(result.data).toContain('+const secret = process.env.SECRET;');
        expect(result.data).toContain('-const secret = "old";');
        // Context lines should NOT appear
        expect(result.data).not.toContain(' import { hash } from "crypto";');
        expect(result.data).not.toContain(' export function authenticate()');
    });

    it('includes context lines by default', async () => {
        const context = createMockExecutionContext({
            parsedDiff: createTestDiff(),
        });
        const result = await tool.execute(
            { file_paths: ['src/services/auth.ts'] },
            context
        );

        expect(result.success).toBe(true);
        expect(result.data).toContain(' import { hash } from "crypto";');
    });

    it('normalizes Windows-style backslash paths', async () => {
        const context = createMockExecutionContext({
            parsedDiff: createTestDiff(),
        });
        const result = await tool.execute(
            { file_paths: ['src\\services\\auth.ts'] },
            context
        );

        expect(result.success).toBe(true);
        expect(result.data).toContain('src/services/auth.ts');
    });

    it('strips leading ./ from requested paths', async () => {
        const context = createMockExecutionContext({
            parsedDiff: createTestDiff(),
        });
        const result = await tool.execute(
            { file_paths: ['./src/services/auth.ts'] },
            context
        );

        expect(result.success).toBe(true);
        expect(result.data).toContain('src/services/auth.ts');
    });

    it('strips leading / from requested paths', async () => {
        const context = createMockExecutionContext({
            parsedDiff: createTestDiff(),
        });
        const result = await tool.execute(
            { file_paths: ['/src/services/auth.ts'] },
            context
        );

        expect(result.success).toBe(true);
        expect(result.data).toContain('src/services/auth.ts');
    });

    it('trims whitespace from file paths via schema', async () => {
        const context = createMockExecutionContext({
            parsedDiff: createTestDiff(),
        });
        const result = await tool.execute(
            { file_paths: ['  src/services/auth.ts  '] },
            context
        );

        expect(result.success).toBe(true);
        expect(result.data).toContain('src/services/auth.ts');
    });

    it('prioritizes exact match over suffix matches', async () => {
        const diffWithExactAndSuffix: DiffHunk[] = [
            {
                filePath: 'Button.tsx',
                isNewFile: true,
                isDeletedFile: false,
                originalHeader: 'diff --git a/Button.tsx b/Button.tsx',
                hunks: [
                    {
                        oldStart: 0,
                        oldLines: 0,
                        newStart: 1,
                        newLines: 1,
                        hunkId: 'Button.tsx:1',
                        hunkHeader: '@@ -0,0 +1,1 @@',
                        parsedLines: [
                            {
                                type: 'added',
                                content: 'export const Root = 1;',
                            },
                        ],
                    },
                ],
            },
            {
                filePath: 'src/components/Button.tsx',
                isNewFile: false,
                isDeletedFile: false,
                originalHeader:
                    'diff --git a/src/components/Button.tsx b/src/components/Button.tsx',
                hunks: [
                    {
                        oldStart: 1,
                        oldLines: 1,
                        newStart: 1,
                        newLines: 1,
                        hunkId: 'src/components/Button.tsx:1',
                        hunkHeader: '@@ -1,1 +1,1 @@',
                        parsedLines: [
                            {
                                type: 'added',
                                content: 'export const Comp = 2;',
                            },
                        ],
                    },
                ],
            },
        ];

        const context = createMockExecutionContext({
            parsedDiff: diffWithExactAndSuffix,
        });
        const result = await tool.execute(
            { file_paths: ['Button.tsx'] },
            context
        );

        // Should match the exact "Button.tsx", not report ambiguous
        expect(result.success).toBe(true);
        expect(result.data).toContain('=== Button.tsx (new file) ===');
        expect(result.data).toContain('Root = 1');
        expect(result.data).not.toContain('Comp = 2');
    });

    it('rejects more than 10 files via schema validation', () => {
        const elevenFiles = Array.from({ length: 11 }, (_, i) => `file${i}.ts`);

        // Schema validation happens in ToolExecutor, not execute() directly.
        // Test the Zod schema rejects > 10 items.
        const result = tool.schema.safeParse({ file_paths: elevenFiles });
        expect(result.success).toBe(false);
    });

    it('accepts exactly 10 files via schema validation', () => {
        const tenFiles = Array.from({ length: 10 }, (_, i) => `file${i}.ts`);

        const result = tool.schema.safeParse({ file_paths: tenFiles });
        expect(result.success).toBe(true);
    });
});
