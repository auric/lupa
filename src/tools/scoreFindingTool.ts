import * as z from 'zod';
import * as vscode from 'vscode';
import { BaseTool } from './baseTool';
import { ToolResult, toolSuccess } from '../types/toolResultTypes';
import { ExecutionContext } from '../types/executionContext';

export class ScoreFindingTool extends BaseTool {
    name = 'score_finding';
    description =
        'Score a review finding on a 1-10 confidence scale during self-reflection. Call this once for each finding to assign your confidence score.';

    schema = z.object({
        finding_id: z
            .string()
            .describe('The unique identifier of the finding to score.'),
        score: z
            .number()
            .int()
            .min(1)
            .max(10)
            .describe(
                'Confidence score from 1 (likely false positive) to 10 (certain real issue).'
            ),
        rationale: z
            .string()
            .describe(
                'Brief rationale explaining why you assigned this score.'
            ),
    });

    async execute(
        args: z.infer<typeof this.schema>,
        context: ExecutionContext
    ): Promise<ToolResult> {
        if (context.cancellationToken.isCancellationRequested) {
            throw new vscode.CancellationError();
        }
        return toolSuccess(
            `Score ${args.score}/10 recorded for finding ${args.finding_id}.`
        );
    }
}
