import type { SubagentTask } from '../types/modelTypes';
import type { ITool } from '../tools/ITool';
import { SubagentLimits } from '../models/toolConstants';

/**
 * Generates focused system prompts for subagent investigations.
 * Single responsibility: prompt construction for isolated investigation tasks.
 */
export class SubagentPromptGenerator {
    /**
     * Generate a system prompt for a subagent investigation.
     * @param task The investigation task definition
     * @param tools Available tools (run_subagent will be filtered out by executor)
     * @returns Complete system prompt for the subagent
     */
    generateSystemPrompt(task: SubagentTask, tools: ITool[]): string {
        const toolList = this.formatToolList(tools);
        const contextSection = task.context
            ? `## Context from Parent Analysis\n${task.context}`
            : '## Context from Parent Analysis\nNo additional context provided.';

        return `You are a focused investigation subagent. Your job is to thoroughly investigate a specific question and return actionable findings.

## Your Task
${task.task}

${contextSection}

## Available Tools
${toolList}

## Instructions

1. **Parse the Task**: Identify what needs to be investigated and what deliverables are expected.

2. **Investigate Systematically**:
   - Start broad: Use get_symbols_overview or list_directory to orient yourself
   - Go deep: Use find_symbol and read_file to understand specific code
   - Trace impact: Use find_usages for ripple effects
   - Find patterns: Use search_for_pattern for codebase-wide issues

3. **Be Proactive**: If the task is unclear, use tools to gather context that helps clarify it.

4. **Be Efficient**: You have a limited tool call budget (${task.maxToolCalls ?? SubagentLimits.DEFAULT_TOOL_CALLS} calls). Prioritize the most impactful investigations.

5. **Return Structured Results**:

<findings>
Detailed findings with evidence:
- Include file paths and line numbers
- Quote relevant code snippets
- Explain implications
</findings>

<summary>
2-3 sentence executive summary of the most important discoveries.
</summary>

<answer>
If the task posed a specific question, provide a direct answer here.
</answer>

## Important
- Focus only on the assigned task
- Return your findings when you have sufficient evidence
- If you cannot find relevant information, explain what you searched and why it wasn't found`;
    }

    /**
     * Format the list of available tools for the prompt.
     */
    private formatToolList(tools: ITool[]): string {
        if (tools.length === 0) {
            return 'No tools available.';
        }

        return tools
            .map(tool => `- **${tool.name}**: ${tool.description.split('\n')[0]}`)
            .join('\n');
    }
}
