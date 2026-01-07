import * as vscode from 'vscode';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fdir } from 'fdir';
import { FindFilesByPatternTool } from '../tools/findFilesByPatternTool';
import { GitOperationsManager } from '../services/gitOperationsManager';
import { PathSanitizer } from '../utils/pathSanitizer';

// Mock vscode
vi.mock('vscode', async () => {
    const actualVscode = await vi.importActual('vscode');
    return {
        ...actualVscode,
        workspace: {
            workspaceFolders: [
                {
                    uri: {
                        fsPath: '/test/workspace',
                    },
                },
            ],
            fs: {
                readFile: vi.fn(),
            },
        },
        Uri: {
            file: vi.fn((filePath) => ({
                fsPath: filePath,
                toString: () => filePath,
            })),
        },
    };
});

// Mock fdir - Vitest 4 requires function syntax for constructor mocks
vi.mock('fdir', () => ({
    fdir: vi.fn().mockImplementation(function () {
        return {
            withGlobFunction: vi.fn().mockReturnThis(),
            glob: vi.fn().mockReturnThis(),
            globWithOptions: vi.fn().mockReturnThis(),
            withRelativePaths: vi.fn().mockReturnThis(),
            withFullPaths: vi.fn().mockReturnThis(),
            withAbortSignal: vi.fn().mockReturnThis(),
            exclude: vi.fn().mockReturnThis(),
            filter: vi.fn().mockReturnThis(),
            crawl: vi.fn().mockReturnThis(),
            withPromise: vi.fn(),
        };
    }),
}));

// Mock picomatch
vi.mock('picomatch', () => ({
    default: vi.fn(),
}));

// Mock ignore - Vitest 4 requires function syntax for constructor mocks
vi.mock('ignore', () => ({
    default: vi.fn(function () {
        return {
            add: vi.fn().mockReturnThis(),
            checkIgnore: vi.fn(function () {
                return { ignored: false };
            }),
            ignores: vi.fn(function () {
                return false;
            }),
            filter: vi.fn().mockImplementation(function (files) {
                return files;
            }),
        };
    }),
}));

// Mock GitOperationsManager
vi.mock('../services/gitOperationsManager');

// Mock PathSanitizer
vi.mock('../utils/pathSanitizer', () => ({
    PathSanitizer: {
        sanitizePath: vi.fn((path) => (path === '' ? '.' : path)),
    },
}));

// Test utility functions for DRY mocks
function createMockFdirInstance(syncReturnValue: string[] = []) {
    const crawlResult = {
        withPromise: vi.fn().mockResolvedValue(syncReturnValue),
        sync: vi.fn().mockReturnValue(syncReturnValue),
    };
    return {
        withGlobFunction: vi.fn().mockReturnThis(),
        glob: vi.fn().mockReturnThis(),
        globWithOptions: vi.fn().mockReturnThis(),
        withRelativePaths: vi.fn().mockReturnThis(),
        withFullPaths: vi.fn().mockReturnThis(),
        withAbortSignal: vi.fn().mockReturnThis(),
        exclude: vi.fn().mockReturnThis(),
        filter: vi.fn().mockReturnThis(),
        crawl: vi.fn().mockReturnValue(crawlResult),
        // Also expose these for test assertions
        withPromise: crawlResult.withPromise,
        sync: crawlResult.sync,
    } as any;
}

describe('FindFileTool', () => {
    let findFileTool: FindFilesByPatternTool;
    let mockGitOperationsManager: GitOperationsManager;
    let mockGetRepository: ReturnType<typeof vi.fn>;
    let mockReadFile: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        // Create mock for getRepository
        mockGetRepository = vi.fn().mockReturnValue({
            rootUri: {
                fsPath: '/test/git-repo',
            },
        });

        // Create mock GitOperationsManager instance
        mockGitOperationsManager = {
            getRepository: mockGetRepository,
        } as any;

        findFileTool = new FindFilesByPatternTool(mockGitOperationsManager);
        mockReadFile = vscode.workspace.fs.readFile as ReturnType<typeof vi.fn>;

        // Clear mocks after setting up our specific mocks
        vi.clearAllMocks();

        // Re-setup the essential mocks after clearing
        mockGetRepository.mockReturnValue({
            rootUri: {
                fsPath: '/test/git-repo',
            },
        });

        // Mock readFile to return empty gitignore by default
        mockReadFile.mockResolvedValue(Buffer.from(''));
    });

    afterEach(() => {
        vi.resetAllMocks();
    });

    describe('Schema Validation', () => {
        it('should have valid schema with required fields', () => {
            const schema = findFileTool.schema;

            // Test valid input with pattern only
            const validInput1 = { pattern: '*.js' };
            expect(schema.safeParse(validInput1).success).toBe(true);

            // Test valid input with pattern and search directory
            const validInput2 = { pattern: '**/*.ts', search_directory: 'src' };
            expect(schema.safeParse(validInput2).success).toBe(true);

            // Test empty pattern should fail
            const invalidInput = { pattern: '', search_directory: 'src' };
            expect(schema.safeParse(invalidInput).success).toBe(false);

            // Test missing pattern should fail
            const missingPattern = { search_directory: 'src' };
            expect(schema.safeParse(missingPattern).success).toBe(false);

            // Test default search directory behavior
            const withoutPath = { pattern: '*.js' };
            const parsed = schema.parse(withoutPath);
            expect(parsed.search_directory).toBe('.');
        });
    });

    describe('Path Sanitization', () => {
        it('should sanitize search path using PathSanitizer', async () => {
            const mockFdirInstance = createMockFdirInstance([]);
            vi.mocked(fdir).mockImplementation(function () {
                return mockFdirInstance;
            } as any);

            await findFileTool.execute({
                pattern: '*.js',
                search_directory: 'src/../test',
            });

            expect(PathSanitizer.sanitizePath).toHaveBeenCalledWith(
                'src/../test'
            );
        });

        it('should use default path when path is undefined', async () => {
            const mockFdirInstance = createMockFdirInstance([]);
            vi.mocked(fdir).mockImplementation(function () {
                return mockFdirInstance;
            } as any);

            await findFileTool.execute({ pattern: '*.js' });

            expect(PathSanitizer.sanitizePath).toHaveBeenCalledWith('.');
        });
    });

    describe('File Finding', () => {
        it('should execute file search with mocked fdir', async () => {
            const mockFdirInstance = createMockFdirInstance([
                '/test/git-repo/src/file1.js',
                '/test/git-repo/src/file2.js',
            ]);
            vi.mocked(fdir).mockImplementation(function () {
                return mockFdirInstance;
            } as any);

            const result = await findFileTool.execute({
                pattern: '*.js',
                search_directory: 'src',
            });

            // Verify basic fdir setup and execution
            expect(vi.mocked(fdir)).toHaveBeenCalled();
            expect(mockFdirInstance.withPromise).toHaveBeenCalled();
            expect(mockFdirInstance.globWithOptions).toHaveBeenCalledWith(
                ['*.js'],
                expect.any(Object)
            );
            expect(result.success).toBe(true);
            expect(result.data).toEqual('src/file1.js\nsrc/file2.js');
        });

        it('should sort results alphabetically', async () => {
            const mockFdirInstance = createMockFdirInstance([
                '/test/git-repo/z.js',
                '/test/git-repo/a.js',
                '/test/git-repo/m.js',
            ]);
            vi.mocked(fdir).mockImplementation(function () {
                return mockFdirInstance;
            } as any);

            const result = await findFileTool.execute({ pattern: '*.js' });

            expect(result.success).toBe(true);
            expect(result.data).toEqual('a.js\nm.js\nz.js');
        });
    });

    describe('GitIgnore Integration', () => {
        it('should read .gitignore file', async () => {
            mockReadFile.mockResolvedValue(
                Buffer.from('node_modules\n.env\n*.log')
            );

            const mockFdirInstance = createMockFdirInstance([]);
            vi.mocked(fdir).mockImplementation(function () {
                return mockFdirInstance;
            } as any);

            await findFileTool.execute({ pattern: '*.js' });

            expect(mockReadFile).toHaveBeenCalledWith(
                expect.objectContaining({
                    fsPath: expect.stringContaining('.gitignore'),
                })
            );
        });

        it('should handle missing .gitignore file gracefully', async () => {
            mockReadFile.mockRejectedValue(new Error('File not found'));

            const mockFdirInstance = createMockFdirInstance([
                '/test/git-repo/file.js',
            ]);
            vi.mocked(fdir).mockImplementation(function () {
                return mockFdirInstance;
            } as any);

            const result = await findFileTool.execute({ pattern: '*.js' });

            expect(result.data).toEqual('file.js');
        });
    });

    describe('Error Handling', () => {
        it('should handle missing git repository', async () => {
            mockGetRepository.mockReturnValue(null);

            const result = await findFileTool.execute({ pattern: '*.js' });

            expect(result.success).toBe(false);
            expect(result.error).toContain('Git repository not found');
        });

        it('should handle fdir errors', async () => {
            const mockFdirInstance = createMockFdirInstance([]);
            mockFdirInstance.withPromise.mockRejectedValue(
                new Error('Directory not found')
            );
            vi.mocked(fdir).mockImplementation(function () {
                return mockFdirInstance;
            } as any);

            const result = await findFileTool.execute({ pattern: '*.js' });

            expect(result.success).toBe(false);
            expect(result.error).toContain('Unable to find files');
            expect(result.error).toContain('Directory not found');
        });

        it('should handle path sanitization errors', async () => {
            vi.mocked(PathSanitizer.sanitizePath).mockImplementation(() => {
                throw new Error(
                    'Invalid search_directory: Directory traversal detected'
                );
            });

            const result = await findFileTool.execute({
                pattern: '*.js',
                search_directory: '../evil',
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain('Unable to find files');
            expect(result.error).toContain('Directory traversal detected');
        });
    });

    describe('Path Normalization', () => {
        it('should normalize Windows paths to forward slashes', async () => {
            const mockFdirInstance = createMockFdirInstance([
                '/test/git-repo/src/components/Button.tsx',
            ]);
            vi.mocked(fdir).mockImplementation(function () {
                return mockFdirInstance;
            } as any);

            const result = await findFileTool.execute({ pattern: '*.tsx' });

            expect(result.success).toBe(true);
            expect(result.data).toEqual('src/components/Button.tsx');
        });
    });

    describe('Windows Pattern Fix', () => {
        it('should pass windows: true to picomatch for pattern matching', async () => {
            // Mock os.platform to return win32 for this test
            const mockOsPlatform = vi.fn().mockReturnValue('win32');
            vi.doMock('os', () => ({ platform: mockOsPlatform }));

            const mockFdirInstance = createMockFdirInstance([
                '/test/git-repo/src/WGChelper.h',
                '/test/git-repo/lib/WGCmath.h',
            ]);
            vi.mocked(fdir).mockImplementation(function () {
                return mockFdirInstance;
            } as any);

            await findFileTool.execute({ pattern: '**/WGC*h' });

            // Verify that windows: true is passed to globWithOptions when on Windows
            expect(mockFdirInstance.globWithOptions).toHaveBeenCalledWith(
                ['**/WGC*h'],
                expect.objectContaining({ windows: true })
            );
        });
    });

    describe('Performance Limits', () => {
        it('should handle large result sets with MAX_RESULTS limit', async () => {
            // Create 1200 mock files (exceeds MAX_RESULTS=1000)
            const largeFileList = Array.from(
                { length: 1200 },
                (_, i) =>
                    `/test/git-repo/file${i.toString().padStart(4, '0')}.js`
            );
            const mockFdirInstance = createMockFdirInstance(largeFileList);
            vi.mocked(fdir).mockImplementation(function () {
                return mockFdirInstance;
            } as any);

            const result = await findFileTool.execute({ pattern: '*.js' });

            expect(result.success).toBe(true);
            // FileDiscoverer truncates to first 1000 and adds a truncation message
            expect(result.data).toContain('file0000.js');
            // The truncation message is added at the end
            expect(result.data).toContain('showing first');
        });
    });

    describe('Real Integration Errors', () => {
        it('should handle actual picomatch/fdir integration errors', async () => {
            const mockFdirInstance = createMockFdirInstance([]);
            // Simulate real fdir error that could occur with complex patterns
            mockFdirInstance.withPromise.mockRejectedValue(
                new Error('ENOENT: no such file or directory, scandir')
            );
            vi.mocked(fdir).mockImplementation(function () {
                return mockFdirInstance;
            } as any);

            const result = await findFileTool.execute({
                pattern: '**/*.js',
                search_directory: 'nonexistent',
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain('Unable to find files');
            expect(result.error).toContain('ENOENT: no such file or directory');
        });
    });
});
