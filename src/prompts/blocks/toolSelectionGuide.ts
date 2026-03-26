/**
 * Tool selection guides for different analysis modes.
 * Provides a quick reference table and usage principles.
 */

/**
 * Tool selection guide for PR review mode.
 * Includes guidance for all tools including subagent and plan.
 */
export function generateToolSelectionGuide(): string {
    return `<tool_selection_guide>
## Tool Selection

| Need | Tool |
|------|------|
| Understand function/class | \`find_symbol\` |
| Find all callers | \`find_usages\` |
| Search patterns | \`search_for_pattern\` |
| File structure | \`get_symbols_overview\` |
| Find files | \`find_files_by_pattern\` |
| Read config/docs | \`read_file\` |
| PR intent/commits | \`get_pr_context\` |
| Track progress | \`update_plan\` |
| Think through analysis | \`think\` |
| Record confirmed issue | \`record_finding\` |
| Verify factual claim | \`validate_claim\` |
| Deep investigation | \`run_subagent_batch\` |
| Parallel tool calls | \`batch_tools\` |

### Principles

1. **Orient then plan**: Read at least one diff with \`get_file_diff\` before calling \`update_plan\` — plans must be based on code, not just file names
2. **Verify before claiming**: Use tools to confirm behavior, don't assume
3. **Symbols over text**: Use \`find_symbol\` for code, \`read_file\` for configs only
4. **Parallelize**: Call independent tools in one turn. If you can only call one tool per turn, use \`batch_tools\` to wrap multiple independent calls into a single parallel invocation
5. **Scope searches**: Provide \`relative_path\` when you know the area
6. **Track progress**: Update your plan as you complete checklist items
7. **Delegate complexity**: Spawn subagent for 4+ file investigations
8. **Validate critical claims**: Use \`validate_claim\` for factual claims about symbols before reporting

### Anti-Patterns

- ❌ Deep investigation (reading files, finding symbols) without first creating a plan with \`update_plan\`
- ❌ Reading files when you only need one function (use \`find_symbol\`)
- ❌ Sequential tool calls that could be parallel — use \`batch_tools\` if needed
- ❌ Claims without tool verification
- ❌ Deep investigation of unchanged code
</tool_selection_guide>`;
}

/**
 * Tool selection guide for exploration mode.
 * Excludes subagent and plan tools (not applicable for Q&A).
 */
export function generateExplorationToolGuide(): string {
    return `<tool_selection_guide>
## Tool Selection

| Need | Tool |
|------|------|
| Understand function/class | \`find_symbol\` |
| Find all callers | \`find_usages\` |
| Search patterns | \`search_for_pattern\` |
| File structure | \`get_symbols_overview\` |
| Find files | \`find_files_by_pattern\` |
| Read config/docs | \`read_file\` |
| Deep investigation | \`run_subagent_batch\` |
| Parallel tool calls | \`batch_tools\` |

### Principles

1. **Verify before answering**: Confirm with tools, don't assume
2. **Symbols over text**: Use \`find_symbol\` for code entities
3. **Parallelize**: Call independent tools together. Use \`batch_tools\` to wrap multiple calls into one parallel invocation if needed
4. **Build incrementally**: Start with overview, then drill down
5. **Delegate complexity**: Use \`run_subagent_batch\` for multi-module questions

### Anti-Patterns

- ❌ Reading entire files for one function
- ❌ Guessing when you can investigate
- ❌ Vague answers when more tools could help
</tool_selection_guide>`;
}
