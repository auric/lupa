import * as z from 'zod';
import * as vscode from 'vscode';
import { ToolResult } from '../types/toolResultTypes';
import { ExecutionContext } from '../types/executionContext';

// Base interface for a tool
export interface ITool {
    name: string;
    description: string;
    schema: z.ZodType;
    getVSCodeTool(): vscode.LanguageModelChatTool;
    execute(args: any, context?: ExecutionContext): Promise<ToolResult>;
}
