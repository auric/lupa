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
| \`think_about_task\` | Before conclusions | analysis_focus, hypotheses_found, disproof_attempts, surviving_findings, decision |
| \`think_about_completion\` | Before final response | summary_draft, issue_counts, files_analyzed, hypothesis_kill_ratio, recommendation |

### Submitting Your Review (REQUIRED)
After completing \`think_about_completion\`, you MUST call \`submit_review\` to deliver your findings.
**Your final action MUST be \`submit_review\`** — this is the explicit completion signal. Do not write a review response without calling \`submit_review\`.

### Why Articulation Matters
Static checklists ("Did I do X?") are less effective than explicit articulation:
- Writing "I examined auth.ts and found no issues" is more rigorous than checking a box
- Creates an audit trail that can be verified
- Prevents rushing through reflection steps

### Workflow
1. Gather context → \`think_about_context\` with files_examined and key_findings
2. Analyze → \`think_about_task\` with analysis_focus and hypotheses_found
   - For each hypothesis: state (1) which tool output supports it, (2) what disproof you attempted, (3) why disproof failed. Drop hypotheses where you cannot answer all three
3. Synthesize → \`think_about_completion\` with summary_draft, recommendation, and hypothesis_kill_ratio ("Started with N hypotheses, M survived"). If >80% survived, revisit your disproof rigor
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
| \`think_about_task\` | After all sub-agents return | analysis_focus (cross-concern patterns), hypotheses_found (from sub-agents), disproof_attempts (validation of uncertain findings), surviving_findings |
| \`think_about_completion\` | Before \`submit_review\` | summary_draft (aggregated review), issue_counts, files_analyzed (vs total), hypothesis_kill_ratio, recommendation |

### Delegation Checkpoints

After reviewing \`<diff_metadata>\`:
→ Call \`update_plan\` to decompose into concern groups, then spawn \`run_subagent\` for each group.

After calling \`update_plan\`:
\u2192 Make multiple \`run_subagent\` tool calls in one response \u2014 one per concern group. They execute in parallel. Do NOT investigate files yourself.

After all sub-agents return:
→ \`think_about_task\`: analysis_focus="Cross-concern synthesis", issues_found=[validated findings from sub-agents], areas_needing_investigation=[gaps or uncertain findings], decision=ready_to_synthesize
→ Apply ALL verification checks from \`<finding_quality>\` above to each MEDIUM+ finding. Drop findings that fail.
→ Bias check: Am I reporting too many issues? Scrutinize each finding — would I mass-file this as a bug report with my name on it? If not, drop it. Zero findings is a valid and common outcome for well-written code.

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
