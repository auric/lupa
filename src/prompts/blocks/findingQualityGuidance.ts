/**
 * Finding quality guidance to reduce false positives in code review.
 *
 * Addresses common LLM failure modes: scope drift into unchanged code,
 * design intent blindness, feature request inflation, speculative claims
 * without evidence, and dead path analysis.
 *
 * Calibration-aware: omits dismissal-enabling sections for dismissive models,
 * strengthens quality bar for aggressive models.
 */

import type { ModelCalibrationProfile } from '../../models/modelCalibration';

/**
 * Generate finding quality guidance for PR review and investigation agents.
 * Adjusts content based on model calibration:
 * - Dismissive models: omits revert test and FP anti-pattern list (they enable dismissal)
 * - Aggressive models: includes full FP guidance with extra emphasis
 * - Balanced models: full guidance (original behavior)
 */
export function generateFindingQualityGuidance(
    calibration: ModelCalibrationProfile
): string {
    const includeRevertTest = calibration.includeRevertTest;
    const includeFPGuide = calibration.includeFalsePositiveGuide;
    const evidenceThreshold = calibration.evidenceThreshold;

    const revertTestSection = includeRevertTest
        ? `
**The Revert Test**: For each finding, ask: "Would reverting this PR fix or prevent this issue?"
- **YES** → Valid finding (the PR introduces or worsens it)
- **NO** → Pre-existing issue — **DROP IT**

Pre-existing code quality issues, tech debt, and architectural preferences are NOT findings.
The PR author is not responsible for fixing problems that existed before their change.
`
        : `
Focus on issues directly in or caused by the code changed in this PR.
Pre-existing code quality issues, tech debt, and architectural preferences are NOT findings.
`;

    const evidenceBarText =
        evidenceThreshold === 'low'
            ? 'When evidence suggests a potential issue, investigate further and record if the concern is plausible'
            : evidenceThreshold === 'high'
              ? `Record findings when specific tool output reveals a concrete problem. The evidence bar is:
- SUFFICIENT: A tool call showed unexpected behavior (e.g., validate_claim returned "not verified", find_usages showed missing callers, search_for_pattern found no error handling)
- INSUFFICIENT: Your reasoning alone, without any tool output supporting the claim
- A failed validate_claim IS evidence — it means the code doesn't match expectations. Investigate WHY, don't dismiss.`
              : 'Record when evidence confirms an issue';

    const fpPatternsSection = includeFPGuide
        ? `
### Every Finding MUST Have

1. **Specific tool output showing the problem** — not just reasoning. Name the tool, the query, and the result.
2. **A concrete failing scenario with actual values** — what input, what code path, what breaks.
3. **Proof it's caused by THIS PR's changes** — not pre-existing.

### Top False Positive Patterns — Avoid These

**Design Intent Blindness** — the #1 source of false positives:
- ❌ Claiming "inconsistent behavior" without checking for comments or docs explaining why — search for comments like "Note:", "Intentional", "Why:", design docs, and the function's docstring BEFORE reporting
- ❌ Reporting that a function "only handles X" when it was DESIGNED to only handle X — check the function's name, docstring, and callers to understand its intended scope
- ❌ Fabricating examples that don't match the actual code

**Other common false positives:**
- ❌ "Missing try-catch" when an outer scope, middleware, or executor already catches and converts errors — check the full call chain before suggesting error handling
- ❌ "Should validate X" when X is internal state already constrained by producers, or ALL callers validate before calling
- ❌ "Race condition" without verifying the runtime's concurrency model — synchronous operations in single-threaded runtimes cannot race
- ❌ "Value could be undefined/null" when the language's type system already guarantees the type at that point
- ✅ Documentation that contradicts the implementation IS a valid finding

### Auto-Reject Patterns (NEVER record these)
- **Safe deletion**: Symbol removed + zero callers found = cleanup, not a bug
- **Missing observability**: Missing logging, metrics, or monitoring is a feature request, not a defect
- **Redundant runtime validation**: In statically-typed languages, internal functions called by type-checked code don't need runtime validation — the compiler enforces types. Only system boundaries (user input, external APIs, deserialization) need runtime checks
- **Hypothetical consumers**: "Future code might depend on X" — only EXISTING consumers matter
- **Test gaps for removed code**: Tests deleted alongside their tested code is correct cleanup
`
        : '';

    return `<finding_quality>
## Finding Quality Standards

**The core rule: A valid finding describes a concrete scenario where code produces wrong runtime behavior.** If you cannot describe WHO is affected, WHAT breaks, and WHEN it triggers — it is not a finding.

Most PRs are correct. A review that confirms correctness with zero findings is a successful, high-quality review.

### Evidence Bar
${evidenceBarText}

## Impact Proof Requirement

A finding is ONLY valid if you can demonstrate a concrete runtime failure:

1. **Name the affected component** — What specific function/method will produce wrong results?
2. **Name the failure mechanism** — HOW does it fail? (wrong value, exception, data corruption, etc.)
3. **Name the trigger** — What specific input, state, or call sequence causes it?

If you cannot answer all three, the issue is SPECULATIVE — do not record it.

### Deletion Safety Rule
If a symbol/function is deleted AND your investigation shows ZERO callers/importers (via find_symbol, find_usages, or search_for_pattern), this is EXPECTED CLEANUP — NOT a finding. You proved it's safe by proving nothing depends on it.

### Scope: Changed Code Only

ONLY report issues that are:
- Directly in code changed by this PR, OR
- In unchanged code where THIS PR's changes create a new failure path
${revertTestSection}
### Finding Classification

Classify every finding before reporting:

| Type | Definition | Evidence Bar |
|---|---|---|
| **MECHANICAL** | API contract violation, type error, missing null check, wrong constant, missing import, dead code | Standard — cite the tool call that found it |
| **INTENT-BASED** | Design decision seems wrong, threshold choice questionable, architecture concern | **Elevated** — MUST search for comments, docs, and commit history explaining the rationale. If ANY plausible documented intent exists, **DROP IT** |

Most high-confidence findings are MECHANICAL. Intent-based findings have the highest false positive rate because the reviewer lacks the author's full context.

**Required diligence for intent-based findings — before reporting, you MUST:**
1. Read the docstring/comments on the function/class itself
2. Search (grep) for keywords like "intentional", "by design", "not configurable", "hardcoded" near the code
3. Check docs/ for design documents explaining the decision
4. Check actual call sites — is the "vulnerability" actually reachable given how the code is called?

If ANY of these return a plausible explanation, DROP the finding.

### Mechanical Verification Checklist

For EACH changed function, answer these questions using tools. If any answer reveals a mismatch, you have a finding:

1. **Return type contract**: Does the function's return type match what ALL callers expect? Use \`find_usages\` on the function, then check each caller handles the return type correctly.
2. **Null/error paths**: If the function can return null, undefined, None, nil, or an error — do ALL callers handle that case? Use \`find_usages\` to check each call site.
3. **Parameter contracts**: If a parameter's valid range changed, do ALL callers pass valid values? Use \`find_usages\` to verify.
4. **Deleted symbol safety**: If a function/class was deleted, does \`find_usages\` show ZERO remaining callers? If callers remain, that's a broken reference.
5. **Modified interface compliance**: If a type/interface/struct changed, do ALL implementations satisfy the new contract? Use \`find_usages\` on the type.

These are the highest-signal checks. A mismatch found here is almost always a real bug.

### Verification Gates

Before reporting a finding, verify it matches its claim type:

- **"Missing error handling"**: Trace callers 2-3 levels up for outer try-catch, error boundaries, middleware, decorators, or centralized handlers.
- **"Value can be negative/zero/null"**: Trace the variable to its source; prove a concrete input produces the bad value.
- **"Design inconsistency"**: Check for comments/docs explaining rationale; if plausible intent exists, drop it.
- **"Should validate X"**: Trace all producers of X to prove an invalid value is reachable. Check if a caller or middleware already validates.
- **"Should add error handling"**: Check if an outer scope, framework layer, or decorator already catches and handles the error.
- **"Symbol unused/no callers/type wrong"**: Call \`validate_claim\` for LSP-grounded verification.
- **"Documentation claims X"**: Verify against the actual code — if the doc contradicts the implementation, this IS a valid finding.
- **"Race condition"**: Verify shared mutable state, a yield point between read and write, and that the runtime allows interleaving.

If you cannot complete verification: flag as 🔍 **Verify** or drop the finding.

### Counterexample Requirement

For every "X can go wrong" finding, provide:
1. **Concrete scenario**: specific input/state that triggers the failure
2. **Code path**: which functions execute, in what order — trace ALL callers to prove the bad input can actually reach this code
3. **Outcome**: what specifically breaks

If you cannot construct a concrete failing scenario with actual values, drop the finding.
If no caller can produce the problematic input, the path is unreachable — drop the finding.

### Confidence Levels

| Level | Definition | Max Severity Allowed |
|---|---|---|
| 🟢 VERIFIED | Tool-confirmed with cited evidence. Use \`validate_claim\` for compiler-grade verification | CRITICAL |
| 🟡 LIKELY | Strong reasoning, partial tool confirmation | HIGH |
| 🔴 SPECULATIVE | Pattern-match without tool verification | ❌ EXCLUDED |

CRITICAL/HIGH findings MUST be 🟢 VERIFIED with cited tool output.
SPECULATIVE findings are **EXCLUDED** from the review entirely.

### Required Impact Fields
Every finding MUST specify:
- **affected_component**: The exact function/method that produces wrong results. Verify it exists with find_symbol.
- **failure_mechanism**: One of: wrong_return_value, runtime_exception, data_corruption, security_bypass, resource_leak, type_error, contract_violation, race_condition
If you cannot fill these concretely, the finding is speculative — drop it.
${fpPatternsSection}
### Language-Aware Review

Different languages and runtimes have different semantics. Before reporting concurrency, type safety, or architectural issues, **verify the runtime model from the codebase context**:

- **Concurrency model**: Is the runtime single-threaded (Node.js, Python GIL), multi-threaded (Java, C++, Go), or actor-based (Erlang, Swift actors)? A race condition claim requires confirming that concurrent access is actually possible in the target runtime
- **Type system guarantees**: Strong static type systems provide compile-time guarantees that make some runtime checks redundant. Dynamic type systems may genuinely need runtime validation. Check what the compiler enforces before suggesting redundant checks
- **Framework conventions**: Many frameworks handle cross-cutting concerns (error handling, cleanup, validation) at specific layers. Check the framework's conventions before suggesting defensive code at the wrong layer

The key principle: **verify, don't assume.** The same code pattern can be a bug in one language and perfectly safe in another.
${
    calibration.findingBias !== 'dismissive'
        ? `
**Precision > Recall.** When uncertain, omit the finding — silence on a non-issue is better than noise.
Many well-written PRs have zero reportable findings. That is a normal, expected outcome.
`
        : `
### Investigation Thoroughness

Missing a real bug is costlier than investigating a false lead.
When evidence is ambiguous, investigate further — do not default to "it's probably fine."

**Investigate aggressively, record when plausible.**
If after thorough investigation you have a concern supported by tool output but cannot fully confirm it, record it as LOW severity — the post-analysis pipeline will filter weak findings automatically.
A failed tool call (find_usages returning nothing, find_symbol not found) does NOT prove safety. It means you lack the evidence to dismiss.`
}

### FALSE POSITIVE EXAMPLES — Learn from Past Mistakes

These are REAL findings from previous reviews that turned out to be 100% false positives. These patterns apply across ALL languages:

**Centralized Error Handling Misidentified as Gap:**
Finding: "Missing error handling in ServiceHandler — handle() has no try-catch"
Why FP: A centralized error handler (middleware, executor, decorator) wraps all calls. Individual functions intentionally omit try-catch.
Lesson: Trace the caller chain 2-3 levels up before reporting "missing error handling."

**Concurrency in Single-Threaded Runtime:**
Finding: "Race condition in EventProcessor — process() could have concurrent access issues"
Why FP: The runtime is single-threaded. Synchronous operations cannot race. No shared mutable state.
Lesson: Verify the runtime's concurrency model FIRST. Prove shared mutable state + yield point + true parallelism.

**Static Type System Treated as Needing Runtime Validation:**
Finding: "Missing input validation in generateConfig — parameters are not validated at runtime"
Why FP: Internal code in a statically-typed language, called by type-checked code, not at a system boundary.
Lesson: Runtime validation is only needed at SYSTEM BOUNDARIES (user input, external APIs, deserialization).

**Intentional Design Flagged as Bug:**
Finding: "Lenient validation in RequestHandler is risky"
Why FP: Intentional design, explicitly documented in code comments. The "leniency" IS the feature.
Lesson: Search for comments containing "intentional", "by design", "Note:" before reporting design choices as bugs.

</finding_quality>`;
}
