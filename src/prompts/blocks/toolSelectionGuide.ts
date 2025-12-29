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

| Need | Tool | Key Parameters |
|------|------|----------------|
| Understand function/class | \`find_symbol\` | \`name_path\`, \`include_body: true\` |
| Find all callers | \`find_usages\` | \`symbol_name\`, \`file_path\` |
| Search patterns | \`search_for_pattern\` | \`pattern\`, \`search_path\` |
| File structure | \`get_symbols_overview\` | \`path\` |
| List directory | \`list_directory\` | \`path\` |
| Find files | \`find_files_by_pattern\` | \`pattern\` |
| Read config/docs | \`read_file\` | \`path\`, \`start_line\`, \`end_line\` |
| Track progress | \`update_plan\` | \`plan\` (markdown checklist) |
| Deep investigation | \`run_subagent\` | \`task\`, \`context\` |

### Principles

1. **Plan first**: Call \`update_plan\` before any investigation to structure your review
2. **Verify before claiming**: Use tools to confirm behavior, don't assume
3. **Symbols over text**: Use \`find_symbol\` for code, \`read_file\` for configs only
4. **Parallelize**: Call independent tools in one turn
5. **Scope searches**: Provide \`relative_path\` when you know the area
6. **Track progress**: Update your plan as you complete checklist items
7. **Delegate complexity**: Spawn subagent for 3+ file investigations

### Anti-Patterns

- ❌ Investigating code without first creating a plan with \`update_plan\`
- ❌ Reading files when you only need one function (use \`find_symbol\`)
- ❌ Sequential tool calls that could be parallel
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

| Need | Tool | Key Parameters |
|------|------|----------------|
| Understand function/class | \`find_symbol\` | \`name_path\`, \`include_body: true\` |
| Find all callers | \`find_usages\` | \`symbol_name\`, \`file_path\` |
| Search patterns | \`search_for_pattern\` | \`pattern\`, \`search_path\` |
| File structure | \`get_symbols_overview\` | \`path\` |
| List directory | \`list_directory\` | \`path\` |
| Find files | \`find_files_by_pattern\` | \`pattern\` |
| Read config/docs | \`read_file\` | \`path\`, \`start_line\`, \`end_line\` |

### Principles

1. **Verify before answering**: Confirm with tools, don't assume
2. **Symbols over text**: Use \`find_symbol\` for code entities
3. **Parallelize**: Call independent tools together
4. **Build incrementally**: Start with overview, then drill down

### Anti-Patterns

- ❌ Reading entire files for one function
- ❌ Guessing when you can investigate
- ❌ Vague answers when more tools could help
</tool_selection_guide>`;
}
