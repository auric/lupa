import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import * as vscode from 'vscode';
import { readGitignore } from '../utils/gitUtils';
import {
    createMockGitRepositoryWithConfig,
    createFileNotFoundError,
    createNoPermissionsError,
} from './testUtils/mockFactories';
import { Log } from '../services/loggingService';

const MOCK_HOME_DIR = '/mock/home';

vi.mock('os', () => ({
    homedir: vi.fn(() => MOCK_HOME_DIR),
}));

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
            expect(vscode.Uri.file).toHaveBeenCalledWith(
                path.resolve(MOCK_HOME_DIR, 'my-gitignore')
            );
        });

        it('should correctly expand ~/path without discarding homedir', async () => {
            // This test verifies the fix for path.join discarding homedir
            // when second arg starts with / (e.g., '~/foo'.slice(1) = '/foo')
            const mockRepo = createMockGitRepositoryWithConfig('/test/repo', {
                'core.excludesFile': '~/.config/git/ignore',
            });
            mockReadFile
                .mockResolvedValueOnce(Buffer.from('global-pattern'))
                .mockResolvedValueOnce(Buffer.from('node_modules'))
                .mockRejectedValueOnce(createFileNotFoundError());

            await readGitignore(mockRepo as any);

            const calls = vi.mocked(vscode.Uri.file).mock.calls;
            const globalIgnorePath = calls[0]?.[0];
            expect(globalIgnorePath).toBe(
                path.resolve(MOCK_HOME_DIR, '.config/git/ignore')
            );
        });

        it('should log warning for non-FileNotFound read errors', async () => {
            const mockRepo = createMockGitRepositoryWithConfig(
                '/test/repo',
                {}
            );
            // First read (.gitignore) throws permission error
            mockReadFile.mockRejectedValueOnce(
                createNoPermissionsError('/test/repo/.gitignore')
            );
            // Second read (.git/info/exclude) succeeds
            mockReadFile.mockResolvedValueOnce(Buffer.from('*.local'));

            const result = await readGitignore(mockRepo as any);

            // Should still return content from .git/info/exclude
            expect(result).toBe('*.local');
            // Should log warning about permission error
            expect(Log.warn).toHaveBeenCalledWith(
                expect.stringContaining('Permission denied')
            );
        });

        it('should log warning for unknown read errors', async () => {
            const mockRepo = createMockGitRepositoryWithConfig(
                '/test/repo',
                {}
            );
            // First read (.gitignore) throws generic error
            mockReadFile.mockRejectedValueOnce(new Error('Network timeout'));
            // Second read (.git/info/exclude) succeeds
            mockReadFile.mockResolvedValueOnce(Buffer.from('*.local'));

            const result = await readGitignore(mockRepo as any);

            // Should still return content from .git/info/exclude
            expect(result).toBe('*.local');
            // Should log warning about the error
            expect(Log.warn).toHaveBeenCalledWith(
                expect.stringContaining('Network timeout')
            );
        });

        it('should log debug message when getGlobalConfig fails', async () => {
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

            await readGitignore(mockRepo as any);

            // Should log debug message about config failure
            expect(Log.debug).toHaveBeenCalledWith(
                expect.stringContaining(
                    'Failed to read global gitignore config'
                )
            );
        });

        it('should NOT expand ~user/ paths (pass through unchanged)', async () => {
            // ~user/path form is not supported and should be passed through unchanged
            const mockRepo = createMockGitRepositoryWithConfig('/test/repo', {
                'core.excludesFile': '~otheruser/gitignore',
            });
            mockReadFile
                .mockResolvedValueOnce(Buffer.from('node_modules'))
                .mockRejectedValueOnce(createFileNotFoundError());

            await readGitignore(mockRepo as any);

            // The ~otheruser/ path should be passed through unchanged
            const calls = vi.mocked(vscode.Uri.file).mock.calls;
            const globalIgnorePath = calls[0]?.[0];
            expect(globalIgnorePath).toBe('~otheruser/gitignore');
        });

        it('should expand bare ~ to home directory', async () => {
            // Just ~ should expand to home directory
            const mockRepo = createMockGitRepositoryWithConfig('/test/repo', {
                'core.excludesFile': '~',
            });
            mockReadFile
                .mockResolvedValueOnce(Buffer.from('bare-tilde-pattern'))
                .mockResolvedValueOnce(Buffer.from('node_modules'))
                .mockRejectedValueOnce(createFileNotFoundError());

            await readGitignore(mockRepo as any);

            const calls = vi.mocked(vscode.Uri.file).mock.calls;
            const globalIgnorePath = calls[0]?.[0];
            expect(globalIgnorePath).toBe(MOCK_HOME_DIR);
        });

        it('should handle Windows-style ~\\path expansion', async () => {
            const mockRepo = createMockGitRepositoryWithConfig('/test/repo', {
                'core.excludesFile': '~\\my-gitignore',
            });
            mockReadFile
                .mockResolvedValueOnce(Buffer.from('*.bak'))
                .mockResolvedValueOnce(Buffer.from('node_modules'))
                .mockRejectedValueOnce(createFileNotFoundError());

            await readGitignore(mockRepo as any);

            const calls = vi.mocked(vscode.Uri.file).mock.calls;
            const globalIgnorePath = calls[0]?.[0];
            expect(globalIgnorePath).toBe(
                path.resolve(MOCK_HOME_DIR, 'my-gitignore')
            );
        });
    });
});
