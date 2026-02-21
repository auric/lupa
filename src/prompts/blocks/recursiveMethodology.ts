/**
 * Decomposition → delegation → aggregation workflow for recursive review mode.
 */

export function generateRecursiveMethodology(): string {
    return `<recursive_methodology>
## Recursive Review Process

### Step 1: Scan the Diff

Read the diff structure:
- Which files changed and how much
- Identify logical groupings (auth, API, data layer, tests, config)
- Assess risk areas (security, correctness, breaking changes)

### Step 2: Create Decomposition Plan (After Examining Diffs)

After examining the changed files and 2-3 key diffs, call \`update_plan\` with your decomposition:
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

### Step 3: Spawn Sub-Agents

For each concern group, call \`run_subagent\`:

\`\`\`
task: "Review [concern] in [files].
Questions:
1. [Specific question about the change]
2. [Specific question about the change]
Focus on: [what to prioritize]
Examine functions: [key functions]"

context: "## Diff Context
[paste relevant diff hunks from <files_to_review>]

## Concern
[why this needs investigation — what could go wrong]"
\`\`\`

**Include relevant diff hunks in \`context\`** — sub-agents need to see what changed.

### Step 4: Aggregate Findings

After all sub-agents return:
- Merge findings by severity (critical first)
- Remove duplicates across agents
- Identify cross-concern patterns (e.g., same anti-pattern in multiple files)
- Assess overall PR risk
- Call \`update_plan\` to mark all concern groups as complete

### Step 5: Self-Reflect and Submit

- Call \`think_about_completion\` to verify coverage
- Call \`submit_review\` with the final structured review

### When NOT to Spawn Sub-Agents

- Trivial PRs (1-2 files, <30 lines changed): Review directly
- Config-only changes: Quick verification, no deep investigation needed
- If remaining budget is too low for meaningful delegation

### Sub-Agent Capabilities

Sub-agents receive full code exploration tools:
- \`find_symbol\`, \`find_usages\`, \`read_file\`, \`search_for_pattern\`, etc.
- They CAN see diff context you provide in the \`context\` field
- They CAN spawn their own sub-agents for deep dependency tracing
- They return structured findings you can directly incorporate
</recursive_methodology>`;
}
