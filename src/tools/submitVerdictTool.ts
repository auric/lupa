import * as z from 'zod';
import * as vscode from 'vscode';
import { BaseTool } from './baseTool';
import { ToolResult, toolSuccess } from '../types/toolResultTypes';
import { ExecutionContext } from '../types/executionContext';

export class SubmitVerdictTool extends BaseTool {
    name = 'submit_verdict';
    description =
        'Submit your final verdict on whether the finding is a true positive or false positive. Call this exactly once after completing your investigation.';

    schema = z.object({
        verdict: z
            .enum(['CONFIRMED', 'REFUTED', 'UNCERTAIN'])
            .describe(
                'CONFIRMED: Finding is a real issue backed by concrete evidence. REFUTED: Finding is wrong or not a real problem. UNCERTAIN: Unable to determine either way.'
            ),
        evidence: z
            .string()
            .describe(
                'Key evidence from tool output that supports your verdict.'
            ),
        summary: z
            .string()
            .describe('1-2 sentence explanation of your reasoning.'),
    });

    async execute(
        args: z.infer<typeof this.schema>,
        context: ExecutionContext
    ): Promise<ToolResult> {
        if (context.cancellationToken.isCancellationRequested) {
            throw new vscode.CancellationError();
        }
        return toolSuccess(`Verdict ${args.verdict} recorded.`, {
            isCompletion: true,
        });
    }
}
