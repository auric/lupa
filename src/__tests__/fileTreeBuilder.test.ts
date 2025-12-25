import { describe, it, expect } from 'vitest';
import { buildFileTree } from '../utils/fileTreeBuilder';
import type { DiffHunk } from '../types/contextTypes';

describe('buildFileTree', () => {
    describe('basic functionality', () => {
        it('should return empty array for empty input', () => {
            const result = buildFileTree([]);
            expect(result).toEqual([]);
        });

        it('should return empty array for undefined input', () => {
            const result = buildFileTree(undefined as unknown as DiffHunk[]);
            expect(result).toEqual([]);
        });

        it('should handle single file at root level', () => {
            const diff: DiffHunk[] = [
                { filePath: 'README.md', hunks: [], isNewFile: false, isDeletedFile: false, originalHeader: '' }
            ];
            const result = buildFileTree(diff);

            expect(result).toEqual([
                { name: 'README.md' }
            ]);
        });

        it('should handle single file in nested path', () => {
            const diff: DiffHunk[] = [
                { filePath: 'src/utils/helper.ts', hunks: [], isNewFile: false, isDeletedFile: false, originalHeader: '' }
            ];
            const result = buildFileTree(diff);

            expect(result).toEqual([
                {
                    name: 'src',
                    children: [
                        {
                            name: 'utils',
                            children: [
                                { name: 'helper.ts' }
                            ]
                        }
                    ]
                }
            ]);
        });
    });

    describe('hierarchical structure', () => {
        it('should create proper folder hierarchy for multiple files', () => {
            const diff: DiffHunk[] = [
                { filePath: 'src/index.ts', hunks: [], isNewFile: false, isDeletedFile: false, originalHeader: '' },
                { filePath: 'src/utils/helper.ts', hunks: [], isNewFile: false, isDeletedFile: false, originalHeader: '' },
                { filePath: 'src/utils/format.ts', hunks: [], isNewFile: false, isDeletedFile: false, originalHeader: '' }
            ];
            const result = buildFileTree(diff);

            expect(result).toHaveLength(1);
            expect(result[0].name).toBe('src');
            expect(result[0].children).toHaveLength(2);

            // utils folder should be first (folders before files)
            expect(result[0].children![0].name).toBe('utils');
            expect(result[0].children![0].children).toHaveLength(2);

            // index.ts should be after utils folder
            expect(result[0].children![1].name).toBe('index.ts');
        });

        it('should handle files in different root folders', () => {
            const diff: DiffHunk[] = [
                { filePath: 'src/app.ts', hunks: [], isNewFile: false, isDeletedFile: false, originalHeader: '' },
                { filePath: 'tests/app.test.ts', hunks: [], isNewFile: false, isDeletedFile: false, originalHeader: '' }
            ];
            const result = buildFileTree(diff);

            expect(result).toHaveLength(2);
            expect(result[0].name).toBe('src');
            expect(result[1].name).toBe('tests');
        });
    });

    describe('sorting', () => {
        it('should sort folders before files alphabetically', () => {
            const diff: DiffHunk[] = [
                { filePath: 'src/zebra.ts', hunks: [], isNewFile: false, isDeletedFile: false, originalHeader: '' },
                { filePath: 'src/alpha/file.ts', hunks: [], isNewFile: false, isDeletedFile: false, originalHeader: '' },
                { filePath: 'src/apple.ts', hunks: [], isNewFile: false, isDeletedFile: false, originalHeader: '' }
            ];
            const result = buildFileTree(diff);

            const srcChildren = result[0].children!;
            expect(srcChildren[0].name).toBe('alpha'); // folder first
            expect(srcChildren[1].name).toBe('apple.ts'); // then files alphabetically
            expect(srcChildren[2].name).toBe('zebra.ts');
        });
    });

    describe('deduplication', () => {
        it('should handle duplicate file paths from multiple hunks', () => {
            const diff: DiffHunk[] = [
                { filePath: 'src/index.ts', hunks: [], isNewFile: false, isDeletedFile: false, originalHeader: '' },
                { filePath: 'src/index.ts', hunks: [], isNewFile: false, isDeletedFile: false, originalHeader: '' }
            ];
            const result = buildFileTree(diff);

            expect(result).toHaveLength(1);
            expect(result[0].children).toHaveLength(1);
            expect(result[0].children![0].name).toBe('index.ts');
        });
    });

    describe('edge cases', () => {
        it('should handle deeply nested paths', () => {
            const diff: DiffHunk[] = [
                { filePath: 'a/b/c/d/e/f.ts', hunks: [], isNewFile: false, isDeletedFile: false, originalHeader: '' }
            ];
            const result = buildFileTree(diff);

            let current = result[0];
            expect(current.name).toBe('a');
            current = current.children![0];
            expect(current.name).toBe('b');
            current = current.children![0];
            expect(current.name).toBe('c');
            current = current.children![0];
            expect(current.name).toBe('d');
            current = current.children![0];
            expect(current.name).toBe('e');
            current = current.children![0];
            expect(current.name).toBe('f.ts');
            expect(current.children).toBeUndefined();
        });

        it('should handle files with similar prefixes', () => {
            const diff: DiffHunk[] = [
                { filePath: 'src/component.ts', hunks: [], isNewFile: false, isDeletedFile: false, originalHeader: '' },
                { filePath: 'src/components/Button.ts', hunks: [], isNewFile: false, isDeletedFile: false, originalHeader: '' }
            ];
            const result = buildFileTree(diff);

            const srcChildren = result[0].children!;
            expect(srcChildren).toHaveLength(2);
            expect(srcChildren[0].name).toBe('components'); // folder first
            expect(srcChildren[1].name).toBe('component.ts'); // then file
        });
    });
});
