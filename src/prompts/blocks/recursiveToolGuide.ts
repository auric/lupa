/**
 * Tool selection guide for the recursive root controller.
 * Differs from standard PR tool guide: emphasizes delegation over direct investigation.
 */

export function generateRecursiveToolGuide(): string {
    return `<recursive_tool_guide>
## Tool Selection Guide (Root Controller)

| Tool | When to Use |
|------|-------------|
| \`list_changed_files\` | **FIRST** — see all changed files and statistics |
| \`get_file_diff\` | **SECOND** — read 2-3 key diffs (largest change, new files, risky files) before planning |
| \`update_plan\` | **THIRD** — decompose PR into concern groups from informed understanding |
| \`run_subagent\` | **PRIMARY TOOL** — delegate each concern group to a focused investigator |
| \`list_directory\` | Orient yourself — understand project structure |
| \`get_symbols_overview\` | Quick scan of a file's exports to classify concern areas |
| \`think_about_completion\` | Before final submission — verify all concerns were covered |
| \`submit_review\` | **FINAL ACTION** — deliver aggregated, structured review |

### Delegation Strategy

| PR Size | Strategy |
|---------|----------|
| 1-3 files, <50 lines | Review directly (no sub-agents needed) |
| 4-9 files | Spawn 2-3 sub-agents, 2-4 files each |
| 10-19 files | Spawn 3-4 sub-agents, 2-4 files each |
| 20+ files | Spawn 3-4 sub-agents, 2-4 files each, prioritize security and breaking changes |

**Key rules:**
- Target **2-4 files per sub-agent** for thorough review
- Sub-agents with 4+ files will automatically decompose further (depth-2 recursion)
- **Never spawn more sub-agents than your budget allows** — check the budget note in your task
- Prefer fewer agents with more files over many agents with 1 file each

### Sub-Agent Task Template

Each \`run_subagent\` call should include:
1. **Specific questions** about the change (not vague "review this")
2. **File paths** to examine (sub-agents call \`get_file_diff\` themselves)
3. **Key functions** to examine
4. **What to report back** (findings format)

**Do NOT read all diffs yourself.** Read 2-3 key diffs with \`get_file_diff\` to inform your decomposition plan, then delegate to sub-agents for thorough analysis. Sub-agents have \`list_changed_files\` and \`get_file_diff\` — they read diffs on demand.
</recursive_tool_guide>`;
}
