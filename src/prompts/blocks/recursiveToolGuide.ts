/**
 * Tool selection guide for the recursive root controller.
 * Differs from standard PR tool guide: emphasizes delegation over direct investigation.
 */

export function generateRecursiveToolGuide(): string {
    return `<recursive_tool_guide>
## Tool Selection Guide (Root Controller)

| Tool | When to Use |
|------|-------------|
| \`list_changed_files\` | **FIRST ACTION** — see all changed files and statistics |
| \`get_file_diff\` | **SECOND ACTION** — examine key files to understand changes before planning |
| \`update_plan\` | After examining diffs — decompose PR into concern groups |
| \`run_subagent\` | **PRIMARY TOOL** — delegate each concern group to a focused investigator |
| \`list_directory\` | Orient yourself — understand project structure |
| \`get_symbols_overview\` | Quick scan of a file's exports to classify concern areas |
| \`read_file\` | Sparingly — only to understand file structure for better decomposition |
| \`think_about_completion\` | Before final submission — verify all concerns were covered |
| \`submit_review\` | **FINAL ACTION** — deliver aggregated, structured review |

### Delegation Strategy

| PR Size | Strategy |
|---------|----------|
| 1-3 files, <50 lines | Review directly (no sub-agents needed) |
| 4-9 files | Spawn 2-3 sub-agents by logical concern |
| 10-19 files | Spawn 3-5 sub-agents, include diff hunks in context |
| 20+ files | Spawn 4-6 sub-agents, prioritize security and breaking changes |

### Sub-Agent Task Template

Each \`run_subagent\` call should include:
1. **Specific questions** about the change (not vague "review this")
2. **Relevant diff hunks** in the \`context\` field
3. **Key functions** to examine
4. **What to report back** (findings format)
</recursive_tool_guide>`;
}
