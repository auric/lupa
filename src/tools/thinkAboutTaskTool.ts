import * as z from 'zod';
import { BaseTool } from './baseTool';
import { ToolResult, toolSuccess } from '../types/toolResultTypes';
import { ExecutionContext } from '../types/executionContext';

const TaskDecision = z.enum([
    'off_track',
    'gaps_in_coverage',
    'ready_to_synthesize',
]);

const IssueSchema = z.object({
    description: z.string().describe('Brief description of the issue found'),
    file: z.string().describe('File where the issue was found'),
    severity: z
        .enum(['critical', 'high', 'medium', 'low'])
        .describe('Severity of the issue'),
});

/**
 * Self-reflection tool for main agent: verifies task alignment.
 *
 * Forces explicit articulation of analysis focus and findings rather than
 * passive checklists. Per prompt engineering best practices: "articulation > checklists" -
 * writing explicit statements is more rigorous than checking boxes.
 */
export class ThinkAboutTaskTool extends BaseTool {
    name = 'think_about_task';
    description =
        'Articulate your analysis focus and findings before drawing conclusions. ' +
        'Forces you to state what you are analyzing, issues found with evidence, and areas needing more work.';

    schema = z
        .object({
            analysis_focus: z
                .string()
                .describe(
                    'What aspect of the PR are you currently focused on? (e.g., "auth changes in auth.ts", "API contract changes")'
                ),
            issues_found: z
                .array(IssueSchema)
                .describe(
                    'Issues identified so far with file location and severity'
                ),
            areas_needing_investigation: z
                .array(z.string())
                .describe(
                    'Areas that still need deeper investigation or verification'
                ),
            positive_observations: z
                .array(z.string())
                .describe('Good practices observed (balance is important)'),
            decision: TaskDecision.describe(
                'Your decision: off_track (refocus on diff), gaps_in_coverage (continue analysis), or ready_to_synthesize'
            ),
        })
        .strict();

    async execute(
        args: z.infer<typeof this.schema>,
        _context?: ExecutionContext
    ): Promise<ToolResult> {
        const {
            analysis_focus,
            issues_found,
            areas_needing_investigation,
            positive_observations,
            decision,
        } = args;

        let guidance = '## Task Alignment Reflection\n\n';

        guidance += `### Current Focus\n${analysis_focus}\n\n`;

        if (issues_found.length > 0) {
            guidance += `### Issues Found (${issues_found.length})\n`;
            for (const issue of issues_found) {
                const emoji =
                    issue.severity === 'critical'
                        ? '🔴'
                        : issue.severity === 'high'
                          ? '🟠'
                          : issue.severity === 'medium'
                            ? '🟡'
                            : '🟢';
                guidance += `- ${emoji} **${issue.severity.toUpperCase()}** in \`${issue.file}\`: ${issue.description}\n`;
            }
            guidance += '\n';
        } else {
            guidance += '### Issues Found\nNone identified yet.\n\n';
        }

        if (positive_observations.length > 0) {
            guidance += `### Positive Observations\n`;
            guidance += positive_observations.map((p) => `- ✓ ${p}`).join('\n');
            guidance += '\n\n';
        }

        if (areas_needing_investigation.length > 0) {
            guidance += `### Areas Needing Investigation\n`;
            guidance += areas_needing_investigation
                .map((a) => `- ${a}`)
                .join('\n');
            guidance += '\n\n';
        }

        guidance += `### Decision: ${decision.replace(/_/g, ' ').toUpperCase()}\n\n`;

        // Provide guidance based on decision
        switch (decision) {
            case 'off_track':
                guidance += '**Action**: Refocus on the actual diff changes.\n';
                guidance +=
                    '- Step back from implementation details of unchanged code\n';
                guidance += '- Center analysis on what THIS PR modifies\n';
                break;
            case 'gaps_in_coverage':
                guidance += `**Action**: Continue analysis for the ${areas_needing_investigation.length} uncovered area(s).\n`;
                guidance += '- Update your plan with new items if needed\n';
                guidance += '- Consider spawning subagents for complex areas\n';
                break;
            case 'ready_to_synthesize':
                guidance += '**Action**: Proceed to final synthesis.\n';
                guidance +=
                    '- Call `think_about_completion` before final response\n';
                guidance += '- Ensure all plan items are marked complete\n';
                break;
        }

        return toolSuccess(guidance);
    }
}
