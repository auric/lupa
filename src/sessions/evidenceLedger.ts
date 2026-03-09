import type { EvidenceEntry, EvidenceQuery } from '../types/evidenceTypes';

const MAX_ENTRIES = 200;

export class EvidenceLedger {
    private entries = new Map<string, EvidenceEntry>();
    private nextId = 1;

    record(entry: Omit<EvidenceEntry, 'id' | 'timestamp'>): EvidenceEntry {
        if (this.entries.size >= MAX_ENTRIES) {
            const oldest = this.entries.keys().next().value;
            if (oldest) {
                this.entries.delete(oldest);
            }
        }
        const id = `evidence-${this.nextId++}`;
        const full: EvidenceEntry = { ...entry, id, timestamp: Date.now() };
        this.entries.set(id, full);
        return full;
    }

    query(q: EvidenceQuery): EvidenceEntry[] {
        return [...this.entries.values()].filter((e) => {
            if (q.file !== undefined && e.file !== q.file) {
                return false;
            }
            if (q.symbol !== undefined && e.symbol !== q.symbol) {
                return false;
            }
            if (q.category !== undefined && e.category !== q.category) {
                return false;
            }
            if (q.agentId !== undefined && e.agentId !== q.agentId) {
                return false;
            }
            if (q.text !== undefined) {
                const lower = q.text.toLowerCase();
                if (
                    !e.claim.toLowerCase().includes(lower) &&
                    !e.rawSnippet?.toLowerCase().includes(lower)
                ) {
                    return false;
                }
            }
            return true;
        });
    }

    getAll(): EvidenceEntry[] {
        return [...this.entries.values()];
    }

    get size(): number {
        return this.entries.size;
    }
}
