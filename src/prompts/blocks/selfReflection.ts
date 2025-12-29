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

### Why Articulation Matters
Static checklists ("Did I do X?") are less effective than explicit articulation:
- Writing "I examined auth.ts and found no issues" is more rigorous than checking a box
- Creates an audit trail that can be verified
- Prevents rushing through reflection steps

### Workflow
1. Gather context → \`think_about_context\` with files_examined and key_findings
2. Analyze → \`think_about_task\` with analysis_focus and issues_found
3. Synthesize → \`think_about_completion\` with summary_draft and recommendation
</self_reflection>`;
}

/**
 * Generate guidance for exploration mode (simpler, one tool).
 */
export function generateExplorationReflectionGuidance(): string {
    return `<self_reflection>
## Self-Reflection

Use \`think_about_context\` after gathering information. Articulate:
- **files_examined**: What did you look at?
- **key_findings**: What did you learn?
- **remaining_gaps**: What's still unclear?
</self_reflection>`;
}
