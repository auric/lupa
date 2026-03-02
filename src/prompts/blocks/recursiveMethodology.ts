/**
 * Decomposition → delegation → aggregation workflow for recursive review mode.
 */

export function generateRecursiveMethodology(): string {
    return `<recursive_methodology>
## Recursive Review Process

### Step 1: Orient

The \`<diff_metadata>\` in this conversation already shows which files changed and how much.
Review it, then call \`get_file_diff\` on **1 key file** (the largest change or most architecturally significant) to understand what the PR does.

From the metadata and this one diff:
- Group files by module/layer (auth, API, data layer, tests, config, documentation)
- Assess risk from file names, change sizes, and the key diff
- Identify new files, deleted files, and large modifications
- If documentation files (.md) changed alongside code, include them in a concern group — docs that make technical claims about tools, settings, or behavior must be verified against the implementation

**Stop after 1 diff.** You now have enough to decompose. Sub-agents will read all remaining diffs.

### Step 2: Create Decomposition Plan

Call \`update_plan\` with your decomposition based on the metadata.
**Check your agent limit** (shown in \`<analysis_task>\`) — plan within the allowed number of sub-agents.
Spawning sub-agents does NOT reduce your own iteration budget — each runs independently.
Target **2-3 files per concern group** for thorough review.
**CRITICAL: Every changed file MUST appear in exactly one concern group.** Cross-check your plan against the full file list — any file not assigned to a group will be flagged as a coverage gap.
\`\`\`markdown
## Recursive Review Plan

### Overview
[1-2 sentences on what this PR does and initial risk assessment]

### Concern Groups
1. [Group name] — Files: [list] — Risk: [level] — Agent: pending
2. [Group name] — Files: [list] — Risk: [level] — Agent: pending
3. [Group name] — Files: [list] — Risk: [level] — Agent: pending

### Unassigned Files
[MUST be empty — all files accounted for above]

### Cross-Concern Items
- [Any cross-cutting concerns to check after agents complete]
\`\`\`

### Step 3: Spawn ALL Sub-Agents (Parallel — Multiple Tool Calls in One Response)

\u26a0\ufe0f **Make multiple \`run_subagent\` tool calls in your response — one per concern group.** They execute in parallel. Do NOT spawn one agent, wait for it, then spawn the next.

For each concern group, call \`run_subagent\`:

\`\`\`
task: "Review [concern] in [files].
Questions:
1. [Specific question about the change]
2. [Specific question about the change]
Focus on: [what to prioritize]
Examine functions: [key functions]"

context: "## Files to Examine
[list specific file paths this agent should focus on]

## Concern
[why this needs investigation — what could go wrong]"
\`\`\`

Sub-agents have \`get_file_diff\` — they read diffs for the files you assign them.
Sub-agents with 4+ files will decompose further by spawning their own sub-agents.
**Each sub-agent MUST call \`get_file_diff\` for EVERY file in its assignment** — do not skip files based on names alone.

**Large files**: For files with very large diffs, a single agent's context may not hold the full diff. In this case, multiple sub-agents can each review different sections of the same file. When delegating, specify which functions or line ranges each sub-agent should focus on. Collective coverage across agents counts — a file is covered when all its sections have been reviewed by at least one agent.

### Step 4: Review Progress and Address Gaps

After sub-agents return, the system automatically reports which files have been reviewed via \`get_file_diff\`.

4a. Call \`update_plan\` to record: which concern groups completed, key findings summary, and coverage status.
4b. If a coverage gap is reported, delegate ALL uncovered files to sub-agents — group trivial files (version bumps, config tweaks, formatting) together into a single sub-agent if needed, and group substantive changes by concern with **specific investigation questions** informed by Phase 1 findings.
4c. If any sub-agent reported truncated diffs (file too large for one call): spawn a focused sub-agent for the truncated file with instructions to call \`get_file_diff\` with \`context_lines: false\` or request specific file sections.
4d. Repeat 4a–4c until all files have been reviewed.

### Step 5: Aggregate Findings

Once all files are covered:
- Merge findings by severity (critical first)
- Remove duplicates across agents

**Quality filter — apply to each MEDIUM+ finding:**
  - Passes the verification gates from \`<finding_quality>\` above (Revert Test, concrete evidence, call-site/handler checks)
  - Severity calibration: re-assess with your own judgment — sub-agents may inflate severity. If a sub-agent reports CRITICAL with weak evidence, downgrade or drop

**Per-file density check**: If a sub-agent reported >3 findings for a single file, review each critically. High density usually indicates surface-level patterns rather than real issues

**Challenge speculative claims**: Drop any finding where the sub-agent used speculative language ("could potentially," "might," "consider adding") without concrete evidence

**Conflicting findings**: If two agents disagree about the same code, investigate the specific disagreement with one targeted tool call before choosing a side

**Coverage gaps**: If any sub-agent returned incomplete results (timeout, remaining areas noted), spawn additional sub-agents to cover those gaps

- Identify cross-concern patterns (e.g., same anti-pattern in multiple files)
- Assess overall PR risk
- Call \`update_plan\` to mark all concern groups as complete

### Step 6: Self-Reflect and Submit

- Call \`think_about_completion\` to verify coverage
- Call \`submit_review\` with the final structured review

### When NOT to Spawn Sub-Agents

- Trivial PRs (1-2 files, <30 lines changed): Review directly
- Agent limit reached: All allowed sub-agents already spawned

### Sub-Agent Capabilities

Sub-agents receive full code exploration tools:
- \`find_symbol\`, \`find_usages\`, \`read_file\`, \`search_for_pattern\`, etc.
- They call \`get_file_diff\` to read diffs — no need to paste hunks in context
- They CAN spawn their own sub-agents for large scopes (4+ files)
- They return structured findings you can directly incorporate

**Assign 2-3 files per sub-agent.** Sub-agents with 4+ files will automatically decompose further.
</recursive_methodology>`;
}
