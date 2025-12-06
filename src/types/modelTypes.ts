import type { LanguageModelChatTool } from 'vscode';
import type { ToolCallRecord } from './toolCallTypes';

/**
 * Analysis mode for PR analysis
 */
export enum AnalysisMode {
    Critical = 'critical',
    Comprehensive = 'comprehensive',
    Security = 'security',
    Performance = 'performance'
}

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

/**
 * Message roles for LLM conversation and tool-calling
 * Shared type to ensure consistency across conversation and model types
 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * Tool call function definition
 */
export interface ToolCallFunction {
    name: string;
    arguments: string;
}

/**
 * Tool call from LLM
 */
export interface ToolCall {
    id: string;
    function: ToolCallFunction;
}

/**
 * Message for tool-calling requests
 */
export interface ToolCallMessage {
    role: MessageRole;
    content: string | null;
    toolCalls?: ToolCall[];
    toolCallId?: string;
}

/**
 * Request for tool-calling
 */
export interface ToolCallRequest {
    messages: ToolCallMessage[];
    tools?: LanguageModelChatTool[];
}

/**
 * Response from tool-calling request
 */
export interface ToolCallResponse {
    content: string | null;
    toolCalls?: ToolCall[];
}

/**
 * Task definition for spawning an isolated subagent investigation.
 */
export interface SubagentTask {
    task: string;
    context?: string;
    /** Maximum iterations for subagent (uses workspace setting if not specified) */
    maxIterations?: number;
}

/**
 * Result from a completed subagent investigation.
 */
export interface SubagentResult {
    /** Whether the subagent completed successfully */
    success: boolean;
    /** Raw response from the subagent - parent LLM interprets naturally */
    response: string;
    /** Number of tool calls made during investigation */
    toolCallsMade: number;
    /** Detailed tool call records from the subagent (reuses ToolCallRecord for consistency) */
    toolCalls: ToolCallRecord[];
    /** Error message if success is false */
    error?: string;
}
