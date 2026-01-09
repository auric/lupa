import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { fdir } from 'fdir';
import { FileDiscoverer } from '../utils/fileDiscoverer';
import { TimeoutError } from '../types/errorTypes';
import type { Repository } from '../types/vscodeGitExtension';
import {
    createMockCancellationTokenSource,
    createMockFdirInstance,
    createMockGitRepository,
} from './testUtils/mockFactories';

// Mock dependencies
vi.mock('fdir');
vi.mock('../utils/gitUtils', () => ({
    readGitignore: vi.fn().mockResolvedValue([]),
}));

describe('FileDiscoverer', () => {
    const mockGitRepo = createMockGitRepository(
        '/test/git-repo'
    ) as unknown as Repository;

    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('discoverFiles', () => {
        it('should return files matching the pattern', async () => {
            const mockFiles = [
                '/test/git-repo/src/file1.ts',
                '/test/git-repo/src/file2.ts',
            ];
            const mockFdirInstance = createMockFdirInstance(mockFiles);
            vi.mocked(fdir).mockImplementation(function () {
                return mockFdirInstance;
            } as any);

            const result = await FileDiscoverer.discoverFiles(mockGitRepo, {
                includePattern: '*.ts',
            });

            expect(result.files).toEqual(['src/file1.ts', 'src/file2.ts']);
            expect(result.truncated).toBe(false);
            expect(result.totalFound).toBe(2);
        });

        it('should truncate results when exceeding maxResults', async () => {
            // Generate many files
            const mockFiles = Array.from(
                { length: 150 },
                (_, i) => `/test/git-repo/file${i}.ts`
            );
            const mockFdirInstance = createMockFdirInstance(mockFiles);
            vi.mocked(fdir).mockImplementation(function () {
                return mockFdirInstance;
            } as any);

            const result = await FileDiscoverer.discoverFiles(mockGitRepo, {
                includePattern: '*.ts',
                maxResults: 100,
            });

            expect(result.files.length).toBe(100);
            expect(result.truncated).toBe(true);
            expect(result.totalFound).toBe(150);
        });

        it('should throw TimeoutError when discovery times out', async () => {
            const mockFdirInstance = createMockFdirInstance([]);
            // Track the abort signal passed to fdir
            let capturedSignal: AbortSignal | undefined;
            mockFdirInstance.withAbortSignal.mockImplementation(function (
                this: ReturnType<typeof createMockFdirInstance>,
                signal: AbortSignal
            ) {
                capturedSignal = signal;
                return this;
            });
            // Simulate fdir that responds to abort signal
            mockFdirInstance.withPromise.mockImplementation(() => {
                return new Promise((resolve, reject) => {
                    // Simulate slow crawl, but respond to abort signal
                    const slowTimeout = setTimeout(() => resolve([]), 60000);
                    capturedSignal?.addEventListener('abort', () => {
                        clearTimeout(slowTimeout);
                        reject(new DOMException('Aborted', 'AbortError'));
                    });
                });
            });
            vi.mocked(fdir).mockImplementation(function () {
                return mockFdirInstance;
            } as any);

            // 20ms timeout - will fire before the mock resolves
            await expect(
                FileDiscoverer.discoverFiles(mockGitRepo, {
                    includePattern: '*.ts',
                    timeoutMs: 20,
                })
            ).rejects.toThrow(TimeoutError);
        });

        it('should throw CancellationError when already cancelled', async () => {
            const tokenSource = createMockCancellationTokenSource();
            tokenSource.cancel();

            await expect(
                FileDiscoverer.discoverFiles(mockGitRepo, {
                    includePattern: '*.ts',
                    cancellationToken: tokenSource.token,
                })
            ).rejects.toThrow(vscode.CancellationError);
        });

        it('should throw CancellationError when cancelled during discovery', async () => {
            const tokenSource = createMockCancellationTokenSource();
            const mockFdirInstance = createMockFdirInstance([]);

            // Simulate fdir rejecting with AbortError when abort signal fires
            mockFdirInstance.withPromise.mockRejectedValue(
                new DOMException('Aborted', 'AbortError')
            );
            vi.mocked(fdir).mockImplementation(function () {
                return mockFdirInstance;
            } as any);

            // Cancel immediately - the mock rejects with AbortError
            tokenSource.cancel();

            await expect(
                FileDiscoverer.discoverFiles(mockGitRepo, {
                    includePattern: '*.ts',
                    timeoutMs: 30000, // Long timeout
                    cancellationToken: tokenSource.token,
                })
            ).rejects.toThrow(vscode.CancellationError);
        });

        it('should throw CancellationError when cancelled mid-flight (after discoverFiles called)', async () => {
            const tokenSource = createMockCancellationTokenSource();
            const mockFdirInstance = createMockFdirInstance([]);

            // Track the abort signal and simulate mid-flight cancellation
            let capturedSignal: AbortSignal | undefined;
            mockFdirInstance.withAbortSignal.mockImplementation(function (
                this: ReturnType<typeof createMockFdirInstance>,
                signal: AbortSignal
            ) {
                capturedSignal = signal;
                return this;
            });

            // Simulate fdir that rejects with AbortError when signal fires mid-flight
            mockFdirInstance.withPromise.mockImplementation(() => {
                return new Promise((resolve, reject) => {
                    // Cancel AFTER the promise starts (mid-flight)
                    setTimeout(() => {
                        tokenSource.cancel();
                    }, 5);
                    // Listen for abort and reject with AbortError (like real fdir)
                    capturedSignal?.addEventListener('abort', () => {
                        reject(new DOMException('Aborted', 'AbortError'));
                    });
                });
            });
            vi.mocked(fdir).mockImplementation(function () {
                return mockFdirInstance;
            } as any);

            // Token is NOT cancelled when discoverFiles is called
            // Cancellation happens mid-flight inside withPromise
            await expect(
                FileDiscoverer.discoverFiles(mockGitRepo, {
                    includePattern: '*.ts',
                    timeoutMs: 30000, // Long timeout so timeout doesn't interfere
                    cancellationToken: tokenSource.token,
                })
            ).rejects.toThrow(vscode.CancellationError);
        });

        it('should pass abort signal to fdir for proper cancellation', async () => {
            const mockFdirInstance = createMockFdirInstance([
                '/test/git-repo/file.ts',
            ]);
            vi.mocked(fdir).mockImplementation(function () {
                return mockFdirInstance;
            } as any);

            await FileDiscoverer.discoverFiles(mockGitRepo, {
                includePattern: '*.ts',
            });

            expect(mockFdirInstance.withAbortSignal).toHaveBeenCalledWith(
                expect.any(AbortSignal)
            );
        });

        it('should prioritize cancellation over timeout when both occur', async () => {
            const tokenSource = createMockCancellationTokenSource();
            const mockFdirInstance = createMockFdirInstance([]);

            // Simulate fdir rejecting with AbortError
            mockFdirInstance.withPromise.mockRejectedValue(
                new DOMException('Aborted', 'AbortError')
            );
            vi.mocked(fdir).mockImplementation(function () {
                return mockFdirInstance;
            } as any);

            // Cancel before calling - cancellation takes priority over timeout
            tokenSource.cancel();

            // Even with very short timeout, CancellationError should be thrown
            await expect(
                FileDiscoverer.discoverFiles(mockGitRepo, {
                    includePattern: '*.ts',
                    timeoutMs: 1, // Very short timeout
                    cancellationToken: tokenSource.token,
                })
            ).rejects.toThrow(vscode.CancellationError);
        });

        it('should clean up timeout when discovery completes successfully', async () => {
            const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
            const mockFdirInstance = createMockFdirInstance([
                '/test/git-repo/file.ts',
            ]);
            vi.mocked(fdir).mockImplementation(function () {
                return mockFdirInstance;
            } as any);

            await FileDiscoverer.discoverFiles(mockGitRepo, {
                includePattern: '*.ts',
            });

            expect(clearTimeoutSpy).toHaveBeenCalled();
        });

        it('should dispose cancellation listener on success', async () => {
            const tokenSource = createMockCancellationTokenSource();
            const mockFdirInstance = createMockFdirInstance([
                '/test/git-repo/file.ts',
            ]);
            vi.mocked(fdir).mockImplementation(function () {
                return mockFdirInstance;
            } as any);

            await FileDiscoverer.discoverFiles(mockGitRepo, {
                includePattern: '*.ts',
                cancellationToken: tokenSource.token,
            });

            // The onCancellationRequested returns a disposable that should be disposed
            const mockDisposable = vi.mocked(
                tokenSource.token.onCancellationRequested
            ).mock.results[0]?.value;
            expect(mockDisposable?.dispose).toHaveBeenCalled();
        });
    });
});
