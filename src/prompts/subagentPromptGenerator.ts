import type { SubagentTask } from '../types/modelTypes';
import type { ITool } from '../tools/ITool';

/**
 * Generates focused system prompts for subagent investigations.
 * Single responsibility: prompt construction for isolated investigation tasks.
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
            ? `## Context from Parent Analysis\n${task.context}`
            : '';

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

4. **Be Efficient**: You have a limited tool call budget (${maxIterations} iterations). Prioritize the most impactful investigations.

5. **Return Clear Results**: When done, provide:
   - What you found (with file paths, line numbers, code snippets)
   - Why it matters (implications, risks, suggestions)
   - A brief summary for quick understanding

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
