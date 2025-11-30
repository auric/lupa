import { z } from 'zod';
import { BaseTool } from './baseTool';
import { ToolResult, toolSuccess } from '../types/toolResultTypes';

/**
 * Self-reflection tool that prompts the LLM to evaluate gathered context.
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
        return toolSuccess(`<context_reflection>
<section name="sufficiency">
Ask yourself:
- Do I have context for ALL changed files in the diff?
- Have I explored code around each significant change?
- Are there symbols or files I haven't investigated yet?
</section>

<section name="relevance">
Verify:
- Is my gathered context actually related to the PR changes?
- Am I focusing on code affected by this PR, not unrelated areas?
- Have I avoided going down rabbit holes into unchanged code?
</section>

<section name="dependencies">
Check:
- How does the changed code interact with other parts of the system?
- Are there callers or callees that might be affected?
- Have I verified type compatibility and interface contracts?
</section>

<section name="gaps">
Identify what's missing:
- What information do I still need?
- Are there edge cases I haven't considered?
- Which tools should I use to fill these gaps?
</section>
</context_reflection>

<next_action>
If gaps exist: Use find_symbol, find_usages, or search_for_pattern to gather more context.
If context is sufficient: Proceed with analysis, being explicit about findings.
</next_action>`);
    }
}
