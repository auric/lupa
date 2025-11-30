import { z } from 'zod';
import { BaseTool } from './baseTool';
import { ToolResult, toolSuccess } from '../types/toolResultTypes';

/**
 * Self-reflection tool that prompts the LLM to verify analysis completeness.
 * Call when ready to provide final review to ensure nothing important was missed
 * and the feedback is well-structured and actionable.
 */
export class ThinkAboutCompletionTool extends BaseTool {
    name = 'think_about_completion';
    description =
        'Call this when you believe you are done to verify the analysis is complete. ' +
        'Helps ensure nothing important was missed before providing the final review.';

    schema = z.object({}).strict();

    async execute(): Promise<ToolResult<string>> {
        return toolSuccess(`<completion_verification>
<section name="coverage">
Verify all files reviewed:
[ ] Analyzed every file in the diff
[ ] Checked both additions and deletions
[ ] Considered impact of moved or renamed code
</section>

<section name="issue_categories">
Confirm you checked for:
[ ] Bugs: Logic errors, null/undefined risks, race conditions
[ ] Security: Input validation, authentication, data exposure
[ ] Performance: N+1 queries, unnecessary computations, memory leaks
[ ] Quality: Code duplication, complexity, naming, SOLID principles
[ ] Testing: Missing tests, edge cases, test quality
</section>

<section name="feedback_quality">
Ensure actionable output:
[ ] Suggestions are specific enough to implement
[ ] Provided code examples where helpful
[ ] Explained WHY something is an issue, not just WHAT
</section>

<section name="prioritization">
Verify clear priority levels:
[ ] Critical issues marked as blockers
[ ] Minor suggestions labeled as nitpicks
[ ] Issues organized by importance
</section>

<section name="constructiveness">
Confirm balanced feedback:
[ ] Acknowledged well-written code
[ ] Recognized good patterns and practices
[ ] Review is constructive, not just fault-finding
</section>
</completion_verification>

<next_action>
If incomplete: Gather more context or refine analysis.
If complete: Provide final review with clear structure:
1. Summary (1-2 sentences)
2. Critical issues (if any)
3. Suggestions for improvement
4. Positive observations
</next_action>`);
    }
}
