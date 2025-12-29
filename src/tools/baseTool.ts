import * as z from 'zod';
import * as vscode from 'vscode';
import { ITool } from './ITool';
import { ToolResult } from '../types/toolResultTypes';
import { ExecutionContext } from '../types/executionContext';

// Abstract base class for tools
export abstract class BaseTool implements ITool {
    abstract name: string;
    abstract description: string;
    abstract schema: z.ZodType;

    getVSCodeTool(): vscode.LanguageModelChatTool {
        return {
            name: this.name,
            description: this.description,
            inputSchema: z.toJSONSchema(this.schema),
        };
    }

    abstract execute(
        args: z.infer<this['schema']>,
        context?: ExecutionContext
    ): Promise<ToolResult>;
}
