import * as vscode from 'vscode';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ListDirTool } from '../tools/listDirTool';
import { GitOperationsManager } from '../services/gitOperationsManager';

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
                readDirectory: vi.fn(),
                readFile: vi.fn(),
            },
        },
        Uri: {
            file: vi.fn((filePath) => ({
                fsPath: filePath,
                toString: () => filePath,
            })),
        },
        FileType: {
            File: 1,
            Directory: 2,
        },
    };
});

// Mock GitOperationsManager
vi.mock('../services/gitOperationsManager');

describe('ListDirTool', () => {
    let listDirTool: ListDirTool;
    let mockReadDirectory: ReturnType<typeof vi.fn>;
    let mockGitOperationsManager: GitOperationsManager;
    let mockGetRepository: ReturnType<typeof vi.fn>;

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

        listDirTool = new ListDirTool(mockGitOperationsManager);
        mockReadDirectory = vscode.workspace.fs.readDirectory as ReturnType<
            typeof vi.fn
        >;

        // Clear mocks after setting up our specific mocks
        vi.clearAllMocks();

        // Re-setup the essential mocks after clearing
        mockGetRepository.mockReturnValue({
            rootUri: {
                fsPath: '/test/git-repo',
            },
        });
    });

    afterEach(() => {
        vi.resetAllMocks();
    });

    describe('Tool Configuration', () => {
        it('should have correct name and description', () => {
            expect(listDirTool.name).toBe('list_directory');
            expect(listDirTool.description).toContain(
                'List files and directories'
            );
        });

        it('should have valid schema with required fields', () => {
            const schema = listDirTool.schema;

            // Test valid input
            const validInput = { relative_path: 'src', recursive: false };
            expect(schema.safeParse(validInput).success).toBe(true);

            // Test empty relativePath should fail
            const invalidInput = { relative_path: '', recursive: false };
            expect(schema.safeParse(invalidInput).success).toBe(false);

            // Test missing fields should fail
            const missingFields = { relative_path: 'src' };
            expect(schema.safeParse(missingFields).success).toBe(false);
        });

        it('should create valid VS Code tool definition', () => {
            const vscodeToolDef = listDirTool.getVSCodeTool();

            expect(vscodeToolDef.name).toBe('list_directory');
            expect(vscodeToolDef.description).toContain(
                'List files and directories'
            );
            expect(vscodeToolDef.inputSchema).toHaveProperty('type', 'object');
            expect(vscodeToolDef.inputSchema).toHaveProperty('properties');
        });
    });

    describe('Path Sanitization', () => {
        it('should prevent directory traversal attacks', async () => {
            // Test various directory traversal attempts
            const traversalPaths = [
                '../../../etc/passwd',
                '..\\..\\..\\system32',
                'src/../../../secret',
                'normal/../../../hack',
            ];

            for (const maliciousPath of traversalPaths) {
                const result = await listDirTool.execute({
                    relative_path: maliciousPath,
                    recursive: false,
                });

                expect(result.success).toBe(false);
                expect(result.error).toContain(
                    'Invalid path: Directory traversal detected'
                );
            }
        });

        it('should reject Unix absolute paths', async () => {
            // Test Unix absolute paths that should be rejected
            const absolutePaths = [
                '/etc/passwd',
                '/usr/bin/',
                '/home/user/file.txt',
            ];

            for (const absolutePath of absolutePaths) {
                const result = await listDirTool.execute({
                    relative_path: absolutePath,
                    recursive: false,
                });

                expect(result.success).toBe(false);
                expect(result.error).toContain(
                    'Invalid path: Absolute paths are not allowed, only relative paths'
                );
            }
        });

        it('should reject Windows absolute paths', async () => {
            // Test Windows absolute paths that should be rejected
            const absolutePaths = [
                'C:/',
                'C:\\',
                'C:\\Windows\\System32\\',
                'D:/Program Files/',
                'E:\\temp\\file.txt',
            ];

            for (const absolutePath of absolutePaths) {
                const result = await listDirTool.execute({
                    relative_path: absolutePath,
                    recursive: false,
                });

                expect(result.success).toBe(false);
                expect(result.error).toContain(
                    'Invalid path: Absolute paths are not allowed, only relative paths'
                );
            }
        });

        it('should reject UNC paths', async () => {
            // Test UNC paths that should be rejected
            const uncPaths = [
                '\\\\Server\\Share\\',
                '\\\\Server\\Share\\Test\\Foo.txt',
                '\\\\?\\UNC\\Server\\Share\\Test\\Foo.txt',
                '\\\\?\\C:\\',
                '\\\\?\\C:\\Windows\\',
                '\\\\.\\UNC\\Server\\Share\\Test\\Foo.txt',
            ];

            for (const uncPath of uncPaths) {
                const result = await listDirTool.execute({
                    relative_path: uncPath,
                    recursive: false,
                });

                expect(result.success).toBe(false);
                expect(result.error).toContain(
                    'Invalid path: Absolute paths are not allowed, only relative paths'
                );
            }
        });

        it('should allow valid relative paths', async () => {
            const validPaths = [
                'src',
                'src/components',
                'docs/architecture',
                '.',
                'build',
            ];

            // Mock empty directory for each test
            mockReadDirectory.mockResolvedValue([]);

            for (const validPath of validPaths) {
                const result = await listDirTool.execute({
                    relative_path: validPath,
                    recursive: false,
                });

                // Should return success with empty directory message
                expect(result.success).toBe(true);
                expect(result.data).toBe('(empty directory)');
            }
        });

        it('should normalize paths correctly', async () => {
            mockReadDirectory.mockResolvedValue([]);

            // Test path normalization that doesn't involve directory traversal
            const result = await listDirTool.execute({
                relative_path: 'src/./utils',
                recursive: false,
            });

            // Should return success (path gets normalized to src/utils)
            expect(result.success).toBe(true);
            expect(result.data).toBe('(empty directory)');
        });
    });

    describe('Directory Listing', () => {
        it('should list files and directories correctly', async () => {
            const mockEntries: [string, vscode.FileType][] = [
                ['file1.ts', vscode.FileType.File],
                ['file2.js', vscode.FileType.File],
                ['subdir', vscode.FileType.Directory],
                ['README.md', vscode.FileType.File],
            ];

            mockReadDirectory.mockResolvedValue(mockEntries);

            const result = await listDirTool.execute({
                relative_path: 'src',
                recursive: false,
            });

            // Should return directories first (with /), then files, all sorted
            expect(result.success).toBe(true);
            expect(result.data).toBe(
                'src/subdir/\nsrc/README.md\nsrc/file1.ts\nsrc/file2.js'
            );
        });

        it('should handle recursive listing', async () => {
            // Mock root directory
            mockReadDirectory
                .mockResolvedValueOnce([
                    ['file1.ts', vscode.FileType.File],
                    ['subdir', vscode.FileType.Directory],
                ])
                // Mock subdirectory
                .mockResolvedValueOnce([
                    ['subfile.js', vscode.FileType.File],
                    ['nested', vscode.FileType.Directory],
                ])
                // Mock nested directory
                .mockResolvedValueOnce([['deep.json', vscode.FileType.File]]);

            const result = await listDirTool.execute({
                relative_path: 'src',
                recursive: true,
            });

            expect(result.success).toBe(true);
            expect(result.data).toContain('src/subdir/');
            expect(result.data).toContain('src/subdir/nested/');
            expect(result.data).toContain('src/file1.ts');
            expect(result.data).toContain('src/subdir/nested/deep.json');
            expect(result.data).toContain('src/subdir/subfile.js');
        });

        it('should handle root directory listing', async () => {
            const mockEntries: [string, vscode.FileType][] = [
                ['src', vscode.FileType.Directory],
                ['package.json', vscode.FileType.File],
            ];

            mockReadDirectory.mockResolvedValue(mockEntries);

            const result = await listDirTool.execute({
                relative_path: '.',
                recursive: false,
            });

            expect(result.success).toBe(true);
            expect(result.data).toBe('src/\npackage.json');
        });
    });

    describe('Error Handling', () => {
        it('should handle directory read errors gracefully', async () => {
            mockReadDirectory.mockRejectedValue(new Error('Permission denied'));

            const result = await listDirTool.execute({
                relative_path: 'src',
                recursive: false,
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain('Error listing directory');
            expect(result.error).toContain('Permission denied');
        });

        it('should handle missing git repository', async () => {
            // Mock GitOperationsManager to return null repository
            mockGetRepository.mockReturnValueOnce(null);

            const result = await listDirTool.execute({
                relative_path: 'src',
                recursive: false,
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain('Error listing directory');
        });

        it('should handle subdirectory read errors in recursive mode', async () => {
            // Mock successful root read but failed subdir read
            mockReadDirectory
                .mockResolvedValueOnce([
                    ['file1.ts', vscode.FileType.File],
                    ['baddir', vscode.FileType.Directory],
                    ['gooddir', vscode.FileType.Directory],
                ])
                .mockRejectedValueOnce(new Error('Access denied')) // baddir fails
                .mockResolvedValueOnce([['subfile.js', vscode.FileType.File]]); // gooddir succeeds

            const result = await listDirTool.execute({
                relative_path: '.',
                recursive: true,
            });

            // Should continue processing and include accessible directories
            expect(result.success).toBe(true);
            expect(result.data).toContain('gooddir/');
            expect(result.data).toContain('gooddir/subfile.js');
            expect(result.data).toContain('file1.ts');
        });
    });
});
