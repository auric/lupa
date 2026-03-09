import * as z from 'zod';
import * as vscode from 'vscode';
import { BaseTool } from './baseTool';
import { ToolResult, toolSuccess } from '../types/toolResultTypes';
import { ExecutionContext } from '../types/executionContext';
import type { RecordedFinding } from '../types/findingTypes';

/**
 * Explicit completion signal for PR review analysis.
 *
 * This tool solves the problem of some models responding with planning
 * messages ("I will review X") without tool calls, which would otherwise
 * be misinterpreted as the final review.
 *
 * The ConversationRunner treats this tool specially:
 * - When called, it extracts the review content and terminates the loop
 * - The review content becomes the final output (no additional formatting)
 *
 * When a FindingStore is present, its structured findings are appended
 * as an appendix. This ensures findings survive even if the LLM's prose
 * misses some, and provides a structured data section for programmatic use.
 */
export class SubmitReviewTool extends BaseTool {
    name = 'submit_review';
    description =
        'Submit your final PR review. Call this as the FINAL step when all analysis is complete. ' +
        'BEFORE calling: for EACH finding verify (1) you can name the tool call that confirmed it, ' +
        '(2) you attempted to disprove it and the disproof failed, (3) the file is in the changed files list. ' +
        'Remove any finding that fails these checks. A review with zero findings is normal for well-written PRs.';

    /**
     * Minimum 20 chars is intentionally lower than reviewExtractionUtils' 50-char
     * threshold. When the model explicitly calls this tool, we trust its intent.
     * Extraction requires stricter validation because the model didn't call properly.
     */
    schema = z
        .object({
            review_content: z
                .string()
                .min(20)
                .describe(
                    'The complete markdown-formatted review following the output format specification. ' +
                        'Each finding must have Evidence and Disproof Attempted sections. ' +
                        'Omit empty categories. If no findings survived verification, submit an approval.'
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

        let content = args.review_content;

        // Append structured findings from FindingStore if available
        const findings = context.findingStore?.getAll();
        if (findings && findings.length > 0) {
            content += '\n\n' + this.formatFindingAppendix(findings);
        }

        return toolSuccess(content, { isCompletion: true });
    }

    private formatFindingAppendix(findings: RecordedFinding[]): string {
        const bySeverity = new Map<string, RecordedFinding[]>();
        for (const f of findings) {
            const list = bySeverity.get(f.severity) ?? [];
            list.push(f);
            bySeverity.set(f.severity, list);
        }

        let appendix =
            '---\n\n<details>\n<summary>Structured Findings (FindingStore)</summary>\n\n';
        const severityOrder = ['critical', 'high', 'medium', 'low', 'info'];

        for (const severity of severityOrder) {
            const group = bySeverity.get(severity);
            if (!group || group.length === 0) {
                continue;
            }

            appendix += `### ${severity.charAt(0).toUpperCase() + severity.slice(1)} (${group.length})\n\n`;
            for (const f of group) {
                const location = f.lineRange
                    ? `${f.file}:${f.lineRange[0]}-${f.lineRange[1]}`
                    : f.file;
                const lspTag =
                    f.lspValidation?.status === 'verified'
                        ? ' ✅ LSP-verified'
                        : f.lspValidation?.status === 'refuted'
                          ? ' ❌ LSP-refuted'
                          : '';
                appendix += `- **${f.title}** (${location})${lspTag}\n`;
                appendix += `  ${f.description}\n`;
            }
            appendix += '\n';
        }

        appendix += '</details>';
        return appendix;
    }
}
