import * as z from 'zod';
import { BaseTool } from './baseTool';
import { ToolResult, toolSuccess, toolError } from '../types/toolResultTypes';
import { ExecutionContext } from '../types/executionContext';

/**
 * Tool for creating and updating a structured review plan.
 *
 * The LLM uses this tool to:
 * 1. Create an initial plan after scanning the diff (MANDATORY first action)
 * 2. Mark checklist items as complete during investigation
 * 3. Add new items when discovering unexpected areas to investigate
 *
 * The plan is scoped to the current analysis via ExecutionContext.
 * Each analysis creates its own context with a fresh PlanSessionManager,
 * ensuring complete isolation between parallel analyses.
 */
export class UpdatePlanTool extends BaseTool {
    name = 'update_plan';
    description =
        'Create or update your review plan. MANDATORY as your first action after receiving the diff. ' +
        'Use to structure analysis, track progress, and ensure comprehensive coverage.';

    schema = z.object({
        plan: z
            .string()
            .min(50)
            .describe(
                `Markdown-formatted review plan. Required structure:

## PR Review Plan

### Overview
[1-2 sentences: What this PR does and initial risk assessment]

### Checklist
- [ ] [File or area to review]
- [ ] [Security concerns if applicable]
- [ ] [Error handling verification]
- [ ] [Test coverage implications]
- [ ] Synthesize findings

Use - [ ] for pending items and - [x] for completed items.
Add notes after items as you complete them (e.g., "- [x] auth.ts - found timing attack risk").`
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

        // Validate plan structure
        const hasOverview =
            plan.includes('### Overview') || plan.includes('## Overview');
        const hasChecklist = plan.includes('- [ ]') || plan.includes('- [x]');

        let feedback = '';
        if (!hasOverview) {
            feedback +=
                '\n⚠️ Plan is missing an Overview section. Add a 1-2 sentence summary of the PR.';
        }
        if (!hasChecklist) {
            feedback +=
                '\n⚠️ Plan is missing checklist items. Use - [ ] to create trackable items.';
        }

        return toolSuccess(`${statusMessage}${feedback}

## Current Plan

${plan}

---

**Next Steps:**
- Investigate items marked as pending (- [ ])
- Use \`find_symbol\` and \`find_usages\` to gather context
- Call \`update_plan\` after completing each major item
- Use \`think_about_context\` after gathering information
- Call \`think_about_completion\` before finalizing your review`);
    }
}
