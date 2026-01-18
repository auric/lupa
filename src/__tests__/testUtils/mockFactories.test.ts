/**
 * Tests for mock factories to ensure they match VS Code's behavior.
 * These tests document expected semantics and prevent regressions.
 */
import { describe, it, expect, vi } from 'vitest';
import {
    createMockCancellationTokenSource,
    createMockExecutionContext,
    createCancelledExecutionContext,
} from './mockFactories';

describe('createMockCancellationTokenSource', () => {
    describe('cancellation behavior', () => {
        it('should start with isCancellationRequested = false', () => {
            const source = createMockCancellationTokenSource();
            expect(source.token.isCancellationRequested).toBe(false);
        });

        it('should set isCancellationRequested = true after cancel()', () => {
            const source = createMockCancellationTokenSource();
            source.cancel();
            expect(source.token.isCancellationRequested).toBe(true);
        });

        it('should be idempotent - calling cancel() twice does not double-fire listeners', () => {
            const source = createMockCancellationTokenSource();
            const listener = vi.fn();

            source.token.onCancellationRequested(listener);
            source.cancel();
            source.cancel(); // Second call should be no-op

            expect(listener).toHaveBeenCalledTimes(1);
        });
    });

    describe('listener invocation', () => {
        it('should invoke listeners when cancel() is called', () => {
            const source = createMockCancellationTokenSource();
            const listener = vi.fn();

            source.token.onCancellationRequested(listener);
            expect(listener).not.toHaveBeenCalled();

            source.cancel();
            expect(listener).toHaveBeenCalledTimes(1);
        });

        it('should invoke listeners synchronously when added after already cancelled (matches VS Code behavior)', () => {
            const source = createMockCancellationTokenSource();
            source.cancel(); // Cancel first

            const listener = vi.fn();
            source.token.onCancellationRequested(listener);

            // Listener should be invoked synchronously, not deferred
            expect(listener).toHaveBeenCalledTimes(1);
        });

        it('should support multiple listeners', () => {
            const source = createMockCancellationTokenSource();
            const listener1 = vi.fn();
            const listener2 = vi.fn();
            const listener3 = vi.fn();

            source.token.onCancellationRequested(listener1);
            source.token.onCancellationRequested(listener2);
            source.token.onCancellationRequested(listener3);

            source.cancel();

            expect(listener1).toHaveBeenCalledTimes(1);
            expect(listener2).toHaveBeenCalledTimes(1);
            expect(listener3).toHaveBeenCalledTimes(1);
        });

        it('should clear listeners after firing to prevent double-calls', () => {
            const source = createMockCancellationTokenSource();
            const listener = vi.fn();

            source.token.onCancellationRequested(listener);
            source.cancel();

            // If we could somehow trigger listeners again, they shouldn't fire
            // This is implicitly tested by the idempotent test above
            expect(listener).toHaveBeenCalledTimes(1);
        });
    });

    describe('dispose behavior', () => {
        it('should remove listener when dispose is called', () => {
            const source = createMockCancellationTokenSource();
            const listener = vi.fn();

            const disposable = source.token.onCancellationRequested(listener);
            disposable.dispose();

            source.cancel();

            expect(listener).not.toHaveBeenCalled();
        });
    });
});

describe('createMockExecutionContext', () => {
    it('should create context with non-cancelled token by default', () => {
        const context = createMockExecutionContext();

        expect(context.cancellationToken).toBeDefined();
        expect(context.cancellationToken.isCancellationRequested).toBe(false);
    });

    it('should have undefined optional fields by default', () => {
        const context = createMockExecutionContext();

        expect(context.planManager).toBeUndefined();
        expect(context.subagentSessionManager).toBeUndefined();
        expect(context.subagentExecutor).toBeUndefined();
    });

    it('should allow overriding fields', () => {
        const mockPlanManager = { someMethod: vi.fn() } as any;
        const context = createMockExecutionContext({
            planManager: mockPlanManager,
        });

        expect(context.planManager).toBe(mockPlanManager);
    });
});

describe('createCancelledExecutionContext', () => {
    it('should create context with pre-cancelled token', () => {
        const context = createCancelledExecutionContext();

        expect(context.cancellationToken).toBeDefined();
        expect(context.cancellationToken.isCancellationRequested).toBe(true);
    });

    it('should invoke listeners synchronously when subscribing to pre-cancelled token', () => {
        const context = createCancelledExecutionContext();
        const listener = vi.fn();

        context.cancellationToken.onCancellationRequested(listener);

        // Listener should be called synchronously
        expect(listener).toHaveBeenCalledTimes(1);
    });
});
