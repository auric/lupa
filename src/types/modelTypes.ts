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
 * Analysis options
 */
export interface AnalysisOptions {
    mode: AnalysisMode;
    modelFamily?: string;
    modelVersion?: string;
    provider?: ModelProvider;
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
