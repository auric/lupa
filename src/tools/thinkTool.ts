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

        // Use call count instead of topic-name matching to determine early vs late checkpoints.
        // Topic-name matching is gameable: dismissive models learned to name early topics
        // "evidence synthesis" or "final assessment" to match the bypass regex.
        // Call count is objective — the first few think calls are always hypothesis-generation
        // checkpoints; later calls are naturally synthesis/devil's-advocate.
        const MAX_EARLY_CHECKPOINT_CALLS = 2;
        const thinkCallCount = context.toolCallCounts.get('think') ?? 0;
        const isEarlyCheckpoint = thinkCallCount <= MAX_EARLY_CHECKPOINT_CALLS;

        const profile = context.calibrationProfile;
        const isDismissive = profile.findingBias === 'dismissive';

        // Hard gate for dismissive models: reject empty identified_risks at early checkpoints.
        // Dismissive models tend to generate empty risks and proceed without investigating.
        // This forces them to generate hypotheses before moving on.
        if (isDismissive && isEarlyCheckpoint && riskCount === 0) {
            return toolSuccess(
                `Checkpoint noted: 0 risks identified for "${topic}". ` +
                    'This may be valid for clean code. However, double-check: have you read the diff for this file? ' +
                    'Have you looked for null handling, error propagation, and logic issues?'
            );
        }

        const findingStore = context.findingStore;
        const currentFindingsCount = findingStore?.size ?? 0;

        const riskNote =
            riskCount > 0
                ? isDismissive
                    ? `${riskCount} risk(s) identified. Investigate each with tools — call find_usages, validate_claim, or search_for_pattern. Do NOT dismiss any hypothesis without concrete tool output proving it safe.`
                    : `${riskCount} risk(s) to verify with tools.`
                : isEarlyCheckpoint
                  ? isDismissive
                      ? 'No risks identified yet. This is almost certainly wrong — real code changes have edge cases. Generate at least 2-3 hypotheses: error handling gaps, type safety issues, missing validation, caller inconsistencies, off-by-one errors. Hypotheses are free — investigate them with tools.'
                      : 'No risks identified yet. Before moving on — consider: edge cases in error handling, type safety gaps, missing validation on inputs, inconsistency with callers, or concurrency issues. Generate at least 2 hypotheses to investigate, even if they turn out to be fine.'
                  : isDismissive && currentFindingsCount === 0
                    ? `No risks identified after ${thinkCallCount} checkpoints, and you have recorded ZERO findings so far. If you investigated real hypotheses and all were disproved with concrete tool output, that is fine. But if any hypothesis was dismissed without tool evidence, revisit it — record it as LOW severity and let the post-analysis pipeline decide.`
                    : 'No risks identified.';
        const actionNote = next_action ? ` Next: ${next_action}.` : '';

        return toolSuccess(
            `Checkpoint "${topic}": ${riskNote}${actionNote} Call think again after your next investigation step.`
        );
    }
}
