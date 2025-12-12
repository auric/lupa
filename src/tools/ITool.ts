import { z } from 'zod';
import * as vscode from 'vscode';
import { ToolResult } from '../types/toolResultTypes';

// Base interface for a tool
export interface ITool {
  name: string;
  description: string;
  schema: z.ZodType;
  getVSCodeTool(): vscode.LanguageModelChatTool;
  execute(args: any): Promise<ToolResult>;
}
