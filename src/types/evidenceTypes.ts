export type EvidenceCategory =
    | 'behavior_observation'
    | 'type_constraint'
    | 'caller_pattern'
    | 'error_handling'
    | 'api_contract'
    | 'design_intent'
    | 'test_coverage';

export interface EvidenceEntry {
    id: string;
    agentId: string;
    timestamp: number;
    category: EvidenceCategory;
    file: string;
    symbol: string | undefined;
    line: number | undefined;
    claim: string;
    rawSnippet: string | undefined;
    confidence: 'high' | 'medium' | 'low';
    source: 'tool_result' | 'lsp_query' | 'observation';
}

export interface EvidenceQuery {
    file: string | undefined;
    symbol: string | undefined;
    category: EvidenceCategory | undefined;
    agentId: string | undefined;
    text: string | undefined;
}
