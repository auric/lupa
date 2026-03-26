export interface CodeIntelligenceBrief {
    enrichedSymbols: EnrichedSymbol[];
    generatedAt: number;
    timeoutCount: number;
}

export interface EnrichedSymbol {
    name: string;
    file: string;
    line: number;
    kind: string;
    typeSignature: string | undefined;
    totalReferences: number;
    externalCallers: number;
    testFileReferences: number;
    isExported: boolean;
}
