/**
 * Analysis methodology for PR review mode.
 * Step-by-step process with plan tool integration.
 */

/**
 * Generate the analysis methodology block for PR review.
 * Emphasizes creating a plan early and tracking progress.
 */
export function generateAnalysisMethodology(): string {
    return `<analysis_methodology>
## Analysis Process

### Step 1: Create Your Plan (MANDATORY - FIRST ACTION)
⚠️ **Your first tool call MUST be \`update_plan\`.** Do not investigate before planning.

After scanning the diff, immediately call \`update_plan\` with this structure:
\`\`\`markdown
## PR Review Plan

### Overview
[1-2 sentences on what this PR does and initial risk assessment]

### Checklist
- [ ] [File/area to review]
- [ ] [File/area to review]
- [ ] [Security concern if applicable]
- [ ] Verify error handling
- [ ] Check test coverage implications
- [ ] Synthesize findings
\`\`\`

### Step 2: Gather Context
For each checklist item:
- Use \`find_symbol\` for unfamiliar functions
- Use \`find_usages\` for changed signatures
- Spawn subagents for complex areas (4+ files or security-sensitive)

**Documentation files** (.md, README, CHANGELOG, docs/): When the PR changes documentation alongside code, verify that technical claims in the docs match the implementation. Check tool availability claims, API descriptions, configuration defaults, and behavioral descriptions against the actual code. A doc that contradicts the code is a valid finding.

**After each file or area reviewed**: Call \`update_plan\` to mark progress with notes.

### Step 3: Self-Reflection Checkpoints (Articulation Required)

At each checkpoint, **explicitly articulate** your current state—don't just acknowledge.

**After gathering context** → \`think_about_context\`:
- files_examined: List what you investigated
- key_findings: State what you learned
- remaining_gaps: Identify specific unknowns
- decision: Declare next action

**Before conclusions** → \`think_about_task\`:
- analysis_focus: What are you analyzing?
- issues_found: List with file, description, severity — these are HYPOTHESES at this stage
- finding_audit: For each issue — (1) what tool call CONFIRMED it? (2) what tool call tried to DISPROVE it? (3) can I provide a concrete failing scenario with actual values? If any answer is missing for a MEDIUM+ finding, drop or downgrade it
- areas_needing_investigation: What's not covered?
- decision: Are you ready or need more work?

**Before final response** → \`think_about_completion\`:
- summary_draft: Write your 2-3 sentence summary
- critical_issues_count: How many blockers?
- files_analyzed vs files_in_diff: Coverage check
- hypothesis_kill_ratio: "Started with N hypotheses, M survived verification" — if >80% survived, re-examine your disproof rigor
- recommendation: approve/request_changes/block

### Step 3b: Verify Your Hypotheses (MANDATORY for MEDIUM+ Findings)

The issues you identified are **HYPOTHESES**, not confirmed findings.
Before including any MEDIUM+ finding, you must attempt to **DISPROVE** it using the verification gates from \`<finding_quality>\` above.

**For each MEDIUM+ hypothesis:**
1. Ask: "What would make this NOT a problem?"
2. Call the tool that checks — \`find_usages\`, \`find_symbol\`, or \`search_for_pattern\`
3. If disproved → **DROP** the finding silently. Do not mention it in your review
4. If not disproved → It survives. Now assign severity based on evidence

**Target kill ratio**: Drop 40-60% of your initial hypotheses through verification.
If you're keeping >80% of hypotheses, you are not trying hard enough to disprove them.

### Step 4: Track Progress (REQUIRED)
Call \`update_plan\` after completing each checklist item:
\`\`\`markdown
- [x] Reviewed auth changes - found timing attack risk
- [x] Verified callers updated
- [ ] Check test coverage
\`\`\`

### Step 5: Synthesize
Combine findings into structured review. Ensure:
- All checklist items marked complete
- All files analyzed
- Findings have evidence with file links
- Critical issues clearly highlighted

### Step 6: Submit Review (REQUIRED - FINAL ACTION)
⚠️ **You MUST call \`submit_review\` to deliver your findings.** Do not respond without tool calls.

Call \`submit_review\` with your complete review following the output format.
This is the explicit signal that your review is complete.

### Critical Thinking

For each change, ask:
- What is the purpose?
- What could go wrong?
- How might this affect other parts?
- What testing is needed?
</analysis_methodology>`;
}
