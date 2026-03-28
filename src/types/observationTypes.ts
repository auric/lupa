export const OBSERVATION_CATEGORIES = [
    'dependency',
    'pattern',
    'invariant',
    'concern',
    'convention',
] as const;
export type ObservationCategory = (typeof OBSERVATION_CATEGORIES)[number];

export interface Observation {
    id: string;
    agentId: string;
    timestamp: number;
    category: ObservationCategory;
    title: string;
    content: string;
    relatedFiles: string[];
}

export interface ObservationQuery {
    category: ObservationCategory | undefined;
    relatedFile: string | undefined;
    agentId: string | undefined;
}
