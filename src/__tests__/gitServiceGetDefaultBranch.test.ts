import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Repository } from '../types/vscodeGitExtension';

// Mock vscode before importing GitService
vi.mock('vscode', async () => {
    const actualVscode = await vi.importActual('vscode');
    return {
        ...actualVscode,
        extensions: {
            getExtension: vi.fn()
        },
        window: {
            showQuickPick: vi.fn(),
            showErrorMessage: vi.fn(),
            showInformationMessage: vi.fn(),
            withProgress: vi.fn()
        },
        workspace: {
            workspaceFolders: []
        },
        commands: {
            executeCommand: vi.fn()
        },
        Uri: {
            file: vi.fn().mockImplementation((path) => ({ fsPath: path, path })),
            joinPath: vi.fn().mockImplementation((...args) => ({ fsPath: args.join('/') }))
        },
        ProgressLocation: {
            Notification: 15
        }
    };
});

// Mock LoggingService
vi.mock('../services/loggingService', () => ({
    Log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn()
    }
}));

// Mock child_process
vi.mock('child_process', () => ({
    spawn: vi.fn()
}));

import { GitService } from '../services/gitService';
import { Log } from '../services/loggingService';
import * as child_process from 'child_process';
import { EventEmitter } from 'events';

/**
 * Creates a mock spawn result for git commands
 */
function createMockSpawn(stdout: string, exitCode = 0, stderr = ''): child_process.ChildProcess {
    const mockProcess = new EventEmitter() as child_process.ChildProcess;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();

    (mockProcess as any).stdout = stdoutEmitter;
    (mockProcess as any).stderr = stderrEmitter;

    // Emit data and close on next tick
    process.nextTick(() => {
        if (stdout) {
            stdoutEmitter.emit('data', Buffer.from(stdout));
        }
        if (stderr) {
            stderrEmitter.emit('data', Buffer.from(stderr));
        }
        mockProcess.emit('close', exitCode);
    });

    return mockProcess;
}

/**
 * Creates a mock spawn that fails with an error
 */
function createMockSpawnError(errorMessage: string): child_process.ChildProcess {
    const mockProcess = new EventEmitter() as child_process.ChildProcess;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();

    (mockProcess as any).stdout = stdoutEmitter;
    (mockProcess as any).stderr = stderrEmitter;

    process.nextTick(() => {
        stderrEmitter.emit('data', Buffer.from(errorMessage));
        mockProcess.emit('close', 1);
    });

    return mockProcess;
}

describe('GitService.getDefaultBranch', () => {
    let gitService: GitService;
    let mockRepository: Partial<Repository>;
    let spawnMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        // Reset the singleton
        (GitService as any).instance = null;
        gitService = GitService.getInstance();

        // Create mock repository
        mockRepository = {
            rootUri: { fsPath: '/test/repo' } as any,
            getConfigs: vi.fn().mockResolvedValue([]),
            getRefs: vi.fn().mockResolvedValue([]),
            state: {
                HEAD: { name: 'feature-branch' },
                remotes: [{ name: 'origin', fetchUrl: 'git@github.com:test/repo.git' }],
                submodules: [],
                workingTreeChanges: [],
                indexChanges: []
            } as any
        };

        // Inject mock repository
        (gitService as any).repository = mockRepository;

        // Setup spawn mock
        spawnMock = vi.mocked(child_process.spawn);
        spawnMock.mockReset();

        // Clear caches
        (gitService as any).defaultBranchCache = null;
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    describe('Method 1: Git config', () => {
        it('should return branch from remote.origin.head config', async () => {
            mockRepository.getConfigs = vi.fn().mockResolvedValue([
                { key: 'remote.origin.head', value: 'refs/heads/main' }
            ]);

            const result = await gitService.getDefaultBranch();

            expect(result).toBe('main');
            expect(Log.info).toHaveBeenCalledWith('Default branch from config: main');
        });

        it('should handle config with develop branch', async () => {
            mockRepository.getConfigs = vi.fn().mockResolvedValue([
                { key: 'remote.origin.head', value: 'refs/heads/develop' }
            ]);

            const result = await gitService.getDefaultBranch();

            expect(result).toBe('develop');
        });
    });

    describe('Method 2: Symbolic ref', () => {
        it('should return branch from symbolic-ref when config is empty', async () => {
            mockRepository.getConfigs = vi.fn().mockResolvedValue([]);
            spawnMock.mockImplementation((cmd, args) => {
                if (args?.includes('symbolic-ref')) {
                    return createMockSpawn('origin/main');
                }
                return createMockSpawnError('not found');
            });

            const result = await gitService.getDefaultBranch();

            expect(result).toBe('main');
            expect(Log.info).toHaveBeenCalledWith('Default branch from symbolic-ref: main');
        });

        it('should strip origin/ prefix from symbolic-ref result', async () => {
            mockRepository.getConfigs = vi.fn().mockResolvedValue([]);
            spawnMock.mockImplementation((cmd, args) => {
                if (args?.includes('symbolic-ref')) {
                    return createMockSpawn('origin/master');
                }
                return createMockSpawnError('not found');
            });

            const result = await gitService.getDefaultBranch();

            expect(result).toBe('master');
        });
    });

    describe('Method 3: Remote tracking branches', () => {
        it('should check remote tracking branches in priority order', async () => {
            mockRepository.getConfigs = vi.fn().mockResolvedValue([]);
            const checkedBranches: string[] = [];

            spawnMock.mockImplementation((cmd, args) => {
                if (args?.includes('symbolic-ref')) {
                    return createMockSpawnError('not a symbolic ref');
                }
                if (args?.includes('rev-parse') && args?.some((a: string) => a.includes('refs/remotes/origin/'))) {
                    const branchArg = args.find((a: string) => a.includes('refs/remotes/origin/'));
                    const branch = branchArg?.replace('refs/remotes/origin/', '');
                    checkedBranches.push(branch!);

                    // Only master exists
                    if (branch === 'master') {
                        return createMockSpawn('abc123');
                    }
                    return createMockSpawnError('not found');
                }
                return createMockSpawnError('not found');
            });

            const result = await gitService.getDefaultBranch();

            // Should check main first, then master
            expect(checkedBranches[0]).toBe('main');
            expect(checkedBranches[1]).toBe('master');
            expect(result).toBe('master');
            expect(Log.info).toHaveBeenCalledWith('Default branch from remote tracking ref: master');
        });

        it('should return main over master when both exist', async () => {
            mockRepository.getConfigs = vi.fn().mockResolvedValue([]);

            spawnMock.mockImplementation((cmd, args) => {
                if (args?.includes('symbolic-ref')) {
                    return createMockSpawnError('not a symbolic ref');
                }
                if (args?.includes('rev-parse') && args?.some((a: string) => a.includes('refs/remotes/origin/'))) {
                    // Both main and master exist
                    return createMockSpawn('abc123');
                }
                return createMockSpawnError('not found');
            });

            const result = await gitService.getDefaultBranch();

            // main should be returned first (priority order)
            expect(result).toBe('main');
        });
    });

    describe('Method 4: Local branches', () => {
        it('should check local branches when remote tracking fails', async () => {
            mockRepository.getConfigs = vi.fn().mockResolvedValue([]);

            spawnMock.mockImplementation((cmd, args) => {
                if (args?.includes('symbolic-ref')) {
                    return createMockSpawnError('not a symbolic ref');
                }
                if (args?.includes('rev-parse')) {
                    const refArg = args.find((a: string) => a.startsWith('refs/'));
                    // Remote tracking branches don't exist
                    if (refArg?.includes('refs/remotes/')) {
                        return createMockSpawnError('not found');
                    }
                    // Local develop branch exists
                    if (refArg === 'refs/heads/develop') {
                        return createMockSpawn('abc123');
                    }
                    return createMockSpawnError('not found');
                }
                return createMockSpawnError('not found');
            });

            const result = await gitService.getDefaultBranch();

            expect(result).toBe('develop');
            expect(Log.info).toHaveBeenCalledWith('Default branch from local branch: develop');
        });

        it('should maintain priority order for local branches', async () => {
            mockRepository.getConfigs = vi.fn().mockResolvedValue([]);
            const localBranchesChecked: string[] = [];

            spawnMock.mockImplementation((cmd, args) => {
                if (args?.includes('symbolic-ref')) {
                    return createMockSpawnError('not a symbolic ref');
                }
                if (args?.includes('rev-parse')) {
                    const refArg = args.find((a: string) => a.startsWith('refs/'));
                    if (refArg?.includes('refs/remotes/')) {
                        return createMockSpawnError('not found');
                    }
                    if (refArg?.includes('refs/heads/')) {
                        localBranchesChecked.push(refArg.replace('refs/heads/', ''));
                        // dev exists
                        if (refArg === 'refs/heads/dev') {
                            return createMockSpawn('abc123');
                        }
                    }
                    return createMockSpawnError('not found');
                }
                return createMockSpawnError('not found');
            });

            const result = await gitService.getDefaultBranch();

            // Should check in order: main, master, develop, dev
            expect(localBranchesChecked).toEqual(['main', 'master', 'develop', 'dev']);
            expect(result).toBe('dev');
        });
    });

    describe('Method 5: Network call (last resort)', () => {
        it('should try network call when all local methods fail', async () => {
            mockRepository.getConfigs = vi.fn().mockResolvedValue([]);

            spawnMock.mockImplementation((cmd, args) => {
                if (args?.includes('symbolic-ref')) {
                    return createMockSpawnError('not a symbolic ref');
                }
                if (args?.includes('rev-parse')) {
                    return createMockSpawnError('not found');
                }
                if (args?.includes('remote') && args?.includes('show')) {
                    return createMockSpawn('* remote origin\n  HEAD branch: main\n');
                }
                return createMockSpawnError('not found');
            });

            const result = await gitService.getDefaultBranch();

            expect(result).toBe('main');
            expect(Log.info).toHaveBeenCalledWith('Default branch from remote: main');
        });

        it('should handle network error gracefully and fall back to HEAD', async () => {
            mockRepository.getConfigs = vi.fn().mockResolvedValue([]);

            spawnMock.mockImplementation((cmd, args) => {
                if (args?.includes('remote') && args?.includes('show')) {
                    return createMockSpawnError('Permission denied (publickey)');
                }
                return createMockSpawnError('not found');
            });

            const result = await gitService.getDefaultBranch();

            // Should fall back to current HEAD
            expect(result).toBe('feature-branch');
            expect(Log.info).toHaveBeenCalledWith(
                'Could not fetch default branch from remote (requires network/SSH access), falling back to current HEAD',
                expect.any(Error)
            );
            expect(Log.info).toHaveBeenCalledWith(
                'Using current HEAD as default branch fallback: feature-branch'
            );
        });
    });

    describe('Method 6: HEAD fallback', () => {
        it('should return HEAD name when all methods fail', async () => {
            mockRepository.getConfigs = vi.fn().mockResolvedValue([]);
            (mockRepository.state as any).remotes = []; // No remotes

            spawnMock.mockImplementation(() => createMockSpawnError('not found'));

            const result = await gitService.getDefaultBranch();

            expect(result).toBe('feature-branch');
            expect(Log.info).toHaveBeenCalledWith(
                'Using current HEAD as default branch fallback: feature-branch'
            );
        });

        it('should return undefined when HEAD has no name', async () => {
            mockRepository.getConfigs = vi.fn().mockResolvedValue([]);
            (mockRepository.state as any).HEAD = {}; // No name
            (mockRepository.state as any).remotes = [];

            spawnMock.mockImplementation(() => createMockSpawnError('not found'));

            const result = await gitService.getDefaultBranch();

            expect(result).toBeUndefined();
        });
    });

    describe('Caching', () => {
        it('should cache the result and return it on subsequent calls', async () => {
            mockRepository.getConfigs = vi.fn().mockResolvedValue([
                { key: 'remote.origin.head', value: 'refs/heads/main' }
            ]);

            const result1 = await gitService.getDefaultBranch();
            const result2 = await gitService.getDefaultBranch();

            expect(result1).toBe('main');
            expect(result2).toBe('main');
            // getConfigs should only be called once due to caching
            expect(mockRepository.getConfigs).toHaveBeenCalledTimes(1);
        });
    });

    describe('Error handling', () => {
        it('should return undefined and log error when repository is not initialized', async () => {
            (gitService as any).repository = null;

            const result = await gitService.getDefaultBranch();

            expect(result).toBeUndefined();
            expect(Log.error).toHaveBeenCalledWith(
                'Error getting default branch:',
                expect.any(Error)
            );
        });
    });
});
