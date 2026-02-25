/**
 * Finding quality guidance to reduce false positives in code review.
 *
 * Addresses common LLM failure modes: scope drift into unchanged code,
 * design intent blindness, feature request inflation, speculative claims
 * without evidence, and dead path analysis.
 */

/**
 * Generate finding quality guidance for PR review and investigation agents.
 * Includes scope boundary rule, revert test, verification gates,
 * counterexample requirements, and false positive anti-patterns.
 */
export function generateFindingQualityGuidance(): string {
    return `<finding_quality>
## Finding Quality Standards

### Scope: Changed Code Only

ONLY report issues that are:
- Directly in code changed by this PR, OR
- In unchanged code where THIS PR's changes create a new failure path

**The Revert Test**: For each finding, ask: "Would reverting this PR fix or prevent this issue?"
- **YES** → Valid finding (the PR introduces or worsens it)
- **NO** → Pre-existing issue — **DROP IT**

Pre-existing code quality issues, tech debt, and architectural preferences are NOT findings.
The PR author is not responsible for fixing problems that existed before their change.

### Verification Gates

Before reporting a finding, complete the verification for its claim type:

| Claim Type | Required Verification |
|---|---|
| "Missing error handling" | Trace callers 2-3 levels up for outer try-catch or error boundaries |
| "Value can be negative/zero/null" | Trace the variable to its source; prove a concrete input produces the bad value |
| "Missing test for X" | Search \`__tests__/\` for function name AND behavioral synonyms |
| "Missing documentation" | Search README and \`docs/\` for the concept by keyword |
| "Design inconsistency" | Check for comments/docs explaining rationale; if plausible intent exists, **drop it** |
| "Should validate X" | Trace all producers of X to prove an invalid value is reachable |
| "Missing cleanup/disposal" | Check framework config (vitest.config, jest.config) for global settings |
| "Design flaw / should refactor" | Search for comments, docs, tests, or commit history explaining the design. If ANY plausible rationale exists, drop the finding |
| "Should add X feature" | This is a suggestion, not a bug. Only report as 🟢 LOW if directly relevant to changed code |
| "Pre-existing issue" | Apply the Revert Test above. If reverting wouldn't fix it, drop it |

If you cannot complete verification: flag as 🔍 **Verify** or drop the finding.

### Counterexample Requirement

For every "X can go wrong" finding, provide:
1. **Concrete scenario**: specific input/state that triggers the failure
2. **Code path**: which functions execute, in what order
3. **Outcome**: what specifically breaks

If you cannot construct a concrete failing scenario with actual values, drop the finding.

### Confidence Levels

| Level | Definition | Max Severity Allowed |
|---|---|---|
| 🟢 VERIFIED | Tool-confirmed with cited evidence | CRITICAL |
| 🟡 LIKELY | Strong reasoning, partial tool confirmation | HIGH |
| 🔴 SPECULATIVE | Pattern-match without tool verification | LOW only |

CRITICAL/HIGH findings MUST be 🟢 VERIFIED. Speculative findings may only be 🟢 LOW.

### False Positive Patterns — Avoid These

- ❌ "Missing try-catch" when an outer scope already handles the error
- ❌ "Can go negative" without proving a concrete input exists that causes it
- ❌ "No tests for X" without searching the test directory first
- ❌ "Inconsistent thresholds" for intentionally asymmetric designs (e.g., different roles)
- ❌ "Missing cleanup" when the test framework config handles it globally
- ❌ "Unused callback/dead code" when the interface is an extension point
- ❌ "Should validate X" when X is internal state already constrained by producers
- ❌ "Should add X" (logging, metrics, retry logic) as MEDIUM or higher — suggestions are 🟢 LOW at most
- ❌ Issues in unchanged code that the PR doesn't make worse
- ❌ "Architecture should use X pattern" without evidence the current approach causes concrete problems
- ❌ Reporting pre-existing tech debt as a PR finding

### False Positive Cost

False positives erode developer trust faster than true positives build it.
**Three verified, actionable findings are worth more than twelve mixed-quality observations.**
When uncertain, omit the finding — silence on a non-issue is better than noise.
</finding_quality>`;
}

/**
 * Generate compact finding quality guidance for subagent investigations.
 * Covers the highest-impact quality requirements for focused investigation agents.
 */
export function generateSubagentFindingQualityGuidance(): string {
    return `
### Finding Quality

Before reporting any issue:
1. **Changed code only**: Only report issues in code changed by this PR, or where the change creates a new failure path. Apply the Revert Test: if reverting this PR wouldn't fix it, drop it
2. **Verify scope**: For "missing error handling" — check callers for outer try-catch
3. **Prove it**: For "X can fail" — provide concrete input values that trigger the failure. No concrete scenario = drop the finding
4. **Search first**: For "missing test/docs" — search before claiming absence
5. **Consider intent**: For "design flaw" — check if the design is intentional (comments, docs, tests). If plausible rationale exists, drop it
6. **Suggestions ≠ bugs**: "Should add X" is a suggestion, not a bug. Report as LOW only, never higher
7. **When uncertain, omit**: Three verified findings beat twelve speculative ones`;
}
