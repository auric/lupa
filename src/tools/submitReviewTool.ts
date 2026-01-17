import * as z from 'zod';
import { BaseTool } from './baseTool';
import { ToolResult, toolSuccess } from '../types/toolResultTypes';
import { ExecutionContext } from '../types/executionContext';

/**
 * Explicit completion signal for PR review analysis.
 *
 * This tool solves the problem of some models responding with planning
 * messages ("I will review X") without tool calls, which would otherwise
 * be misinterpreted as the final review.
 *
 * The ConversationRunner treats this tool specially:
 * - When called, it extracts the review content and terminates the loop
 * - The review content becomes the final output (no additional formatting)
 *
 * The review content should follow the output format specification which
 * already includes summary, risk level, and recommendation.
 */
export class SubmitReviewTool extends BaseTool {
    name = 'submit_review';
    description =
        'Submit your final PR review. Call this as the FINAL step when all analysis is complete. ' +
        'The review content should follow the output format with summary, findings, and recommendations.';

    /**
     * Minimum 20 chars is intentionally lower than reviewExtractionUtils' 50-char
     * threshold. When the model explicitly calls this tool, we trust its intent.
     * Extraction requires stricter validation because the model didn't call properly.
     */
    schema = z
        .object({
            review_content: z
                .string()
                .min(20)
                .describe(
                    'The complete markdown-formatted review following the output format specification. ' +
                        'Must include summary section, findings by category, and recommendations.'
                ),
        })
        .strict();

    async execute(
        args: z.infer<typeof this.schema>,
        _context: ExecutionContext
    ): Promise<ToolResult> {
        // Return review content as-is - the output format prompt already defines structure
        return toolSuccess(args.review_content, { isCompletion: true });
    }
}
