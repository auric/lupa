import { z } from 'zod';
import { BaseTool } from './baseTool';
import { ToolResult, toolSuccess } from '../types/toolResultTypes';

/**
 * Self-reflection tool for main agent: evaluates gathered context.
 * Call after using context-gathering tools (find_symbol, find_usages, etc.)
 * to verify information sufficiency before proceeding with analysis.
 */
export class ThinkAboutContextTool extends BaseTool {
    name = 'think_about_context';
    description =
        'Pause to reflect on gathered information. Call this after collecting context ' +
        'to verify you have sufficient and relevant information before proceeding with analysis.';

    schema = z.object({}).strict();

    async execute(): Promise<ToolResult> {
        return toolSuccess(`## Context Evaluation

### Diff Coverage Check
- Have I investigated the key changes in each modified file?
- Did I use find_symbol for functions I don't fully understand?
- Did I check find_usages for functions whose signature/behavior changed?

### Understanding Check
- Can I explain what this PR is trying to accomplish?
- Do I understand the "before" and "after" behavior?
- Are there any changes I'm confused about?

### Gap Identification
What I still need to investigate:
- [List specific unknowns]

### Subagent Consideration
- Are there areas requiring deep investigation that would benefit from a subagent?
- Have I spawned subagents for security-sensitive changes?
- If 4+ files changed, have I parallelized analysis with subagents?

### Decision
□ Need more context → Use specific tools to fill gaps
□ Need deep investigation → Spawn subagent with clear task + code context
□ Context sufficient → Proceed to synthesis`);
    }
}
