import { describe, it, expect } from 'vitest';
import {
    SUPPORTED_LANGUAGES,
    getSupportedFilesGlob,
    getExcludePattern,
    getLanguageForExtension,
    type SupportedLanguage,
} from '../types/types';

describe('types.ts', () => {
    describe('SupportedLanguage interface', () => {
        it('should have required properties', () => {
            const language: SupportedLanguage = {
                extension: 'ts',
                language: 'typescript',
                lineCommentMarker: '//',
            };

            expect(language.extension).toBe('ts');
            expect(language.language).toBe('typescript');
            expect(language.lineCommentMarker).toBe('//');
        });

        it('should allow undefined lineCommentMarker for languages without line comments', () => {
            const language: SupportedLanguage = {
                extension: 'css',
                language: 'css',
                lineCommentMarker: undefined,
            };

            expect(language.lineCommentMarker).toBeUndefined();
        });
    });

    describe('SUPPORTED_LANGUAGES constant', () => {
        it('should contain all expected language extensions', () => {
            const expectedExtensions = [
                'js',
                'jsx',
                'ts',
                'tsx',
                'py',
                'pyw',
                'java',
                'c',
                'cpp',
                'h',
                'hpp',
                'cs',
                'go',
                'rb',
                'rs',
                'css',
            ];

            expectedExtensions.forEach((ext) => {
                expect(SUPPORTED_LANGUAGES[ext]).toBeDefined();
                expect(SUPPORTED_LANGUAGES[ext].extension).toBe(ext);
            });
        });

        it('should have correct comment markers for languages with line comments', () => {
            // Languages using // for comments
            const slashCommentLanguages = [
                'js',
                'jsx',
                'ts',
                'tsx',
                'java',
                'c',
                'cpp',
                'h',
                'hpp',
                'cs',
                'go',
                'rs',
            ];
            slashCommentLanguages.forEach((ext) => {
                expect(SUPPORTED_LANGUAGES[ext].lineCommentMarker).toBe('//');
            });

            // Languages using # for comments
            const hashCommentLanguages = ['py', 'pyw', 'rb'];
            hashCommentLanguages.forEach((ext) => {
                expect(SUPPORTED_LANGUAGES[ext].lineCommentMarker).toBe('#');
            });
        });

        it('should have undefined comment marker for CSS (block comments only)', () => {
            expect(
                SUPPORTED_LANGUAGES['css'].lineCommentMarker
            ).toBeUndefined();
        });

        it('should maintain backwards compatibility with existing properties', () => {
            Object.values(SUPPORTED_LANGUAGES).forEach((lang) => {
                expect(lang.extension).toBeDefined();
                expect(lang.language).toBeDefined();
                expect(typeof lang.extension).toBe('string');
                expect(typeof lang.language).toBe('string');

                // Optional properties should be either string or undefined
                if (lang.variant !== undefined) {
                    expect(typeof lang.variant).toBe('string');
                }

                // lineCommentMarker should be either string or undefined
                if (lang.lineCommentMarker !== undefined) {
                    expect(typeof lang.lineCommentMarker).toBe('string');
                    expect(lang.lineCommentMarker.length).toBeGreaterThan(0);
                }
            });
        });
    });

    describe('getSupportedFilesGlob', () => {
        it('should return a valid glob pattern', () => {
            const pattern = getSupportedFilesGlob();
            expect(pattern).toMatch(/^\*\*\/\*\.\{.+\}$/);
            expect(pattern).toContain('js');
            expect(pattern).toContain('ts');
            expect(pattern).toContain('py');
        });
    });

    describe('getExcludePattern', () => {
        it('should return exclude patterns for common directories', () => {
            const pattern = getExcludePattern();
            expect(pattern).toContain('node_modules');
            expect(pattern).toContain('.git');
            expect(pattern).toContain('dist');
            expect(pattern).toContain('build');
            expect(pattern).toContain('.vscode');
        });
    });

    describe('getLanguageForExtension', () => {
        it('should return language data for supported extensions', () => {
            const tsLang = getLanguageForExtension('ts');
            expect(tsLang).toBeDefined();
            expect(tsLang?.extension).toBe('ts');
            expect(tsLang?.language).toBe('typescript');
            expect(tsLang?.lineCommentMarker).toBe('//');
        });

        it('should return undefined for unsupported extensions', () => {
            const unsupported = getLanguageForExtension('xyz');
            expect(unsupported).toBeUndefined();
        });

        it('should handle CSS correctly (undefined comment marker)', () => {
            const cssLang = getLanguageForExtension('css');
            expect(cssLang).toBeDefined();
            expect(cssLang?.lineCommentMarker).toBeUndefined();
        });
    });

    describe('comment marker integration', () => {
        it('should provide safe access to comment markers', () => {
            // Test that the interface supports safe access patterns
            Object.values(SUPPORTED_LANGUAGES).forEach((lang) => {
                // This should not throw - safe access pattern
                const hasLineComments = lang.lineCommentMarker !== undefined;
                if (hasLineComments) {
                    expect(typeof lang.lineCommentMarker).toBe('string');
                    expect(lang.lineCommentMarker!.length).toBeGreaterThan(0);
                }
            });
        });

        it('should support graceful handling of missing markers', () => {
            // Simulate the filtering logic that would use these markers
            const processLanguageComments = (
                lang: SupportedLanguage,
                codeText: string
            ) => {
                if (lang.lineCommentMarker === undefined) {
                    // Should gracefully handle languages without line comments
                    return codeText; // No filtering for languages like CSS
                }

                // Would normally filter out comments here
                return codeText
                    .split('\n')
                    .filter(
                        (line) =>
                            !line.trim().startsWith(lang.lineCommentMarker!)
                    )
                    .join('\n');
            };

            const cssLang = SUPPORTED_LANGUAGES['css'];
            const jsLang = SUPPORTED_LANGUAGES['js'];
            const testCode = '// This is a comment\nconsole.log("hello");';

            // Should not throw for CSS (undefined marker)
            expect(() =>
                processLanguageComments(cssLang, testCode)
            ).not.toThrow();

            // Should work normally for JS
            expect(() =>
                processLanguageComments(jsLang, testCode)
            ).not.toThrow();
        });
    });
});
