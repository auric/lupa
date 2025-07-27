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

/**
 * Components of an analysis that consume tokens
 */
export interface TokenComponents {
    systemPrompt?: string;
    diffText?: string; // Original flat diff, can be used as fallback or for non-interleaved
    contextSnippets?: ContextSnippet[]; // Original context snippets for type-aware truncation
    embeddingContext?: string; // Context from embedding search
    lspReferenceContext?: string; // Context from LSP references
    lspDefinitionContext?: string; // Context from LSP definitions
    userMessages?: string[];
    assistantMessages?: string[];
    diffStructureTokens?: number; // Tokens for the diff's structural representation in an interleaved prompt
    responsePrefill?: string; // Response prefill content that will be sent to the model
}

/**
 * Result of token allocation calculation
 */
export interface TokenAllocation {
    totalAvailableTokens: number;
    systemPromptTokens: number;
    diffTextTokens: number;
    contextTokens: number; // Tokens of the preliminary formatted string
    userMessagesTokens: number;
    assistantMessagesTokens: number;
    responsePrefillTokens: number; // Tokens for response prefill content
    messageOverheadTokens: number; // Overhead for chat message structure
    otherTokens: number; // Reserved for formatting, metadata, etc.
}

/**
 * Content prioritization order configuration
 */
export interface ContentPrioritization {
    order: ContentType[];
}

/**
 * Result of truncation operations
 */
export interface TruncationResult {
    content: string;
    wasTruncated: boolean;
}

/**
 * Result of context optimization
 */
export interface OptimizationResult {
    optimizedSnippets: ContextSnippet[];
    wasTruncated: boolean;
}

/**
 * Result of token component truncation
 */
export interface TruncatedTokenComponents {
    components: TokenComponents;
    wasTruncated: boolean;
}
