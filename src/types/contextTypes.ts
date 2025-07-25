// Type-safe content type definitions
export type ContextSnippetType = 'lsp-definition' | 'lsp-reference' | 'embedding';
export type ContentType = 'diff' | ContextSnippetType;

export interface ContextSnippet {
    id: string; // Unique ID, e.g., filePath:startLine:type or hash of content
    type: ContextSnippetType;
    content: string; // The formatted markdown snippet itself
    relevanceScore: number; // Higher is more relevant. e.g., LSP defs=1.0, LSP refs=0.9, embeddings=0.0-0.8
    filePath?: string; // For logging or more granular pruning
    associatedHunkIdentifiers?: string[]; // Identifiers of diff hunks this snippet is primarily associated with
    startLine?: number; // For logging or more granular pruning
    // tokenCount?: number; // Optional: pre-calculated token count for the content
}

export interface DiffHunkLine {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
    hunkId?: string; // Unique identifier for this hunk within its file
}

export interface DiffHunk {
    filePath: string;
    hunks: DiffHunkLine[];
}

export interface HybridContextResult {
    snippets: ContextSnippet[];
    parsedDiff: DiffHunk[];
}