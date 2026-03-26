import * as z from 'zod';
import * as vscode from 'vscode';
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
        'Create or update your review plan. ' +
        'Call once after reading the diff to decompose the PR into concern groups, then again after each investigation round to track progress and coverage gaps.';

    schema = z.object({
        plan: z
            .string()
            .min(50)
            .describe(
                `Markdown-formatted review plan. Must include an Overview section.
Use Concern Groups with status tracking (pending/complete) and coverage notes.
Call this tool multiple times: first to create the plan, then to update with findings and coverage status after each investigation round.`
            ),
    });

    async execute(
        args: z.infer<typeof this.schema>,
        context: ExecutionContext
    ): Promise<ToolResult> {
        if (context.cancellationToken.isCancellationRequested) {
            throw new vscode.CancellationError();
        }

        const { plan } = args;

        const planManager = context.planManager;
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

        // Validate plan structure with soft warnings (not schema errors).
        // Design: We use a low schema bar (50 chars) to ensure the tool always works,
        // then provide feedback warnings for structural issues. This allows the LLM to
        // self-correct on the next call rather than getting stuck in validation errors.
        // Making these schema-level errors would cause retry loops for minor formatting.
        const hasOverview =
            plan.includes('### Overview') || plan.includes('## Overview');
        const hasChecklist =
            plan.includes('- [ ]') ||
            plan.includes('- [x]') ||
            plan.includes('### Concern Groups');

        let feedback = '';
        if (!hasOverview) {
            feedback +=
                '\n⚠️ Plan is missing an Overview section. Add a 1-2 sentence summary of the PR.';
        }
        if (!hasChecklist) {
            feedback +=
                '\n⚠️ Plan is missing checklist items. Use - [ ] to create trackable items.';
        }

        return toolSuccess(`${statusMessage}${feedback}`);
    }
}
