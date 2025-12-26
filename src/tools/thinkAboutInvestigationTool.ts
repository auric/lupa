import * as z from 'zod';
import { BaseTool } from './baseTool';
import { ToolResult, toolSuccess } from '../types/toolResultTypes';

/**
 * Self-reflection tool optimized for subagent investigations.
 * Call midway through investigation to evaluate progress and ensure
 * the investigation stays on track and delivers useful results.
 *
 * Also useful for main agent during complex investigations.
 */
export class ThinkAboutInvestigationTool extends BaseTool {
    name = 'think_about_investigation';
    description =
        'Evaluate progress on your investigation. Call this midway through ' +
        'to verify you are on track and making efficient use of your tool budget.';

    schema = z.object({}).strict();

    async execute(): Promise<ToolResult> {
        return toolSuccess(`## Investigation Progress Check

### Task Focus
- What was my assigned task?
- Am I still investigating that specific concern?
- Have I drifted into unrelated areas?

### Evidence Gathered
- What concrete evidence have I found?
- Do I have markdown file links for each finding?
- Are my findings supported by code snippets?

### Tool Budget
- How many iterations have I used?
- What's the most important thing I still need to check?
- Should I wrap up or continue investigating?

### Deliverable Readiness
Can I provide:
□ Findings with location, evidence, and severity
□ Specific recommendations
□ Summary for parent agent

### Decision
□ Key gaps remain → Use remaining iterations on highest-priority investigation
□ Running low on iterations → Start wrapping up, provide partial findings
□ Investigation complete → Formulate response with findings + recommendations`);
    }
}
