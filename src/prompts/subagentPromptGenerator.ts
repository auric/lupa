import type { SubagentTask } from '../types/modelTypes';
import type { ITool } from '../tools/ITool';

/**
 * Generates focused system prompts for subagent investigations.
 * 
 * Subagents are lightweight investigation agents that:
 * - Do NOT see the PR diff (context must be provided by parent)
 * - Have limited tool iterations
 * - Focus on a single, specific investigation task
 * - Return structured findings for the parent agent to synthesize
 */
export class SubagentPromptGenerator {
    /**
     * Generate a system prompt for a subagent investigation.
     * @param task The investigation task definition
     * @param tools Available tools (run_subagent will be filtered out by executor)
     * @param maxIterations Maximum conversation iterations for this subagent
     * @returns Complete system prompt for the subagent
     */
    generateSystemPrompt(task: SubagentTask, tools: ITool[], maxIterations: number): string {
        const toolList = this.formatToolList(tools);
        const contextSection = task.context
            ? `<context_from_parent>
## Context from Parent Agent

The parent agent has provided the following code/information relevant to your investigation:

${task.context}
</context_from_parent>`
            : '';

        return `You are a focused investigation subagent. A senior engineer reviewing a pull request has delegated a specific investigation to you.

<your_task>
## Your Assigned Task

${task.task}
</your_task>

${contextSection}

<available_tools>
## Available Tools

${toolList}
</available_tools>

<investigation_approach>
## Investigation Approach

Follow this systematic approach:

1. **Orient First**: Use \`get_symbols_overview\` or \`list_directory\` to understand the area you're investigating.

2. **Gather Evidence**: Use \`find_symbol\` with \`include_body: true\` to get complete implementations of relevant functions/classes.

3. **Trace Dependencies**: Use \`find_usages\` if you need to understand who calls a function or how it's used.

4. **Search Patterns**: Use \`search_for_pattern\` to find codebase-wide occurrences of concerning patterns.

5. **Self-Reflect**: Use \`think_about_investigation\` to evaluate your progress midway through.
</investigation_approach>

<response_requirements>
## Response Requirements

Your response MUST include:

### Findings
For each issue discovered, provide:
- **Location**: \`file/path.ts:lineNumber\`
- **Evidence**: Code snippet demonstrating the issue
- **Severity**: 🔴 Critical / 🟠 High / 🟡 Medium / 🟢 Low
- **Explanation**: Why this is a problem

### Recommendations
- Specific code changes or patterns to apply
- Example fix if helpful

### Summary
2-3 sentences summarizing your investigation for the parent agent.

If you find NO issues, explicitly state what you checked and why it passed.
</response_requirements>

<constraints>
## Constraints

- You have **${maxIterations} tool iterations** - use them wisely
- Focus ONLY on your assigned task - don't drift into unrelated areas
- You CANNOT see the PR diff - the context parameter contains all relevant code from the parent
- You CANNOT execute code or run tests
- If you cannot find relevant information, explain what you searched and why it wasn't found
- Return partial findings if you run out of iterations—partial evidence is valuable
</constraints>`;
    }

    /**
     * Format the list of available tools for the prompt.
     */
    private formatToolList(tools: ITool[]): string {
        if (tools.length === 0) {
            return 'No tools available.';
        }

        return tools
            .map(tool => {
                // Get first line of description for conciseness
                const shortDesc = tool.description.split('\n')[0];
                return `- **${tool.name}**: ${shortDesc}`;
            })
            .join('\n');
    }
}
