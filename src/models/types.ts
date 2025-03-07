/**
 * Available analysis modes for PR reviews
 */
export type AnalysisMode = 'critical' | 'comprehensive' | 'security' | 'performance';

/**
 * Model provider types
 */
export type ModelProvider = 'copilot' | 'openai' | 'ollama' | 'anthropic' | 'mistral';

/**
 * Severity levels for issues
 */
export type IssueSeverity = 'error' | 'warning' | 'info';

/**
 * Issue identified in code
 */
export interface CodeIssue {
    file: string;
    line: number;
    message: string;
    severity: IssueSeverity;
    code?: string;
}

/**
 * Chat message
 */
export interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: number;
}

/**
 * Analysis options
 */
export interface AnalysisOptions {
    mode: AnalysisMode;
    modelFamily?: string;
    modelVersion?: string;
    provider?: ModelProvider;
}

// Define interfaces for clear typing
export interface EmbeddingOptions {
    pooling?: 'mean' | 'cls' | 'none';
    normalize?: boolean;
    overlapSize?: number;
}

export interface TokenEstimatorOptions {
    modelName: string;
    contextLength: number;
}

export interface ChunkingResult {
    chunks: string[];
    offsets: number[];
}

export interface CodeChunkingOptions {
    overlapSize?: number;
}
