import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { EventEmitter } from 'events';
import * as childProcess from 'child_process';

// Mock child_process.spawn
vi.mock('child_process', () => ({
    spawn: vi.fn(),
}));

// Mock fs for the path validation
vi.mock('fs', () => ({
    existsSync: vi.fn().mockReturnValue(true),
}));

describe('RipgrepSearchService', () => {
    let mockProcess: MockChildProcess;
    let mockSpawn: ReturnType<typeof vi.fn>;

    class MockChildProcess extends EventEmitter {
        stdout = new EventEmitter();
        stderr = new EventEmitter();
        exitCode: number | null = null;
        killed = false;
        killCalls: string[] = [];

        kill(signal?: string) {
            this.killCalls.push(signal || 'SIGTERM');
            this.killed = true;
            // Don't automatically set exitCode - let the test control this
        }

        // Helper to simulate process close
        simulateClose(code: number | null = 0) {
            this.exitCode = code;
            this.emit('close', code);
        }
    }

    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();

        mockProcess = new MockChildProcess();
        mockSpawn = vi.mocked(childProcess.spawn);
        mockSpawn.mockReturnValue(
            mockProcess as unknown as childProcess.ChildProcess
        );
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('SIGKILL escalation', () => {
        it('should escalate to SIGKILL if SIGTERM is ignored after grace period', async () => {
            // Import after mocks are set up
            const { RipgrepSearchService } =
                await import('../services/ripgrepSearchService');

            const service = new RipgrepSearchService();

            // Create a mock cancellation token that becomes cancelled
            let cancellationCallback: (() => void) | undefined;
            const mockToken = {
                isCancellationRequested: false,
                onCancellationRequested: vi.fn((callback) => {
                    cancellationCallback = callback;
                    return { dispose: vi.fn() };
                }),
            };

            // Start the search
            const searchPromise = service.search({
                pattern: 'test',
                cwd: '/test',
                multiline: false,
                token: mockToken as vscode.CancellationToken,
            });

            // Trigger cancellation and mark token as cancelled
            expect(cancellationCallback).toBeDefined();
            mockToken.isCancellationRequested = true;
            cancellationCallback!();

            // Verify SIGTERM was called first
            expect(mockProcess.killCalls).toContain('SIGTERM');
            expect(mockProcess.killCalls).not.toContain('SIGKILL');

            // Process ignores SIGTERM - exitCode stays null
            expect(mockProcess.exitCode).toBeNull();

            // Advance time past the SIGTERM grace period (500ms)
            await vi.advanceTimersByTimeAsync(600);

            // Now SIGKILL should have been called
            expect(mockProcess.killCalls).toContain('SIGKILL');

            // Simulate process finally closing
            mockProcess.simulateClose(null);

            // The search should reject with CancellationError
            await expect(searchPromise).rejects.toThrow();
        });

        it('should not send SIGKILL if process exits before grace period', async () => {
            const { RipgrepSearchService } =
                await import('../services/ripgrepSearchService');

            const service = new RipgrepSearchService();

            let cancellationCallback: (() => void) | undefined;
            const mockToken = {
                isCancellationRequested: false,
                onCancellationRequested: vi.fn((callback) => {
                    cancellationCallback = callback;
                    return { dispose: vi.fn() };
                }),
            };

            const searchPromise = service.search({
                pattern: 'test',
                cwd: '/test',
                multiline: false,
                token: mockToken as vscode.CancellationToken,
            });

            // Suppress unhandled rejection warning
            searchPromise.catch(() => {});

            // Trigger cancellation
            mockToken.isCancellationRequested = true;
            cancellationCallback!();

            // Verify SIGTERM was called
            expect(mockProcess.killCalls).toContain('SIGTERM');

            // Process exits quickly (before 500ms grace period)
            mockProcess.exitCode = 0;
            mockProcess.simulateClose(0);

            // Advance time past the grace period
            await vi.advanceTimersByTimeAsync(600);

            // SIGKILL should NOT have been called because exitCode was set
            expect(mockProcess.killCalls).not.toContain('SIGKILL');

            // Search completes (with cancellation error since token was cancelled)
            await expect(searchPromise).rejects.toThrow();
        });

        it('should clear SIGKILL timeout when process closes normally', async () => {
            const { RipgrepSearchService } =
                await import('../services/ripgrepSearchService');

            const service = new RipgrepSearchService();
            const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');

            let cancellationCallback: (() => void) | undefined;
            const mockToken = {
                isCancellationRequested: false,
                onCancellationRequested: vi.fn((callback) => {
                    cancellationCallback = callback;
                    return { dispose: vi.fn() };
                }),
            };

            const searchPromise = service.search({
                pattern: 'test',
                cwd: '/test',
                multiline: false,
                token: mockToken as vscode.CancellationToken,
            });

            // Trigger cancellation (this sets up the SIGKILL timeout)
            mockToken.isCancellationRequested = true;
            cancellationCallback!();

            // Process exits before grace period
            mockProcess.simulateClose(0);

            // Verify clearTimeout was called (cleanup the SIGKILL timer)
            expect(clearTimeoutSpy).toHaveBeenCalled();

            await expect(searchPromise).rejects.toThrow();

            clearTimeoutSpy.mockRestore();
        });

        it('should force-reject if process ignores SIGKILL (final watchdog)', async () => {
            const { RipgrepSearchService } =
                await import('../services/ripgrepSearchService');

            const service = new RipgrepSearchService();

            let cancellationCallback: (() => void) | undefined;
            const mockToken = {
                isCancellationRequested: false,
                onCancellationRequested: vi.fn((callback) => {
                    cancellationCallback = callback;
                    return { dispose: vi.fn() };
                }),
            };

            const searchPromise = service.search({
                pattern: 'test',
                cwd: '/test',
                multiline: false,
                token: mockToken as vscode.CancellationToken,
            });

            // Suppress unhandled rejection for cleanup
            searchPromise.catch(() => {});

            // Trigger cancellation
            mockToken.isCancellationRequested = true;
            cancellationCallback!();

            // Verify SIGTERM was called
            expect(mockProcess.killCalls).toContain('SIGTERM');

            // Advance past SIGTERM grace period (500ms) - SIGKILL is sent
            await vi.advanceTimersByTimeAsync(500);
            expect(mockProcess.killCalls).toContain('SIGKILL');

            // Process ignores SIGKILL - exitCode stays null, no 'close' event
            // Advance past final watchdog (5000ms)
            await vi.advanceTimersByTimeAsync(5000);

            // Search should reject with termination error
            await expect(searchPromise).rejects.toThrow(
                'ripgrep process did not respond to termination signals'
            );
        });

        it('should not trigger final watchdog if process closes after SIGKILL', async () => {
            const { RipgrepSearchService } =
                await import('../services/ripgrepSearchService');

            const service = new RipgrepSearchService();

            let cancellationCallback: (() => void) | undefined;
            const mockToken = {
                isCancellationRequested: false,
                onCancellationRequested: vi.fn((callback) => {
                    cancellationCallback = callback;
                    return { dispose: vi.fn() };
                }),
            };

            const searchPromise = service.search({
                pattern: 'test',
                cwd: '/test',
                multiline: false,
                token: mockToken as vscode.CancellationToken,
            });

            // Trigger cancellation
            mockToken.isCancellationRequested = true;
            cancellationCallback!();

            // Advance past SIGTERM grace period - SIGKILL is sent
            await vi.advanceTimersByTimeAsync(500);
            expect(mockProcess.killCalls).toContain('SIGKILL');

            // Process closes after SIGKILL but before final watchdog
            await vi.advanceTimersByTimeAsync(1000);
            mockProcess.simulateClose(null);

            // Should reject with CancellationError, not termination error
            await expect(searchPromise).rejects.toThrow();
            // Verify it's not the termination error
            try {
                await searchPromise;
            } catch (err) {
                expect((err as Error).message).not.toContain(
                    'did not respond to termination'
                );
            }
        });
    });
});
