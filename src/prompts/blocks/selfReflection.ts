/**
 * Self-reflection guidance for think_about_* tools.
 *
 * These tools require ARTICULATION, not just acknowledgment.
 * The LLM must provide structured input that forces explicit reasoning.
 */

/**
 * Generate guidance for using self-reflection tools during PR review.
 */
export function generateSelfReflectionGuidance(): string {
    return `<self_reflection>
## Self-Reflection Tools

Use these to improve analysis quality. Each requires **structured articulation**, not passive acknowledgment.

| Tool | When | What to Articulate |
|------|------|-------------------|
| \`think_about_context\` | After gathering context | files_examined, key_findings, remaining_gaps, decision |
| \`think_about_task\` | Before conclusions | analysis_focus, issues_found, areas_needing_investigation, decision |
| \`think_about_completion\` | Before final response | summary_draft, issue_counts, files_analyzed, recommendation |

### Submitting Your Review (REQUIRED)
After completing \`think_about_completion\`, you MUST call \`submit_review\` to deliver your findings.
**Never respond without tool calls** - use \`submit_review\` as the explicit completion signal.

### Why Articulation Matters
Static checklists ("Did I do X?") are less effective than explicit articulation:
- Writing "I examined auth.ts and found no issues" is more rigorous than checking a box
- Creates an audit trail that can be verified
- Prevents rushing through reflection steps

### Workflow
1. Gather context → \`think_about_context\` with files_examined and key_findings
2. Analyze → \`think_about_task\` with analysis_focus and issues_found
3. Synthesize → \`think_about_completion\` with summary_draft and recommendation
4. **Finalize** → \`submit_review\` with the complete review output
</self_reflection>`;
}

/**
 * Generate self-reflection guidance for the recursive root controller.
 * Reinforces the decompose→delegate→aggregate pattern instead of direct investigation.
 */
export function generateRecursiveSelfReflectionGuidance(): string {
    return `<self_reflection>
## Self-Reflection Tools (Recursive Root)

You are a **controller**, not an investigator. Reflection checkpoints must reinforce delegation.

| Tool | When | What to Articulate |
|------|------|-------------------|
| \`think_about_context\` | After \`list_changed_files\` | files_seen, concern_groups_identified, decomposition_rationale, delegation_plan |
| \`think_about_task\` | After all sub-agents return | agents_spawned, findings_received, cross_concern_patterns, findings_validated, gaps_in_coverage |
| \`think_about_completion\` | Before \`submit_review\` | aggregated_issues, severity_counts, files_covered_vs_total, final_recommendation |

### Delegation Checkpoints

After calling \`list_changed_files\`:
→ \`think_about_context\`: "I see N files. I will group them into K concern groups and delegate via \`run_subagent\`."

After calling \`update_plan\`:
\u2192 Make multiple \`run_subagent\` tool calls in one response \u2014 one per concern group. They execute in parallel. Do NOT investigate files yourself.

After all sub-agents return:
→ \`think_about_task\`: "I received findings from K agents. Cross-cutting patterns: [list]. Findings to validate: [any that seem uncertain]. Coverage gaps: [list]."
→ For each MEDIUM+ finding, verify: Is it about changed code? Does it cite evidence? Would reverting this PR fix it? Does a surrounding layer already handle it? Did the agent search before claiming something is missing? Does the flagged method have production callers? Did the agent verify role intent before claiming threshold inconsistency? Drop findings that fail these checks.

Before submitting:
→ \`think_about_completion\`: Verify all concern groups were delegated and findings aggregated.
→ \`submit_review\` with the complete review output.

### Anti-Pattern: Direct Investigation
If you find yourself calling \`read_file\`, \`find_symbol\`, or \`get_file_diff\` more than once, STOP.
You are falling into direct investigation mode. Spawn a \`run_subagent\` instead.
</self_reflection>`;
}

/**
 * Generate guidance for exploration mode.
 * Uses think_about_investigation since exploration has no diff context.
 */
export function generateExplorationReflectionGuidance(): string {
    return `<self_reflection>
## Self-Reflection

Use \`think_about_investigation\` after gathering information. Articulate:
- **assigned_task**: What question are you investigating?
- **questions_answered**: What did you learn?
- **questions_remaining**: What's still unclear?
- **evidence_gathered**: What code/files support your findings?
</self_reflection>`;
}
