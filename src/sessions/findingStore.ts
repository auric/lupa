import type {
    RecordedFinding,
    FindingQuery,
    FindingSeverity,
} from '../types/findingTypes';

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
}
