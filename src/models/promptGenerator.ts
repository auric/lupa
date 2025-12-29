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
     * Optimized for tool-calling workflow with enhanced examples
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

        // 2. Tool usage examples
        const toolExamplesSection = this.generateToolUsageExamples();

        // 3. User-provided focus instructions (if any)
        const userFocusSection = userInstructions?.trim()
            ? `<user_focus>\nThe developer has requested you focus on: ${userInstructions.trim()}\n\nWhile performing comprehensive analysis, prioritize findings related to this request.\n</user_focus>\n\n`
            : '';

        // 4. Analysis instructions with tool guidance
        const toolInstructionsSection = this.generateToolCallingInstructions();

        return `${fileContentSection}${toolExamplesSection}${userFocusSection}${toolInstructionsSection}`;
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
     * Generate tool usage examples for multishot prompting
     * Shows the LLM how to use tools effectively during analysis
     */
    private generateToolUsageExamples(): string {
        return `<tool_usage_examples>
<example>
<scenario>Encountering unknown function in diff</scenario>
<analysis_approach>
I see a call to \`validateUserPermissions()\` in the diff but don't understand its implementation. Let me investigate:

1. Use find_symbol to get the function definition
2. Use find_usages to understand how it's used elsewhere
3. Check for potential security implications
</analysis_approach>
<tool_sequence>
find_symbol(symbolName: "validateUserPermissions", includeFullBody: true)
find_usages(symbolName: "validateUserPermissions", filePath: "src/auth/permissions.ts")
</tool_sequence>
</example>

<example>
<scenario>New file in diff with unclear context</scenario>
<analysis_approach>
I see a new file \`src/utils/encryption.ts\` but need context about the project structure:

1. Get overview of the utils directory
2. Search for similar encryption patterns
3. Find any existing crypto implementations
</analysis_approach>
<tool_sequence>
get_symbols_overview(path: "src/utils")
search_for_pattern(pattern: "crypto|encrypt|decrypt", include: "*.ts")
find_file(fileName: "*crypto*")
</tool_sequence>
</example>

<example>
<scenario>Refactoring with potential breaking changes</scenario>
<analysis_approach>
The diff shows function signature changes. I need to assess impact:

1. Find all usages of the modified function
2. Check if there are tests covering this function
3. Look for similar patterns that might need updating
</analysis_approach>
<tool_sequence>
find_usages(symbolName: "processUserData", filePath: "src/services/userService.ts")
find_file(fileName: "*test*", path: "src")
search_for_pattern(pattern: "processUserData", include: "*.test.ts")
</tool_sequence>
</example>
</tool_usage_examples>

`;
    }

    /**
     * Generate tool-calling specific instructions
     */
    private generateToolCallingInstructions(): string {
        return `<instructions>
## Tool-Powered Analysis Approach

**Step 1: Initial Context Gathering**
- Use \`get_symbols_overview\` to understand file/directory structure
- Use \`list_directory\` to explore related areas of the codebase

**Step 2: Deep Dive Investigation**
- Use \`find_symbol\` to understand any functions, classes, or variables mentioned in the diff
- Use \`find_usages\` to assess impact of changes across the codebase
- Use \`search_for_pattern\` to find similar code patterns or potential issues

**Step 3: Comprehensive Analysis**
After gathering context with tools, provide structured analysis using:

- **<thinking>**: Document your tool usage and reasoning process
- **<suggestion_security>**: Security recommendations with specific evidence
- **<suggestion_performance>**: Performance improvements with context
- **<suggestion_maintainability>**: Code quality improvements with examples
- **<suggestion_reliability>**: Error handling and robustness improvements
- **<suggestion_type_safety>**: Type system and safety improvements
- **<example_fix>**: Concrete code examples with tool-informed recommendations
- **<explanation>**: Detailed reasoning with tool findings

**Tool Usage Strategy:**
- Be proactive: If you see unfamiliar code, investigate immediately
- Be thorough: Use multiple tools to build complete understanding
- Be specific: Reference exact findings from tool results in your analysis
- Be contextual: Use tools to understand not just what changed, but why and what it affects

**Analysis Quality Requirements:**
1. Include severity assessment (Critical/High/Medium/Low)
2. Reference specific file paths and line numbers from diff
3. Provide concrete solutions with implementation details
4. Base recommendations on actual tool findings, not assumptions
5. Consider both immediate fixes and architectural improvements

Your goal is to provide the most comprehensive, accurate analysis possible by leveraging all available tools to understand the full context and implications of the changes.
</instructions>`;
    }

    public dispose(): void {
        // No resources to dispose in this service
    }
}
