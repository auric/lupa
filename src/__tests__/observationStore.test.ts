import { describe, it, expect } from 'vitest';
import { ObservationStore } from '../sessions/observationStore';
import type {
    Observation,
    ObservationCategory,
} from '../types/observationTypes';

function makeObservation(
    overrides: Partial<Omit<Observation, 'id' | 'timestamp'>> = {}
) {
    return {
        agentId: overrides.agentId ?? 'agent-1',
        category: overrides.category ?? ('pattern' as ObservationCategory),
        title: overrides.title ?? 'Test observation',
        content: overrides.content ?? 'Some observation content',
        relatedFiles: overrides.relatedFiles ?? ['src/foo.ts'],
    };
}

describe('ObservationStore', () => {
    it('records observations with auto-incrementing IDs', () => {
        const store = new ObservationStore();
        const o1 = store.add(makeObservation());
        const o2 = store.add(makeObservation());

        expect(o1.id).toBe('obs-1');
        expect(o2.id).toBe('obs-2');
    });

    it('sets timestamp on add', () => {
        const store = new ObservationStore();
        const before = Date.now();
        const obs = store.add(makeObservation());

        expect(obs.timestamp).toBeGreaterThanOrEqual(before);
        expect(obs.timestamp).toBeLessThanOrEqual(Date.now());
    });

    it('query filters by category', () => {
        const store = new ObservationStore();
        store.add(makeObservation({ category: 'pattern' }));
        store.add(makeObservation({ category: 'concern' }));
        store.add(makeObservation({ category: 'pattern' }));

        const results = store.query({
            category: 'pattern',
            relatedFile: undefined,
            agentId: undefined,
        });
        expect(results).toHaveLength(2);
        expect(results.every((o) => o.category === 'pattern')).toBe(true);
    });

    it('query filters by relatedFile including partial match', () => {
        const store = new ObservationStore();
        store.add(makeObservation({ relatedFiles: ['src/utils/helpers.ts'] }));
        store.add(makeObservation({ relatedFiles: ['src/other.ts'] }));

        const results = store.query({
            category: undefined,
            relatedFile: 'helpers.ts',
            agentId: undefined,
        });
        expect(results).toHaveLength(1);
        expect(results[0]!.relatedFiles).toContain('src/utils/helpers.ts');
    });

    it('query filters by agentId', () => {
        const store = new ObservationStore();
        store.add(makeObservation({ agentId: 'agent-A' }));
        store.add(makeObservation({ agentId: 'agent-B' }));
        store.add(makeObservation({ agentId: 'agent-A' }));

        const results = store.query({
            category: undefined,
            relatedFile: undefined,
            agentId: 'agent-A',
        });
        expect(results).toHaveLength(2);
        expect(results.every((o) => o.agentId === 'agent-A')).toBe(true);
    });

    it('query with no filters returns all', () => {
        const store = new ObservationStore();
        store.add(makeObservation({ category: 'pattern' }));
        store.add(makeObservation({ category: 'concern' }));

        const results = store.query({
            category: undefined,
            relatedFile: undefined,
            agentId: undefined,
        });
        expect(results).toHaveLength(2);
    });

    it('getAll returns all observations', () => {
        const store = new ObservationStore();
        store.add(makeObservation({ title: 'first' }));
        store.add(makeObservation({ title: 'second' }));

        const all = store.getAll();
        expect(all).toHaveLength(2);
        expect(all[0]!.title).toBe('first');
        expect(all[1]!.title).toBe('second');
    });

    it('getByCategory filters correctly', () => {
        const store = new ObservationStore();
        store.add(makeObservation({ category: 'dependency' }));
        store.add(makeObservation({ category: 'invariant' }));
        store.add(makeObservation({ category: 'dependency' }));

        expect(store.getByCategory('dependency')).toHaveLength(2);
        expect(store.getByCategory('invariant')).toHaveLength(1);
        expect(store.getByCategory('convention')).toHaveLength(0);
    });

    it('size returns the number of observations', () => {
        const store = new ObservationStore();
        expect(store.size).toBe(0);

        store.add(makeObservation());
        expect(store.size).toBe(1);

        store.add(makeObservation());
        expect(store.size).toBe(2);
    });

    it('getById retrieves by ID', () => {
        const store = new ObservationStore();
        const o1 = store.add(makeObservation({ title: 'first' }));
        const o2 = store.add(makeObservation({ title: 'second' }));

        expect(store.getById(o1.id)).toBe(o1);
        expect(store.getById(o2.id)).toBe(o2);
    });

    it('getById returns undefined for nonexistent ID', () => {
        const store = new ObservationStore();
        store.add(makeObservation());

        expect(store.getById('nonexistent')).toBeUndefined();
    });
});
