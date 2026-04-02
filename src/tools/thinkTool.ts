import * as z from 'zod';
import * as vscode from 'vscode';
import { BaseTool } from './baseTool';
import { ToolResult, toolSuccess } from '../types/toolResultTypes';
import { ExecutionContext } from '../types/executionContext';
import { flexibleStringArray } from './schemaHelpers';

/**
 * Structured thinking tool for the LLM to organize reasoning during analysis.
 *
 * Integrates with ReasoningChain to track hypotheses across checkpoints,
 * detect uninvestigated risks, and enforce evidence-aware gating.
 *
 * Uses a flat schema with 2 required + 2 optional fields to maximize adoption by all models.
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

        const MAX_EARLY_CHECKPOINT_CALLS = 2;
        const thinkCallCount = context.toolCallCounts.get('think') ?? 0;
        const isEarlyCheckpoint = thinkCallCount <= MAX_EARLY_CHECKPOINT_CALLS;

        const profile = context.calibrationProfile;
        const isDismissive = profile.findingBias === 'dismissive';

        // Record checkpoint in reasoning chain
        const chain = context.reasoningChain;
        const checkpoint = chain?.addCheckpoint(topic, identified_risks ?? []);

        // Build response parts
        const parts: string[] = [];

        // --- Evidence-aware gating ---
        // Warn if next_action mentions recording but no investigation since last checkpoint
        const wantsToRecord = next_action
            ? /record.?finding|record_finding/i.test(next_action)
            : false;
        // Use checkpoint's captured count — addCheckpoint already reset the running counter
        const investigationCount = checkpoint?.investigationToolCount ?? 0;

        if (wantsToRecord && checkpoint && investigationCount === 0) {
            parts.push(
                `⚠️ EVIDENCE GAP: You plan to record a finding but have NOT called any investigation tools (find_usages, find_symbol, read_file, validate_claim, etc.) since your last checkpoint. Investigate FIRST — call at least one investigation tool, then call think again before recording.`
            );
        }

        // --- Uninvestigated hypothesis follow-up reminder ---
        // Note: hypotheses auto-transition to 'investigating' when investigation
        // tools run, so truly uninvestigated ones had no tool activity at all.
        const uninvestigated = chain?.getUninvestigatedHypotheses() ?? [];
        const staleHypotheses = uninvestigated.filter(
            (h) =>
                checkpoint &&
                h.generatedAtCheckpoint < checkpoint.number &&
                checkpoint.number - h.generatedAtCheckpoint >= 2
        );

        if (staleHypotheses.length > 0 && !isEarlyCheckpoint) {
            const staleList = staleHypotheses
                .map((h) => `[H${h.id}] "${h.text}"`)
                .join(', ');
            parts.push(
                `⚠️ FOLLOW-UP REMINDER: ${staleHypotheses.length} hypothesis(es) from earlier checkpoints may still need attention: ${staleList}. If already investigated, record findings or dismiss with evidence; otherwise investigate with tools.`
            );
        }

        // --- Hard gate for dismissive models: reject empty identified_risks at early checkpoints ---
        if (isDismissive && isEarlyCheckpoint && riskCount === 0) {
            parts.push(
                `Checkpoint noted: 0 risks identified for "${topic}". ` +
                    'This may be valid for clean code. However, double-check: have you read the diff for this file? ' +
                    'Have you looked for null handling, error propagation, and logic issues?'
            );
            return toolSuccess(parts.join('\n\n'));
        }

        const findingStore = context.findingStore;
        const currentFindingsCount = findingStore?.size ?? 0;

        // --- Risk note (calibrated by model bias) ---
        let riskNote: string;
        if (riskCount > 0) {
            riskNote = isDismissive
                ? `${riskCount} risk(s) identified. Investigate each with tools — call find_usages, validate_claim, or search_for_pattern. Do NOT dismiss any hypothesis without concrete tool output proving it safe.`
                : `${riskCount} risk(s) to verify with tools.`;
        } else if (isEarlyCheckpoint) {
            riskNote = isDismissive
                ? 'No risks identified yet. This is almost certainly wrong — real code changes have edge cases. Generate at least 2-3 hypotheses: error handling gaps, type safety issues, missing validation, caller inconsistencies, off-by-one errors. Hypotheses are free — investigate them with tools.'
                : 'No risks identified yet. Before moving on — consider: edge cases in error handling, type safety gaps, missing validation on inputs, inconsistency with callers, or concurrency issues. Generate at least 2 hypotheses to investigate, even if they turn out to be fine.';
        } else if (isDismissive && currentFindingsCount === 0) {
            riskNote = `No risks identified after ${thinkCallCount} checkpoints, and you have recorded ZERO findings so far. If you investigated real hypotheses and all were disproved with concrete tool output, that is fine. But if any hypothesis was dismissed without tool evidence, revisit it — record it as LOW severity and let the post-analysis pipeline decide.`;
        } else {
            riskNote = 'No risks identified.';
        }

        const actionNote = next_action ? ` Next: ${next_action}.` : '';
        parts.push(`Checkpoint "${topic}": ${riskNote}${actionNote}`);

        // --- Dismissive model structured hypothesis status ---
        if (isDismissive && chain && !isEarlyCheckpoint) {
            const open = chain.getOpenHypotheses();
            if (open.length > 0) {
                const statusLines = open.map(
                    (h) =>
                        `  [H${h.id}] ${h.status.toUpperCase()}: "${h.text}" (checkpoint ${h.generatedAtCheckpoint}, tools: ${h.investigationTools.length})`
                );
                parts.push(
                    `📋 Open hypotheses requiring resolution:\n${statusLines.join('\n')}\nFor each: investigate with tools → then either record_finding or dismiss with evidence.`
                );
            }
        }

        return toolSuccess(parts.join('\n\n'));
    }
}
