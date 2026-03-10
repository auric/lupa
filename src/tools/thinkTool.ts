import * as z from 'zod';
import * as vscode from 'vscode';
import { BaseTool } from './baseTool';
import { ToolResult, toolSuccess } from '../types/toolResultTypes';
import { ExecutionContext } from '../types/executionContext';
import { flexibleStringArray } from './schemaHelpers';

/**
 * Structured thinking tool for the LLM to organize reasoning during analysis.
 *
 * Covers context reflection, code change reasoning, investigation
 * progress, or task alignment.
 *
 * Uses a flat schema with 2 required + 2 optional fields to maximize adoption by all models.
 * Replaces: think_about_context, think_about_investigation,
 * think_about_task, and think_about_code_change.
 */
export class ThinkTool extends BaseTool {
    name = 'think';
    description =
        'REQUIRED reasoning checkpoint. Call at three points: ' +
        '(1) after reading diffs — plan what to investigate, ' +
        '(2) after gathering evidence — synthesize what tools found, does it confirm or disprove risks? ' +
        '(3) before recording a finding — verify your conclusion holds under scrutiny. ' +
        'Skipping checkpoints causes false positives and missed issues.';

    schema = z.object({
        topic: z
            .string()
            .describe(
                'What you are thinking about (e.g., "auth changes in login.ts", "investigation progress", "context gaps")'
            ),
        analysis: z
            .string()
            .describe(
                'Your reasoning: what you know, what changed, what concerns you, what looks correct'
            ),
        identified_risks: flexibleStringArray
            .describe(
                'Specific risks, concerns, or gaps identified (empty array if none)'
            )
            .optional(),
        next_action: z
            .string()
            .describe(
                'What to do next based on your thinking (e.g., "investigate with find_usages", "move to next file", "record finding")'
            )
            .optional(),
    });

    async execute(
        args: z.infer<typeof this.schema>,
        context: ExecutionContext
    ): Promise<ToolResult> {
        if (context.cancellationToken.isCancellationRequested) {
            throw new vscode.CancellationError();
        }

        const { topic, identified_risks, next_action } = args;

        const riskCount = identified_risks?.length ?? 0;
        const riskNote =
            riskCount > 0
                ? `${riskCount} risk(s) to verify with tools.`
                : 'No risks identified.';
        const actionNote = next_action ? ` Next: ${next_action}.` : '';

        return toolSuccess(
            `Checkpoint "${topic}": ${riskNote}${actionNote} Call think again after your next investigation step.`
        );
    }
}
