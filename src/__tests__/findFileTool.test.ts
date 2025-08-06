import * as vscode from 'vscode';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FindFileTool } from '../tools/findFileTool';
import { GitOperationsManager } from '../services/gitOperationsManager';
import { fdir } from 'fdir';
import picomatch from 'picomatch';
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
                        fsPath: '/test/workspace'
                    }
                }
            ],
            fs: {
                readFile: vi.fn()
            }
        },
        Uri: {
            file: vi.fn((filePath) => ({ fsPath: filePath, toString: () => filePath }))
        }
    };
});

// Mock fdir
vi.mock('fdir', () => ({
    fdir: vi.fn().mockImplementation(() => ({
        withGlobFunction: vi.fn().mockReturnThis(),
        glob: vi.fn().mockReturnThis(),
        withRelativePaths: vi.fn().mockReturnThis(),
        exclude: vi.fn().mockReturnThis(),
        filter: vi.fn().mockReturnThis(),
        crawl: vi.fn().mockReturnThis(),
        withPromise: vi.fn()
    }))
}));

// Mock picomatch
vi.mock('picomatch', () => ({
    default: vi.fn()
}));

// Mock ignore
vi.mock('ignore', () => ({
    default: vi.fn(() => ({
        add: vi.fn().mockReturnThis(),
        checkIgnore: vi.fn(() => ({ ignored: false }))
    }))
}));

// Mock GitOperationsManager
vi.mock('../services/gitOperationsManager');

// Mock PathSanitizer
vi.mock('../utils/pathSanitizer', () => ({
    PathSanitizer: {
        sanitizePath: vi.fn((path) => path === '' ? '.' : path)
    }
}));

describe('FindFileTool', () => {
    let findFileTool: FindFileTool;
    let mockGitOperationsManager: GitOperationsManager;
    let mockGetRepository: ReturnType<typeof vi.fn>;
    let mockReadFile: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        // Create mock for getRepository
        mockGetRepository = vi.fn().mockReturnValue({
            rootUri: {
                fsPath: '/test/git-repo'
            }
        });

        // Create mock GitOperationsManager instance
        mockGitOperationsManager = {
            getRepository: mockGetRepository
        } as any;

        findFileTool = new FindFileTool(mockGitOperationsManager);
        mockReadFile = vscode.workspace.fs.readFile as ReturnType<typeof vi.fn>;

        // Clear mocks after setting up our specific mocks
        vi.clearAllMocks();

        // Re-setup the essential mocks after clearing
        mockGetRepository.mockReturnValue({
            rootUri: {
                fsPath: '/test/git-repo'
            }
        });

        // Mock readFile to return empty gitignore by default
        mockReadFile.mockResolvedValue(Buffer.from(''));
    });

    afterEach(() => {
        vi.resetAllMocks();
    });

    describe('Tool Configuration', () => {
        it('should have correct name and description', () => {
            expect(findFileTool.name).toBe('find_files_by_pattern');
            expect(findFileTool.description).toContain('Find files matching glob patterns within a directory');
            expect(findFileTool.description).toContain('glob patterns');
            expect(findFileTool.description).toContain('.gitignore');
        });

        it('should have valid schema with required fields', () => {
            const schema = findFileTool.schema;

            // Test valid input with filename only
            const validInput1 = { pattern: '*.js' };
            expect(schema.safeParse(validInput1).success).toBe(true);

            // Test valid input with filename and path
            const validInput2 = { pattern: '**/*.ts', search_directory: 'src' };
            expect(schema.safeParse(validInput2).success).toBe(true);

            // Test empty fileName should fail
            const invalidInput = { pattern: '', search_directory: 'src' };
            expect(schema.safeParse(invalidInput).success).toBe(false);

            // Test missing fileName should fail
            const missingFileName = { search_directory: 'src' };
            expect(schema.safeParse(missingFileName).success).toBe(false);

            // Test default path behavior
            const withoutPath = { pattern: '*.js' };
            const parsed = schema.parse(withoutPath);
            expect(parsed.search_directory).toBe('.');
        });

        it('should create valid VS Code tool definition', () => {
            const vscodeToolDef = findFileTool.getVSCodeTool();

            expect(vscodeToolDef.name).toBe('find_files_by_pattern');
            expect(vscodeToolDef.description).toContain('Find files matching glob patterns within a directory');
            expect(vscodeToolDef.inputSchema).toBeDefined();
        });
    });

    describe('Path Sanitization', () => {

        it('should sanitize search path using PathSanitizer', async () => {
            const mockFdirInstance = {
                withGlobFunction: vi.fn().mockReturnThis(),
                glob: vi.fn().mockReturnThis(),
                withRelativePaths: vi.fn().mockReturnThis(),
                exclude: vi.fn().mockReturnThis(),
                filter: vi.fn().mockReturnThis(),
                crawl: vi.fn().mockReturnThis(),
                withPromise: vi.fn().mockResolvedValue([])
            } as any;
            vi.mocked(fdir).mockReturnValue(mockFdirInstance);

            await findFileTool.execute({ pattern: '*.js', search_directory: 'src/../test' });

            expect(PathSanitizer.sanitizePath).toHaveBeenCalledWith('src/../test');
        });

        it('should use default path when path is undefined', async () => {
            const mockFdirInstance = {
                withGlobFunction: vi.fn().mockReturnThis(),
                glob: vi.fn().mockReturnThis(),
                withRelativePaths: vi.fn().mockReturnThis(),
                exclude: vi.fn().mockReturnThis(),
                filter: vi.fn().mockReturnThis(),
                crawl: vi.fn().mockReturnThis(),
                withPromise: vi.fn().mockResolvedValue([])
            } as any;
            vi.mocked(fdir).mockReturnValue(mockFdirInstance);

            await findFileTool.execute({ pattern: '*.js' });

            expect(PathSanitizer.sanitizePath).toHaveBeenCalledWith('.');
        });
    });

    describe('File Finding', () => {
        it('should use fdir with correct configuration', async () => {
            const mockFdirInstance = {
                withGlobFunction: vi.fn().mockReturnThis(),
                glob: vi.fn().mockReturnThis(),
                withRelativePaths: vi.fn().mockReturnThis(),
                exclude: vi.fn().mockReturnThis(),
                filter: vi.fn().mockReturnThis(),
                crawl: vi.fn().mockReturnThis(),
                withPromise: vi.fn().mockResolvedValue(['file1.js', 'file2.js'])
            } as any;
            vi.mocked(fdir).mockReturnValue(mockFdirInstance);

            const result = await findFileTool.execute({ pattern: '*.js', search_directory: 'src' });

            // Verify fdir was configured correctly
            expect(mockFdirInstance.withGlobFunction).toHaveBeenCalledWith(picomatch);
            expect(mockFdirInstance.glob).toHaveBeenCalledWith('*.js');
            expect(mockFdirInstance.withRelativePaths).toHaveBeenCalled();
            expect(mockFdirInstance.exclude).toHaveBeenCalled();
            expect(mockFdirInstance.filter).toHaveBeenCalled();
            expect(mockFdirInstance.crawl).toHaveBeenCalledWith(expect.stringContaining('git-repo'));
            expect(mockFdirInstance.withPromise).toHaveBeenCalled();

            expect(result).toEqual(['src/file1.js', 'src/file2.js']);
        });

        it('should handle multiple glob patterns', async () => {

            const mockFdirInstance = {
                withGlobFunction: vi.fn().mockReturnThis(),
                glob: vi.fn().mockReturnThis(),
                withRelativePaths: vi.fn().mockReturnThis(),
                exclude: vi.fn().mockReturnThis(),
                filter: vi.fn().mockReturnThis(),
                crawl: vi.fn().mockReturnThis(),
                withPromise: vi.fn().mockResolvedValue(['component.js', 'test.ts'])
            } as any;
            vi.mocked(fdir).mockReturnValue(mockFdirInstance);

            const result = await findFileTool.execute({ pattern: '**/*.{js,ts}' });

            expect(mockFdirInstance.glob).toHaveBeenCalledWith('**/*.{js,ts}');
            expect(result).toEqual(['component.js', 'test.ts']);
        });

        it('should sort results alphabetically', async () => {

            const mockFdirInstance = {
                withGlobFunction: vi.fn().mockReturnThis(),
                glob: vi.fn().mockReturnThis(),
                withRelativePaths: vi.fn().mockReturnThis(),
                exclude: vi.fn().mockReturnThis(),
                filter: vi.fn().mockReturnThis(),
                crawl: vi.fn().mockReturnThis(),
                withPromise: vi.fn().mockResolvedValue(['z.js', 'a.js', 'm.js'])
            } as any;
            vi.mocked(fdir).mockReturnValue(mockFdirInstance);

            const result = await findFileTool.execute({ pattern: '*.js' });

            expect(result).toEqual(['a.js', 'm.js', 'z.js']);
        });
    });

    describe('GitIgnore Integration', () => {
        it('should read .gitignore file', async () => {
            mockReadFile.mockResolvedValue(Buffer.from('node_modules\n.env\n*.log'));

            const mockFdirInstance = {
                withGlobFunction: vi.fn().mockReturnThis(),
                glob: vi.fn().mockReturnThis(),
                withRelativePaths: vi.fn().mockReturnThis(),
                exclude: vi.fn().mockReturnThis(),
                filter: vi.fn().mockReturnThis(),
                crawl: vi.fn().mockReturnThis(),
                withPromise: vi.fn().mockResolvedValue([])
            } as any;
            vi.mocked(fdir).mockReturnValue(mockFdirInstance);

            await findFileTool.execute({ pattern: '*.js' });

            expect(mockReadFile).toHaveBeenCalledWith(
                expect.objectContaining({
                    fsPath: expect.stringContaining('.gitignore')
                })
            );
        });

        it('should handle missing .gitignore file gracefully', async () => {
            mockReadFile.mockRejectedValue(new Error('File not found'));

            const mockFdirInstance = {
                withGlobFunction: vi.fn().mockReturnThis(),
                glob: vi.fn().mockReturnThis(),
                withRelativePaths: vi.fn().mockReturnThis(),
                exclude: vi.fn().mockReturnThis(),
                filter: vi.fn().mockReturnThis(),
                crawl: vi.fn().mockReturnThis(),
                withPromise: vi.fn().mockResolvedValue(['file.js'])
            } as any;
            vi.mocked(fdir).mockReturnValue(mockFdirInstance);

            const result = await findFileTool.execute({ pattern: '*.js' });

            expect(result).toEqual(['file.js']);
        });
    });

    describe('Error Handling', () => {
        it('should handle missing git repository', async () => {
            mockGetRepository.mockReturnValue(null);

            const result = await findFileTool.execute({ pattern: '*.js' });

            expect(result[0]).toContain('Unable to find files matching pattern');
            expect(result[0]).toContain('Git repository not found');
        });

        it('should handle fdir errors', async () => {
            const mockFdirInstance = {
                withGlobFunction: vi.fn().mockReturnThis(),
                glob: vi.fn().mockReturnThis(),
                withRelativePaths: vi.fn().mockReturnThis(),
                exclude: vi.fn().mockReturnThis(),
                filter: vi.fn().mockReturnThis(),
                crawl: vi.fn().mockReturnThis(),
                withPromise: vi.fn().mockRejectedValue(new Error('Directory not found'))
            } as any;
            vi.mocked(fdir).mockReturnValue(mockFdirInstance);

            const result = await findFileTool.execute({ pattern: '*.js' });

            expect(result[0]).toContain('Unable to find files matching pattern');
            expect(result[0]).toContain('Directory not found');
        });

        it('should handle path sanitization errors', async () => {
            vi.mocked(PathSanitizer.sanitizePath).mockImplementation(() => {
                throw new Error('Invalid search_directory: Directory traversal detected');
            });

            const result = await findFileTool.execute({ pattern: '*.js', search_directory: '../evil' });

            expect(result[0]).toContain('Unable to find files matching pattern');
            expect(result[0]).toContain('Directory traversal detected');
        });
    });

    describe('Path Normalization', () => {
        it('should normalize Windows paths to forward slashes', async () => {
            const mockFdirInstance = {
                withGlobFunction: vi.fn().mockReturnThis(),
                glob: vi.fn().mockReturnThis(),
                withRelativePaths: vi.fn().mockReturnThis(),
                exclude: vi.fn().mockReturnThis(),
                filter: vi.fn().mockReturnThis(),
                crawl: vi.fn().mockReturnThis(),
                withPromise: vi.fn().mockResolvedValue(['src\\components\\Button.tsx'])
            } as any;
            vi.mocked(fdir).mockReturnValue(mockFdirInstance);

            const result = await findFileTool.execute({ pattern: '*.tsx' });

            expect(result).toEqual(['src/components/Button.tsx']);
        });
    });
});
