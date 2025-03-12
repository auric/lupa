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
 * Supported languages for indexing and analysis
 */
export interface SupportedLanguage {
    extension: string;
    language: string;
}

/**
 * Map of supported file extensions to language names
 */
export const SUPPORTED_LANGUAGES: Record<string, string> = {
    'js': 'javascript',
    'jsx': 'javascript',
    'ts': 'typescript',
    'tsx': 'typescript',
    'py': 'python',
    'java': 'java',
    'c': 'c',
    'cpp': 'cpp',
    'h': 'cpp',
    'hpp': 'cpp',
    'cs': 'csharp',
    'go': 'go',
    'rb': 'ruby',
    'php': 'php'
};

/**
 * Get a glob pattern for finding supported source files
 * @returns A glob pattern matching all supported file extensions
 */
export function getSupportedFilesGlob(): string {
    const extensions = Object.keys(SUPPORTED_LANGUAGES).join(',');
    return `**/*.{${extensions}}`;
}

/**
 * Get a VS Code exclude pattern for filtering out non-source directories
 * @returns A pattern to exclude common non-source directories
 */
export function getExcludePattern(): string {
    return '**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/.vscode/**';
}

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

/**
 * Database-related interfaces
 */

/**
 * Represents a file in the embeddings database
 */
export interface FileRecord {
    id: string;
    path: string;
    hash: string;
    lastModified: number;
    language?: string;
    isIndexed: boolean;
    size: number;
}

/**
 * Represents a chunk of code from a file
 */
export interface ChunkRecord {
    id: string;
    fileId: string;
    content: string;
    startOffset: number;
    endOffset: number;
    tokenCount?: number;
}

/**
 * Represents an embedding vector for a chunk
 */
export interface EmbeddingRecord {
    id: string;
    chunkId: string;
    vector: Float32Array;
    model: string;
    dimension: number;
    createdAt: number;
}

/**
 * Options for similarity search
 */
export interface SimilaritySearchOptions {
    limit?: number;
    minScore?: number;
    fileFilter?: string[];
    languageFilter?: string[];
}

/**
 * Result of a similarity search
 */
export interface SimilaritySearchResult {
    chunkId: string;
    fileId: string;
    filePath: string;
    content: string;
    startOffset: number;
    endOffset: number;
    score: number;
}

/**
 * Database configuration options
 */
export interface DatabaseConfig {
    dbPath: string;
    maxConnections?: number;
    busyTimeout?: number;
    migrationsPath?: string;
}

/**
 * Storage statistics
 */
export interface StorageStats {
    fileCount: number;
    chunkCount: number;
    embeddingCount: number;
    databaseSizeBytes: number;
    lastIndexed: number | null;
    embeddingModel: string;
}
