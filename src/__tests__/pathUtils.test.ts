import { describe, it, expect } from 'vitest';
import {
    parseFilePaths,
    parseFilePathFromUrl,
    parseMarkdownFileLinks,
    FILE_PATH_REGEX,
} from '../lib/pathUtils';

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
                endIndex: 31,
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
                endIndex: 28,
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
                endIndex: 20,
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
            const text =
                'Invalid: noextension, .hidden, toolong' + 'x'.repeat(500);
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
            const text =
                'Files: ./src/file.ts, ../lib/util.js, ../../config.json';
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
                endLine: undefined,
                column: undefined,
            });
        });

        it('should parse file path with line number', () => {
            const result = parseFilePathFromUrl('src/utils/helper.ts:45');
            expect(result).toEqual({
                filePath: 'src/utils/helper.ts',
                line: 45,
                endLine: undefined,
                column: undefined,
            });
        });

        it('should parse file path with line and column', () => {
            const result = parseFilePathFromUrl('src/main.ts:12:34');
            expect(result).toEqual({
                filePath: 'src/main.ts',
                line: 12,
                endLine: undefined,
                column: 34,
            });
        });

        it('should parse file path with line range', () => {
            const result = parseFilePathFromUrl('src/file.cpp:104-115');
            expect(result).toEqual({
                filePath: 'src/file.cpp',
                line: 104,
                endLine: 115,
                column: undefined,
            });
        });

        it('should handle dot files without extensions', () => {
            const result1 = parseFilePathFromUrl('.gitignore');
            expect(result1).toEqual({
                filePath: '.gitignore',
                line: undefined,
                endLine: undefined,
                column: undefined,
            });

            const result2 = parseFilePathFromUrl('.env');
            expect(result2).toEqual({
                filePath: '.env',
                line: undefined,
                endLine: undefined,
                column: undefined,
            });

            const result3 = parseFilePathFromUrl('src/.env:10');
            expect(result3).toEqual({
                filePath: 'src/.env',
                line: 10,
                endLine: undefined,
                column: undefined,
            });
        });

        it('should handle dot files with extensions', () => {
            const result = parseFilePathFromUrl('.eslintrc.js:25');
            expect(result).toEqual({
                filePath: '.eslintrc.js',
                line: 25,
                endLine: undefined,
                column: undefined,
            });
        });

        it('should return null for external URLs', () => {
            expect(
                parseFilePathFromUrl('https://example.com/file.ts')
            ).toBeNull();
            expect(
                parseFilePathFromUrl('http://localhost:3000/test.js')
            ).toBeNull();
            expect(parseFilePathFromUrl('mailto:test@example.com')).toBeNull();
            expect(
                parseFilePathFromUrl('ftp://server.com/file.txt')
            ).toBeNull();
        });

        it('should return null for paths without extension or dot prefix', () => {
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
                endLine: undefined,
                column: undefined,
            });

            const result2 = parseFilePathFromUrl('../lib/util.js:10');
            expect(result2).toEqual({
                filePath: '../lib/util.js',
                line: 10,
                endLine: undefined,
                column: undefined,
            });
        });

        it('should handle absolute Unix paths', () => {
            const result = parseFilePathFromUrl(
                '/home/user/project/file.py:25'
            );
            expect(result).toEqual({
                filePath: '/home/user/project/file.py',
                line: 25,
                endLine: undefined,
                column: undefined,
            });
        });

        it('should handle Windows absolute paths with drive letter', () => {
            const result = parseFilePathFromUrl('C:\\src\\file.ts:42');
            expect(result).toEqual({
                filePath: 'C:\\src\\file.ts',
                line: 42,
                endLine: undefined,
                column: undefined,
            });
        });

        it('should handle Windows paths with line and column', () => {
            const result = parseFilePathFromUrl(
                'D:\\project\\src\\main.ts:10:5'
            );
            expect(result).toEqual({
                filePath: 'D:\\project\\src\\main.ts',
                line: 10,
                endLine: undefined,
                column: 5,
            });
        });

        it('should handle Windows paths with forward slashes', () => {
            const result = parseFilePathFromUrl('C:/Users/test/file.txt:100');
            expect(result).toEqual({
                filePath: 'C:/Users/test/file.txt',
                line: 100,
                endLine: undefined,
                column: undefined,
            });
        });

        it('should handle Windows paths without line numbers', () => {
            const result = parseFilePathFromUrl(
                'E:\\dev\\copilot-review\\src\\extension.ts'
            );
            expect(result).toEqual({
                filePath: 'E:\\dev\\copilot-review\\src\\extension.ts',
                line: undefined,
                endLine: undefined,
                column: undefined,
            });
        });

        it('should return null for empty string', () => {
            expect(parseFilePathFromUrl('')).toBeNull();
        });

        it('should return null for paths that are too short', () => {
            expect(parseFilePathFromUrl('a')).toBeNull();
        });

        it('should handle very short dot files', () => {
            // Short dot files like .b are valid (similar to .a, .z, etc.)
            const result = parseFilePathFromUrl('.b');
            expect(result).toEqual({
                filePath: '.b',
                line: undefined,
                endLine: undefined,
                column: undefined,
            });
        });

        it('should handle paths with multiple dots in filename', () => {
            const result = parseFilePathFromUrl('src/file.spec.ts:10:5');
            expect(result).toEqual({
                filePath: 'src/file.spec.ts',
                line: 10,
                endLine: undefined,
                column: 5,
            });
        });

        it('should handle root-level files without directory prefix', () => {
            // Root-level files like README.md, package.json are common in projects
            const result1 = parseFilePathFromUrl('README.md:10');
            expect(result1).toEqual({
                filePath: 'README.md',
                line: 10,
                endLine: undefined,
                column: undefined,
            });

            const result2 = parseFilePathFromUrl('package.json:25');
            expect(result2).toEqual({
                filePath: 'package.json',
                line: 25,
                endLine: undefined,
                column: undefined,
            });

            const result3 = parseFilePathFromUrl('tsconfig.json');
            expect(result3).toEqual({
                filePath: 'tsconfig.json',
                line: undefined,
                endLine: undefined,
                column: undefined,
            });

            const result4 = parseFilePathFromUrl('vite.config.mts:42:8');
            expect(result4).toEqual({
                filePath: 'vite.config.mts',
                line: 42,
                endLine: undefined,
                column: 8,
            });
        });

        it('should handle root-level files with line ranges', () => {
            const result = parseFilePathFromUrl('CHANGELOG.md:1-50');
            expect(result).toEqual({
                filePath: 'CHANGELOG.md',
                line: 1,
                endLine: 50,
                column: undefined,
            });
        });

        it('should handle GitHub-style line format with L prefix', () => {
            const result = parseFilePathFromUrl('src/file.ts#L42');
            expect(result).toEqual({
                filePath: 'src/file.ts',
                line: 42,
                endLine: undefined,
                column: undefined,
            });
        });

        it('should handle GitHub-style line range with L prefix', () => {
            const result = parseFilePathFromUrl('src/file.cpp#L79-L85');
            expect(result).toEqual({
                filePath: 'src/file.cpp',
                line: 79,
                endLine: 85,
                column: undefined,
            });
        });

        it('should handle GitHub-style mixed format (L only on first)', () => {
            const result = parseFilePathFromUrl(
                'src/Plugin/Source/File.cpp#L79-85'
            );
            expect(result).toEqual({
                filePath: 'src/Plugin/Source/File.cpp',
                line: 79,
                endLine: 85,
                column: undefined,
            });
        });

        it('should handle GitHub-style links with Windows paths', () => {
            const result = parseFilePathFromUrl('C:\\src\\file.ts#L100');
            expect(result).toEqual({
                filePath: 'C:\\src\\file.ts',
                line: 100,
                endLine: undefined,
                column: undefined,
            });
        });

        it('should handle GitHub-style links for root-level files', () => {
            const result = parseFilePathFromUrl('README.md#L15');
            expect(result).toEqual({
                filePath: 'README.md',
                line: 15,
                endLine: undefined,
                column: undefined,
            });
        });
    });

    describe('parseMarkdownFileLinks', () => {
        it('should parse simple markdown with no links', () => {
            const result = parseMarkdownFileLinks('Hello world');
            expect(result).toEqual([{ type: 'text', content: 'Hello world' }]);
        });

        it('should parse single file link', () => {
            const result = parseMarkdownFileLinks(
                'Check [file.ts:42](file.ts:42)'
            );
            expect(result).toHaveLength(2);
            expect(result[0]).toEqual({ type: 'text', content: 'Check ' });
            expect(result[1]).toEqual({
                type: 'fileLink',
                content: '[file.ts:42](file.ts:42)',
                filePath: 'file.ts',
                line: 42,
                endLine: undefined,
                column: undefined,
                title: 'file.ts:42',
            });
        });

        it('should parse file link with path', () => {
            const result = parseMarkdownFileLinks(
                'See [handler](src/auth/handler.ts:45)'
            );
            expect(result).toHaveLength(2);
            expect(result[1]).toEqual({
                type: 'fileLink',
                content: '[handler](src/auth/handler.ts:45)',
                filePath: 'src/auth/handler.ts',
                line: 45,
                endLine: undefined,
                column: undefined,
                title: 'handler',
            });
        });

        it('should parse multiple file links', () => {
            const markdown = 'Check [a.ts](a.ts:10) and [b.ts](b.ts:20)';
            const result = parseMarkdownFileLinks(markdown);
            expect(result).toHaveLength(4);
            expect(result[0]).toEqual({ type: 'text', content: 'Check ' });
            expect(result[1].type).toBe('fileLink');
            expect(result[1].filePath).toBe('a.ts');
            expect(result[2]).toEqual({ type: 'text', content: ' and ' });
            expect(result[3].type).toBe('fileLink');
            expect(result[3].filePath).toBe('b.ts');
        });

        it('should preserve external links as text', () => {
            const result = parseMarkdownFileLinks(
                'Visit [Google](https://google.com)'
            );
            expect(result).toEqual([
                { type: 'text', content: 'Visit ' },
                { type: 'text', content: '[Google](https://google.com)' },
            ]);
        });

        it('should handle Windows paths in links', () => {
            const result = parseMarkdownFileLinks(
                'See [main.ts](C:\\project\\main.ts:100)'
            );
            expect(result).toHaveLength(2);
            expect(result[1]).toEqual({
                type: 'fileLink',
                content: '[main.ts](C:\\project\\main.ts:100)',
                filePath: 'C:\\project\\main.ts',
                line: 100,
                endLine: undefined,
                column: undefined,
                title: 'main.ts',
            });
        });

        it('should handle file links with line and column', () => {
            const result = parseMarkdownFileLinks(
                'Error at [file.ts:10:5](file.ts:10:5)'
            );
            expect(result[1]).toEqual({
                type: 'fileLink',
                content: '[file.ts:10:5](file.ts:10:5)',
                filePath: 'file.ts',
                line: 10,
                endLine: undefined,
                column: 5,
                title: 'file.ts:10:5',
            });
        });

        it('should handle file links with line range', () => {
            const result = parseMarkdownFileLinks(
                'Check [file.cpp:104-115](src/file.cpp:104-115)'
            );
            expect(result).toHaveLength(2);
            expect(result[1]).toEqual({
                type: 'fileLink',
                content: '[file.cpp:104-115](src/file.cpp:104-115)',
                filePath: 'src/file.cpp',
                line: 104,
                endLine: 115,
                column: undefined,
                title: 'file.cpp:104-115',
            });
        });

        it('should handle long paths with line ranges', () => {
            const markdown =
                'at [`src/SampleApp/Plugins/Plugin/Source/File.cpp:104-115`](src/SampleApp/Plugins/Plugin/Source/File.cpp:104-115)';
            const result = parseMarkdownFileLinks(markdown);
            expect(result).toHaveLength(2);
            expect(result[0]).toEqual({ type: 'text', content: 'at ' });
            expect(result[1].type).toBe('fileLink');
            expect(result[1].filePath).toBe(
                'src/SampleApp/Plugins/Plugin/Source/File.cpp'
            );
            expect(result[1].line).toBe(104);
            expect(result[1].endLine).toBe(115);
        });

        it('should handle empty string', () => {
            const result = parseMarkdownFileLinks('');
            expect(result).toEqual([]);
        });

        it('should handle mixed content with code blocks', () => {
            const markdown =
                'Issue in [utils.ts](utils.ts:42)\n\n```ts\nconst x = 1;\n```';
            const result = parseMarkdownFileLinks(markdown);
            expect(result).toHaveLength(3);
            expect(result[0]).toEqual({ type: 'text', content: 'Issue in ' });
            expect(result[1].type).toBe('fileLink');
            expect(result[2]).toEqual({
                type: 'text',
                content: '\n\n```ts\nconst x = 1;\n```',
            });
        });

        it('should handle GitHub-style links with L prefix', () => {
            const markdown =
                'See [SolvePoWChallange.cpp:79-85](src/SampleApp/Plugins/Plugin/Source/Accounts/Private/SolvePoWChallange.cpp#L79-L85)';
            const result = parseMarkdownFileLinks(markdown);
            expect(result).toHaveLength(2);
            expect(result[0]).toEqual({ type: 'text', content: 'See ' });
            expect(result[1]).toEqual({
                type: 'fileLink',
                content:
                    '[SolvePoWChallange.cpp:79-85](src/SampleApp/Plugins/Plugin/Source/Accounts/Private/SolvePoWChallange.cpp#L79-L85)',
                filePath:
                    'src/SampleApp/Plugins/Plugin/Source/Accounts/Private/SolvePoWChallange.cpp',
                line: 79,
                endLine: 85,
                column: undefined,
                title: 'SolvePoWChallange.cpp:79-85',
            });
        });

        it('should handle GitHub-style links with mixed L prefix format', () => {
            const result = parseMarkdownFileLinks(
                'Check [file.cpp](src/file.cpp#L42-50)'
            );
            expect(result).toHaveLength(2);
            expect(result[1]).toEqual({
                type: 'fileLink',
                content: '[file.cpp](src/file.cpp#L42-50)',
                filePath: 'src/file.cpp',
                line: 42,
                endLine: 50,
                column: undefined,
                title: 'file.cpp',
            });
        });

        it('should handle root-level file links without directory', () => {
            const result = parseMarkdownFileLinks(
                'See [README.md](README.md:15) for details'
            );
            expect(result).toHaveLength(3);
            expect(result[1]).toEqual({
                type: 'fileLink',
                content: '[README.md](README.md:15)',
                filePath: 'README.md',
                line: 15,
                endLine: undefined,
                column: undefined,
                title: 'README.md',
            });
        });
    });
});
