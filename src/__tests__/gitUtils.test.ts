import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { readGitignore } from '../utils/gitUtils';
import {
    createMockGitRepositoryWithConfig,
    createFileNotFoundError,
} from './testUtils/mockFactories';

vi.mock('vscode', async (importOriginal) => {
    const vscodeMock = await importOriginal<typeof vscode>();
    return {
        ...vscodeMock,
        workspace: {
            ...(vscodeMock as any).workspace,
            fs: {
                readFile: vi.fn(),
            },
        },
        Uri: {
            file: vi.fn((filePath: string) => ({
                fsPath: filePath,
                toString: () => filePath,
            })),
        },
    };
});

vi.mock('../services/loggingService', () => ({
    Log: {
        warn: vi.fn(),
        debug: vi.fn(),
    },
}));

describe('gitUtils', () => {
    let mockReadFile: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.clearAllMocks();
        mockReadFile = vscode.workspace.fs.readFile as ReturnType<typeof vi.fn>;
    });

    describe('readGitignore', () => {
        it('should return empty string when repository is null', async () => {
            const result = await readGitignore(null);
            expect(result).toBe('');
        });

        it('should read .gitignore from repository root', async () => {
            const mockRepo = createMockGitRepositoryWithConfig(
                '/test/repo',
                {}
            );
            mockReadFile
                .mockResolvedValueOnce(Buffer.from('node_modules\ndist'))
                .mockRejectedValueOnce(createFileNotFoundError());

            const result = await readGitignore(mockRepo as any);

            expect(result).toBe('node_modules\ndist');
            expect(vscode.Uri.file).toHaveBeenCalledWith(
                expect.stringContaining('.gitignore')
            );
        });

        it('should read .git/info/exclude and combine with .gitignore', async () => {
            const mockRepo = createMockGitRepositoryWithConfig(
                '/test/repo',
                {}
            );
            mockReadFile
                .mockResolvedValueOnce(Buffer.from('node_modules\ndist'))
                .mockResolvedValueOnce(Buffer.from('*.local\n.env.local'));

            const result = await readGitignore(mockRepo as any);

            expect(result).toBe('node_modules\ndist\n*.local\n.env.local');
        });

        it('should read global gitignore from core.excludesFile', async () => {
            const mockRepo = createMockGitRepositoryWithConfig('/test/repo', {
                'core.excludesFile': '~/.gitignore_global',
            });
            mockReadFile
                .mockResolvedValueOnce(Buffer.from('*.bak')) // global
                .mockResolvedValueOnce(Buffer.from('node_modules')) // .gitignore
                .mockResolvedValueOnce(Buffer.from('*.local')); // .git/info/exclude

            const result = await readGitignore(mockRepo as any);

            expect(result).toBe('*.bak\nnode_modules\n*.local');
            expect(mockRepo.getGlobalConfig).toHaveBeenCalledWith(
                'core.excludesFile'
            );
        });

        it('should handle missing global gitignore gracefully', async () => {
            const mockRepo = createMockGitRepositoryWithConfig('/test/repo', {
                'core.excludesFile': '/nonexistent/.gitignore',
            });
            // Global gitignore file not found
            mockReadFile.mockRejectedValueOnce(createFileNotFoundError());
            // .gitignore exists
            mockReadFile.mockResolvedValueOnce(Buffer.from('node_modules'));
            // .git/info/exclude not found
            mockReadFile.mockRejectedValueOnce(createFileNotFoundError());

            const result = await readGitignore(mockRepo as any);

            expect(result).toBe('node_modules');
        });

        it('should handle missing .gitignore gracefully', async () => {
            const mockRepo = createMockGitRepositoryWithConfig(
                '/test/repo',
                {}
            );
            mockReadFile.mockRejectedValueOnce(createFileNotFoundError());
            mockReadFile.mockResolvedValueOnce(Buffer.from('*.local'));

            const result = await readGitignore(mockRepo as any);

            expect(result).toBe('*.local');
        });

        it('should handle missing .git/info/exclude gracefully', async () => {
            const mockRepo = createMockGitRepositoryWithConfig(
                '/test/repo',
                {}
            );
            mockReadFile.mockResolvedValueOnce(Buffer.from('node_modules'));
            mockReadFile.mockRejectedValueOnce(createFileNotFoundError());

            const result = await readGitignore(mockRepo as any);

            expect(result).toBe('node_modules');
        });

        it('should return empty string when all files are missing', async () => {
            const mockRepo = createMockGitRepositoryWithConfig(
                '/test/repo',
                {}
            );
            mockReadFile.mockRejectedValue(createFileNotFoundError());

            const result = await readGitignore(mockRepo as any);

            expect(result).toBe('');
        });

        it('should handle getGlobalConfig failure gracefully', async () => {
            const mockRepo = createMockGitRepositoryWithConfig(
                '/test/repo',
                {}
            );
            // Override getGlobalConfig to throw
            mockRepo.getGlobalConfig.mockRejectedValue(
                new Error('Git not available')
            );

            mockReadFile
                .mockResolvedValueOnce(Buffer.from('node_modules'))
                .mockRejectedValueOnce(createFileNotFoundError());

            const result = await readGitignore(mockRepo as any);

            // Should still return .gitignore content despite config failure
            expect(result).toBe('node_modules');
        });

        it('should expand ~ in global gitignore path', async () => {
            const mockRepo = createMockGitRepositoryWithConfig('/test/repo', {
                'core.excludesFile': '~/my-gitignore',
            });
            mockReadFile
                .mockResolvedValueOnce(Buffer.from('*.bak'))
                .mockResolvedValueOnce(Buffer.from('node_modules'))
                .mockRejectedValueOnce(createFileNotFoundError());

            const result = await readGitignore(mockRepo as any);

            expect(result).toContain('*.bak');
            // Verify path expansion happened (home dir should be used)
            expect(vscode.Uri.file).toHaveBeenCalledWith(
                expect.not.stringContaining('~')
            );
        });
    });
});
