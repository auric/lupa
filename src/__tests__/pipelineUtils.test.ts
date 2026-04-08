import { describe, it, expect, vi } from 'vitest';
import {
    classifyConversationCompletion,
    createBufferedHandler,
    dismissHypothesesForDroppedFinding,
    isTitleMentionedInText,
    reconcileFindingStoreWithReview,
} from '../services/pipeline/pipelineUtils';
import { FindingStore } from '../sessions/findingStore';
import type { RecordedFinding } from '../types/findingTypes';
import type { ToolCallHandler } from '../models/conversationRunner';

import type { ExitReason } from '../models/conversationRunner';

function makeRunner(
    overrides: Partial<
        Parameters<typeof classifyConversationCompletion>[0]
    > = {}
) {
    return {
        wasCancelled: false,
        hitMaxIterations: false,
        hitRateLimit: false,
        hitQuotaExhausted: false,
        degraded: false,
        exitReason: undefined as ExitReason | undefined,
        ...overrides,
    };
}

describe('classifyConversationCompletion', () => {
    it('returns completed for normal completion', () => {
        const result = classifyConversationCompletion(makeRunner());
        expect(result).toEqual({
            completed: true,
            budgetExhausted: false,
            reason: undefined,
        });
    });

    it('returns budgetExhausted for hitMaxIterations', () => {
        const result = classifyConversationCompletion(
            makeRunner({ hitMaxIterations: true })
        );
        expect(result.completed).toBe(false);
        expect(result.budgetExhausted).toBe(true);
        expect(result.reason).toBe('hit iteration limit');
    });

    it('returns non-budget-exhausted result for hitRateLimit', () => {
        const result = classifyConversationCompletion(
            makeRunner({ hitRateLimit: true })
        );
        expect(result.completed).toBe(false);
        expect(result.budgetExhausted).toBe(false);
        expect(result.reason).toBe('hit rate limit');
    });

    it('returns budgetExhausted for hitQuotaExhausted', () => {
        const result = classifyConversationCompletion(
            makeRunner({ hitQuotaExhausted: true })
        );
        expect(result.completed).toBe(false);
        expect(result.budgetExhausted).toBe(true);
        expect(result.reason).toBe('quota exhausted');
    });

    it('returns degraded exit for degraded runner', () => {
        const result = classifyConversationCompletion(
            makeRunner({ degraded: true })
        );
        expect(result.completed).toBe(false);
        expect(result.budgetExhausted).toBe(false);
        expect(result.reason).toBe('exited abnormally (degraded)');
    });

    it('returns cancelled for wasCancelled', () => {
        const result = classifyConversationCompletion(
            makeRunner({ wasCancelled: true })
        );
        expect(result.completed).toBe(false);
        expect(result.budgetExhausted).toBe(false);
        expect(result.reason).toBe('was cancelled');
    });

    it('wasCancelled takes priority over hitMaxIterations', () => {
        const result = classifyConversationCompletion(
            makeRunner({ wasCancelled: true, hitMaxIterations: true })
        );
        expect(result.reason).toBe('was cancelled');
        expect(result.budgetExhausted).toBe(true);
    });

    it('hitMaxIterations determines reason when both degraded and hitMaxIterations are true', () => {
        const result = classifyConversationCompletion(
            makeRunner({ degraded: true, hitMaxIterations: true })
        );
        expect(result.budgetExhausted).toBe(true);
        expect(result.reason).toBe('hit iteration limit');
    });

    it('uses exitReason when provided for degraded', () => {
        const result = classifyConversationCompletion(
            makeRunner({ degraded: true, exitReason: 'fatal-error' })
        );
        expect(result.reason).toBe('exited abnormally (fatal-error)');
    });
});

describe('createBufferedHandler', () => {
    function makeSourceHandler(): Required<ToolCallHandler> {
        return {
            onToolCallStart: vi.fn(),
            onToolCallComplete: vi.fn(),
            onIterationStart: vi.fn(),
            getContextStatusSuffix: vi.fn().mockResolvedValue(' [test]'),
        };
    }

    it('buffers onToolCallStart events', () => {
        const source = makeSourceHandler();
        const { handler } = createBufferedHandler(source);

        handler.onToolCallStart!('read_file', { path: 'a.ts' }, 0, 1);

        expect(source.onToolCallStart).not.toHaveBeenCalled();
    });

    it('buffers onToolCallComplete events', () => {
        const source = makeSourceHandler();
        const { handler } = createBufferedHandler(source);

        handler.onToolCallComplete!(
            'id-1',
            'read_file',
            { path: 'a.ts' },
            'ok',
            true
        );

        expect(source.onToolCallComplete).not.toHaveBeenCalled();
    });

    it('flushCompletions forwards events in chronological order', () => {
        const source = makeSourceHandler();
        const { handler, flushCompletions } = createBufferedHandler(source);

        handler.onToolCallStart!('tool_a', {}, 0, 2);
        handler.onToolCallComplete!('id-1', 'tool_a', {}, 'result-a', true);
        handler.onToolCallStart!('tool_b', {}, 1, 2);
        handler.onToolCallComplete!('id-2', 'tool_b', {}, 'result-b', true);

        flushCompletions();

        expect(source.onToolCallStart).toHaveBeenCalledTimes(2);
        expect(source.onToolCallComplete).toHaveBeenCalledTimes(2);

        // Verify starts and completions are flushed in chronological order
        const callOrder: string[] = [];
        const source2 = {
            onToolCallStart: vi.fn(() => callOrder.push('start')),
            onToolCallComplete: vi.fn(() => callOrder.push('complete')),
        } as unknown as Required<ToolCallHandler>;
        const b2 = createBufferedHandler(source2);
        b2.handler.onToolCallStart!('a', {}, 0, 2);
        b2.handler.onToolCallComplete!('1', 'a', {}, 'r', true);
        b2.handler.onToolCallStart!('b', {}, 1, 2);
        b2.handler.onToolCallComplete!('2', 'b', {}, 'r', true);
        b2.flushCompletions();
        expect(callOrder).toEqual(['start', 'complete', 'start', 'complete']);
    });

    it('passes onIterationStart through immediately', () => {
        const source = makeSourceHandler();
        const { handler } = createBufferedHandler(source);

        handler.onIterationStart!(3, 10);

        expect(source.onIterationStart).toHaveBeenCalledWith(3, 10);
    });

    it('passes getContextStatusSuffix through immediately', async () => {
        const source = makeSourceHandler();
        const { handler } = createBufferedHandler(source);

        const result = await handler.getContextStatusSuffix!();

        expect(result).toBe(' [test]');
        expect(source.getContextStatusSuffix).toHaveBeenCalled();
    });

    it('empty flush is a no-op', () => {
        const source = makeSourceHandler();
        const { flushCompletions } = createBufferedHandler(source);

        flushCompletions();

        expect(source.onToolCallStart).not.toHaveBeenCalled();
        expect(source.onToolCallComplete).not.toHaveBeenCalled();
    });

    it('buffer is cleared after flush', () => {
        const source = makeSourceHandler();
        const { handler, flushCompletions } = createBufferedHandler(source);

        handler.onToolCallStart!('tool_a', {}, 0, 1);
        handler.onToolCallComplete!('id-1', 'tool_a', {}, 'r', true);
        flushCompletions();

        handler.onToolCallStart!('tool_b', {}, 0, 1);
        handler.onToolCallComplete!('id-2', 'tool_b', {}, 'r2', true);
        flushCompletions();

        expect(source.onToolCallStart).toHaveBeenCalledTimes(2);
        expect(source.onToolCallComplete).toHaveBeenCalledTimes(2);
    });

    it('handles undefined source methods without crashing', () => {
        const source: ToolCallHandler = {};
        const { handler, flushCompletions } = createBufferedHandler(source);

        handler.onToolCallStart!('t', {}, 0, 1);
        handler.onToolCallComplete!('id', 't', {}, 'r', true);

        expect(() => flushCompletions()).not.toThrow();
    });
});

describe('dismissHypothesesForDroppedFinding', () => {
    it('calls dismissConfirmedForFinding with correct args', () => {
        const reasoningChain = {
            dismissConfirmedForFinding: vi.fn(),
        };

        dismissHypothesesForDroppedFinding(
            'finding-123',
            reasoningChain as any,
            'low severity'
        );

        expect(reasoningChain.dismissConfirmedForFinding).toHaveBeenCalledWith(
            'finding-123',
            'low severity'
        );
    });

    it('handles undefined reasoningChain gracefully', () => {
        expect(() =>
            dismissHypothesesForDroppedFinding(
                'finding-123',
                undefined,
                'dropped'
            )
        ).not.toThrow();
    });
});

describe('isTitleMentionedInText', () => {
    it('returns true when enough title words match in text', () => {
        expect(
            isTitleMentionedInText(
                'Null pointer dereference in handler',
                'Found a null pointer issue in the request handler'
            )
        ).toBe(true);
    });

    it('returns false when too few title words match', () => {
        expect(
            isTitleMentionedInText(
                'Null pointer dereference in handler',
                'The code looks fine with no issues detected'
            )
        ).toBe(false);
    });

    it('returns true for single-word title when word matches', () => {
        expect(
            isTitleMentionedInText('Deadlock', 'Found a deadlock in the code')
        ).toBe(true);
    });

    it('returns false for single-word title when word is absent', () => {
        expect(
            isTitleMentionedInText(
                'Deadlock',
                'The code is correct and approved'
            )
        ).toBe(false);
    });

    it('returns true when all title words are below length threshold', () => {
        expect(
            isTitleMentionedInText(
                'It is OK',
                'Anything at all — no matchable words'
            )
        ).toBe(true);
    });

    it('is case-insensitive', () => {
        expect(
            isTitleMentionedInText(
                'SQL Injection vulnerability',
                'Found an SQL INJECTION in the login form'
            )
        ).toBe(true);
    });

    it('filters short words from matching', () => {
        // "No" and "in" are < 3 chars, filtered out. "XSS" and "form" remain.
        expect(
            isTitleMentionedInText(
                'No XSS in form',
                'XSS vulnerability in the form handler'
            )
        ).toBe(true);
    });
});

function recordFinding(
    store: FindingStore,
    partial: Partial<
        Omit<RecordedFinding, 'id' | 'timestamp' | 'lspValidation'>
    >
): RecordedFinding {
    return store.record({
        agentId: partial.agentId ?? 'agent-1',
        severity: partial.severity ?? 'HIGH',
        category: partial.category ?? 'logic_error',
        title: partial.title ?? 'Default title',
        file: partial.file ?? 'src/index.ts',
        lineRange: partial.lineRange ?? [1, 5],
        description: partial.description ?? 'desc',
        affectedComponent: partial.affectedComponent ?? 'Component',
        failureMechanism: partial.failureMechanism ?? 'wrong_return_value',
        supportingToolCalls: partial.supportingToolCalls ?? ['read_file'],
        disproof: partial.disproof ?? {
            attempted: true,
            method: 'test',
            result: 'confirmed',
        },
        verifiableClaims: partial.verifiableClaims ?? [],
    });
}

describe('reconcileFindingStoreWithReview', () => {
    it('removes findings not mentioned in review text', () => {
        const store = new FindingStore();
        const f1 = recordFinding(store, {
            title: 'Null pointer dereference',
            file: 'src/handler.ts',
        });
        const f2 = recordFinding(store, {
            title: 'Memory exhaustion in loop',
            file: 'src/cache.ts',
        });

        const reviewText =
            'The PR has a null pointer dereference bug in the handler.';
        const dropped = reconcileFindingStoreWithReview(
            store,
            reviewText,
            undefined
        );

        expect(dropped).toEqual([f2.title]);
        expect(store.getById(f1.id)).toBeDefined();
        expect(store.getById(f2.id)).toBeUndefined();
    });

    it('keeps findings mentioned by file path even if title is absent', () => {
        const store = new FindingStore();
        const f1 = recordFinding(store, {
            title: 'Obscure issue',
            file: 'src/utils/parser.ts',
        });

        const reviewText =
            'Found an issue in src/utils/parser.ts that needs attention.';
        const dropped = reconcileFindingStoreWithReview(
            store,
            reviewText,
            undefined
        );

        expect(dropped).toHaveLength(0);
        expect(store.getById(f1.id)).toBeDefined();
    });

    it('dismisses hypotheses for removed findings', () => {
        const store = new FindingStore();
        const f1 = recordFinding(store, {
            title: 'Memory exhaustion in loop',
            file: 'src/cache.ts',
        });

        const mockChain = {
            dismissConfirmedForFinding: vi.fn(),
        };

        const reviewText = 'No issues found. The code is correct.';
        reconcileFindingStoreWithReview(store, reviewText, mockChain as never);

        expect(mockChain.dismissConfirmedForFinding).toHaveBeenCalledWith(
            f1.id,
            'Finding silently omitted from rewritten review'
        );
    });

    it('returns empty array when all findings are mentioned', () => {
        const store = new FindingStore();
        recordFinding(store, {
            title: 'Null pointer dereference',
            file: 'src/handler.ts',
        });
        recordFinding(store, {
            title: 'SQL injection risk',
            file: 'src/db.ts',
        });

        const reviewText =
            'Found null pointer dereference and SQL injection risk in the code.';
        const dropped = reconcileFindingStoreWithReview(
            store,
            reviewText,
            undefined
        );

        expect(dropped).toHaveLength(0);
        expect(store.size).toBe(2);
    });

    it('handles empty store gracefully', () => {
        const store = new FindingStore();
        const dropped = reconcileFindingStoreWithReview(
            store,
            'Some review text',
            undefined
        );
        expect(dropped).toHaveLength(0);
    });
});
