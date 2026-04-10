import type {
    RecordedFinding,
    FindingQuery,
    FindingSeverity,
} from '../types/findingTypes';

export interface FindingStoreSnapshot {
    findings: RecordedFinding[];
    nextId: number;
}

export class FindingStore {
    private findings = new Map<string, RecordedFinding>();
    private nextId = 1;

    record(
        finding: Omit<RecordedFinding, 'id' | 'timestamp' | 'lspValidation'>
    ): RecordedFinding {
        const id = `finding-${this.nextId++}`;
        const full: RecordedFinding = {
            ...finding,
            id,
            timestamp: Date.now(),
            lspValidation: undefined,
        };
        this.findings.set(id, full);
        return full;
    }

    updateLspValidation(
        findingId: string,
        validation: RecordedFinding['lspValidation']
    ): void {
        const finding = this.findings.get(findingId);
        if (finding) {
            finding.lspValidation = validation;
        }
    }

    query(q: FindingQuery): RecordedFinding[] {
        return [...this.findings.values()].filter((f) => {
            if (q.file !== undefined && f.file !== q.file) {
                return false;
            }
            if (q.severity !== undefined && f.severity !== q.severity) {
                return false;
            }
            if (q.agentId !== undefined && f.agentId !== q.agentId) {
                return false;
            }
            return true;
        });
    }

    getAll(): RecordedFinding[] {
        return [...this.findings.values()];
    }

    createSnapshot(): FindingStoreSnapshot {
        return {
            findings: structuredClone(this.getAll()),
            nextId: this.nextId,
        };
    }

    restoreSnapshot(snapshot: FindingStoreSnapshot): void {
        this.findings = new Map(
            structuredClone(snapshot.findings).map((finding) => [
                finding.id,
                finding,
            ])
        );
        this.nextId = snapshot.nextId;
    }

    getBySeverity(severity: FindingSeverity): RecordedFinding[] {
        return [...this.findings.values()].filter(
            (f) => f.severity === severity
        );
    }

    get size(): number {
        return this.findings.size;
    }

    getById(id: string): RecordedFinding | undefined {
        return this.findings.get(id);
    }

    remove(id: string): boolean {
        return this.findings.delete(id);
    }

    updateSeverity(id: string, severity: FindingSeverity): void {
        const finding = this.findings.get(id);
        if (finding) {
            finding.severity = severity;
        }
    }
}
