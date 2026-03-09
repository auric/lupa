/**
 * Self-reflection guidance for think tools.
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

These tools are MANDATORY at specific workflow points. Skipping them is NOT allowed — they enforce the structured reasoning that prevents false positives.

| Tool | When | What to Articulate |
|------|------|-------------------|
| \`think\` | After reading diffs, gathering context, before conclusions | topic, analysis, identified_risks, next_action |
| \`think_about_completion\` | Before final response | summary_draft, issues_count, files_analyzed, files_in_diff, recommendation |

### Submitting Your Review (REQUIRED)
After completing \`think_about_completion\`, you MUST call \`submit_review\` to deliver your findings.
**Your final action MUST be \`submit_review\`** — this is the explicit completion signal. Do not write a review response without calling \`submit_review\`.

### Why Articulation Matters
Static checklists ("Did I do X?") are less effective than explicit articulation:
- Writing "I examined auth.ts and found no issues" is more rigorous than checking a box
- Creates an audit trail that can be verified
- Prevents rushing through reflection steps

### Workflow
1. Read diff → \`think\` with topic="[filename] changes", analysis of what changed, risks, next_action
2. Gather context → \`think\` with topic="context review", what you found, remaining gaps, next_action
3. Before conclusions → \`think\` with topic="task alignment", what issues you found (HYPOTHESES), what needs investigation
   - For each issue: state (1) which tool output supports it, (2) what disproof you attempted, (3) why disproof failed. Drop issues where you cannot answer all three
4. Synthesize → \`think_about_completion\` with summary_draft, issues_count, recommendation
5. **Finalize** → \`submit_review\` with the complete review output
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
| \`think\` | After sub-agents return | topic="cross-concern synthesis", analysis of findings from sub-agents, identified_risks (uncertain findings), next_action |
| \`think_about_completion\` | Before \`submit_review\` | summary_draft (aggregated review), issues_count, files_analyzed (vs total), files_in_diff, recommendation |

### Delegation Checkpoints

After reviewing \`<diff_metadata>\`:
→ Call \`update_plan\` to decompose into concern groups, then spawn \`run_subagent\` for each group.

After calling \`update_plan\`:
→ Make multiple \`run_subagent\` tool calls in one response — one per concern group. They execute in parallel. Do NOT investigate files yourself.

After all sub-agents return:
→ \`think\`: topic="Cross-concern synthesis", analysis=[validated findings from sub-agents], identified_risks=[gaps or uncertain findings], next_action="synthesize and submit"
→ Apply ALL verification checks from \`<finding_quality>\` above to each MEDIUM+ finding. Drop findings that fail.
→ Bias check: Am I reporting too many issues? Scrutinize each finding — would I mass-file this as a bug report with my name on it? If not, drop it. Zero findings is a valid and common outcome for well-written code.

Before submitting:
→ \`think_about_completion\`: Verify all concern groups were delegated and findings aggregated.
→ \`submit_review\` with the complete review output.

### Anti-Pattern: Direct Investigation
After your initial orientation (1 key diff), you must NEVER call \`get_file_diff\`, \`read_file\`, or \`find_symbol\` again.
If files need review, spawn \`run_subagent\` — even for trivial files (group them into one sub-agent).
Reading diffs yourself provides no code understanding — sub-agents can trace symbols, check usages, and verify context.
</self_reflection>`;
}

/**
 * Generate guidance for exploration mode.
 * Uses the unified think tool since exploration has no diff context.
 */
export function generateExplorationReflectionGuidance(): string {
    return `<self_reflection>
## Self-Reflection

Use \`think\` after gathering information. Articulate:
- **topic**: What question are you investigating?
- **analysis**: What did you learn? What's still unclear?
- **identified_risks**: Concerns or gaps found
- **next_action**: What to do next
</self_reflection>`;
}
