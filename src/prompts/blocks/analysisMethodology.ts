/**
 * Analysis methodology for PR review mode.
 * Step-by-step process with plan tool integration.
 * Includes explicit reasoning mandate for non-reasoning models (GPT-4.1).
 */

/**
 * Generate the analysis methodology block for PR review.
 * Emphasizes creating a plan early and tracking progress.
 */
export function generateAnalysisMethodology(): string {
    return `<analysis_methodology>
## Analysis Process

### IMPORTANT: Explicit Reasoning Required

You MUST think out loud between tool calls. Before EVERY tool call, write a brief text message explaining:
1. What you learned from the previous result
2. What you plan to do next and why

Do NOT chain tool calls silently. Always reflect on results before proceeding.

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

### Step 3: Think Through Each Change

After reading each file's diff, call \`think\` to structure your thinking:
- topic: The file or area you are analyzing
- analysis: What changed, what could go wrong, what looks correct
- identified_risks: Specific risks found (empty if none)
- next_action: What to do next (investigate, move on, record finding)

This prevents jumping to conclusions. Think first, then investigate, then record.
**Call \`think\` after reading each diff — before investigating or recording findings.**

### Step 4: Self-Reflection Checkpoints

At key points, call \`think\` to explicitly articulate your state:

**After gathering context** → \`think\` with topic "context review":
- What you examined, what you found, what gaps remain, what to do next

**Before conclusions** → \`think\` with topic "task alignment":
- What you're analyzing, issues found (these are HYPOTHESES), areas needing investigation
- For each issue — (1) what tool call CONFIRMED it? (2) what tool call tried to DISPROVE it? (3) can you provide a concrete failing scenario? If any answer is missing for MEDIUM+, drop or downgrade it

**Before final response** → \`think_about_completion\`:
- summary_draft: Write your 2-3 sentence summary
- issues_count: Total issues found
- files_analyzed vs files_in_diff: Coverage check
- recommendation: approve/request_changes/block

### Step 5: Verify Your Hypotheses (MANDATORY for MEDIUM+ Findings)

The issues you identified are **HYPOTHESES**, not confirmed findings.
Before including any MEDIUM+ finding, you must attempt to **DISPROVE** it using the verification gates from \`<finding_quality>\` above.

**For each MEDIUM+ hypothesis:**
1. Ask: "What would make this NOT a problem?"
2. Call the tool that checks — \`find_usages\`, \`find_symbol\`, or \`search_for_pattern\`
3. If disproved → **DROP** the finding silently. Do not mention it in your review
4. If not disproved → It survives. Now assign severity based on evidence
5. For factual claims (symbol unused, type mismatch, missing callers): call \`validate_claim\` for definitive LSP verification

**Target kill ratio**: Drop 40-60% of your initial hypotheses through verification.
If you're keeping >80% of hypotheses, you are not trying hard enough to disprove them.

### Step 6: Track Progress (REQUIRED)
Call \`update_plan\` after completing each checklist item:
\`\`\`markdown
- [x] Reviewed auth changes - found timing attack risk
- [x] Verified callers updated
- [ ] Check test coverage
\`\`\`

### Step 7: Synthesize
Combine findings into structured review. Ensure:
- All checklist items marked complete
- All files analyzed
- Findings have evidence with file links
- Call \`record_finding\` for each confirmed finding (ensures findings survive timeout)
- Critical issues clearly highlighted

### Step 8: Submit Review (REQUIRED - FINAL ACTION)
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
