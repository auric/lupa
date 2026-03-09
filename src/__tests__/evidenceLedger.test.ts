import { describe, it, expect } from 'vitest';
import { EvidenceLedger } from '../sessions/evidenceLedger';
import type { EvidenceEntry, EvidenceCategory } from '../types/evidenceTypes';

function makeEntry(
    overrides: Partial<Omit<EvidenceEntry, 'id' | 'timestamp'>> = {}
) {
    return {
        agentId: overrides.agentId ?? 'agent-1',
        category:
            overrides.category ?? ('behavior_observation' as EvidenceCategory),
        file: overrides.file ?? 'src/foo.ts',
        symbol: overrides.symbol ?? undefined,
        line: overrides.line ?? 10,
        claim: overrides.claim ?? 'some claim',
        rawSnippet: overrides.rawSnippet ?? undefined,
        confidence: overrides.confidence ?? ('high' as const),
        source: overrides.source ?? ('tool_result' as const),
    };
}

describe('EvidenceLedger', () => {
    it('records entries and retrieves them', () => {
        const ledger = new EvidenceLedger();
        const entry = ledger.record(makeEntry());

        expect(entry.id).toBe('evidence-1');
        expect(entry.timestamp).toBeGreaterThan(0);
        expect(ledger.size).toBe(1);
        expect(ledger.getAll()).toHaveLength(1);
        expect(ledger.getAll()[0]).toBe(entry);
    });

    it('queries by file', () => {
        const ledger = new EvidenceLedger();
        ledger.record(makeEntry({ file: 'src/a.ts' }));
        ledger.record(makeEntry({ file: 'src/b.ts' }));
        ledger.record(makeEntry({ file: 'src/a.ts' }));

        const results = ledger.query({
            file: 'src/a.ts',
            symbol: undefined,
            category: undefined,
            agentId: undefined,
            text: undefined,
        });
        expect(results).toHaveLength(2);
        expect(results.every((e) => e.file === 'src/a.ts')).toBe(true);
    });

    it('queries by symbol', () => {
        const ledger = new EvidenceLedger();
        ledger.record(makeEntry({ symbol: 'foo' }));
        ledger.record(makeEntry({ symbol: 'bar' }));
        ledger.record(makeEntry({ symbol: 'foo' }));

        const results = ledger.query({
            file: undefined,
            symbol: 'foo',
            category: undefined,
            agentId: undefined,
            text: undefined,
        });
        expect(results).toHaveLength(2);
    });

    it('queries by category', () => {
        const ledger = new EvidenceLedger();
        ledger.record(makeEntry({ category: 'type_constraint' }));
        ledger.record(makeEntry({ category: 'api_contract' }));
        ledger.record(makeEntry({ category: 'type_constraint' }));

        const results = ledger.query({
            file: undefined,
            symbol: undefined,
            category: 'type_constraint',
            agentId: undefined,
            text: undefined,
        });
        expect(results).toHaveLength(2);
    });

    it('queries by text search in claim', () => {
        const ledger = new EvidenceLedger();
        ledger.record(makeEntry({ claim: 'null pointer dereference' }));
        ledger.record(makeEntry({ claim: 'buffer overflow' }));

        const results = ledger.query({
            file: undefined,
            symbol: undefined,
            category: undefined,
            agentId: undefined,
            text: 'null pointer',
        });
        expect(results).toHaveLength(1);
        expect(results[0].claim).toBe('null pointer dereference');
    });

    it('queries by text search in rawSnippet', () => {
        const ledger = new EvidenceLedger();
        ledger.record(
            makeEntry({
                claim: 'unrelated',
                rawSnippet: 'const x = fetchData()',
            })
        );
        ledger.record(makeEntry({ claim: 'something else' }));

        const results = ledger.query({
            file: undefined,
            symbol: undefined,
            category: undefined,
            agentId: undefined,
            text: 'fetchData',
        });
        expect(results).toHaveLength(1);
    });

    it('text search is case-insensitive', () => {
        const ledger = new EvidenceLedger();
        ledger.record(makeEntry({ claim: 'NULL Pointer' }));

        const results = ledger.query({
            file: undefined,
            symbol: undefined,
            category: undefined,
            agentId: undefined,
            text: 'null pointer',
        });
        expect(results).toHaveLength(1);
    });

    it('applies combined query filters', () => {
        const ledger = new EvidenceLedger();
        ledger.record(
            makeEntry({
                file: 'src/a.ts',
                category: 'type_constraint',
                claim: 'strict null',
            })
        );
        ledger.record(
            makeEntry({
                file: 'src/a.ts',
                category: 'api_contract',
                claim: 'strict null',
            })
        );
        ledger.record(
            makeEntry({
                file: 'src/b.ts',
                category: 'type_constraint',
                claim: 'strict null',
            })
        );

        const results = ledger.query({
            file: 'src/a.ts',
            symbol: undefined,
            category: 'type_constraint',
            agentId: undefined,
            text: 'strict',
        });
        expect(results).toHaveLength(1);
        expect(results[0].file).toBe('src/a.ts');
        expect(results[0].category).toBe('type_constraint');
    });

    it('evicts oldest entries when MAX_ENTRIES reached', () => {
        const ledger = new EvidenceLedger();
        for (let i = 0; i < 200; i++) {
            ledger.record(makeEntry({ claim: `claim-${i}` }));
        }
        expect(ledger.size).toBe(200);

        // Adding one more should evict the oldest (evidence-1)
        ledger.record(makeEntry({ claim: 'claim-200' }));
        expect(ledger.size).toBe(200);

        const all = ledger.getAll();
        expect(all.find((e) => e.id === 'evidence-1')).toBeUndefined();
        expect(all.find((e) => e.claim === 'claim-200')).toBeDefined();
    });

    it('empty query returns all entries', () => {
        const ledger = new EvidenceLedger();
        ledger.record(makeEntry({ file: 'a.ts' }));
        ledger.record(makeEntry({ file: 'b.ts' }));
        ledger.record(makeEntry({ file: 'c.ts' }));

        const results = ledger.query({
            file: undefined,
            symbol: undefined,
            category: undefined,
            agentId: undefined,
            text: undefined,
        });
        expect(results).toHaveLength(3);
    });
});
