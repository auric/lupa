import { describe, it, expect } from 'vitest';
import { FindingStore } from '../sessions/findingStore';
import type { RecordedFinding, FindingSeverity } from '../types/findingTypes';

function makeFinding(
    overrides: Partial<
        Omit<RecordedFinding, 'id' | 'timestamp' | 'lspValidation'>
    > = {}
) {
    return {
        agentId: overrides.agentId ?? 'agent-1',
        severity: overrides.severity ?? ('MEDIUM' as FindingSeverity),
        category: overrides.category ?? 'bug',
        title: overrides.title ?? 'Test finding',
        file: overrides.file ?? 'src/foo.ts',
        lineRange: overrides.lineRange ?? ([10, 20] as [number, number]),
        description: overrides.description ?? 'A test finding',
        supportingToolCalls: overrides.supportingToolCalls ?? [],
        disproof: overrides.disproof ?? {
            attempted: false,
            method: '',
            result: '',
        },
        verifiableClaims: overrides.verifiableClaims ?? [],
    };
}

describe('FindingStore', () => {
    it('records findings and retrieves them', () => {
        const store = new FindingStore();
        const finding = store.record(makeFinding());

        expect(finding.id).toBe('finding-1');
        expect(finding.timestamp).toBeGreaterThan(0);
        expect(finding.lspValidation).toBeUndefined();
        expect(store.size).toBe(1);
        expect(store.getAll()).toHaveLength(1);
        expect(store.getAll()[0]).toBe(finding);
    });

    it('queries by file', () => {
        const store = new FindingStore();
        store.record(makeFinding({ file: 'src/a.ts' }));
        store.record(makeFinding({ file: 'src/b.ts' }));
        store.record(makeFinding({ file: 'src/a.ts' }));

        const results = store.query({
            file: 'src/a.ts',
            severity: undefined,
            agentId: undefined,
        });
        expect(results).toHaveLength(2);
        expect(results.every((f) => f.file === 'src/a.ts')).toBe(true);
    });

    it('queries by severity', () => {
        const store = new FindingStore();
        store.record(makeFinding({ severity: 'CRITICAL' }));
        store.record(makeFinding({ severity: 'LOW' }));
        store.record(makeFinding({ severity: 'CRITICAL' }));

        const results = store.query({
            file: undefined,
            severity: 'CRITICAL',
            agentId: undefined,
        });
        expect(results).toHaveLength(2);
    });

    it('queries by agentId', () => {
        const store = new FindingStore();
        store.record(makeFinding({ agentId: 'agent-A' }));
        store.record(makeFinding({ agentId: 'agent-B' }));
        store.record(makeFinding({ agentId: 'agent-A' }));

        const results = store.query({
            file: undefined,
            severity: undefined,
            agentId: 'agent-A',
        });
        expect(results).toHaveLength(2);
    });

    it('getBySeverity returns correct findings', () => {
        const store = new FindingStore();
        store.record(makeFinding({ severity: 'HIGH' }));
        store.record(makeFinding({ severity: 'LOW' }));
        store.record(makeFinding({ severity: 'HIGH' }));

        expect(store.getBySeverity('HIGH')).toHaveLength(2);
        expect(store.getBySeverity('LOW')).toHaveLength(1);
        expect(store.getBySeverity('CRITICAL')).toHaveLength(0);
    });

    it('getById returns correct finding', () => {
        const store = new FindingStore();
        const f1 = store.record(makeFinding({ title: 'first' }));
        const f2 = store.record(makeFinding({ title: 'second' }));

        expect(store.getById(f1.id)).toBe(f1);
        expect(store.getById(f2.id)).toBe(f2);
        expect(store.getById('nonexistent')).toBeUndefined();
    });

    it('updateLspValidation updates the correct finding', () => {
        const store = new FindingStore();
        const f1 = store.record(makeFinding());
        const f2 = store.record(makeFinding());

        const validation: RecordedFinding['lspValidation'] = {
            status: 'verified',
            details: 'confirmed by LSP',
            claimResults: [],
        };

        store.updateLspValidation(f1.id, validation);

        expect(store.getById(f1.id)!.lspValidation).toBe(validation);
        expect(store.getById(f2.id)!.lspValidation).toBeUndefined();
    });

    it('updateLspValidation is no-op for unknown id', () => {
        const store = new FindingStore();
        store.record(makeFinding());

        // Should not throw
        store.updateLspValidation('nonexistent', {
            status: 'refuted',
            details: '',
            claimResults: [],
        });
        expect(store.size).toBe(1);
    });

    it('handles multiple findings from different agents', () => {
        const store = new FindingStore();
        store.record(
            makeFinding({ agentId: 'agent-1', file: 'a.ts', severity: 'HIGH' })
        );
        store.record(
            makeFinding({ agentId: 'agent-2', file: 'b.ts', severity: 'LOW' })
        );
        store.record(
            makeFinding({
                agentId: 'agent-1',
                file: 'b.ts',
                severity: 'MEDIUM',
            })
        );

        expect(store.size).toBe(3);
        expect(
            store.query({
                file: 'b.ts',
                severity: undefined,
                agentId: undefined,
            })
        ).toHaveLength(2);
        expect(
            store.query({
                file: undefined,
                severity: undefined,
                agentId: 'agent-1',
            })
        ).toHaveLength(2);
        expect(store.getBySeverity('LOW')).toHaveLength(1);
    });

    it('remove deletes a finding and returns true', () => {
        const store = new FindingStore();
        const f1 = store.record(makeFinding({ title: 'to-remove' }));
        store.record(makeFinding({ title: 'to-keep' }));

        expect(store.remove(f1.id)).toBe(true);
        expect(store.size).toBe(1);
        expect(store.getById(f1.id)).toBeUndefined();
        expect(store.getAll()[0]!.title).toBe('to-keep');
    });

    it('remove returns false for non-existent id', () => {
        const store = new FindingStore();
        store.record(makeFinding());

        expect(store.remove('nonexistent')).toBe(false);
        expect(store.size).toBe(1);
    });
});
