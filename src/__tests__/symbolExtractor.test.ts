import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { SymbolExtractor } from '../utils/symbolExtractor';
import { GitOperationsManager } from '../services/gitOperationsManager';

// Mock vscode module
vi.mock('vscode', async () => {
    const actual = await vi.importActual<typeof vscode>('vscode');
    return {
        ...actual,
        commands: {
            executeCommand: vi.fn(),
        },
        workspace: {
            fs: {
                readDirectory: vi.fn(),
                stat: vi.fn(),
            },
        },
        Uri: {
            file: (path: string) => ({ fsPath: path, toString: () => path }),
        },
        CancellationError: class CancellationError extends Error {
            constructor() {
                super('Cancelled');
                this.name = 'CancellationError';
            }
        },
        CancellationTokenSource: class {
            token = {
                isCancellationRequested: false,
                onCancellationRequested: vi.fn(() => ({ dispose: vi.fn() })),
            };
            cancel() {
                this.token.isCancellationRequested = true;
            }
            dispose() {}
        },
        FileType: {
            File: 1,
            Directory: 2,
        },
    };
});

// Mock gitUtils
vi.mock('../utils/gitUtils', () => ({
    readGitignore: vi.fn().mockResolvedValue(''),
}));

describe('SymbolExtractor', () => {
    let symbolExtractor: SymbolExtractor;
    let mockGitOperationsManager: GitOperationsManager;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();

        mockGitOperationsManager = {
            getGitRoot: vi.fn().mockReturnValue('/workspace'),
            getRepository: vi.fn().mockReturnValue(undefined),
        } as unknown as GitOperationsManager;

        symbolExtractor = new SymbolExtractor(mockGitOperationsManager);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('getFileSymbols', () => {
        it('should return symbols from LSP', async () => {
            const mockSymbols = [
                { name: 'TestClass', kind: 5 },
                { name: 'testMethod', kind: 6 },
            ];

            (vscode.commands.executeCommand as any).mockResolvedValue(
                mockSymbols
            );

            const result = await symbolExtractor.getFileSymbols(
                vscode.Uri.file('/workspace/test.ts')
            );

            expect(result).toEqual(mockSymbols);
            expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
                'vscode.executeDocumentSymbolProvider',
                expect.any(Object)
            );
        });

        it('should return empty array when LSP returns null', async () => {
            (vscode.commands.executeCommand as any).mockResolvedValue(null);

            const result = await symbolExtractor.getFileSymbols(
                vscode.Uri.file('/workspace/test.ts')
            );

            expect(result).toEqual([]);
        });

        it('should throw CancellationError when token is pre-cancelled', async () => {
            const tokenSource = new vscode.CancellationTokenSource();
            tokenSource.cancel();

            // The LSP call shouldn't even be reached
            (vscode.commands.executeCommand as any).mockResolvedValue([]);

            await expect(
                symbolExtractor.getFileSymbols(
                    vscode.Uri.file('/workspace/test.ts'),
                    tokenSource.token
                )
            ).rejects.toThrow(vscode.CancellationError);
        });

        it('should throw TimeoutError when LSP is slow', async () => {
            // LSP takes too long - simulate by never resolving
            let resolvePromise: (() => void) | undefined;
            (vscode.commands.executeCommand as any).mockImplementation(
                () =>
                    new Promise((resolve) => {
                        resolvePromise = () => resolve([]);
                        setTimeout(resolvePromise, 10_000); // 10 seconds
                    })
            );

            const promise = symbolExtractor.getFileSymbols(
                vscode.Uri.file('/workspace/test.ts')
            );

            // Suppress the rejection we're testing
            promise.catch(() => {});

            // Advance past FILE_SYMBOL_TIMEOUT (5 seconds)
            await vi.advanceTimersByTimeAsync(5_100);

            await expect(promise).rejects.toThrow(/timed out/i);
        });

        it('should return empty array for non-fatal LSP errors', async () => {
            (vscode.commands.executeCommand as any).mockRejectedValue(
                new Error('LSP provider not available')
            );

            const result = await symbolExtractor.getFileSymbols(
                vscode.Uri.file('/workspace/test.ts')
            );

            expect(result).toEqual([]);
        });
    });

    describe('getDirectorySymbols', () => {
        beforeEach(() => {
            // Mock readDirectory to return some files
            (vscode.workspace.fs.readDirectory as any).mockResolvedValue([
                ['file1.ts', vscode.FileType.File],
                ['file2.ts', vscode.FileType.File],
            ]);

            // Mock LSP to return symbols for each file
            (vscode.commands.executeCommand as any).mockResolvedValue([
                { name: 'Symbol1', kind: 5 },
            ]);
        });

        it('should extract symbols from all files in directory', async () => {
            const tokenSource = new vscode.CancellationTokenSource();
            const result = await symbolExtractor.getDirectorySymbols(
                '/workspace/src',
                'src',
                { token: tokenSource.token }
            );

            expect(result.results.length).toBe(2);
            expect(result.truncated).toBe(false);
            expect(result.timedOutFiles).toBe(0);
        });

        it('should throw CancellationError when token is pre-cancelled', async () => {
            const tokenSource = new vscode.CancellationTokenSource();
            tokenSource.cancel();

            await expect(
                symbolExtractor.getDirectorySymbols('/workspace/src', 'src', {
                    token: tokenSource.token,
                })
            ).rejects.toThrow(vscode.CancellationError);

            // readDirectory should not have been called
            expect(vscode.workspace.fs.readDirectory).not.toHaveBeenCalled();
        });

        it('should return truncated=true and timedOutFiles count when per-file timeouts occur', async () => {
            // First file times out, second succeeds
            let callCount = 0;
            (vscode.commands.executeCommand as any).mockImplementation(() => {
                callCount++;
                if (callCount === 1) {
                    // First file - simulate timeout (returns promise that resolves after timeout)
                    return new Promise((resolve) => {
                        setTimeout(() => resolve([]), 10_000);
                    });
                }
                // Second file - return immediately
                return Promise.resolve([{ name: 'Symbol', kind: 5 }]);
            });

            const tokenSource = new vscode.CancellationTokenSource();
            const promise = symbolExtractor.getDirectorySymbols(
                '/workspace/src',
                'src',
                { token: tokenSource.token, timeoutMs: 30_000 } // Give enough time for directory scan
            );

            // Suppress unhandled rejections during timer advancement
            promise.catch(() => {});

            // Advance past file timeout (5s) but not directory timeout
            await vi.advanceTimersByTimeAsync(5_100);

            const result = await promise;

            // Should have 1 successful file, 1 timed out
            expect(result.results.length).toBe(1);
            expect(result.timedOutFiles).toBe(1);
            expect(result.truncated).toBe(true);
        });

        it('should respect maxDepth option', async () => {
            // Root has a subdirectory
            (vscode.workspace.fs.readDirectory as any)
                .mockResolvedValueOnce([
                    ['file1.ts', vscode.FileType.File],
                    ['subdir', vscode.FileType.Directory],
                ])
                .mockResolvedValueOnce([['file2.ts', vscode.FileType.File]]);

            const tokenSource = new vscode.CancellationTokenSource();
            const result = await symbolExtractor.getDirectorySymbols(
                '/workspace/src',
                'src',
                { token: tokenSource.token, maxDepth: 0 } // Only root level
            );

            // Should only process root level file
            expect(result.results.length).toBe(1);
            expect(result.results[0].filePath).toContain('file1.ts');
        });
    });

    describe('getAllFiles', () => {
        it('should throw CancellationError when token is pre-cancelled', async () => {
            const tokenSource = new vscode.CancellationTokenSource();
            // Pre-cancel the token
            tokenSource.cancel();

            (vscode.workspace.fs.readDirectory as any).mockResolvedValue([
                ['file1.ts', vscode.FileType.File],
            ]);

            const getAllFiles = (symbolExtractor as any).getAllFiles.bind(
                symbolExtractor
            );

            const mockIgnore = { ignores: () => false };

            await expect(
                getAllFiles(
                    '/workspace/src', // targetPath
                    'src', // relativePath
                    mockIgnore, // ignorePatterns
                    { token: tokenSource.token }, // options
                    0, // currentDepth
                    Date.now(), // startTime
                    10_000 // timeoutMs
                )
            ).rejects.toThrow(vscode.CancellationError);

            // readDirectory should not have been called since token was pre-cancelled
            expect(vscode.workspace.fs.readDirectory).not.toHaveBeenCalled();
        });
    });
});
