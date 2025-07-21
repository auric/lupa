import { describe, it, expect } from 'vitest';
import { parseFilePaths, ParsedPath, FILE_PATH_REGEX } from '../lib/pathUtils';

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
});