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

### Step 1: Create a Plan
After scanning the diff, call \`update_plan\` to create a structured checklist:
\`\`\`markdown
## PR Review Plan

### Overview
[1-2 sentences on what this PR does]

### Checklist
- [ ] [File/area to review]
- [ ] [File/area to review]
- [ ] [Security concern if applicable]
- [ ] Verify test coverage
- [ ] Synthesize findings
\`\`\`

### Step 2: Gather Context
For each checklist item:
- Use \`find_symbol\` for unfamiliar functions
- Use \`find_usages\` for changed signatures
- Spawn subagents for complex areas (4+ files or security-sensitive)

### Step 3: Self-Reflection Checkpoints
- After gathering context: call \`think_about_context\`
- Before conclusions: call \`think_about_task\`
- Before final response: call \`think_about_completion\`

### Step 4: Update Plan
Mark items complete as you investigate:
\`\`\`markdown
- [x] Reviewed auth changes - found timing attack risk
- [x] Verified callers updated
- [ ] Check test coverage
\`\`\`

### Step 5: Synthesize
Combine findings into structured review. Ensure:
- All files analyzed
- Findings have evidence
- Critical issues clearly highlighted

### Critical Thinking

For each change, ask:
- What is the purpose?
- What could go wrong?
- How might this affect other parts?
- What testing is needed?
</analysis_methodology>`;
}
