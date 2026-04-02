/**
 * Analysis methodology for PR review mode.
 * Step-by-step process with plan tool integration.
 * Includes explicit reasoning mandate for non-reasoning models (GPT-4.1).
 * Calibration-aware: adjusts skepticism and verification emphasis per model.
 */

import type { ModelCalibrationProfile } from '../../models/modelCalibration';

/**
 * Generate the analysis methodology block for PR review.
 * Adjusts verification emphasis based on model calibration:
 * - Dismissive models: removes kill ratio, strengthens persistence
 * - Aggressive models: emphasizes kill ratio and evidence bar
 */
export function generateAnalysisMethodology(
    calibration: ModelCalibrationProfile
): string {
    return `<analysis_methodology>
## Analysis Process

### Reasoning Between Tool Calls

Before each tool call, briefly explain what you learned from the previous result and what you plan to do next. This keeps your analysis grounded in evidence.

### Step 1: Orient, Then Plan (MANDATORY - FIRST ACTIONS)
⚠️ **Turn 1**: Call \`get_pr_context\` and \`get_file_diff\` (for the largest/riskiest file) to understand the PR.
⚠️ **Turn 2**: Call \`update_plan\` based on what you learned. Do NOT call \`update_plan\` until you have read at least one diff.

Read the PR commit messages from \`get_pr_context\` and examine a key diff to understand the developer's intent, then call \`update_plan\` with this structure:
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
- Use \`find_symbol\` for unfamiliar functions
- Use \`find_usages\` for changed signatures
- Spawn subagents for complex areas (4+ files or security-sensitive)

**Documentation files** (.md, README, CHANGELOG, docs/): When the PR changes documentation alongside code, verify that technical claims in the docs match the implementation. Check tool availability claims, API descriptions, configuration defaults, and behavioral descriptions against the actual code. A doc that contradicts the code is a valid finding.

**After each file or area reviewed**: Call \`update_plan\` to mark progress with notes.

### Step 3: Think Through Each Change
After reading a diff, call \`think\` to organize your analysis before investigating further.

**Hypothesis generation is encouraged.** When you call \`think\` after reading a diff, include 2-3 items in \`identified_risks\`. These are hypotheses to investigate — they may turn out to be fine, but generating them prevents premature conclusions. On the FIRST checkpoint after reading a diff, always generate at least 2 hypotheses. Consider: error handling edge cases, type safety gaps, missing validation on inputs, inconsistency with callers, off-by-one errors, concurrency issues.

### Productive Skepticism

${
    calibration.findingBias === 'dismissive'
        ? `### Investigation Algorithm (execute for each changed file)

1. Call \\\`get_file_diff({file_paths: ["<file>"]})\\\` → read the diff
2. For each changed function/method in the diff:
   a. Call \\\`read_file\\\` → full function body with 30 lines context
   b. Call \\\`find_usages\\\` → all callers of this function
   c. For EACH caller, verify:
      - New null/undefined return? → Does caller check for null?
      - New error throw? → Does caller have try-catch?
      - Changed parameter type? → Does caller pass correct type?
      - Changed return type? → Does caller use return value correctly?
      - Removed validation? → Does any caller depend on it?
   d. If ANY caller CANNOT handle the change → call \\\`record_finding\\\`
   e. If ALL callers handle it correctly → move to next function
3. After all functions checked, verify:
   - New error paths propagated to callers?
   - New resources acquired and released?
   - Changed control flow breaks existing invariants?
4. Call \\\`think\\\` checkpoint with findings summary
5. Repeat for next file

**Decision rule**: A finding exists when a SPECIFIC caller of CHANGED code will produce wrong behavior. Name the caller, the scenario, and the wrong behavior. If you cannot name all three, it is not a finding.`
        : `You are a senior reviewer, not a rubber stamp. Your job is to find issues the developer missed.
- If you review multiple files and identify zero risks at checkpoint #1, you are likely being too agreeable — go back and hypothesize harder
- Real code changes almost always have edge cases, error handling gaps, or subtle type issues worth at least investigating
- Generating hypotheses costs nothing — disprove them with tools if they're wrong
- A review that says "everything looks good" without any \\\`validate_claim\\\` calls is incomplete, not thorough`
}

### Example: Reviewing a File Change

1. \`get_file_diff({file_paths: ["src/auth.ts"]})\` → see what changed
2. \`think({topic: "src/auth.ts changes", analysis: "login() now accepts plain string password instead of hash", identified_risks: ["timing attack on === comparison", "plain text password in memory"], next_action: "find_usages for login()"})\`
3. \`find_usages({symbol: "login", file: "src/auth.ts"})\` → trace all callers
4. For each caller, check: does it handle the new behavior?
5. If caller at risk → \`record_finding({...})\` immediately
6. If all callers safe → move to next changed function

### Tool Call Workflow
The standard analysis flow follows this pattern:

\`get_file_diff\` → \`think\` → investigate → \`record_finding\` (if issue confirmed)
After all files → \`think_about_completion\` → \`submit_review\`

### Step 4: Self-Reflection Checkpoints

Call \`think\` at these checkpoints to maintain analysis quality:

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
${
    calibration.findingBias === 'dismissive'
        ? `
**Verification procedure for dismissive models**:
1. For each hypothesis in your think checkpoint:
   a. Write the specific tool call that would DISPROVE it
   b. Execute that tool call
   c. If tool output shows the issue exists → record_finding
   d. If tool output shows the issue does NOT exist → drop silently
   e. If tool output is ambiguous → call a DIFFERENT tool for the same hypothesis
2. After 3 tool calls for the same hypothesis with no clear answer → DROP it
3. Each hypothesis MUST be resolved (confirmed or dropped) before moving on`
        : calibration.findingBias === 'aggressive'
          ? `
**Target kill ratio**: Drop 50-70% of your initial hypotheses through verification.
If you're keeping >70% of hypotheses, you are not trying hard enough to disprove them. Every finding must survive rigorous challenge.`
          : `
**Target kill ratio**: Drop 40-60% of your initial hypotheses through verification.
If you're keeping >80% of hypotheses, you are not trying hard enough to disprove them.`
}

### Step 6: Track Progress (REQUIRED)
Call \`update_plan\` after completing each checklist item:
\`\`\`markdown
- [x] Reviewed auth changes - found timing attack risk
- [x] Verified callers updated
- [ ] Check test coverage
\`\`\`

### Step 7: Record and Synthesize
⚠️ For EVERY confirmed finding, you MUST call \`record_finding\` IMMEDIATELY after verification — do NOT wait until synthesis. Unrecorded findings are LOST on timeout.

Combine findings into structured review. Ensure:
- All checklist items marked complete
- All files analyzed
- Findings have evidence with file links
- Every MEDIUM+ finding has been recorded via \`record_finding\`
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
${
    calibration.findingBias === 'dismissive'
        ? `
**Zero-finding safety check**: If you have investigated every file and recorded zero findings, verify:
1. Did you call \\\`find_usages\\\` for every changed public function? (check your tool call history)
2. Did every caller handle the change? (cite the specific tool output)
3. Are there any new null paths, error paths, or type changes?
If yes to all three → zero findings is correct. If no → go back and investigate the gap.`
        : ''
}
${
    calibration.investigationProtocol?.investigationPreamble
        ? `
### Investigation Persistence
${calibration.investigationProtocol.investigationPreamble}`
        : ''
}
</analysis_methodology>`;
}
