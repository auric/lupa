/**
 * Decomposition → delegation → aggregation workflow for recursive review mode.
 */

export function generateRecursiveMethodology(): string {
    return `<recursive_methodology>
## Recursive Review Process

### Step 1: Orient

The \`<diff_metadata>\` in this conversation already shows which files changed and how much.
Call \`list_changed_files\` for a structured view. Then call \`get_file_diff\` on **1 key file** (the largest change or most architecturally significant) to understand what the PR does.

From the metadata and this one diff:
- Group files by module/layer (auth, API, data layer, tests, config)
- Assess risk from file names, change sizes, and the key diff
- Identify new files, deleted files, and large modifications

**Stop after 1 diff.** You now have enough to decompose. Sub-agents will read all remaining diffs.

### Step 2: Create Decomposition Plan

Call \`update_plan\` with your decomposition based on the metadata.
**Check your agent limit** (shown in \`<analysis_task>\`) — plan within the allowed number of sub-agents.
Spawning sub-agents does NOT reduce your own iteration budget — each runs independently.
Target **2-4 files per concern group** for thorough review.
\`\`\`markdown
## Recursive Review Plan

### Overview
[1-2 sentences on what this PR does and initial risk assessment]

### Concern Groups
1. [Group name] — Files: [list] — Risk: [level] — Agent: pending
2. [Group name] — Files: [list] — Risk: [level] — Agent: pending
3. [Group name] — Files: [list] — Risk: [level] — Agent: pending

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

### Step 4: Aggregate Findings

After all sub-agents return:
- Merge findings by severity (critical first)
- Remove duplicates across agents

**Quality filter — apply ALL of these to each MEDIUM+ finding:**
  - (a) Cites evidence from changed code (not just pre-existing patterns)
  - (b) Passes the Revert Test: would reverting this PR fix the issue?
  - (c) Has a concrete failing scenario for bug claims — with actual values, not "could potentially"
  - (d) Call-site contract check: if "method X lacks guard Y", verify callers DON'T already perform Y
  - (e) Centralized handler check: if "missing error handling", verify no middleware/executor already catches
  - (f) Severity calibration: re-assess severity with your own judgment — sub-agents may inflate severity. If a sub-agent reports CRITICAL with weak evidence, downgrade or drop

**Per-file density check**: If a sub-agent reported >3 findings for a single file, review each critically. High density usually indicates the agent found surface-level patterns rather than real issues

**Challenge speculative claims**: Drop any finding where the sub-agent used speculative language ("could potentially," "might," "consider adding") without concrete evidence

**Conflicting findings**: If two agents disagree about the same code, investigate the specific disagreement with one targeted tool call before choosing a side

**Coverage gaps**: If any sub-agent returned incomplete results (timeout, remaining areas noted), cover those gaps yourself with targeted \`get_file_diff\` calls

- Identify cross-concern patterns (e.g., same anti-pattern in multiple files)
- Assess overall PR risk
- Call \`update_plan\` to mark all concern groups as complete

### Step 5: Self-Reflect and Submit

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

**Assign 2-4 files per sub-agent.** If a concern group has 4+ files, the sub-agent will automatically decompose further.
</recursive_methodology>`;
}
