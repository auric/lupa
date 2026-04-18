import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveDiff } from '../../eval/diffResolver';
import type { IServiceRegistry } from '../../services/serviceManager';

vi.mock('vscode');

const compareBranches = vi.fn();

vi.mock('../../services/gitService', () => ({
    GitService: {
        getInstance: () => ({
            compareBranches,
        }),
    },
}));

function makeServices(initialize: () => Promise<boolean>): IServiceRegistry {
    return {
        gitOperations: {
            initialize: vi.fn(initialize),
        },
    } as unknown as IServiceRegistry;
}

describe('resolveDiff', () => {
    beforeEach(() => {
        compareBranches.mockReset();
    });

    it('throws when baseRef is a dir: path but headRef is a git ref', async () => {
        const services = makeServices(async () => true);
        await expect(
            resolveDiff(
                {
                    workspaceRoot: '/w',
                    baseRef: 'dir:/a',
                    headRef: 'main',
                },
                services
            )
        ).rejects.toThrow(
            /both be directory paths \(dir:\) or both be git refs/
        );
    });

    it('throws when the git extension is unavailable', async () => {
        const services = makeServices(async () => false);
        await expect(
            resolveDiff(
                {
                    workspaceRoot: '/w',
                    baseRef: 'main',
                    headRef: 'dev',
                },
                services
            )
        ).rejects.toThrow(/Git extension unavailable/);
    });

    it('strips sha: prefix before invoking compareBranches', async () => {
        const services = makeServices(async () => true);
        compareBranches.mockResolvedValue({
            diffText: 'x',
            error: undefined,
        });

        const diff = await resolveDiff(
            {
                workspaceRoot: '/w',
                baseRef: 'sha:abc',
                headRef: 'sha:def',
            },
            services
        );

        expect(diff).toBe('x');
        expect(compareBranches).toHaveBeenCalledTimes(1);
        expect(compareBranches).toHaveBeenCalledWith({
            base: 'abc',
            compare: 'def',
        });
    });

    it('surfaces compareBranches errors', async () => {
        const services = makeServices(async () => true);
        compareBranches.mockResolvedValue({
            diffText: '',
            error: 'bad ref',
        });

        await expect(
            resolveDiff(
                {
                    workspaceRoot: '/w',
                    baseRef: 'main',
                    headRef: 'dev',
                },
                services
            )
        ).rejects.toThrow(/bad ref/);
    });
});
