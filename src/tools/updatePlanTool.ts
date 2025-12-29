import * as z from 'zod';
import { BaseTool } from './baseTool';
import { ToolResult, toolSuccess, toolError } from '../types/toolResultTypes';
import { ExecutionContext } from '../types/executionContext';

/**
 * Tool for creating and updating a structured review plan.
 *
 * The LLM uses this tool to:
 * 1. Create an initial plan after scanning the diff
 * 2. Mark checklist items as complete during investigation
 * 3. Add findings and notes as the review progresses
 *
 * The plan is scoped to the current analysis via ExecutionContext.
 * Each analysis creates its own context with a fresh PlanSessionManager,
 * ensuring complete isolation between parallel analyses.
 */
export class UpdatePlanTool extends BaseTool {
    name = 'update_plan';
    description =
        'Create or update your review plan. Use this to structure your analysis, track progress, ' +
        'and ensure comprehensive coverage. Call early to create a plan, then update as you complete items.';

    schema = z.object({
        plan: z
            .string()
            .min(10)
            .describe(
                'Markdown-formatted review plan with checklist items. Use - [ ] for pending and - [x] for completed items.'
            ),
    });

    async execute(
        args: z.infer<typeof this.schema>,
        context?: ExecutionContext
    ): Promise<ToolResult> {
        const { plan } = args;

        const planManager = context?.planManager;
        if (!planManager) {
            return toolError(
                'No active analysis session. The update_plan tool is only available during PR analysis.'
            );
        }

        const isUpdate = planManager.hasPlan();
        planManager.updatePlan(plan);

        const statusMessage = isUpdate
            ? '✅ Plan updated successfully.'
            : '📋 Review plan created.';

        return toolSuccess(`${statusMessage}

## Current Plan

${plan}

---

**Next Steps:**
- Continue investigating items marked as pending (- [ ])
- Use tools to gather evidence for each checklist item
- Update the plan as you complete investigations
- Call \`think_about_completion\` before finalizing your review`);
    }
}
