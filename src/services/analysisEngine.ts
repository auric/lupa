import type * as vscode from 'vscode';
import type { ToolCallRecord } from '../types/toolCallTypes';
import type { SelfReflectionScore } from './selfReflectionScorer';
import type { ILLMClient } from '../models/ILLMClient';

export interface ModelInfo {
    family: string;
    id: string;
    name: string;
    maxInputTokens: number;
}

export interface AnalysisEngineInput {
    diff: string;
    llmClient: ILLMClient;
    model: ModelInfo;
    token: vscode.CancellationToken;
    userPromptSuffix: string | undefined;
}

export interface AnalysisEngineOutput {
    onProgress(message: string, increment?: number): void;
    onToolCallStart?(
        id: string,
        name: string,
        args: Record<string, unknown>
    ): void;
    onToolCallComplete?(record: ToolCallRecord): void;
    onIterationStart?(current: number, max: number): void;
}

export interface AnalysisEngineResult {
    analysisText: string;
    toolCallRecords: ToolCallRecord[];
    completed: boolean;
    wasCancelled: boolean;
    error: string | undefined;
    iterationsUsed: number | undefined;
    selfReflectionScores: SelfReflectionScore[];
}
