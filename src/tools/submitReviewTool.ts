import * as z from 'zod';
import { BaseTool } from './baseTool';
import { ToolResult, toolSuccess } from '../types/toolResultTypes';
import { ExecutionContext } from '../types/executionContext';
import { SEVERITY } from '../config/chatEmoji';

/**
 * Special tool that signals the LLM has completed its analysis
 * and is ready to submit the final review.
 *
 * This tool solves the problem of some models (like GPT-4.1) responding
 * with "I will do X" messages without tool calls, which gets misinterpreted
 * as the final review.
 *
 * The ConversationRunner treats this tool specially:
 * - When called, it extracts the review content and terminates the loop
 * - The review content becomes the final output
 */
export class SubmitReviewTool extends BaseTool {
    /** Special tool name recognized by ConversationRunner */
    static readonly TOOL_NAME = 'submit_review';

    name = SubmitReviewTool.TOOL_NAME;
    description =
        'Submit your final PR review. Call this as the FINAL step when all analysis is complete. ' +
        'This is the explicit completion signal - never respond without tool calls.';

    schema = z
        .object({
            summary: z
                .string()
                .min(20)
                .describe(
                    '2-3 sentence summary of the PR and your key findings'
                ),
            risk_level: z
                .enum(['low', 'medium', 'high', 'critical'])
                .describe('Overall risk level of merging this PR'),
            recommendation: z
                .enum([
                    'approve',
                    'approve_with_suggestions',
                    'request_changes',
                    'block_merge',
                ])
                .describe('Your recommendation for this PR'),
            review_content: z
                .string()
                .min(100)
                .describe(
                    'The complete markdown-formatted review including all findings, suggestions, and positive observations'
                ),
        })
        .strict();

    private readonly riskEmojis: Record<string, string> = {
        low: SEVERITY.low,
        medium: SEVERITY.medium,
        high: SEVERITY.high,
        critical: SEVERITY.critical,
    };

    private readonly recommendationLabels: Record<string, string> = {
        approve: 'Approve',
        approve_with_suggestions: 'Approve with Suggestions',
        request_changes: 'Request Changes',
        block_merge: 'Block Merge',
    };

    async execute(
        args: z.infer<typeof this.schema>,
        _context?: ExecutionContext
    ): Promise<ToolResult> {
        // The tool result contains the formatted review
        // ConversationRunner will extract this as the final output
        const { summary, risk_level, recommendation, review_content } = args;

        const emoji = this.riskEmojis[risk_level] || '';
        const riskLabel =
            risk_level.charAt(0).toUpperCase() + risk_level.slice(1);
        const recommendationLabel =
            this.recommendationLabels[recommendation] || recommendation;

        // Format the final review output
        const output = [
            '## Summary',
            summary,
            '',
            `**Risk Level:** ${emoji} ${riskLabel}`,
            `**Recommendation:** ${recommendationLabel}`,
            '',
            review_content,
        ].join('\n');

        return toolSuccess(output, {
            isCompletion: true,
            riskLevel: risk_level,
            recommendation,
        });
    }
}
