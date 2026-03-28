import type {
    Observation,
    ObservationQuery,
    ObservationCategory,
} from '../types/observationTypes';

export class ObservationStore {
    private observations = new Map<string, Observation>();
    private nextId = 1;

    add(observation: Omit<Observation, 'id' | 'timestamp'>): Observation {
        const id = `obs-${this.nextId++}`;
        const full: Observation = {
            ...observation,
            id,
            timestamp: Date.now(),
        };
        this.observations.set(id, full);
        return full;
    }

    query(q: ObservationQuery): Observation[] {
        return [...this.observations.values()].filter((o) => {
            if (q.category !== undefined && o.category !== q.category) {
                return false;
            }
            if (
                q.relatedFile !== undefined &&
                !o.relatedFiles.some(
                    (f) =>
                        f === q.relatedFile ||
                        f.includes(q.relatedFile!) ||
                        q.relatedFile!.includes(f)
                )
            ) {
                return false;
            }
            if (q.agentId !== undefined && o.agentId !== q.agentId) {
                return false;
            }
            return true;
        });
    }

    getAll(): Observation[] {
        return [...this.observations.values()];
    }

    getByCategory(category: ObservationCategory): Observation[] {
        return [...this.observations.values()].filter(
            (o) => o.category === category
        );
    }

    get size(): number {
        return this.observations.size;
    }

    getById(id: string): Observation | undefined {
        return this.observations.get(id);
    }
}
