/**
 * Tool selection guide for the recursive root controller.
 * Differs from standard PR tool guide: emphasizes delegation over direct investigation.
 */

export function generateRecursiveToolGuide(): string {
    return `<recursive_tool_guide>
## Tool Selection Guide (Root Controller)

| Tool | When to Use |
|------|-------------|
| \`<diff_metadata>\` (in prompt) | **ALREADY PROVIDED** — all changed files and line counts are in your conversation |
| \`get_file_diff\` | **FIRST TOOL CALL** — read 1 key diff (largest/riskiest) to understand the PR's purpose |
| \`update_plan\` | **SECOND** — decompose PR into concern groups |
| \`run_subagent\` | **PRIMARY TOOL** — make multiple calls in one response (parallel execution) |
| \`list_directory\` | Orient yourself — understand project structure |
| \`get_symbols_overview\` | Quick scan of a file's exports to classify concern areas |
| \`think_about_completion\` | Before final submission — verify all concerns were covered |
| \`submit_review\` | **FINAL ACTION** — deliver aggregated, structured review |
| \`record_finding\` | Commit findings as discovered — survives timeout |
| \`query_evidence\` | Read evidence from sub-agents for aggregation |
| \`validate_claim\` | LSP-verify critical claims before including in final review |

⚠️ **Read at most 1 diff for orientation.** Do NOT call \`get_file_diff\` more than once or use \`read_file\`. Sub-agents read all remaining diffs.

### Delegation Strategy

| PR Size | Strategy |
|---------|----------|
| 1-2 files, <30 lines | Review directly (no sub-agents needed) |
| 3-9 files | Spawn 2-3 sub-agents, 2-3 files each |
| 10-19 files | Spawn 3-4 sub-agents, 2-3 files each |
| 20+ files | Spawn 3-4 sub-agents, 2-3 files each, prioritize security and breaking changes |

**Key rules:**
- Target **2-3 files per sub-agent** for thorough review
- Sub-agents with 4+ files will automatically decompose further (depth-2 recursion)
- **Never spawn more sub-agents than your budget allows** — check the budget note in your task
- Prefer fewer agents with more files over many agents with 1 file each

### Sub-Agent Task Template

Each \`run_subagent\` call should include:
1. **Specific questions** about the change (not vague "review this")
2. **File paths** to examine (sub-agents call \`get_file_diff\` themselves)
3. **Key functions** to examine
4. **What to report back** (findings format)
</recursive_tool_guide>`;
}
