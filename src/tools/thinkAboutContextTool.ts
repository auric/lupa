import * as z from 'zod';
import * as vscode from 'vscode';
import { BaseTool } from './baseTool';
import { ToolResult, toolSuccess } from '../types/toolResultTypes';
import { ExecutionContext } from '../types/executionContext';
import {
    flexibleStringArray,
    flexibleStringArrayNonEmpty,
} from './schemaHelpers';

const ContextDecision = z.enum([
    'need_more_context',
    'need_subagent',
    'context_sufficient',
]);

/**
 * Self-reflection tool for evaluating gathered context.
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
            files_examined: flexibleStringArrayNonEmpty.describe(
                'List of files or symbols you have investigated so far'
            ),
            key_findings: flexibleStringArray.describe(
                'Key observations from your investigation (can be empty if none yet)'
            ),
            remaining_gaps: flexibleStringArray.describe(
                'Specific unknowns or areas that still need investigation'
            ),
            decision: ContextDecision.describe(
                'Your decision: need_more_context (use tools), need_subagent (spawn investigation), or context_sufficient (proceed)'
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

        const { files_examined, key_findings, remaining_gaps, decision } = args;

        const hasGaps = remaining_gaps.length > 0;
        const hasFindings = key_findings.length > 0;

        let guidance = '## Context Reflection\n\n';

        guidance += `### Files/Symbols Examined (${files_examined.length})\n`;
        guidance += files_examined.map((f) => `- ${f}`).join('\n');
        guidance += '\n\n';

        if (hasFindings) {
            guidance += `### Key Findings (${key_findings.length})\n`;
            guidance += key_findings.map((f) => `- ${f}`).join('\n');
            guidance += '\n\n';
        }

        if (hasGaps) {
            guidance += `### Remaining Gaps (${remaining_gaps.length})\n`;
            guidance += remaining_gaps.map((g) => `- ${g}`).join('\n');
            guidance += '\n\n';
        }

        guidance += `### Decision: ${decision.replace(/_/g, ' ').toUpperCase()}\n\n`;

        // Provide guidance based on decision
        switch (decision) {
            case 'need_more_context':
                guidance += `**Next Steps**: Use tools to fill the ${remaining_gaps.length} identified gap(s).\n`;
                guidance += '- `find_symbol` for unfamiliar functions\n';
                guidance += '- `find_usages` for changed signatures\n';
                guidance += '- `read_file` for specific file sections\n';
                break;
            case 'need_subagent':
                guidance += `**Next Steps**: Spawn a subagent for deep investigation.\n`;
                guidance +=
                    '- Specify which files the subagent should examine\n';
                if (context.parsedDiff) {
                    guidance +=
                        '- Sub-agents have `get_file_diff` and code exploration tools\n';
                } else {
                    guidance +=
                        '- Sub-agents have code exploration tools (`read_file`, `find_symbol`, `find_usages`)\n';
                }
                guidance += '- Ask focused questions about specific concerns\n';
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
