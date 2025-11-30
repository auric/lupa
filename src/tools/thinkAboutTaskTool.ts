import { z } from 'zod';
import { BaseTool } from './baseTool';
import { ToolResult, toolSuccess } from '../types/toolResultTypes';

/**
 * Self-reflection tool that prompts the LLM to verify task alignment.
 * Call before drawing conclusions to ensure the analysis stays focused
 * on the actual PR changes and addresses all review categories.
 */
export class ThinkAboutTaskTool extends BaseTool {
    name = 'think_about_task';
    description =
        'Pause to verify you are on track with the PR review task. Call this before drawing ' +
        'conclusions to ensure your analysis aligns with the original request and covers all changed files.';

    schema = z.object({}).strict();

    async execute(): Promise<ToolResult<string>> {
        return toolSuccess(`<task_alignment>
<section name="scope">
Verify your focus:
- Am I reviewing what was ACTUALLY changed in this PR?
- Have I avoided analyzing unchanged code?
- Am I staying focused on the diff, not the entire codebase?
</section>

<section name="completeness">
Check coverage:
- Have I analyzed ALL significant changes in the diff?
- Did I review each modified file?
- Are there any hunks or sections I skipped?
</section>

<section name="actionability">
Ensure value:
- Are my findings specific to THIS PR?
- Can the author act on my suggestions?
- Have I avoided generic advice that doesn't apply here?
</section>

<section name="balance">
Maintain fairness:
- Have I acknowledged good decisions and clean code?
- Am I being fair to the author's intent?
- Is my review constructive, not just critical?
</section>
</task_alignment>

<review_categories>
Have you evaluated each category?
[ ] Bugs and logic errors
[ ] Security vulnerabilities
[ ] Performance implications
[ ] Code quality and maintainability
[ ] Test coverage
[ ] Documentation needs
</review_categories>

<next_action>
If off-track: Refocus on the actual changes in the diff.
If on-track: Proceed with conclusions, organized by priority.
</next_action>`);
    }
}
