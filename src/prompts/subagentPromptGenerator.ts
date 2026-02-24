import type { SubagentTask } from '../types/modelTypes';
import type { ITool } from '../tools/ITool';
import { RecursionConstants } from '../sessions/recursiveStateManager';

/**
 * Generates focused system prompts for subagent investigations.
 *
 * Subagents are lightweight investigation agents that:
 * - Access PR diff on demand via list_changed_files/get_file_diff tools (RLM mode)
 * - Have limited tool iterations
 * - Focus on a single, specific investigation task
 * - Return structured findings for the parent agent to synthesize
 * - May spawn their own sub-agents when in recursive mode (canRecurse=true)
 */
export class SubagentPromptGenerator {
    /**
     * Generate a system prompt for a subagent investigation.
     * @param task The investigation task definition
     * @param tools Available tools (run_subagent will be filtered out by executor unless recursive)
     * @param maxIterations Maximum conversation iterations for this subagent
     * @param canRecurse Whether this agent can spawn its own sub-agents
     * @returns Complete system prompt for the subagent
     */
    generateSystemPrompt(
        task: SubagentTask,
        tools: ITool[],
        maxIterations: number,
        canRecurse: boolean = false
    ): string {
        const toolList = this.formatToolList(tools);
        const hasDiffTools = tools.some((t) => t.name === 'list_changed_files');
        const contextSection = task.context
            ? `<context_from_parent>
## Context from Parent Agent

The parent agent has provided the following code/information relevant to your investigation:

${task.context}
</context_from_parent>`
            : '';

        const diffAccessSection = hasDiffTools
            ? `
### Diff Access

You have direct access to the PR diff via tools:
- \`get_file_diff\` — Read the actual diff for specific file(s)
- \`list_changed_files\` — See all changed files (only if you need broader context)`
            : '';

        // When canRecurse, the investigation approach defers to decomposition for large scopes
        const investigationSteps =
            canRecurse && hasDiffTools
                ? `
1. **Check your scope**: Count the files in your task.
   - **1-3 files**: Call \`get_file_diff\` for ALL of them, then investigate directly.
   - **4+ files**: Follow the **Decomposition Strategy** below — read 1-2 key diffs to orient, then spawn sub-agents for the rest.

2. **Gather Evidence**: Use \`find_symbol\` with \`include_body: true\` to get complete implementations of relevant functions/classes.

3. **Trace Dependencies**: Use \`find_usages\` if you need to understand who calls a function or how it's used.

4. **Search Patterns**: Use \`search_for_pattern\` to find codebase-wide occurrences of concerning patterns.

**Do NOT call \`list_directory\` or \`list_changed_files\` first** — your task already tells you which files to examine.`
                : hasDiffTools
                  ? `
1. **Read the Diff FIRST**: Call \`get_file_diff\` immediately for the files listed in your task. This is your primary input — do this before anything else.

2. **Gather Evidence**: Use \`find_symbol\` with \`include_body: true\` to get complete implementations of relevant functions/classes.

3. **Trace Dependencies**: Use \`find_usages\` if you need to understand who calls a function or how it's used.

4. **Search Patterns**: Use \`search_for_pattern\` to find codebase-wide occurrences of concerning patterns.

5. **Self-Reflect**: Use \`think_about_investigation\` to evaluate your progress midway through.

**Do NOT call \`list_directory\` or \`list_changed_files\` first** — your task already tells you which files to examine.`
                  : `
1. **Review Parent Context**: Study the code and information the parent agent provided in context above — this is your primary input.

2. **Gather Evidence**: Use \`find_symbol\` with \`include_body: true\` to get complete implementations of relevant functions/classes.

3. **Trace Dependencies**: Use \`find_usages\` if you need to understand who calls a function or how it's used.

4. **Search Patterns**: Use \`search_for_pattern\` to find codebase-wide occurrences of concerning patterns.

5. **Self-Reflect**: Use \`think_about_investigation\` to evaluate your progress midway through.`;

        const recursionSection = canRecurse
            ? `
### Decomposition Strategy (You CAN Spawn Sub-Agents)

You have \`run_subagent\` available and **${maxIterations} iterations** for your own work.

**RULE: If your task spans 4+ files, DECOMPOSE before investigating.**
Do NOT try to review 4+ files directly — you'll exhaust your iterations and produce incomplete findings.

**Decomposition approach:**
1. Call \`get_file_diff\` for 1-2 key files to orient yourself (~2 iterations)
2. Based on the diff, split your remaining files into focused sub-tasks
3. Spawn sub-agents for each group — each gets its own **${RecursionConstants.DEFAULT_CHILD_BUDGET}** iteration budget (independent of yours)
4. Aggregate their findings into your response

**If your task spans 1-3 files:** Investigate directly — no need to spawn.

**Task format for sub-agents:**
\`\`\`
task: "Investigate [specific concern] in [files/functions].
Questions:
1. [Specific question]
2. [Specific question]
Examine: [function1], [function2]"

context: "[What you found so far and why this needs deeper investigation]"
\`\`\`

**Budget:** Your sub-agents each get their own **${RecursionConstants.DEFAULT_CHILD_BUDGET}** iterations (not deducted from your budget). After they return, you still have your remaining iterations to aggregate results and write findings.`
            : `
### Recursion Limit

You are at maximum recursion depth—you **cannot** spawn sub-agents.
Complete your investigation within your iteration budget.
Note any uninvestigated areas in your response so the parent agent can follow up.`;

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
${diffAccessSection}
${investigationSteps}
${recursionSection}
</investigation_approach>

<response_requirements>
## Response Requirements

Your response MUST include:

### Findings
For each issue discovered, provide:
- **Location**: [file/path.ts:lineNumber](file/path.ts:lineNumber)
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

**Scope Limits:**
- Answer ONLY the specific questions in your task - don't expand investigation
- Focus on the files/functions mentioned - don't wander into unrelated areas
- If you discover unrelated issues, note briefly but don't deep-dive

**Technical Limits:**
- You have **${maxIterations} tool iterations** - use them wisely
- **Parallelize**: If you intend to call multiple tools and there are no dependencies between calls, make ALL independent calls in the same turn
${hasDiffTools ? '- Use `list_changed_files` and `get_file_diff` to access the PR diff on demand' : '- You CANNOT see the PR diff - only what the parent provided in context'}
- You CANNOT execute code or run tests

**Self-Reflection:**
- Use \`think_about_investigation\` to check if you're staying focused
- Return partial findings if running low on iterations - partial evidence is valuable
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
            .map((tool) => {
                // Get first line of description for conciseness
                const shortDesc = tool.description.split('\n')[0];
                return `- **${tool.name}**: ${shortDesc}`;
            })
            .join('\n');
    }
}
