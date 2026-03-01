import { DiffHunk } from '../types/contextTypes';
import { ToolAwareSystemPromptGenerator } from '../prompts/toolAwareSystemPromptGenerator';
import { RecursionConstants } from '../sessions/recursiveStateManager';
import { ITool } from '../tools/ITool';

/**
 * Centralized prompt generation service.
 * Generates system and user prompts for PR analysis with diff-on-demand via tools.
 */
export class PromptGenerator {
    private toolAwarePromptGenerator = new ToolAwareSystemPromptGenerator();

    /**
     * Generate tool-aware system prompt with dynamic tool discovery
     * @param availableTools Array of tools available to the LLM
     * @returns Complete system prompt with comprehensive tool guidance
     */
    public generateToolAwareSystemPrompt(availableTools: ITool[]): string {
        return this.toolAwarePromptGenerator.generateSystemPrompt(
            availableTools
        );
    }

    /**
     * Generate recursive review system prompt for the root controller agent.
     * Uses decompose → delegate → aggregate → synthesize methodology.
     * @param availableTools Array of tools available to the LLM
     * @returns System prompt for recursive root auditor
     */
    public generateRecursiveSystemPrompt(availableTools: ITool[]): string {
        return this.toolAwarePromptGenerator.generateRecursiveSystemPrompt(
            availableTools
        );
    }

    /**
     * Generate exploration-focused system prompt for answering codebase questions.
     * Uses the same tool infrastructure but without PR/diff-specific language.
     * @param availableTools Array of tools available to the LLM
     * @returns Complete system prompt for exploration mode
     */
    public generateExplorationSystemPrompt(availableTools: ITool[]): string {
        return this.toolAwarePromptGenerator.generateExplorationPrompt(
            availableTools
        );
    }

    /**
     * Generate user prompt with diff metadata only.
     * The LLM uses list_changed_files and get_file_diff tools to access diff on demand.
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
        maxSubagents?: number
    ): string {
        const metadataSection = this.generateDiffMetadataSection(parsedDiff);
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

        return `${metadataSection}${userFocusSection}${reminder}`;
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
        section +=
            '\nUse `list_changed_files` for detailed statistics and `get_file_diff` to examine specific file changes.\n';
        section += '</diff_metadata>\n\n';

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
        reminder += `**Important**: The diff is NOT embedded in this message. Use these tools to access it:\n`;
        reminder += `1. \`list_changed_files\` — See all changed files with statistics\n`;
        reminder += `2. \`get_file_diff\` — Read the actual diff for specific file(s)\n\n`;

        if (spawnSubagents) {
            reminder += `**Note**: This PR has ${fileCount} files. Consider spawning subagents for parallel analysis.\n\n`;
        }

        reminder += `**Workflow**:\n`;
        reminder += `1. Call \`list_changed_files\` to understand the scope\n`;
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
            '1. Call `list_changed_files` for a structured view of all changes\n';
        reminder +=
            '2. Call `get_file_diff` on **1 key file** (largest change or riskiest) to understand the PR\n';
        reminder += '3. Call `update_plan` — decompose into concern groups\n';
        reminder +=
            '4. **Make multiple `run_subagent` calls in one response** — one per concern group (parallel execution)\n';
        reminder +=
            '5. After agents return, call `update_plan` to record findings and coverage status\n';
        reminder +=
            '6. If coverage gaps reported, spawn additional sub-agents for uncovered files\n';
        reminder += '7. Aggregate findings, check for cross-concern issues\n';
        reminder +=
            '8. Call `think_about_completion`, then `submit_review`\n\n';

        reminder +=
            '⚠️ **Delegation is mandatory** — Read at most 1 diff for orientation, then delegate everything via `run_subagent`. ' +
            'Do NOT read additional diffs or investigate files yourself. ' +
            'Sub-agents read diffs on demand via `get_file_diff` and return findings to you.\n\n';
        reminder +=
            '⚠️ **Total file coverage required** — Every changed file must be assigned to exactly one sub-agent. ' +
            'If you receive a coverage gap report after sub-agents complete, spawn additional sub-agents for the uncovered files.\n\n';
        reminder +=
            'Quality matters more than quantity — a thorough review that finds zero issues is better than a review padded with speculative concerns.\n';
        reminder += '</analysis_task>';

        return reminder;
    }

    /**
     * Generate a concise analysis reminder based on PR size and mode.
     * Full methodology is in system prompt - this just provides context-specific nudges.
     */
    private generateAnalysisReminder(
        fileCount: number,
        recursiveMode: boolean = false
    ): string {
        if (recursiveMode) {
            return this.generateRecursiveAnalysisReminder(fileCount);
        }

        const spawnSubagents = fileCount >= 4;

        let reminder = '<analysis_task>\n';
        reminder += `Review the ${fileCount} file(s) above.\n\n`;

        if (spawnSubagents) {
            reminder += `**Note**: This PR has ${fileCount} files. Per your methodology, spawn at least 2 subagents for parallel analysis.\n\n`;
        }

        reminder += `**Workflow Reminder**:
1. Create a plan with \`update_plan\` to track progress
2. Use tools to investigate unfamiliar code
3. Call reflection tools before concluding
4. Deliver structured Markdown review
</analysis_task>`;

        return reminder;
    }

    /**
     * Generate analysis reminder for recursive review mode.
     * Emphasizes decomposition and delegation workflow.
     */
    private generateRecursiveAnalysisReminder(fileCount: number): string {
        let reminder = '<analysis_task>\n';
        reminder += `Review the ${fileCount} file(s) above.\n\n`;

        reminder += `**Recursive Review Mode**: You MUST decompose this PR into logical concern groups and spawn focused sub-agents for each via \`run_subagent\`. Do NOT review files directly — delegate.\n\n`;

        reminder += `**Workflow**:
1. Scan the diff structure and classify changes
2. Call \`update_plan\` with your decomposition plan
3. **Make multiple \`run_subagent\` calls in one response** — one per concern group (parallel execution)
4. After all agents return, aggregate findings
5. Check for cross-concern issues
6. Call \`think_about_completion\`, then \`submit_review\`
</analysis_task>`;

        return reminder;
    }

    public dispose(): void {
        // No resources to dispose in this service
    }
}
