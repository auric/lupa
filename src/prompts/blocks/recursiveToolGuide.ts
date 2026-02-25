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
| \`get_file_diff\` | **ONCE** — read 1 key diff (largest/riskiest) to understand the PR's purpose |
| \`update_plan\` | **THIRD** — decompose PR into concern groups |
| \`run_subagent\` | **PRIMARY TOOL** — make multiple calls in one response (parallel execution) |
| \`list_directory\` | Orient yourself — understand project structure |
| \`get_symbols_overview\` | Quick scan of a file's exports to classify concern areas |
| \`think_about_completion\` | Before final submission — verify all concerns were covered |
| \`submit_review\` | **FINAL ACTION** — deliver aggregated, structured review |

⚠️ **Read at most 1 diff for orientation.** Do NOT call \`get_file_diff\` more than once or use \`read_file\`. Sub-agents read all remaining diffs.

### Delegation Strategy

| PR Size | Strategy |
|---------|----------|
| 1-2 files, <30 lines | Review directly (no sub-agents needed) |
| 3-9 files | Spawn 2-3 sub-agents, 2-4 files each |
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

**Read at most 1 diff, then delegate.** Orient via \`list_changed_files\` + 1 key diff, decompose with \`update_plan\`, then spawn ALL sub-agents in one turn. Sub-agents have \`list_changed_files\` and \`get_file_diff\` — they read diffs on demand.

**Parallel spawning**: Make multiple \`run_subagent\` tool calls in one response \u2014 one call per concern group. They execute in parallel. Do NOT call \`run_subagent\` once, wait for results, then call it again.
</recursive_tool_guide>`;
}
