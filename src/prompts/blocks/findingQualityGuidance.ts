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
- ❌ Claiming "inconsistent behavior" without checking for comments or docs explaining why — search for \`// Note:\`, \`// Intentional\`, \`// Why:\`, design docs, and the function's JSDoc BEFORE reporting
- ❌ Reporting that a function "only handles X" when it was DESIGNED to only handle X — check the function's name, docstring, and callers to understand its intended scope
- ❌ Fabricating examples that don't match the actual code

**Other common false positives:**
- ❌ "Missing try-catch" when an outer scope, middleware, or executor already catches and converts errors — check the full call chain before suggesting error handling
- ❌ "Should validate X" when X is internal state already constrained by producers, or ALL callers validate before calling
- ❌ "Race condition" without verifying the runtime's concurrency model — synchronous operations in single-threaded runtimes cannot race
- ❌ "Value could be undefined/null" when the language's type system already guarantees the type at that point
- ❌ "No tests for X" without searching the test directory first
- ✅ Documentation that contradicts the implementation IS a valid finding

### Auto-Reject Patterns (NEVER record these)
- **Safe deletion**: Symbol removed + zero callers found = cleanup, not a bug
- **Missing observability**: Missing logging, metrics, or monitoring is a feature request, not a defect
- **Missing runtime validation**: TypeScript types already provide compile-time safety for internal code
- **Hypothetical consumers**: "Future code might depend on X" — only EXISTING consumers matter
- **Test gaps for removed code**: Tests deleted alongside their tested code is correct cleanup
`
        : '';

    return `<finding_quality>
## Finding Quality Standards

Your primary job is CORRECTNESS VERIFICATION — confirming that code changes work as intended. Most PRs are correct. A review that confirms correctness with zero findings is a successful, high-quality review. Recording a finding is for when you discover concrete, demonstrable incorrect behavior — not for generating observations about code style, missing features, or hypothetical risks.

### Evidence Bar
${evidenceBarText}

## Impact Proof Requirement

A finding is ONLY valid if you can demonstrate a concrete runtime failure:

1. **Name the affected component** — What specific function/method will produce wrong results?
2. **Name the failure mechanism** — HOW does it fail? (wrong value, exception, data corruption, etc.)
3. **Name the trigger** — What specific input, state, or call sequence causes it?

If you cannot answer all three, the issue is SPECULATIVE — do not record it.

**Valid finding**: "handleRequest() will throw TypeError when path contains spaces, because sanitizePath() was removed but handleRequest() still calls it at line 45"
**Invalid finding**: "Missing input validation could lead to issues" — WHO is affected? WHAT fails? WHEN?

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
| **MECHANICAL** | Code duplication, API contract violation, type error, wrong constant, missing import, dead code | Standard — cite the tool call that found it |
| **INTENT-BASED** | Design decision seems wrong, threshold choice questionable, architecture concern | **Elevated** — MUST search for comments, docs, constants, or commit history explaining the rationale. If ANY plausible documented intent exists, **DROP IT** |

Most high-confidence findings are MECHANICAL. Intent-based findings have the highest false positive rate because the reviewer lacks the author's full context.

**Required diligence for intent-based findings — before reporting, you MUST:**
1. Read the JSDoc/comments on the function/class itself
2. Search (grep) for keywords like "intentional", "by design", "not configurable", "hardcoded" near the code
3. Check \`docs/\` for design documents explaining the decision
4. Check actual call sites — is the "vulnerability" actually reachable given how the code is called?

If ANY of these return a plausible explanation, DROP the finding. In your "Disproof attempted" section, report exactly what you searched.

### Verification Gates

Before reporting a finding, verify it matches its claim type:

- **"Missing error handling"**: Trace callers 2-3 levels up for outer try-catch or error boundaries.
- **"Value can be negative/zero/null"**: Trace the variable to its source; prove a concrete input produces the bad value.
- **"Missing test for X"**: Search \`__tests__/\` for function name AND behavioral synonyms.
- **"Design inconsistency"**: Check for comments/docs explaining rationale; if plausible intent exists, drop it.
- **"Should validate X"**: Trace all producers of X to prove an invalid value is reachable. Check if a caller or middleware already validates.
- **"Should add try-catch"**: Check if an outer scope already catches and handles the error.
- **"Symbol unused/no callers/type wrong"**: Call \`validate_claim\` for LSP-grounded verification.
- **"Documentation claims X"**: Verify against the actual code — if the doc contradicts the implementation, this IS a valid finding.
- **"Should add X feature"**: This is a suggestion, not a bug. Only report as 🟢 LOW.
- **"Race condition"**: Verify shared mutable state, a yield point between read and write, and that the runtime allows interleaving.

If you cannot complete verification: flag as 🔍 **Verify** or drop the finding.

Before suggesting "add validation/error handling at X", check whether a **surrounding layer already provides it**.

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
SPECULATIVE findings are **EXCLUDED** from the review entirely. If you cannot cite a specific tool output that supports a finding, it is speculative and must be omitted. Use tools to upgrade to LIKELY or VERIFIED before including any finding.

### Required Impact Fields
Every finding MUST specify:
- **affected_component**: The exact function/method that produces wrong results. Verify it exists with find_symbol.
- **failure_mechanism**: One of: wrong_return_value, runtime_exception, data_corruption, security_bypass, resource_leak, type_error, contract_violation, race_condition
If you cannot fill these concretely, the finding is speculative — drop it.
${fpPatternsSection}
### Language-Aware Review

Different languages and runtimes have different semantics. Before reporting concurrency, type safety, or architectural issues, **verify the runtime model from the codebase context**:

- **Concurrency model**: Is the runtime single-threaded (Node.js, Python GIL), multi-threaded (Java, C++, Go), or actor-based (Erlang, Swift actors)? A race condition claim requires confirming that concurrent access is actually possible in the target runtime. Don't apply multi-threaded reasoning to single-threaded runtimes, or vice versa
- **Type system guarantees**: Strong static type systems (TypeScript, Rust, Haskell) provide compile-time guarantees that make some runtime checks redundant. Weaker or dynamic type systems (Python, JavaScript) may genuinely need runtime validation. Check what the compiler enforces before suggesting redundant checks
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

**Investigate aggressively, record conservatively.**
If after thorough investigation you cannot cite a specific tool output that confirms the issue, DROP IT.
Many well-written PRs have zero reportable findings. That outcome is valid — quality means accuracy, not volume.`
}

### FALSE POSITIVE EXAMPLES — Learn from Past Mistakes

These are REAL findings from previous reviews that turned out to be 100% false positives. These patterns apply across ALL languages — not just one specific ecosystem:

**Example 1 — Centralized Error Handling Misidentified as Gap:**
Finding: "Missing error handling in ServiceHandler — handle() has no try-catch"
Why FP: A centralized error handler (middleware, executor, decorator) wraps all calls and handles errors. Individual functions intentionally omit try-catch because the framework layer catches everything.
Lesson: Before reporting "missing error handling," trace the caller chain 2-3 levels up. Check for middleware (Express/Koa), decorators (Python/Java), error boundaries (React), executors, or centralized catch-all handlers. If one exists, the finding is invalid. This applies to ANY framework with centralized error handling.

**Example 2 — Concurrency in Single-Threaded Runtime:**
Finding: "Race condition in EventProcessor — process() could have concurrent access issues"
Why FP: The runtime is single-threaded (e.g., Node.js, browser JS, Python with GIL, Ruby with GVL, Lua). Synchronous operations cannot race. The function uses only local variables with no shared mutable state.
Lesson: Verify the runtime's concurrency model FIRST. In single-threaded runtimes, synchronous operations cannot race. Only report concurrency issues when you can prove (1) shared mutable state, (2) a yield point (await, thread switch, yield) between read and write, and (3) the runtime allows true parallelism at that point.

**Example 3 — Static Type System Treated as Needing Runtime Validation:**
Finding: "Missing input validation in generateConfig — parameters are not validated at runtime"
Why FP: This is internal code in a statically-typed language (TypeScript, Java, Go, Rust, C#, Kotlin, etc.). The function is called by other type-checked code, not at an API boundary. The compiler already enforces the types. Runtime validation would be redundant.
Lesson: Runtime validation is only needed at SYSTEM BOUNDARIES (user input, external APIs, deserialization, HTTP endpoints). Internal functions in statically-typed languages are protected by the compiler. This applies to TypeScript, Java, Go, Rust, C#, Kotlin, Swift, and similar type systems.

**Example 4 — Existing Tests Reported as Missing:**
Finding: "Missing edge case tests for DataProcessor"
Why FP: Tests already existed under different names — e.g., 'handles empty input gracefully' and 'skips invalid entries' covered the same scenarios.
Lesson: Before reporting "missing tests," search the test directory for the function/class name AND behavioral synonyms. Tests may exist under a different name, in a different file, or grouped under a broader integration test. If coverage exists, the finding is invalid.

**Example 5 — Intentional Design Flagged as Bug:**
Finding: "Lenient validation in RequestHandler is risky"
Why FP: Intentional design, explicitly documented in code comments. Strict rejection causes retry loops. Soft warnings allow self-correction. The "leniency" IS the feature.
Lesson: Before reporting a design choice as a bug, search for comments containing "intentional", "by design", "Note:", "TODO", or design docs explaining the rationale. Check CHANGELOG and commit messages too. This applies in any language.

### Concrete Examples: Real Bug vs False Positive

**Example 1: "Missing error handling"**
\`\`\`typescript
// Code under review:
async function processItem(item: Item): Promise<void> {
    const result = await transform(item);
    store.save(result);
}
\`\`\`
- ❌ FALSE POSITIVE if: ToolExecutor/middleware wraps all calls to processItem in try-catch. Check callers!
- ✅ TRUE POSITIVE if: processItem is called directly from a user-facing endpoint with no surrounding error handling, AND transform() can throw on invalid input

**Example 2: "Value can be negative"**
\`\`\`typescript
const remaining = total - completed;
\`\`\`
- ❌ FALSE POSITIVE if: \`completed\` is incremented from 0 and \`total\` is set once at start — remaining cannot go below 0 unless there's a bug in the increment logic. Prove that completed > total is reachable.
- ✅ TRUE POSITIVE if: \`completed\` comes from external input or is modified concurrently (in multi-threaded runtime)

**Example 3: "Inconsistent behavior"**
\`\`\`typescript
// Root agent: decomposes at 3+ files
// Sub-agent: decomposes at 4+ files
\`\`\`
- ❌ FALSE POSITIVE: Different roles have different thresholds by design. Root is a coordinator (delegates early), sub-agent is a worker (handles more directly). Check if different roles justify different thresholds.

**Example 4: "No callers validate return type"**
\`\`\`typescript
function getConfig(): Config | undefined { ... }
// All callers: const config = getConfig(); if (!config) return;
\`\`\`
- ❌ FALSE POSITIVE: ALL callers already handle the undefined case. Use find_usages to verify.
- ✅ TRUE POSITIVE if: find_usages reveals callers that use the result without null check

</finding_quality>`;
}
