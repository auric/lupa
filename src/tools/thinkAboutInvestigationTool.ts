import * as z from 'zod';
import * as vscode from 'vscode';
import { BaseTool } from './baseTool';
import { ToolResult, toolSuccess } from '../types/toolResultTypes';
import { ExecutionContext } from '../types/executionContext';
import { flexibleStringArray } from './schemaHelpers';

const InvestigationDecision = z.enum([
    'continue_investigating',
    'wrap_up_partial',
    'investigation_complete',
]);

/**
 * Self-reflection tool optimized for subagent investigations.
 *
 * Forces explicit articulation of investigation progress rather than passive checklists.
 * Subagents have limited context (no diff) and limited iterations, so they need
 * focused reflection on task completion within budget constraints.
 */
export class ThinkAboutInvestigationTool extends BaseTool {
    name = 'think_about_investigation';
    description =
        'Pause and reflect on investigation progress before continuing. ' +
        'CALL THIS after 3-5 tool calls to check if you are staying focused and on budget. ' +
        'decision values: continue_investigating (more work needed), wrap_up_partial (running low on iterations), investigation_complete (all questions answered).';

    schema = z
        .object({
            assigned_task: z
                .string()
                .describe('What task were you assigned to investigate?'),
            questions_answered: flexibleStringArray.describe(
                'Questions from the task that you have answered'
            ),
            questions_remaining: flexibleStringArray.describe(
                'Questions that still need investigation'
            ),
            evidence_gathered: flexibleStringArray.describe(
                'Concrete evidence found (file paths, code references, findings)'
            ),
            estimated_iterations_used: z
                .number()
                .int()
                .min(0)
                .describe(
                    'Approximate number of tool calls/iterations used so far'
                ),
            decision: InvestigationDecision.describe(
                'Your decision: continue_investigating, wrap_up_partial (time running out), or investigation_complete'
            ),
        })
        .strict();

    async execute(
        args: z.infer<typeof this.schema>,
        context: ExecutionContext
    ): Promise<ToolResult> {
        if (context.cancellationToken.isCancellationRequested) {
            throw new vscode.CancellationError();
        }

        const {
            assigned_task,
            questions_answered,
            questions_remaining,
            evidence_gathered,
            estimated_iterations_used,
            decision,
        } = args;

        const answeredCount = questions_answered.length;
        const remainingCount = questions_remaining.length;
        const hasEvidence = evidence_gathered.length > 0;

        let guidance = '## Investigation Progress Reflection\n\n';

        guidance += `### Assigned Task\n${assigned_task}\n\n`;

        guidance += `### Progress: ${answeredCount} answered, ${remainingCount} remaining\n\n`;

        if (answeredCount > 0) {
            guidance += `**Questions Answered:**\n`;
            guidance += questions_answered.map((q) => `- ✓ ${q}`).join('\n');
            guidance += '\n\n';
        }

        if (remainingCount > 0) {
            guidance += `**Questions Remaining:**\n`;
            guidance += questions_remaining.map((q) => `- ○ ${q}`).join('\n');
            guidance += '\n\n';
        }

        if (hasEvidence) {
            guidance += `### Evidence Gathered (${evidence_gathered.length})\n`;
            guidance += evidence_gathered.map((e) => `- ${e}`).join('\n');
            guidance += '\n\n';
        }

        guidance += `### Iterations Used: ~${estimated_iterations_used}\n\n`;

        guidance += `### Decision: ${decision.replace(/_/g, ' ').toUpperCase()}\n\n`;

        // Provide guidance based on decision
        switch (decision) {
            case 'continue_investigating':
                guidance +=
                    '**Action**: Focus on highest-priority remaining question(s).\n';
                guidance +=
                    "- Use `get_file_diff` if you haven't read the diff for all assigned files\n";
                guidance +=
                    '- Prioritize questions most relevant to the parent task\n';
                guidance += '- Be efficient with remaining iterations\n';
                guidance +=
                    '- If you have hypotheses about potential issues, search for comments/docs explaining the design before investigating further\n';
                break;
            case 'wrap_up_partial':
                guidance +=
                    '**Action**: Start formulating response with partial findings.\n';
                guidance += '- Summarize what you found with evidence\n';
                guidance += '- Note which questions remain unanswered\n';
                guidance +=
                    '- Report any truncated diffs that need re-review by the parent\n';
                guidance +=
                    '- Provide clear recommendations based on available evidence\n';
                guidance += this.getQualityCheckGuidance();
                break;
            case 'investigation_complete':
                guidance +=
                    '**Action**: Formulate final response to parent agent.\n';
                guidance += '- Include findings with markdown file links\n';
                guidance += '- Provide specific recommendations\n';
                guidance += '- Summarize evidence clearly\n';
                guidance += this.getQualityCheckGuidance();
                break;
        }

        return toolSuccess(guidance);
    }

    private getQualityCheckGuidance(): string {
        return (
            '\n**Before reporting findings, challenge each one:**\n' +
            '- Is it MECHANICAL (duplication, API misuse, type error) or INTENT-BASED (design disagreement)?\n' +
            '- For intent-based: did you search for comments/JSDoc/docs explaining the design? If ANY documented rationale exists → **DROP IT**\n' +
            '- Did you check the ACTUAL CALL SITES? A theoretical vulnerability where the only callers pass safe values is NOT a finding. Use `find_usages` or `search_for_pattern` to verify.\n' +
            '- Can you cite the specific tool output that confirms it?\n' +
            '- Revert Test: would reverting this PR fix this issue? If NO → DROP IT\n' +
            '- Zero findings is a valid outcome — do not invent issues to justify your investigation\n'
        );
    }
}
