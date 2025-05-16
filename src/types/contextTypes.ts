export interface ContextSnippet {
    id: string; // Unique ID, e.g., filePath:startLine:type or hash of content
    type: 'lsp-definition' | 'lsp-reference' | 'embedding';
    content: string; // The formatted markdown snippet itself
    relevanceScore: number; // Higher is more relevant. e.g., LSP defs=1.0, LSP refs=0.9, embeddings=0.0-0.8
    filePath?: string; // For logging or more granular pruning
    startLine?: number; // For logging or more granular pruning
    // tokenCount?: number; // Optional: pre-calculated token count for the content
}