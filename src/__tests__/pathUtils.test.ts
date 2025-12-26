import { describe, it, expect } from 'vitest';
import { parseFilePaths, parseFilePathFromUrl, ParsedPath, FILE_PATH_REGEX } from '../lib/pathUtils';

describe('pathUtils', () => {
    describe('FILE_PATH_REGEX', () => {
        it('should match relative paths', () => {
            const text = 'Check src/file.ts for implementation';
            const matches = text.match(FILE_PATH_REGEX);
            expect(matches).toContain(' src/file.ts');
        });

        it('should match paths with line numbers', () => {
            const text = 'Error in src/file.ts:123';
            const matches = text.match(FILE_PATH_REGEX);
            expect(matches).toBeTruthy();
            expect(matches![0]).toContain('src/file.ts:123');
        });

        it('should match quoted paths', () => {
            const text = 'File "src/file.ts" contains error';
            const matches = text.match(FILE_PATH_REGEX);
            expect(matches).toBeTruthy();
            expect(matches![0]).toContain('"src/file.ts"');
        });
    });

    describe('parseFilePaths', () => {
        it('should parse simple relative path', () => {
            const text = 'Check src/components/Button.tsx';
            const paths = parseFilePaths(text);

            expect(paths).toHaveLength(1);
            expect(paths[0]).toEqual({
                fullMatch: ' src/components/Button.tsx',
                filePath: 'src/components/Button.tsx',
                line: undefined,
                column: undefined,
                startIndex: 6,
                endIndex: 31
            });
        });

        it('should parse path with line number', () => {
            const text = 'Error at src/utils/helper.ts:45';
            const paths = parseFilePaths(text);

            expect(paths).toHaveLength(1);
            expect(paths[0]).toEqual({
                fullMatch: ' src/utils/helper.ts:45',
                filePath: 'src/utils/helper.ts',
                line: 45,
                column: undefined,
                startIndex: 9,
                endIndex: 28
            });
        });

        it('should parse path with line and column', () => {
            const text = 'Issue in src/main.ts:12:34';
            const paths = parseFilePaths(text);

            expect(paths).toHaveLength(1);
            expect(paths[0]).toEqual({
                fullMatch: ' src/main.ts:12:34',
                filePath: 'src/main.ts',
                line: 12,
                column: 34,
                startIndex: 9,
                endIndex: 20
            });
        });

        it('should parse quoted paths', () => {
            const text = 'File "src/config.json" not found';
            const paths = parseFilePaths(text);

            expect(paths).toHaveLength(1);
            expect(paths[0].filePath).toBe('src/config.json');
        });

        it('should parse backtick quoted paths', () => {
            const text = 'Check `src/types.ts` file';
            const paths = parseFilePaths(text);

            expect(paths).toHaveLength(1);
            expect(paths[0].filePath).toBe('src/types.ts');
        });

        it('should parse absolute Windows paths', () => {
            const text = 'File C:\\\\Users\\\\test\\\\file.txt exists';
            const paths = parseFilePaths(text);

            expect(paths).toHaveLength(1);
            expect(paths[0].filePath).toBe('C:\\\\Users\\\\test\\\\file.txt');
        });

        it('should parse absolute Unix paths', () => {
            const text = 'Check /home/user/project/file.py';
            const paths = parseFilePaths(text);

            expect(paths).toHaveLength(1);
            expect(paths[0].filePath).toBe('/home/user/project/file.py');
        });

        it('should handle multiple paths in same text', () => {
            const text = 'Files src/a.ts and src/b.js modified';
            const paths = parseFilePaths(text);

            expect(paths).toHaveLength(2);
            expect(paths[0].filePath).toBe('src/a.ts');
            expect(paths[1].filePath).toBe('src/b.js');
        });

        it('should ignore invalid paths', () => {
            const text = 'Invalid: noextension, .hidden, toolong' + 'x'.repeat(500);
            const paths = parseFilePaths(text);

            expect(paths).toHaveLength(0);
        });

        it('should handle empty input', () => {
            const paths = parseFilePaths('');
            expect(paths).toHaveLength(0);
        });

        it('should handle text with no paths', () => {
            const text = 'This is just regular text with no file references';
            const paths = parseFilePaths(text);
            expect(paths).toHaveLength(0);
        });

        it('should handle relative path prefixes', () => {
            const text = 'Files: ./src/file.ts, ../lib/util.js, ../../config.json';
            const paths = parseFilePaths(text);

            expect(paths).toHaveLength(3);
            expect(paths[0].filePath).toBe('./src/file.ts');
            expect(paths[1].filePath).toBe('../lib/util.js');
            expect(paths[2].filePath).toBe('../../config.json');
        });

        it('should parse markdown-style code blocks', () => {
            const text = 'Error in `src/components/Header.tsx` at line 42';
            const paths = parseFilePaths(text);

            expect(paths).toHaveLength(1);
            expect(paths[0].filePath).toBe('src/components/Header.tsx');
            expect(paths[0].line).toBe(42);
        });

        it('should parse simple Windows paths', () => {
            const text = 'Found error in d:\\dev\\test.cpp at line 45';
            const paths = parseFilePaths(text);

            expect(paths).toHaveLength(1);
            expect(paths[0].filePath).toBe('d:\\dev\\test.cpp');
            expect(paths[0].line).toBe(45);
        });
    });

    describe('parseFilePathFromUrl', () => {
        it('should parse file path without line numbers', () => {
            const result = parseFilePathFromUrl('src/components/Button.tsx');
            expect(result).toEqual({
                filePath: 'src/components/Button.tsx',
                line: undefined,
                column: undefined
            });
        });

        it('should parse file path with line number', () => {
            const result = parseFilePathFromUrl('src/utils/helper.ts:45');
            expect(result).toEqual({
                filePath: 'src/utils/helper.ts',
                line: 45,
                column: undefined
            });
        });

        it('should parse file path with line and column', () => {
            const result = parseFilePathFromUrl('src/main.ts:12:34');
            expect(result).toEqual({
                filePath: 'src/main.ts',
                line: 12,
                column: 34
            });
        });

        it('should return null for external URLs', () => {
            expect(parseFilePathFromUrl('https://example.com/file.ts')).toBeNull();
            expect(parseFilePathFromUrl('http://localhost:3000/test.js')).toBeNull();
            expect(parseFilePathFromUrl('mailto:test@example.com')).toBeNull();
            expect(parseFilePathFromUrl('ftp://server.com/file.txt')).toBeNull();
        });

        it('should return null for paths without extension', () => {
            expect(parseFilePathFromUrl('src/components/Button')).toBeNull();
            expect(parseFilePathFromUrl('no-extension')).toBeNull();
        });

        it('should return null for invalid file paths', () => {
            expect(parseFilePathFromUrl('invalid:path')).toBeNull();
            expect(parseFilePathFromUrl('..')).toBeNull();
            expect(parseFilePathFromUrl('.')).toBeNull();
        });

        it('should handle relative paths with ./ and ../', () => {
            const result1 = parseFilePathFromUrl('./src/file.ts');
            expect(result1).toEqual({
                filePath: './src/file.ts',
                line: undefined,
                column: undefined
            });

            const result2 = parseFilePathFromUrl('../lib/util.js:10');
            expect(result2).toEqual({
                filePath: '../lib/util.js',
                line: 10,
                column: undefined
            });
        });

        it('should handle absolute Unix paths', () => {
            const result = parseFilePathFromUrl('/home/user/project/file.py:25');
            expect(result).toEqual({
                filePath: '/home/user/project/file.py',
                line: 25,
                column: undefined
            });
        });

        it('should return null for empty string', () => {
            expect(parseFilePathFromUrl('')).toBeNull();
        });

        it('should return null for paths that are too short', () => {
            expect(parseFilePathFromUrl('a')).toBeNull();
            expect(parseFilePathFromUrl('.b')).toBeNull();
        });

        it('should handle paths with multiple dots in filename', () => {
            const result = parseFilePathFromUrl('src/file.spec.ts:10:5');
            expect(result).toEqual({
                filePath: 'src/file.spec.ts',
                line: 10,
                column: 5
            });
        });
    });
});