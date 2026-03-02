import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    SubagentBatchManager,
    type QueuedSubagent,
} from '../sessions/subagentBatchManager';

vi.mock('../services/loggingService', () => ({
    Log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}));

function createEntry(overrides: Partial<QueuedSubagent> = {}): QueuedSubagent {
    return {
        task: 'Review auth changes',
        taskContext: undefined,
        subagentId: 1,
        childAgentId: 'child-1',
        childBudget: 10,
        ...overrides,
    };
}

describe('SubagentBatchManager', () => {
    let manager: SubagentBatchManager;

    beforeEach(() => {
        manager = new SubagentBatchManager();
    });

    it('starts with no pending tasks', () => {
        expect(manager.hasPending()).toBe(false);
        expect(manager.getPendingCount()).toBe(0);
    });

    it('enqueues tasks and reports pending count', () => {
        manager.enqueue(createEntry({ subagentId: 1 }));
        expect(manager.hasPending()).toBe(true);
        expect(manager.getPendingCount()).toBe(1);

        manager.enqueue(createEntry({ subagentId: 2 }));
        expect(manager.getPendingCount()).toBe(2);
    });

    it('drain returns all queued tasks and clears the queue', () => {
        const entry1 = createEntry({ subagentId: 1 });
        const entry2 = createEntry({ subagentId: 2 });
        manager.enqueue(entry1);
        manager.enqueue(entry2);

        const drained = manager.drain();
        expect(drained).toEqual([entry1, entry2]);
        expect(manager.hasPending()).toBe(false);
        expect(manager.getPendingCount()).toBe(0);
    });

    it('drain returns empty array when nothing is queued', () => {
        const drained = manager.drain();
        expect(drained).toEqual([]);
    });

    it('clear discards all queued tasks', () => {
        manager.enqueue(createEntry({ subagentId: 1 }));
        manager.enqueue(createEntry({ subagentId: 2 }));
        manager.clear();

        expect(manager.hasPending()).toBe(false);
        expect(manager.getPendingCount()).toBe(0);
        expect(manager.drain()).toEqual([]);
    });

    it('allows enqueue after drain', () => {
        manager.enqueue(createEntry({ subagentId: 1 }));
        manager.drain();

        manager.enqueue(createEntry({ subagentId: 3 }));
        expect(manager.getPendingCount()).toBe(1);
        const drained = manager.drain();
        expect(drained[0]!.subagentId).toBe(3);
    });

    it('preserves entry fields through enqueue/drain cycle', () => {
        const entry: QueuedSubagent = {
            task: 'Investigate security concerns in auth module',
            taskContext: 'Found suspicious pattern in login handler',
            subagentId: 42,
            childAgentId: 'child-2.1',
            childBudget: 15,
        };
        manager.enqueue(entry);

        const [drained] = manager.drain();
        expect(drained).toEqual(entry);
    });
});
