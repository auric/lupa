import * as z from 'zod';
import { BaseTool } from './baseTool';
import { ToolResult, toolSuccess } from '../types/toolResultTypes';

/**
 * Self-reflection tool for main agent: verifies task alignment.
 * Call before drawing conclusions to ensure the analysis stays focused
 * on the actual PR changes and addresses all review categories.
 */
export class ThinkAboutTaskTool extends BaseTool {
    name = 'think_about_task';
    description =
        'Pause to verify you are on track with the PR review task. Call this before drawing ' +
        'conclusions to ensure your analysis aligns with the original request and covers all changed files.';

    schema = z.object({}).strict();

    async execute(): Promise<ToolResult> {
        return toolSuccess(`## Task Alignment Check

### Scope Verification
- Am I analyzing what CHANGED in this PR, not the entire codebase?
- Have I avoided deep rabbit-holes into unchanged code?
- Are my findings relevant to these specific changes?

### Review Coverage
Have I evaluated:
□ Bugs and logic errors - incorrect behavior, edge cases
□ Security issues - vulnerabilities, data exposure, auth problems
□ Performance impact - complexity, resource usage, scalability
□ Code quality - readability, maintainability, patterns
□ Error handling - exceptions, recovery, user experience
□ Test implications - what should be tested, coverage gaps

### Finding Quality
For each finding I plan to report:
□ Do I have a specific file:line reference?
□ Can I show evidence (code snippet)?
□ Is my severity assessment justified?
□ Is my recommendation actionable?

### Balance Check
□ Have I acknowledged good practices, not just problems?
□ Am I being fair to the author's intent?
□ Is my tone constructive?

### Decision
□ Off-track → Refocus on the actual diff changes
□ Gaps in coverage → Continue analysis for uncovered areas
□ Ready → Proceed to final synthesis`);
    }
}
