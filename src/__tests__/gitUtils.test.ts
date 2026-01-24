import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { readGitignore } from '../utils/gitUtils';

// Mock vscode
vi.mock('vscode', async () => {
    return {
        workspace: {
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
            mockReadFile.mockResolvedValueOnce(
                Buffer.from('node_modules\ndist')
            );
            mockReadFile.mockRejectedValueOnce(new Error('ENOENT')); // No .git/info/exclude

            const mockRepo = {
                rootUri: { fsPath: '/test/repo' },
            };

            const result = await readGitignore(mockRepo as any);

            expect(result).toBe('node_modules\ndist');
            expect(vscode.Uri.file).toHaveBeenCalledWith(
                expect.stringContaining('.gitignore')
            );
        });

        it('should read .git/info/exclude and combine with .gitignore', async () => {
            mockReadFile.mockResolvedValueOnce(
                Buffer.from('node_modules\ndist')
            );
            mockReadFile.mockResolvedValueOnce(
                Buffer.from('*.local\n.env.local')
            );

            const mockRepo = {
                rootUri: { fsPath: '/test/repo' },
            };

            const result = await readGitignore(mockRepo as any);

            expect(result).toBe('node_modules\ndist\n*.local\n.env.local');
            expect(vscode.Uri.file).toHaveBeenCalledWith(
                expect.stringContaining('.gitignore')
            );
            expect(vscode.Uri.file).toHaveBeenCalledWith(
                expect.stringContaining('exclude')
            );
        });

        it('should handle missing .gitignore gracefully', async () => {
            mockReadFile.mockRejectedValueOnce(new Error('ENOENT')); // No .gitignore
            mockReadFile.mockResolvedValueOnce(Buffer.from('*.local'));

            const mockRepo = {
                rootUri: { fsPath: '/test/repo' },
            };

            const result = await readGitignore(mockRepo as any);

            expect(result).toBe('*.local');
        });

        it('should handle missing .git/info/exclude gracefully', async () => {
            mockReadFile.mockResolvedValueOnce(Buffer.from('node_modules'));
            mockReadFile.mockRejectedValueOnce(new Error('ENOENT')); // No exclude file

            const mockRepo = {
                rootUri: { fsPath: '/test/repo' },
            };

            const result = await readGitignore(mockRepo as any);

            expect(result).toBe('node_modules');
        });

        it('should return empty string when both files are missing', async () => {
            mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));
            mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));

            const mockRepo = {
                rootUri: { fsPath: '/test/repo' },
            };

            const result = await readGitignore(mockRepo as any);

            expect(result).toBe('');
        });
    });
});
