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
              ? 'Record ONLY with strong, concrete evidence from tool output — speculative concerns must be verified or dropped'
              : 'Record when evidence confirms an issue';

    const fpPatternsSection = includeFPGuide
        ? `
### False Positive Patterns — Avoid These

**Design Intent Blindness** — the #1 source of false positives:
- ❌ Claiming "inconsistent behavior" without checking for comments or docs explaining why — search for \`// Note:\`, \`// Intentional\`, \`// Why:\`, design docs, and the function's JSDoc BEFORE reporting
- ❌ Reporting that a function "only handles X" when it was DESIGNED to only handle X — check the function's name, docstring, and callers to understand its intended scope
- ❌ Claiming a counter/metric "miscounts" without understanding what it's tracking — "completed" may mean "finished" (including failures), not "succeeded". Read the callers and UI that consumes the value
- ❌ Flagging standard CS primitives as "risky" (e.g., semaphores deadlock on reentrant acquire, hash maps don't preserve insertion order) — these are known properties of the data structure, not bugs
- ❌ Fabricating examples that don't match the actual code — if a log says \`#5 spawned (5/10, 5 remaining)\`, don't claim it shows \`#5 spawned (2/10)\`

**Other common false positives:**
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
- ✅ Documentation that contradicts the implementation IS a valid finding — if a doc claims a tool/setting/behavior works one way but the code does the opposite, report it. Docs ship with the product
- ❌ "Architecture should use X pattern" without evidence the current approach causes concrete problems
- ❌ Reporting pre-existing tech debt as a PR finding
- ❌ Flagging an untested code path that is unreachable — if no caller can produce the input, there's nothing to test
- ❌ "Race condition" without verifying the runtime's concurrency model — in single-threaded runtimes (Node.js, Python GIL), synchronous operations cannot race. Verify the runtime allows concurrent access AND shared state is accessed without synchronization before reporting
- ❌ "Value could be undefined/null" when the language's type system already guarantees the type at that point — check what the compiler enforces (e.g., TypeScript narrowing, Rust ownership, Kotlin null safety) before suggesting redundant runtime checks
- ❌ "Math.max(x, 0) can return 0" or similar bounded arithmetic — the bounded value IS the designed behavior. \`Math.max\`, \`Math.min\`, and clamping produce edge values by design. Unless the edge value causes a concrete downstream failure (prove it with a code path), this is not a finding
- ❌ "Property X is set but not immediately used" when the property follows a set-at-start, read-at-end lifecycle (timers, session state, accumulators). The gap between set and use is by design
- ❌ "Method should be called X instead of Y" or similar naming/style preferences — unless the name causes demonstrable confusion or bugs, naming is a style preference, not a defect
`
        : '';

    return `<finding_quality>
## Finding Quality Standards

### Evidence Bar
${evidenceBarText}

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
| "Symbol unused/no callers/type wrong" | Call \`validate_claim\` for LSP-grounded verification — the result is compiler-grade and overrides LLM reasoning |
| "Documentation claims X" | Verify the claim against the actual code — search for the referenced constants, tool lists, settings, API behavior. If the documentation contradicts the implementation, this IS a valid finding |
| "Should add X feature" | This is a suggestion, not a bug. Only report as 🟢 LOW if directly relevant to changed code |
| "Race condition" | Verify (1) shared mutable state exists, (2) a yield point (e.g., \`await\`, thread switch, \`yield\`) separates the read and write of that state, and (3) the runtime's concurrency model allows interleaving at that point. In single-threaded runtimes, two synchronous operations without a yield point between them CANNOT race — drop it |
| "Pre-existing issue" | Focus on issues in changed code. If it existed before this PR, it's not a PR finding |

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
| 🟢 VERIFIED | Tool-confirmed with cited evidence. Use \`validate_claim\` for compiler-grade verification | CRITICAL |
| 🟡 LIKELY | Strong reasoning, partial tool confirmation | HIGH |
| 🔴 SPECULATIVE | Pattern-match without tool verification | ❌ EXCLUDED |

CRITICAL/HIGH findings MUST be 🟢 VERIFIED with cited tool output.
SPECULATIVE findings are **EXCLUDED** from the review entirely. If you cannot cite a specific tool output that supports a finding, it is speculative and must be omitted. Use tools to upgrade to LIKELY or VERIFIED before including any finding.
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
### False Positive Cost

False positives erode developer trust faster than true positives build it.
**Every false positive costs more credibility than a true positive earns.**
When uncertain, omit the finding — silence on a non-issue is better than noise.
Many well-written PRs have zero reportable findings. That is a normal, expected outcome — not a review failure.`
        : `
### Investigation Thoroughness

Missing a real bug is costlier than investigating a false lead.
When evidence is ambiguous, investigate further — do not default to "it's probably fine."
Use tools to resolve ambiguity: call \`validate_claim\`, \`find_usages\`, or \`search_for_pattern\` instead of reasoning your way to dismissal.

### Prosecution Mode ≠ Lower Evidence Bar

You are in prosecution mode: your job is to generate MORE hypotheses and investigate them MORE thoroughly. But prosecution mode does NOT lower the evidence bar for recording findings.

**Prosecution means:**
- Generate more hypotheses — at least 2-3 per file
- Investigate each hypothesis with tools — do not dismiss based on reasoning alone
- If a tool result is ambiguous, use ANOTHER tool to clarify — do not record ambiguity as a finding

**Prosecution does NOT mean:**
- Recording findings when you couldn't verify them ("ambiguity persists, recording anyway")
- Using prosecution mode as justification to skip verification
- Treating inconclusive \`validate_claim\` results as confirmation

**The rule: Investigate aggressively, record conservatively.**
If after thorough investigation you cannot cite a specific tool output that confirms the issue, DROP IT. Recording unverified findings destroys review credibility. A review with 2 verified findings is worth more than 5 unverified ones.`
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
