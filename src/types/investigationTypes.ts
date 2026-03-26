export interface InvestigationAudit {
    filesRead: FileReadEntry[];
    symbolsResolved: SymbolResolutionEntry[];
    usagesChecked: UsageCheckEntry[];
    patternsSearched: PatternSearchEntry[];
    diffsExamined: string[];
    depthScores: Map<string, InvestigationDepth>;
}

export interface FileReadEntry {
    path: string;
    lineRange: [number, number];
}

export interface SymbolResolutionEntry {
    name: string;
    file: string;
    kind: string;
}

export interface UsageCheckEntry {
    symbol: string;
    referenceCount: number;
}

export interface PatternSearchEntry {
    query: string;
    matchCount: number;
}

export interface InvestigationDepth {
    score: number;
    breakdown: string;
}
