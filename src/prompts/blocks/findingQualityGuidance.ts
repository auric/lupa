/**
 * Finding quality guidance to reduce false positives in code review.
 *
 * Addresses common LLM failure modes: scope tunnel vision, domain blindness,
 * existence check failures, design intent projection, and dead path analysis.
 */

/**
 * Generate finding quality guidance for PR review and investigation agents.
 * Includes verification gates, counterexample requirements, and false positive examples.
 */
export function generateFindingQualityGuidance(): string {
    return `<finding_quality>
## Finding Quality Standards

### Verification Gates

Before reporting a finding, complete the verification for its claim type:

| Claim Type | Required Verification |
|---|---|
| "Missing error handling" | Trace callers 2-3 levels up for outer try-catch or error boundaries |
| "Value can be negative/zero/null" | Trace the variable to its source; prove a concrete input produces the bad value |
| "Missing test for X" | Search \`__tests__/\` for function name AND behavioral synonyms |
| "Missing documentation" | Search README and \`docs/\` for the concept by keyword |
| "Design inconsistency" | Check for comments/docs explaining rationale; if plausible intent exists, downgrade or drop |
| "Should validate X" | Trace all producers of X to prove an invalid value is reachable |
| "Missing cleanup/disposal" | Check framework config (vitest.config, jest.config) for global settings |

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
</finding_quality>`;
}

/**
 * Generate compact finding quality guidance for subagent investigations.
 * Lighter version focusing on the highest-impact verification requirements.
 */
export function generateSubagentFindingQualityGuidance(): string {
    return `
### Finding Quality

Before reporting any issue:
1. **Verify scope**: For "missing error handling" — check callers for outer try-catch
2. **Prove it**: For "X can fail" — provide concrete input values that trigger the failure. No concrete scenario = drop the finding
3. **Search first**: For "missing test/docs" — search before claiming absence
4. **Consider intent**: For "inconsistent design" — check if asymmetry is intentional`;
}
