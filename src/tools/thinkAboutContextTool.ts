import * as z from 'zod';
import { BaseTool } from './baseTool';
import { ToolResult, toolSuccess } from '../types/toolResultTypes';
import { ExecutionContext } from '../types/executionContext';

const ContextDecision = z.enum([
    'need_more_context',
    'need_subagent',
    'context_sufficient',
]);

/**
 * Self-reflection tool for main agent: evaluates gathered context.
 *
 * Forces explicit articulation of findings rather than passive checklists.
 * Per prompt engineering best practices: "articulation > checklists" -
 * writing explicit statements is more rigorous than checking boxes.
 */
export class ThinkAboutContextTool extends BaseTool {
    name = 'think_about_context';
    description =
        'Articulate your current understanding after gathering context. ' +
        'Forces you to explicitly state what you examined, what you found, and what gaps remain.';

    schema = z
        .object({
            files_examined: z
                .array(z.string())
                .min(1)
                .describe(
                    'List of files or symbols you have investigated so far'
                ),
            key_findings: z
                .array(z.string())
                .describe(
                    'Key observations from your investigation (can be empty if none yet)'
                ),
            remaining_gaps: z
                .array(z.string())
                .describe(
                    'Specific unknowns or areas that still need investigation'
                ),
            decision: ContextDecision.describe(
                'Your decision: need_more_context (use tools), need_subagent (spawn investigation), or context_sufficient (proceed)'
            ),
        })
        .strict();

    async execute(
        args: z.infer<typeof this.schema>,
        _context?: ExecutionContext
    ): Promise<ToolResult> {
        const { files_examined, key_findings, remaining_gaps, decision } = args;

        // Defensive: ensure arrays even if model sends strings
        const filesArr = Array.isArray(files_examined)
            ? files_examined
            : [files_examined].filter(Boolean);
        const findingsArr = Array.isArray(key_findings)
            ? key_findings
            : [key_findings].filter(Boolean);
        const gapsArr = Array.isArray(remaining_gaps)
            ? remaining_gaps
            : [remaining_gaps].filter(Boolean);

        const hasGaps = gapsArr.length > 0;
        const hasFindings = findingsArr.length > 0;

        let guidance = '## Context Reflection\n\n';

        guidance += `### Files/Symbols Examined (${filesArr.length})\n`;
        guidance += filesArr.map((f) => `- ${f}`).join('\n');
        guidance += '\n\n';

        if (hasFindings) {
            guidance += `### Key Findings (${findingsArr.length})\n`;
            guidance += findingsArr.map((f) => `- ${f}`).join('\n');
            guidance += '\n\n';
        }

        if (hasGaps) {
            guidance += `### Remaining Gaps (${gapsArr.length})\n`;
            guidance += gapsArr.map((g) => `- ${g}`).join('\n');
            guidance += '\n\n';
        }

        guidance += `### Decision: ${decision.replace(/_/g, ' ').toUpperCase()}\n\n`;

        // Provide guidance based on decision
        switch (decision) {
            case 'need_more_context':
                guidance += `**Next Steps**: Use tools to fill the ${gapsArr.length} identified gap(s).\n`;
                guidance += '- `find_symbol` for unfamiliar functions\n';
                guidance += '- `find_usages` for changed signatures\n';
                guidance += '- `read_file` for specific file sections\n';
                break;
            case 'need_subagent':
                guidance += `**Next Steps**: Spawn a subagent for deep investigation.\n`;
                guidance += '- Provide specific code context from the diff\n';
                guidance +=
                    '- Ask CURRENT-STATE questions (subagent cannot see diff)\n';
                guidance +=
                    '- Consider: security analysis, dependency tracing, or pattern analysis\n';
                break;
            case 'context_sufficient':
                guidance += `**Next Steps**: Proceed to analysis and synthesis.\n`;
                guidance +=
                    '- Consider calling `think_about_task` before conclusions\n';
                break;
        }

        return toolSuccess(guidance);
    }
}
