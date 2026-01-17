import * as z from 'zod';
import { BaseTool } from './baseTool';
import { ToolResult, toolSuccess } from '../types/toolResultTypes';
import { ExecutionContext } from '../types/executionContext';

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
        'Articulate your investigation progress (primarily for subagents). ' +
        'Forces you to state questions answered, evidence gathered, and remaining work within your budget.';

    schema = z
        .object({
            assigned_task: z
                .string()
                .describe('What task were you assigned to investigate?'),
            questions_answered: z
                .array(z.string())
                .describe('Questions from the task that you have answered'),
            questions_remaining: z
                .array(z.string())
                .describe('Questions that still need investigation'),
            evidence_gathered: z
                .array(z.string())
                .describe(
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
        _context: ExecutionContext
    ): Promise<ToolResult> {
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
                    '- Prioritize questions most relevant to the parent task\n';
                guidance += '- Be efficient with remaining iterations\n';
                break;
            case 'wrap_up_partial':
                guidance +=
                    '**Action**: Start formulating response with partial findings.\n';
                guidance += '- Summarize what you found with evidence\n';
                guidance += '- Note which questions remain unanswered\n';
                guidance +=
                    '- Provide clear recommendations based on available evidence\n';
                break;
            case 'investigation_complete':
                guidance +=
                    '**Action**: Formulate final response to parent agent.\n';
                guidance += '- Include findings with markdown file links\n';
                guidance += '- Provide specific recommendations\n';
                guidance += '- Summarize evidence clearly\n';
                break;
        }

        return toolSuccess(guidance);
    }
}
