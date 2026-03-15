import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GetPRContextTool } from '../tools/getPRContextTool';
import { createMockExecutionContext } from './testUtils/mockFactories';
import type { ExecutionContext } from '../types/executionContext';
import type { GitOperationsManager } from '../services/gitOperationsManager';

function createMockGitOps(
    overrides: Partial<GitOperationsManager> = {}
): GitOperationsManager {
    return {
        getRepository: vi.fn().mockReturnValue({
            state: { HEAD: { name: 'feature/my-branch' } },
        }),
        getDefaultBranch: vi.fn().mockResolvedValue('main'),
        getCommitLog: vi
            .fn()
            .mockResolvedValue(
                'abc1234 feat: add new feature\ndef5678 fix: resolve edge case'
            ),
        ...overrides,
    } as unknown as GitOperationsManager;
}

describe('GetPRContextTool', () => {
    let tool: GetPRContextTool;
    let mockGitOps: GitOperationsManager;
    let context: ExecutionContext;

    beforeEach(() => {
        mockGitOps = createMockGitOps();
        tool = new GetPRContextTool(mockGitOps);
        context = createMockExecutionContext({
            parsedDiff: [
                { filePath: 'src/foo.ts', hunks: [] } as any,
                { filePath: 'src/bar.ts', hunks: [] } as any,
            ],
        });
    });

    it('should have correct name', () => {
        expect(tool.name).toBe('get_pr_context');
    });

    it('returns branch name, commits, and changed files', async () => {
        const result = await tool.execute({ max_commits: 30 }, context);
        expect(result.success).toBe(true);
        expect(result.data).toContain('feature/my-branch');
        expect(result.data).toContain('main');
        expect(result.data).toContain('feat: add new feature');
        expect(result.data).toContain('fix: resolve edge case');
        expect(result.data).toContain('src/foo.ts');
        expect(result.data).toContain('src/bar.ts');
        expect(result.data).toContain('Changed Files (2)');
    });

    it('returns error when no repository available', async () => {
        mockGitOps = createMockGitOps({
            getRepository: vi.fn().mockReturnValue(null),
        });
        tool = new GetPRContextTool(mockGitOps);
        const result = await tool.execute({ max_commits: 30 }, context);
        expect(result.success).toBe(false);
        expect(result.error).toContain('not available');
    });

    it('handles missing default branch gracefully', async () => {
        mockGitOps = createMockGitOps({
            getDefaultBranch: vi.fn().mockResolvedValue(undefined),
        });
        tool = new GetPRContextTool(mockGitOps);
        const result = await tool.execute({ max_commits: 30 }, context);
        expect(result.success).toBe(true);
        expect(result.data).toContain('feature/my-branch');
        expect(result.data).toContain('Could not determine base branch');
    });

    it('handles no commits between branches', async () => {
        mockGitOps = createMockGitOps({
            getCommitLog: vi.fn().mockResolvedValue(''),
        });
        tool = new GetPRContextTool(mockGitOps);
        const result = await tool.execute({ max_commits: 30 }, context);
        expect(result.success).toBe(true);
        expect(result.data).toContain('No commits found');
    });

    it('handles git error gracefully', async () => {
        mockGitOps = createMockGitOps({
            getCommitLog: vi.fn().mockRejectedValue(new Error('git failed')),
        });
        tool = new GetPRContextTool(mockGitOps);
        const result = await tool.execute({ max_commits: 30 }, context);
        expect(result.success).toBe(true);
        expect(result.data).toContain('Could not retrieve commit messages');
    });

    it('works without parsedDiff', async () => {
        context = createMockExecutionContext();
        const result = await tool.execute({ max_commits: 30 }, context);
        expect(result.success).toBe(true);
        expect(result.data).toContain('feature/my-branch');
        expect(result.data).not.toContain('Changed Files');
    });

    it('handles detached HEAD', async () => {
        mockGitOps = createMockGitOps({
            getRepository: vi.fn().mockReturnValue({
                state: { HEAD: { name: undefined } },
            }),
        });
        tool = new GetPRContextTool(mockGitOps);
        const result = await tool.execute({ max_commits: 30 }, context);
        expect(result.success).toBe(true);
        expect(result.data).toContain('detached HEAD');
    });

    it('passes max_commits to getCommitLog', async () => {
        await tool.execute({ max_commits: 10 }, context);
        expect(mockGitOps.getCommitLog).toHaveBeenCalledWith('main', 10);
    });
});
