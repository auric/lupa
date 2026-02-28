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
| "Missing test for X" | Search \`__tests__/\` for function name AND behavioral synonyms. Then verify the proposed test would catch a **concrete regression** — not just exercise a code path |
| "Missing documentation" | Search README, \`docs/\`, and CHANGELOG for the concept by keyword |
| "Design inconsistency" | Check for comments/docs explaining rationale; if plausible intent exists, **drop it** |
| "Should validate X" | Trace all producers of X to prove an invalid value is reachable. Check if a **caller or middleware** already validates — redundant validation is not a finding |
| "Should add try-catch" | Check if an outer scope (middleware, executor, framework) already catches and handles the error — redundant error handling is not a finding |
| "Method X lacks guard Y" | Before reporting, find ALL callers of X. If every call-site already performs Y before calling X, the method is safe by **call-site contract**. Single-entry-point methods protected by their caller do not need redundant internal guards |
| "Missing integration test" | Check if each layer already has unit tests covering the code paths. Estimate test complexity: if the test spans 3+ mocked layers and primarily exercises mock wiring rather than real logic, it is likely not worth adding |
| "Unused / incorrect public method" | Before reporting an issue about a public method's behavior, verify it has **production callers** (not just test consumers). Methods with zero production callers are NOT findings — they are future API surface or test infrastructure |
| "Missing cleanup/disposal" | Check framework config (vitest.config, jest.config) for global settings |
| "Design flaw / should refactor" | Search for comments, docs, tests, or commit history explaining the design. If ANY plausible rationale exists, drop the finding |
| "Should add X feature" | This is a suggestion, not a bug. Only report as 🟢 LOW if directly relevant to changed code |
| "Race condition" | Verify (1) shared mutable state exists, (2) a yield point (e.g., \`await\`, thread switch, \`yield\`) separates the read and write of that state, and (3) the runtime's concurrency model allows interleaving at that point. In single-threaded runtimes, two synchronous operations without a yield point between them CANNOT race — drop it |
| "Pre-existing issue" | Apply the Revert Test above. If reverting wouldn't fix it, drop it |

If you cannot complete verification: flag as 🔍 **Verify** or drop the finding.

### Layered Validation Awareness

Many codebases use layered architecture where validation happens at specific boundaries:
- **Middleware/executor catches errors** → individual functions don't need try-catch
- **Caller validates before calling** → callee doesn't need to re-validate inputs
- **Framework handles lifecycle** → components don't need manual cleanup
- **Type system constrains values** → runtime validation is redundant for typed internals

Before suggesting "add validation/error handling at X", check whether a **surrounding layer already provides it**. Redundant defensive code is not an improvement — it's noise.

**Defense-in-depth is for trust boundaries**, not internal method calls. Adding redundant validation between two methods in the same module is noise, not safety. Reserve defensive checks for system boundaries: user input, external APIs, plugin interfaces.

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
| 🟢 VERIFIED | Tool-confirmed with cited evidence | CRITICAL |
| 🟡 LIKELY | Strong reasoning, partial tool confirmation | HIGH |
| 🔴 SPECULATIVE | Pattern-match without tool verification | ❌ EXCLUDED |

CRITICAL/HIGH findings MUST be 🟢 VERIFIED with cited tool output.
SPECULATIVE findings are **EXCLUDED** from the review entirely. If you cannot cite a specific tool output that supports a finding, it is speculative and must be omitted. Use tools to upgrade to LIKELY or VERIFIED before including any finding.

### False Positive Patterns — Avoid These

- ❌ "Can go negative" without proving a concrete input exists that causes it
- ❌ "No tests for X" without searching the test directory first
- ❌ "Inconsistent thresholds" for intentionally asymmetric designs — different roles may have different thresholds by design (e.g., coordinator delegates at 3+ files, workers decompose at 4+). Verify the ROLE before claiming inconsistency
- ❌ "Missing cleanup" when the test framework config handles it globally
- ❌ "Unused callback/dead code" when the interface is an extension point
- ❌ "Should validate X" when X is internal state already constrained by producers
- ❌ "Missing try-catch" / "Should add try-catch" when an outer scope, middleware, or executor already catches and converts errors — this includes centralized error handlers (e.g., ToolExecutor, Express middleware, Redux middleware) that wrap all callees. Check the full call chain before suggesting error handling
- ❌ "Method X doesn't validate Y" when ALL callers of X already validate Y before calling — the method is safe by call-site contract. This applies to pre-flight guards (e.g., \`canSpawn\` before \`register\`), schema validation before processing, and permission checks before action
- ❌ "Missing filtering/dedup" in data aggregation when the data model guarantees the property by construction — e.g., if only one method populates a field and it runs only for completed items, aggregating all items is already correct without runtime filtering
- ❌ "Should add X" (logging, metrics, retry logic) as MEDIUM or higher — suggestions are 🟢 LOW at most
- ❌ "Missing test" when the test exists under a different name, or the proposed test only exercises trivial pass-through logic (e.g., testing that a spread operator works, that a mock factory returns defaults)
- ❌ "Missing integration test" when each layer has unit tests covering the same code paths — if the proposed test spans 3+ mocked layers, it primarily exercises mock infrastructure, not real logic
- ❌ "O(n*m) is slow" or similar performance concerns without quantifying actual n and m — for bounded inputs (schema-capped arrays, typical PR sizes), linear scans are often optimal. Premature optimization is not a finding
- ❌ Reporting a public method's behavior as incorrect when the method has zero production callers — it may be future API surface. Check for actual usage before reporting
- ❌ "Should document rationale" when the rationale is in CHANGELOG, commit messages, or design docs — not every constant needs inline comments
- ❌ Issues in unchanged code that the PR doesn't make worse
- ❌ "Architecture should use X pattern" without evidence the current approach causes concrete problems
- ❌ Reporting pre-existing tech debt as a PR finding
- ❌ Flagging an untested code path that is unreachable — if no caller can produce the input, there's nothing to test
- ❌ "Race condition" without verifying the runtime's concurrency model — in single-threaded runtimes (Node.js, Python GIL), synchronous operations cannot race. Verify the runtime allows concurrent access AND shared state is accessed without synchronization before reporting
- ❌ "Value could be undefined/null" when the language's type system already guarantees the type at that point — check what the compiler enforces (e.g., TypeScript narrowing, Rust ownership, Kotlin null safety) before suggesting redundant runtime checks
- ❌ "Math.max(x, 0) can return 0" or similar bounded arithmetic — the bounded value IS the designed behavior. \`Math.max\`, \`Math.min\`, and clamping produce edge values by design. Unless the edge value causes a concrete downstream failure (prove it with a code path), this is not a finding
- ❌ "Property X is set but not immediately used" when the property follows a set-at-start, read-at-end lifecycle (timers, session state, accumulators). The gap between set and use is by design
- ❌ "Method should be called X instead of Y" or similar naming/style preferences — unless the name causes demonstrable confusion or bugs, naming is a style preference, not a defect

### Language-Aware Review

Different languages and runtimes have different semantics. Before reporting concurrency, type safety, or architectural issues, **verify the runtime model from the codebase context**:

- **Concurrency model**: Is the runtime single-threaded (Node.js, Python GIL), multi-threaded (Java, C++, Go), or actor-based (Erlang, Swift actors)? A race condition claim requires confirming that concurrent access is actually possible in the target runtime. Don't apply multi-threaded reasoning to single-threaded runtimes, or vice versa
- **Type system guarantees**: Strong static type systems (TypeScript, Rust, Haskell) provide compile-time guarantees that make some runtime checks redundant. Weaker or dynamic type systems (Python, JavaScript) may genuinely need runtime validation. Check what the compiler enforces before suggesting redundant checks
- **Framework conventions**: Many frameworks handle cross-cutting concerns (error handling, cleanup, validation) at specific layers. Check the framework's conventions before suggesting defensive code at the wrong layer

The key principle: **verify, don't assume.** The same code pattern can be a bug in one language and perfectly safe in another.

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
2. **Verify scope**: For "missing error handling" — check if a caller, middleware, or executor already catches the error. Redundant try-catch is not a finding
3. **Prove it**: For "X can fail" — trace ALL callers to prove a bad input can reach this code, then provide the concrete scenario. Unreachable paths are not findings
4. **Search first**: For "missing test/docs" — search \`__tests__/\` and \`docs/\` before claiming absence. Then verify the proposed test would catch a real regression, not just exercise trivial logic
5. **Consider intent**: For "design flaw" — check if the design is intentional (comments, docs, tests, changelogs). If plausible rationale exists, drop it
6. **Layered architecture**: Before suggesting validation/error handling, check if a surrounding layer already provides it. Don't suggest try-catch when a middleware catches, or input validation when the caller already validates
7. **Suggestions ≠ bugs**: "Should add X" is a suggestion, not a bug. Report as LOW only, never higher
8. **When uncertain, omit**: If you're not sure whether something is an issue after investigation, leave it out entirely. Silence on a non-issue is better than noise
9. **Check callers exist**: Before reporting a public method's behavior as a bug, verify it has production callers — methods with only test consumers may be future API surface
10. **Quantify performance**: Don't flag "O(n*m) is slow" without knowing actual n and m. For bounded inputs (schema-capped, small collections), linear scans are fine
11. **Call-site contract**: Before reporting "method X lacks guard Y", find ALL callers of X. If every caller performs Y before calling X (pre-flight pattern), the method is safe — don't suggest redundant internal guards
12. **Centralized handlers**: If a middleware/executor catches errors at the call boundary, don't suggest try-catch in individual callees. The handler exists for a reason
13. **Confidence caps**: CRITICAL/HIGH findings MUST be tool-verified with cited evidence. SPECULATIVE findings (pattern-match without tool verification) are EXCLUDED — use tools to verify before including
14. **When genuinely suspicious, flag**: If you suspect a real issue AND you made a genuine attempt to verify with tool calls but couldn't fully confirm, report it as 🔍 **Verify** with your reasoning. This is NOT an escape hatch for skipping verification — you must have actually called tools first
15. **Verify concurrency model**: Before reporting race conditions, confirm the runtime actually allows concurrent access. Single-threaded runtimes (Node.js, Python with GIL) serialize synchronous operations — they cannot race without an explicit yield point. Multi-threaded runtimes (Java, C++, Go) CAN race on shared mutable state. Check the runtime first
16. **Use definitive language**: Back every claim with tool evidence. Avoid 'could potentially,' 'might lead to,' 'consider adding' — these signal speculation. If you can't state the issue definitively with evidence, it's not a finding`;
}
