import { DiffHunk } from '../types/contextTypes';
import type { CodeIntelligenceBrief } from '../types/enrichedDiffTypes';
import { ToolAwareSystemPromptGenerator } from '../prompts/toolAwareSystemPromptGenerator';
import { RecursionConstants } from '../sessions/recursiveStateManager';
import type { ModelCalibrationProfile } from '../models/modelCalibration';

/**
 * Centralized prompt generation service.
 * Generates system and user prompts for PR analysis with diff-on-demand via tools.
 */
export class PromptGenerator {
    private toolAwarePromptGenerator = new ToolAwareSystemPromptGenerator();

    /**
     * Generate tool-aware system prompt with dynamic tool discovery.
     * Tool descriptions are provided to the LLM via the VS Code API tool schemas,
     * so the system prompt focuses on methodology and behavioral guidance.
     */
    public generateToolAwareSystemPrompt(
        calibration: ModelCalibrationProfile
    ): string {
        return this.toolAwarePromptGenerator.generateSystemPrompt(calibration);
    }

    /**
     * Generate recursive review system prompt for the root controller agent.
     * Uses decompose → delegate → aggregate → synthesize methodology.
     */
    public generateRecursiveSystemPrompt(
        calibration: ModelCalibrationProfile
    ): string {
        return this.toolAwarePromptGenerator.generateRecursiveSystemPrompt(
            calibration
        );
    }

    /**
     * Generate exploration-focused system prompt for answering codebase questions.
     * Uses the same tool infrastructure but without PR/diff-specific language.
     */
    public generateExplorationSystemPrompt(): string {
        return this.toolAwarePromptGenerator.generateExplorationPrompt();
    }

    /**
     * Generate user prompt with diff metadata only.
     * The LLM uses get_file_diff tool to access diff on demand.
     * @param parsedDiff Parsed diff structure (for metadata extraction)
     * @param userInstructions Optional user-provided instructions
     * @param recursiveMode Whether to use recursive review workflow
     * @param maxSubagents Maximum subagents the root can spawn
     * @returns User prompt with diff metadata and tool usage instructions
     */
    public generateUserPrompt(
        parsedDiff: DiffHunk[],
        userInstructions?: string,
        recursiveMode: boolean = false,
        maxSubagents?: number,
        codeIntelBrief?: CodeIntelligenceBrief
    ): string {
        const metadataSection = this.generateDiffMetadataSection(parsedDiff);
        const briefSection =
            codeIntelBrief && codeIntelBrief.enrichedSymbols.length > 0
                ? this.formatCodeIntelligenceBrief(codeIntelBrief)
                : '';
        const sanitizedInstructions = userInstructions
            ?.trim()
            .replace(/[<>]/g, '');
        const userFocusSection = sanitizedInstructions
            ? `<user_focus>\nThe developer has requested you focus on: ${sanitizedInstructions}\n\nWhile performing comprehensive analysis, prioritize findings related to this request.\n</user_focus>\n\n`
            : '';
        const reminder = this.generateRlmAnalysisReminder(
            parsedDiff.length,
            recursiveMode,
            maxSubagents
        );

        return `${metadataSection}${briefSection}${userFocusSection}${reminder}`;
    }

    /**
     * Generate diff metadata section.
     * Provides a high-level summary instead of full diff content.
     */
    private generateDiffMetadataSection(parsedDiff: DiffHunk[]): string {
        let totalAdded = 0;
        let totalRemoved = 0;
        const fileSummaries: string[] = [];

        for (const file of parsedDiff) {
            let added = 0;
            let removed = 0;
            for (const hunk of file.hunks) {
                for (const line of hunk.parsedLines) {
                    if (line.type === 'added') {
                        added++;
                    }
                    if (line.type === 'removed') {
                        removed++;
                    }
                }
            }
            totalAdded += added;
            totalRemoved += removed;

            const status = file.isNewFile
                ? 'new'
                : file.isDeletedFile
                  ? 'deleted'
                  : 'modified';
            const sanitizedPath = file.filePath.replace(/[<>]/g, '');
            fileSummaries.push(
                `  - ${sanitizedPath} [${status}] (+${added} -${removed})`
            );
        }

        let section = '<diff_metadata>\n';
        section += `Files changed: ${parsedDiff.length}\n`;
        section += `Total lines: +${totalAdded} -${totalRemoved}\n`;
        section += `\nChanged files:\n${fileSummaries.join('\n')}\n`;
        section += '\nUse `get_file_diff` to examine specific file changes.\n';
        section += '</diff_metadata>\n\n';

        return section;
    }

    private formatCodeIntelligenceBrief(brief: CodeIntelligenceBrief): string {
        let section = '<code_intelligence_brief>\n';
        section +=
            'LSP-verified metadata for symbols in changed regions. Use this to prioritize investigation.\n\n';

        for (const sym of brief.enrichedSymbols) {
            const exported = sym.isExported ? 'exported' : 'internal';
            const safeName = sym.name
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
            const type = (sym.typeSignature ?? 'unknown type')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
            section += `- ${sym.file}:${sym.line} \`${safeName}\` (${sym.kind}, ${exported})\n`;
            section += `  Type: ${type}\n`;
            section += `  Refs: ${sym.totalReferences} total, ${sym.externalCallers} external, ${sym.testFileReferences} in tests\n`;
        }

        if (brief.timeoutCount > 0) {
            section += `\nNote: ${brief.timeoutCount} symbol(s) could not be enriched (LSP timeout).\n`;
        }

        section += '</code_intelligence_brief>\n\n';
        return section;
    }

    /**
     * Generate analysis reminder for RLM approach.
     */
    private generateRlmAnalysisReminder(
        fileCount: number,
        recursiveMode: boolean,
        maxSubagents?: number
    ): string {
        if (recursiveMode) {
            return this.generateRecursiveRlmReminder(fileCount, maxSubagents);
        }

        const spawnSubagents = fileCount >= 4;

        let reminder = '<analysis_task>\n';
        reminder += `Review the ${fileCount} changed file(s) in this PR.\n\n`;
        reminder += `**Important**: The diff is NOT embedded in this message. Use \`get_file_diff\` to access it on demand.\n\n`;

        if (spawnSubagents) {
            reminder += `**Note**: This PR has ${fileCount} files. Consider spawning subagents for parallel analysis.\n\n`;
        }

        reminder += `**Workflow**:\n`;
        reminder += `1. Review \`<diff_metadata>\` above \u2014 you already have all file names and line counts\n`;
        reminder += `2. Use \`get_file_diff\` to examine key files and understand the changes\n`;
        reminder += `3. Create a plan with \`update_plan\` based on what you've seen\n`;
        reminder += `4. Continue examining remaining files with \`get_file_diff\`\n`;
        reminder += `5. Use other tools to investigate context as needed\n`;
        reminder += `6. Call reflection tools before concluding\n`;
        reminder += `7. Deliver structured Markdown review via \`submit_review\`\n\n`;
        reminder +=
            'Quality matters more than quantity — a thorough review that finds zero issues is better than a review padded with speculative concerns.\n';
        reminder += '</analysis_task>';

        return reminder;
    }

    /**
     * Generate recursive RLM analysis reminder.
     */
    private generateRecursiveRlmReminder(
        fileCount: number,
        maxSubagents?: number
    ): string {
        // The real constraint is the total number of subagent spawns.
        const agentLimit = maxSubagents;

        let reminder = '<analysis_task>\n';
        reminder += `Review the ${fileCount} changed file(s) in this PR.\n\n`;
        reminder +=
            'The `<diff_metadata>` above shows all changed files with line counts. ' +
            'Sub-agents have `get_file_diff` \u2014 they will read diffs themselves.\n\n';

        if (agentLimit !== undefined && agentLimit > 0) {
            reminder +=
                `**Agent Budget**: You can spawn up to **${agentLimit}** sub-agents total across all depths. ` +
                `Each sub-agent gets its own **${RecursionConstants.DEFAULT_CHILD_BUDGET}** iteration budget (independent of yours). ` +
                'Target **2\u20134 files per sub-agent** for thorough review.\n\n';
        } else if (agentLimit !== undefined) {
            reminder +=
                '**Agent Budget**: All sub-agent slots have been used. ' +
                'Complete the review yourself using `get_file_diff` to read remaining files directly.\n\n';
        }

        reminder += '**Workflow**:\n';
        reminder +=
            '1. Review `<diff_metadata>` above \u2014 you already have all file names and line counts\n';
        reminder +=
            '2. Call `get_file_diff` on **1 key file** (largest change or riskiest) to understand the PR\n';
        reminder += '3. Call `update_plan` — decompose into concern groups\n';
        reminder +=
            '4. **Make multiple `run_subagent` calls in one response** — one per concern group (parallel execution)\n';
        reminder +=
            '5. After agents return, call `update_plan` to record findings and coverage status\n';
        reminder +=
            '6. If coverage gaps reported, group uncovered files and delegate via additional `run_subagent` calls\n';
        reminder += '7. Aggregate findings, check for cross-concern issues\n';
        reminder +=
            '8. Call `think_about_completion`, then `submit_review`\n\n';

        reminder +=
            '⚠️ **Delegation is mandatory** — Read at most 1 diff for orientation, then delegate everything via `run_subagent`. ' +
            'Do NOT read additional diffs or investigate files yourself. ' +
            'Sub-agents read diffs on demand via `get_file_diff` and return findings to you.\n\n';
        reminder +=
            '⚠️ **Total file coverage required** — Every changed file must be reviewed. ' +
            'If you receive a coverage gap report after sub-agents complete, group uncovered files and delegate them via additional `run_subagent` calls.\n\n';
        reminder +=
            'Quality matters more than quantity — a thorough review that finds zero issues is better than a review padded with speculative concerns.\n';
        reminder += '</analysis_task>';

        return reminder;
    }

    public dispose(): void {
        // No resources to dispose in this service
    }
}
