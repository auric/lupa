import { describe, it, expect } from 'vitest';
import { PathSanitizer } from '../utils/pathSanitizer';

describe('PathSanitizer', () => {
    describe('sanitizePath', () => {
        describe('valid paths', () => {
            it('should accept simple relative paths', () => {
                expect(PathSanitizer.sanitizePath('src')).toBe('src');
                expect(PathSanitizer.sanitizePath('src/components')).toBe(
                    'src/components'
                );
                expect(PathSanitizer.sanitizePath('src/utils/helper.ts')).toBe(
                    'src/utils/helper.ts'
                );
            });

            it('should accept current directory reference', () => {
                expect(PathSanitizer.sanitizePath('.')).toBe('.');
                expect(PathSanitizer.sanitizePath('./src')).toBe('src');
                expect(PathSanitizer.sanitizePath('./src/file.ts')).toBe(
                    'src/file.ts'
                );
            });

            it('should handle empty string by returning current directory', () => {
                expect(PathSanitizer.sanitizePath('')).toBe('.');
                expect(PathSanitizer.sanitizePath('   ')).toBe('.');
            });

            it('should normalize redundant path separators', () => {
                expect(PathSanitizer.sanitizePath('src//utils')).toBe(
                    'src/utils'
                );
                expect(
                    PathSanitizer.sanitizePath('src///components//Button.tsx')
                ).toBe('src/components/Button.tsx');
            });

            it('should normalize current directory segments', () => {
                expect(PathSanitizer.sanitizePath('src/./utils')).toBe(
                    'src/utils'
                );
                expect(PathSanitizer.sanitizePath('./src/./utils/.')).toBe(
                    'src/utils'
                );
            });

            it('should preserve file extensions', () => {
                expect(PathSanitizer.sanitizePath('file.ts')).toBe('file.ts');
                expect(PathSanitizer.sanitizePath('src/file.test.tsx')).toBe(
                    'src/file.test.tsx'
                );
            });
        });

        describe('directory traversal prevention', () => {
            it('should reject paths starting with parent directory', () => {
                expect(() => PathSanitizer.sanitizePath('..')).toThrow(
                    'Directory traversal detected'
                );
                expect(() =>
                    PathSanitizer.sanitizePath('../etc/passwd')
                ).toThrow('Directory traversal detected');
                expect(() =>
                    PathSanitizer.sanitizePath('..\\system32')
                ).toThrow('Directory traversal detected');
            });

            it('should reject paths with embedded traversal', () => {
                expect(() =>
                    PathSanitizer.sanitizePath('src/../../../etc/passwd')
                ).toThrow('Directory traversal detected');
                expect(() =>
                    PathSanitizer.sanitizePath('src/utils/../../..')
                ).toThrow('Directory traversal detected');
            });

            it('should reject paths that normalize to traversal', () => {
                expect(() =>
                    PathSanitizer.sanitizePath('src/components/../../../secret')
                ).toThrow('Directory traversal detected');
            });
        });

        describe('absolute path rejection', () => {
            it('should reject Unix absolute paths', () => {
                expect(() => PathSanitizer.sanitizePath('/etc/passwd')).toThrow(
                    'Absolute paths are not allowed'
                );
                expect(() => PathSanitizer.sanitizePath('/usr/bin')).toThrow(
                    'Absolute paths are not allowed'
                );
                expect(() =>
                    PathSanitizer.sanitizePath('/home/user/file.txt')
                ).toThrow('Absolute paths are not allowed');
            });

            it('should reject Windows drive paths', () => {
                expect(() => PathSanitizer.sanitizePath('C:\\')).toThrow(
                    'Absolute paths are not allowed'
                );
                expect(() =>
                    PathSanitizer.sanitizePath('C:/Windows/System32')
                ).toThrow('Absolute paths are not allowed');
                expect(() =>
                    PathSanitizer.sanitizePath('D:\\Program Files')
                ).toThrow('Absolute paths are not allowed');
                expect(() => PathSanitizer.sanitizePath('c:/users')).toThrow(
                    'Absolute paths are not allowed'
                );
            });

            it('should reject UNC paths', () => {
                expect(() =>
                    PathSanitizer.sanitizePath('\\\\Server\\Share')
                ).toThrow('Absolute paths are not allowed');
                expect(() => PathSanitizer.sanitizePath('\\\\?\\C:\\')).toThrow(
                    'Absolute paths are not allowed'
                );
                expect(() => PathSanitizer.sanitizePath('\\\\.\\COM1')).toThrow(
                    'Absolute paths are not allowed'
                );
            });
        });

        describe('null byte injection prevention', () => {
            it('should reject paths containing null bytes', () => {
                expect(() => PathSanitizer.sanitizePath('src\x00.txt')).toThrow(
                    'Path contains null bytes'
                );
                expect(() =>
                    PathSanitizer.sanitizePath('\x00src/file.ts')
                ).toThrow('Path contains null bytes');
                expect(() =>
                    PathSanitizer.sanitizePath('src/file.ts\x00')
                ).toThrow('Path contains null bytes');
            });

            it('should reject paths with null bytes in the middle', () => {
                expect(() =>
                    PathSanitizer.sanitizePath('src/file\x00.ts')
                ).toThrow('Path contains null bytes');
                expect(() =>
                    PathSanitizer.sanitizePath('src\x00/utils/file.ts')
                ).toThrow('Path contains null bytes');
            });

            it('should reject paths with multiple null bytes', () => {
                expect(() =>
                    PathSanitizer.sanitizePath('src\x00\x00file.ts')
                ).toThrow('Path contains null bytes');
            });

            it('should check null bytes before other validation', () => {
                // Null byte combined with traversal - should fail on null bytes first
                expect(() =>
                    PathSanitizer.sanitizePath('src\x00/../../../etc/passwd')
                ).toThrow('Path contains null bytes');
                // Null byte combined with absolute path - should fail on null bytes first
                expect(() =>
                    PathSanitizer.sanitizePath('/etc\x00/passwd')
                ).toThrow('Path contains null bytes');
            });
        });

        describe('path length limit', () => {
            it('should accept paths at maximum length', () => {
                const maxPath = 'a'.repeat(1024);
                expect(() => PathSanitizer.sanitizePath(maxPath)).not.toThrow();
            });

            it('should reject paths exceeding maximum length', () => {
                const tooLongPath = 'a'.repeat(1025);
                expect(() => PathSanitizer.sanitizePath(tooLongPath)).toThrow(
                    'Path exceeds maximum length of 1024 characters'
                );
            });

            it('should count length after trimming', () => {
                const paddedPath = '   ' + 'a'.repeat(1024) + '   ';
                // After trimming, this is exactly 1024 characters
                expect(() =>
                    PathSanitizer.sanitizePath(paddedPath)
                ).not.toThrow();
            });

            it('should provide clear error message with limit value', () => {
                const tooLongPath = 'a'.repeat(2000);
                expect(() => PathSanitizer.sanitizePath(tooLongPath)).toThrow(
                    '1024'
                );
            });

            it('should reject long paths before checking for traversal', () => {
                const longTraversalPath = '../'.repeat(500);
                expect(() =>
                    PathSanitizer.sanitizePath(longTraversalPath)
                ).toThrow('Path exceeds maximum length');
            });
        });

        describe('unicode normalization (NFC)', () => {
            it('should normalize decomposed characters to composed form', () => {
                // e followed by combining acute accent (NFD) should equal e-acute (NFC)
                const nfdPath = 'caf\u0065\u0301'; // "cafe" with combining accent
                const nfcPath = 'caf\u00e9'; // "cafe" with precomposed e-acute

                expect(PathSanitizer.sanitizePath(nfdPath)).toBe(
                    PathSanitizer.sanitizePath(nfcPath)
                );
            });

            it('should handle paths with mixed Unicode forms', () => {
                const path1 = 'src/caf\u00e9/file.ts'; // NFC
                const path2 = 'src/caf\u0065\u0301/file.ts'; // NFD

                expect(PathSanitizer.sanitizePath(path1)).toBe(
                    PathSanitizer.sanitizePath(path2)
                );
            });

            it('should normalize Korean hangul', () => {
                // Korean syllable can be composed or decomposed
                const composedPath = 'src/\uAC00/file.ts'; // 가 as single codepoint
                const decomposedPath = 'src/\u1100\u1161/file.ts'; // 가 as jamo

                expect(PathSanitizer.sanitizePath(composedPath)).toBe(
                    PathSanitizer.sanitizePath(decomposedPath)
                );
            });

            it('should preserve ASCII-only paths unchanged', () => {
                const asciiPath = 'src/components/Button.tsx';
                expect(PathSanitizer.sanitizePath(asciiPath)).toBe(
                    'src/components/Button.tsx'
                );
            });

            it('should handle common accented characters', () => {
                expect(PathSanitizer.sanitizePath('src/résumé.txt')).toBe(
                    'src/résumé.txt'
                );
                expect(PathSanitizer.sanitizePath('src/naïve.ts')).toBe(
                    'src/naïve.ts'
                );
            });
        });

        describe('combined security checks', () => {
            it('should check null bytes before length check', () => {
                // A very long path with a null byte should fail on null byte, not length
                const longPathWithNull = 'a'.repeat(2000) + '\x00';
                expect(() =>
                    PathSanitizer.sanitizePath(longPathWithNull)
                ).toThrow('null bytes');
            });

            it('should check length before Unicode normalization', () => {
                // Very long path should fail on length
                const longPath = '\u00e9'.repeat(2000); // 2000 composed accented-e
                expect(() => PathSanitizer.sanitizePath(longPath)).toThrow(
                    'maximum length'
                );
            });

            it('should handle all checks in sequence for valid path', () => {
                const validPath = 'src/caf\u00e9/component.tsx';
                const result = PathSanitizer.sanitizePath(validPath);
                expect(result).toBe('src/caf\u00e9/component.tsx');
            });

            it('should handle whitespace trimming with other checks', () => {
                expect(PathSanitizer.sanitizePath('  src/file.ts  ')).toBe(
                    'src/file.ts'
                );
                expect(PathSanitizer.sanitizePath('\tsrc/file.ts\n')).toBe(
                    'src/file.ts'
                );
            });
        });
    });

    describe('isAbsolutePath', () => {
        it('should identify Windows drive letters', () => {
            expect(PathSanitizer.isAbsolutePath('C:')).toBe(true);
            expect(PathSanitizer.isAbsolutePath('C:/')).toBe(true);
            expect(PathSanitizer.isAbsolutePath('C:\\')).toBe(true);
            expect(PathSanitizer.isAbsolutePath('d:/files')).toBe(true);
            expect(PathSanitizer.isAbsolutePath('Z:\\temp')).toBe(true);
        });

        it('should identify UNC paths', () => {
            expect(PathSanitizer.isAbsolutePath('\\\\server\\share')).toBe(
                true
            );
            expect(PathSanitizer.isAbsolutePath('\\\\?\\C:\\')).toBe(true);
            expect(PathSanitizer.isAbsolutePath('\\\\.\\COM1')).toBe(true);
        });

        it('should identify Unix absolute paths', () => {
            expect(PathSanitizer.isAbsolutePath('/')).toBe(true);
            expect(PathSanitizer.isAbsolutePath('/etc/passwd')).toBe(true);
            expect(PathSanitizer.isAbsolutePath('/home/user')).toBe(true);
        });

        it('should identify relative paths as non-absolute', () => {
            expect(PathSanitizer.isAbsolutePath('src')).toBe(false);
            expect(PathSanitizer.isAbsolutePath('./src')).toBe(false);
            expect(PathSanitizer.isAbsolutePath('../parent')).toBe(false);
            expect(PathSanitizer.isAbsolutePath('.')).toBe(false);
            expect(PathSanitizer.isAbsolutePath('')).toBe(false);
        });

        it('should not be fooled by drive-letter-like patterns', () => {
            expect(PathSanitizer.isAbsolutePath('CC:/file')).toBe(false);
            expect(PathSanitizer.isAbsolutePath('1:/file')).toBe(false);
        });
    });
});
