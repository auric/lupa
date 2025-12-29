import { DiffHunk } from '../types/contextTypes';
import { ToolAwareSystemPromptGenerator } from '../prompts/toolAwareSystemPromptGenerator';
import { ITool } from '../tools/ITool';

/**
 * Centralized prompt generation service following Anthropic best practices
 * - Focused system prompt for role definition only
 * - Task instructions in user messages
 * - Proper XML structure with underscores
 * - Optimized for long context (query at end)
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
     * Generate tool-calling focused user prompt
     * Optimized for tool-calling workflow with diff content
     * @param parsedDiff Parsed diff structure
     * @param userInstructions Optional user-provided instructions to focus the analysis
     * @returns User prompt optimized for tool-calling analysis
     */
    public generateToolCallingUserPrompt(
        parsedDiff: DiffHunk[],
        userInstructions?: string
    ): string {
        // 1. File content at top for long context optimization
        const fileContentSection = this.generateFileContentSection(parsedDiff);

        // 2. User-provided focus instructions (if any)
        const userFocusSection = userInstructions?.trim()
            ? `<user_focus>\nThe developer has requested you focus on: ${userInstructions.trim()}\n\nWhile performing comprehensive analysis, prioritize findings related to this request.\n</user_focus>\n\n`
            : '';

        // 3. Concise analysis reminder (main instructions are in system prompt)
        const analysisReminder = this.generateAnalysisReminder(
            parsedDiff.length
        );

        return `${fileContentSection}${userFocusSection}${analysisReminder}`;
    }

    /**
     * Generate file content section with proper structure
     */
    private generateFileContentSection(parsedDiff: DiffHunk[]): string {
        let fileContentXml = '<files_to_review>\n';

        for (const fileDiff of parsedDiff) {
            fileContentXml += `<file>\n<path>${fileDiff.filePath}</path>\n<changes>\n`;

            for (const hunk of fileDiff.hunks) {
                // Use the stored hunk header instead of regex matching
                fileContentXml += `${hunk.hunkHeader}\n`;

                // Reconstruct diff lines from parsed data
                const diffLines = hunk.parsedLines.map((parsedLine) => {
                    const prefix =
                        parsedLine.type === 'added'
                            ? '+'
                            : parsedLine.type === 'removed'
                              ? '-'
                              : ' ';
                    return prefix + parsedLine.content;
                });

                fileContentXml += diffLines.join('\n') + '\n\n';
            }

            fileContentXml += '</changes>\n</file>\n\n';
        }

        fileContentXml += '</files_to_review>\n\n';
        return fileContentXml;
    }

    /**
     * Generate a concise analysis reminder based on PR size.
     * Full methodology is in system prompt - this just provides context-specific nudges.
     */
    private generateAnalysisReminder(fileCount: number): string {
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

    public dispose(): void {
        // No resources to dispose in this service
    }
}
