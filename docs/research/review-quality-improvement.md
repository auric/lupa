# Review Quality Improvement: Reducing False Positives in AI Code Review

**Date:** June 2025
**Based on:** Empirical triage of 40 findings across 3 review rounds + industry research

---

## Executive Summary

AI code review tools produce **60–85% false positive rates** on complex codebases without targeted mitigation. Lupa's current prompt-based quality architecture provides ~20 prompt-level gates, 5 tool-level checkpoints, and ~14 programmatic validations, but FPs still slip through because **prompt-only quality control plateaus around 60–70% accuracy**.

The highest-ROI improvements shift verification from self-judgment (LLM evaluating its own claims) to external checks (programmatic validation, tool-based re-verification, structured output schemas). This document catalogs root causes, maps the current architecture, and provides a prioritized roadmap.

---

## 1. Empirical FP Data

### Triage Results

| Round     | Source           | Findings | FP     | Debatable | Valid | FP Rate    |
| --------- | ---------------- | -------- | ------ | --------- | ----- | ---------- |
| 1         | Lupa self-review | 10       | 7      | 2         | 1     | 70–90%     |
| 2         | External LLM     | 10       | 8      | 2         | 0     | 80–100%    |
| 3         | External LLM     | 20       | 12     | 3         | 5     | 60–75%     |
| **Total** |                  | **40**   | **27** | **7**     | **6** | **67–85%** |

_Range depends on whether debatable findings are counted as FP._

### Industry Benchmarks (Approximate)

| Tool                   | Reported FP Rate | Notes                                              |
| ---------------------- | ---------------- | -------------------------------------------------- |
| cubic                  | ~11%             | Structured output, verification agents, multi-pass |
| CodeRabbit             | ~15%             | Static analysis integration, user feedback loops   |
| First-gen AI reviewers | 40–50%+          | Single-pass prompt-only approaches                 |
| BugBot (Microsoft)     | Not published    | Uses Roslyn analyzers + LLM for C#/.NET            |

_Sources: published blog posts and marketing materials, not independent benchmarks. Actual rates depend on codebase complexity and measurement methodology._

---

## 2. False Positive Root Cause Taxonomy

Derived from manually triaging 40 findings. Each category includes the percentage of FPs it represents, a concrete example from our reviews, and which architectural improvement targets it.

### 2.1 Design Intent Blindness (~40% of FPs)

**Pattern**: The reviewer doesn't understand _why_ the code was written this way and reports an intentional design choice as a bug.

**Examples from triage**:

- "`MAX_TOOL_RESPONSE_CHARS` should be configurable" — it's an LLM context budget, hardcoded by design
- "Tool X should be available in subagent mode" — it's `ROOT_ONLY_TOOLS` by architecture
- "`AsyncSemaphore.acquire()` could get non-integer" — every call site passes `1`

**Root cause**: The LLM sees code but not the design rationale. Comments, JSDoc, and architectural documentation that explain "why" are either missing or not consulted.

**Fix targets**: Intent verification prompts (implemented), JSDoc/comment checking requirement (implemented), call-site checking via `find_usages` (implemented), architectural context injection (gap).

### 2.2 Wrong Factual Premise (~20% of FPs)

**Pattern**: The reviewer bases a finding on incorrect facts — wrong file association, miscounted parameters, misunderstood API contracts.

**Examples from triage**:

- "Uses 8K context window" — model actually has 128K+
- "CHANGELOG says 30s but code uses 60s" — valid finding, but many in this category are factually wrong in the other direction
- "Function missing from tool table" — the function is listed under a different name

**Root cause**: LLM confabulates details or carries forward assumptions from earlier in the conversation. No external fact-checking mechanism exists.

**Fix targets**: Structured output with verifiable fields (gap), programmatic fact-checking (gap — e.g., verify file exists, line range valid), cross-referencing tool call results (gap).

### 2.3 Mode/Context Confusion (~15% of FPs)

**Pattern**: The reviewer doesn't understand architectural separation — browser vs Node, root vs subagent, per-analysis vs singleton.

**Examples from triage**:

- "Webview should use vscode API" — webview runs in browser context, no vscode access
- "Tool should be available in exploration mode" — it's intentionally restricted to root
- "finalization tools are missing from restricted list" — they're ROOT_ONLY_TOOLS, not restricted

**Root cause**: Complex architectures with modal behavior confuse the LLM. The system prompt explains modes, but the LLM loses track during deep investigation.

**Fix targets**: Mode awareness reinforcement in subagent prompts (partial), architectural context injection per concern group (gap), programmatic mode validation on findings (gap).

### 2.4 Theoretical-Only Concerns (~15% of FPs)

**Pattern**: The issue is technically possible but can't happen in practice due to upstream validation, runtime guarantees, or call-site constraints.

**Examples from triage**:

- "Quadratic complexity in markdown processing" — input is bounded by LLM token limits
- "Race condition in semaphore" — Node.js is single-threaded
- "Missing null check on parameter" — TypeScript compiler prevents null at call sites

**Root cause**: LLM applies generic security/safety patterns without checking whether the concern is reachable in this specific codebase.

**Fix targets**: Counterexample requirement (existing), call-site verification (implemented), reachability analysis prompts (partial), static analysis integration (gap).

### 2.5 Complementary Block Misunderstanding (~10% of FPs)

**Pattern**: The reviewer reports a gap in prompt section A, not realizing that section B already covers it. The LLM sees prompts incrementally and loses the full picture.

**Examples from triage**:

- "Standard guide missing tool details" — `tool_selection_guide` has comprehensive tool docs
- "No quality guidance for subagents" — `thinkAboutInvestigationTool` injects quality checks
- "Missing coverage tracking" — `recursiveMethodology` Step 4 checks file coverage

**Root cause**: Prompt blocks are composed at runtime; the LLM reviewing one block doesn't have full visibility into all other blocks. This is unique to reviewing prompt-based systems.

**Fix targets**: Cross-reference documentation in prompt blocks (partial), full prompt dump for reviewer context (gap), programmatic complementarity checking (unlikely to be feasible).

---

## 3. Current Quality Architecture

### 3.1 Prompt-Level Gates (~20 mechanisms)

These are text instructions embedded in the system prompt that guide the LLM's behavior.

| Gate                           | Location                    | What It Does                                                                             | Primary FP Category       |
| ------------------------------ | --------------------------- | ---------------------------------------------------------------------------------------- | ------------------------- |
| Revert Test                    | `findingQualityGuidance.ts` | "Would reverting the PR fix this?" — if no, drop it                                      | Pre-existing issues       |
| Scope Boundary Rule            | `findingQualityGuidance.ts` | Only report issues in changed code                                                       | Scope drift               |
| Finding Classification         | `findingQualityGuidance.ts` | MECHANICAL (tool-confirmed) vs INTENT-BASED (needs design search)                        | Design Intent Blindness   |
| Verification Gates             | `findingQualityGuidance.ts` | Per-claim-type verification (missing error handling → check catch blocks, etc.)          | Speculative claims        |
| Mandatory Intent Diligence     | `findingQualityGuidance.ts` | 4-step check for intent-based findings (JSDoc, docs/, comments, call sites)              | Design Intent Blindness   |
| Counterexample Requirement     | `findingQualityGuidance.ts` | Concrete scenario with actual input values required                                      | Theoretical-Only          |
| Confidence Calibration         | `findingQualityGuidance.ts` | CRITICAL/HIGH require VERIFIED; SPECULATIVE excluded entirely                            | Severity inflation        |
| FP Pattern Catalog             | `findingQualityGuidance.ts` | ~25 documented anti-patterns to recognize and avoid                                      | All categories            |
| Language-Aware Review          | `findingQualityGuidance.ts` | Runtime/type system semantics (Node.js single-threaded, TS compile-time)                 | Theoretical-Only          |
| Layered Validation Awareness   | `findingQualityGuidance.ts` | Check if middleware/framework already handles the concern                                | Design Intent Blindness   |
| Speculative Language Exclusion | `outputFormat.ts`           | Drop findings using "could potentially", "might", "consider adding"                      | Weak-evidence findings    |
| Pre-Submission Checklist       | `outputFormat.ts`           | Before any finding: name confirming tool, disproof attempt, in changed code, Revert Test | All categories            |
| Plan-First Methodology         | `analysisMethodology.ts`    | First tool call must be `update_plan` — structure before investigate                     | Unfocused investigation   |
| Hypothesis Kill Ratio          | `analysisMethodology.ts`    | Target dropping 40–60% of initial hypotheses via disproof                                | Over-credulous acceptance |
| Sub-Agent Finding Validation   | `recursiveMethodology.ts`   | Treat subagent findings as UNVERIFIED CLAIMS; re-verify CRITICAL/HIGH                    | Echo chamber              |
| Per-File Density Check         | `recursiveMethodology.ts`   | If >3 findings per file, scrutinize each                                                 | Noise cascade             |
| Bias Check                     | `recursiveMethodology.ts`   | "Would I mass-file this as a bug with my name on it?"                                    | Over-reporting            |
| Investigation Depth Req.       | `recursiveMethodology.ts`   | Subagents must call `get_file_diff` for every assigned file                              | Lazy investigation        |
| Articulation Over Checklists   | `selfReflection.ts`         | Force explicit "I examined X and found Y" not passive checks                             | Superficial reflection    |

### 3.2 Tool-Level Gates (5 mechanisms)

Self-verification tools the LLM calls during analysis.

| Tool                        | Purpose                                   | Key Fields                                                        | FP Prevention                              |
| --------------------------- | ----------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------ |
| `think_about_context`       | Articulate context gaps before proceeding | `remaining_gaps`, `decision`                                      | Incomplete context → premature conclusions |
| `think_about_task`          | Structure investigation focus             | `issues_found` (with severity), `areas_needing_investigation`     | Scope drift, severity inflation            |
| `think_about_completion`    | Pre-submission verification               | `files_analyzed` vs `files_in_diff` (coverage %)                  | Incomplete coverage, unjustified severity  |
| `think_about_investigation` | Subagent self-check with quality guidance | `questions_answered`, `evidence_gathered`, call-site verification | Subagent ghost claims, unfocused work      |
| `submit_review`             | Explicit completion signal                | Enforces Evidence + Disproof sections in output                   | Premature submission, format violations    |

### 3.3 Programmatic Gates (~14 mechanisms)

Code-level validation that runs automatically.

| Mechanism                   | Location                         | What It Validates                                                  |
| --------------------------- | -------------------------------- | ------------------------------------------------------------------ |
| Zod Schema Validation       | `toolExecutor.ts`                | Tool arguments match expected types/shapes                         |
| Response Size Limit         | `toolExecutor.ts`                | Tool results ≤ `MAX_TOOL_RESPONSE_CHARS`                           |
| Tool Call Rate Limiting     | `toolExecutor.ts`                | Total calls ≤ `maxIterations × 2`                                  |
| Tool Hallucination Blocking | `conversationRunner.ts`          | Blocks calls to disabled tools                                     |
| Token Validation            | `tokenValidator.ts`              | Warns at 70% and 90% of context limit                              |
| Context Cleanup             | `tokenValidator.ts`              | Removes oldest tool results when near limit                        |
| Investigation Depth Check   | `conversationRunner.ts`          | Subagents must make minimum tool calls                             |
| Wind-Down Nudge at 85%      | `conversationRunner.ts`          | Warning when 85% of iterations used                                |
| Final Iteration Enforcement | `conversationRunner.ts`          | Removes tools on last turn, forces synthesis                       |
| Min Substantive Response    | `conversationRunner.ts`          | Falls back to last >50-char response if API returns trivial output |
| Explicit Completion Nudging | `conversationRunner.ts`          | Nudges LLM to call `submit_review` (max 2 attempts)                |
| Cancellation Precedence     | `toolExecutor.ts`                | Cancel check before rate limit to prevent masking                  |
| Rate Limit Retry Backoff    | `conversationRunner.ts`          | Exponential backoff: 2s → 60s, max 5 retries                       |
| Tool Call Audit Trail       | `toolCallingAnalysisProvider.ts` | Records every tool call with args, result, duration                |

---

## 4. Identified Gaps

Where FPs slip through despite the current architecture.

| #   | Gap                                                        | Impact                                                                                   | FP Category Affected                    | Severity |
| --- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------- | -------- |
| 1   | **No programmatic validation of finding content**          | Findings with invalid file paths, wrong line numbers, or missing evidence pass through   | Wrong Factual Premise                   | High     |
| 2   | **No cross-validation between findings**                   | Contradictory findings (e.g., "too much validation" + "missing validation") both survive | All categories                          | Medium   |
| 3   | **No deduplication logic at aggregation**                  | Multiple subagents report same issue from different angles                               | Noise                                   | Medium   |
| 4   | **No verification agent / second opinion**                 | Single model judges its own work; self-assessment is unreliable                          | All categories                          | High     |
| 5   | **No feedback loop from FP → prompt refinement**           | Known FP patterns require manual prompt editing                                          | All categories                          | Medium   |
| 6   | **Root agent trusts subagent severity without re-scoring** | Subagents tend to inflate severity; root passes it through                               | Severity inflation                      | Medium   |
| 7   | **No static analysis integration for fact-checking**       | LLM can't verify type correctness, reachability, or runtime behavior                     | Theoretical-Only, Wrong Factual Premise | High     |
| 8   | **Single-model, single-pass for initial review**           | No diversity of perspective; one model's blind spots dominate                            | Design Intent Blindness                 | Medium   |
| 9   | **No confidence scoring on individual findings**           | Binary include/exclude decision; no graduated confidence                                 | All categories                          | Low      |

---

## 5. Industry Approaches to FP Reduction

Based on research of published architectures and blog posts.

### 5.1 Verification Agent (Augment, Cursor)

A dedicated agent reviews the initial findings and challenges each one. Acts as "devil's advocate."

- **How it works**: After initial review generates findings, a second pass with a different prompt (or model) attempts to _refute_ each finding. Findings that survive are higher confidence.
- **FP reduction**: 40–60% estimated for CRITICAL/HIGH findings
- **Complexity**: Medium — requires second model call per review, roughly doubles cost
- **Applicable to Lupa**: High fit. Could be implemented as a post-aggregation phase where root agent verifies subagent findings with tools.

### 5.2 Multi-Model Voting (Qodo, academic research)

Multiple models independently review the same code, and only findings reported by ≥2 models are kept.

- **How it works**: Same diff sent to 2–3 different models (or same model with different temperatures). Intersection of findings is the final output.
- **FP reduction**: 30–50% estimated
- **Complexity**: High — multiplies cost linearly with model count, requires aggregation logic
- **Applicable to Lupa**: Medium fit. Expensive but effective. Could use majority voting for high-severity findings only.

### 5.3 Static Analysis Integration (CodeRabbit, BugBot)

Pair LLM findings with static analyzer output. LLM focuses on intent/design; static analyzer handles correctness.

- **How it works**: Run linters, type checkers, or Roslyn analyzers alongside LLM. Cross-reference: findings confirmed by both are high-confidence; LLM-only findings are flagged for review.
- **FP reduction**: 20–30% estimated (eliminates Wrong Factual Premise and Theoretical-Only categories)
- **Complexity**: Low to medium — VS Code has built-in diagnostics API
- **Applicable to Lupa**: High fit. Could leverage `vscode.languages.getDiagnostics()` to ground findings in compiler/linter output.

### 5.4 Structured Output + Programmatic Validation

Force JSON-schema output with required evidence fields, then validate programmatically.

- **How it works**: Each finding must include `file_path`, `line_range`, `evidence_tool_call_id`, `disproof_attempted`. Programmatic checks verify: file exists, line range valid, referenced tool call exists in audit trail.
- **FP reduction**: 10–20% estimated (catches Wrong Factual Premise cheaply)
- **Complexity**: Low — schema already partially exists in `submit_review`
- **Applicable to Lupa**: Very high fit. Lowest-cost, highest-certainty improvement.

### 5.5 User Feedback Loops (cubic, Greptile, CodeRabbit)

Track which findings users dismiss as FP. Use this data to tune prompts or train classifiers.

- **How it works**: Users mark findings as "not helpful." Over time, a classifier learns which patterns to suppress, or findings matching dismissed patterns are auto-downgraded.
- **FP reduction**: 15–25% estimated over multiple review cycles
- **Complexity**: Medium — requires telemetry, storage, and analysis pipeline
- **Applicable to Lupa**: Medium fit long-term. Requires adoption volume for statistical significance.

---

## 6. Improvement Roadmap

Prioritized by ROI (FP reduction per unit of implementation effort).

### Phase 1: Prompt Improvements ✅ (Completed)

**Status**: Implemented in this session.

| Change                                  | File                             | FP Category Targeted             |
| --------------------------------------- | -------------------------------- | -------------------------------- |
| Root Skepticism for subagent findings   | `recursiveMethodology.ts`        | Echo chamber, Severity inflation |
| Call-site verification requirement      | `thinkAboutInvestigationTool.ts` | Design Intent Blindness          |
| Mandatory 4-step intent-based diligence | `findingQualityGuidance.ts`      | Design Intent Blindness          |

**Expected impact**: 15–25% reduction in FPs from Design Intent Blindness and echo-chamber acceptance.

**Limitation**: Prompt improvements are "suggestions" — the LLM may not consistently follow them, especially under context pressure.

### Phase 2: Structured Output + Programmatic Validation

**Effort**: Low (1–2 days)
**Expected impact**: 10–15% FP reduction

**Implementation plan**:

1. Define a JSON schema for individual findings:

    ```typescript
    interface ReviewFinding {
        id: string;
        severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
        category: string;
        title: string;
        file_path: string; // Must exist in repository
        line_range: [number, number]; // Must be valid for file
        evidence: {
            tool_call_id: string; // Must match audit trail
            description: string;
        };
        disproof_attempted: boolean;
        disproof_result: string; // What happened when trying to disprove
        mechanical_or_intent: 'MECHANICAL' | 'INTENT_BASED';
    }
    ```

2. After `submit_review`, run programmatic validation:
    - Verify `file_path` exists in the repository
    - Verify `line_range` is within file bounds
    - Verify `evidence.tool_call_id` matches a real tool call in the audit trail
    - Flag findings where `disproof_attempted` is false for severity > LOW
    - Flag INTENT_BASED findings without design-rationale search evidence

3. Reject or downgrade findings that fail validation, returning them to the LLM for correction.

**Key insight**: This catches Wrong Factual Premise FPs that prompt-level gates miss, because the check is _external_ — the LLM can't confabulate its way past a file existence check.

### Phase 3: Root Verification Phase

**Effort**: Medium (3–5 days)
**Expected impact**: 20–30% FP reduction

**Implementation plan**:

1. After subagent aggregation, before final output, add a verification phase:
    - For each CRITICAL/HIGH finding, the root agent runs 2–3 targeted tool calls:
        - `read_file` on the cited location to verify the claim
        - `find_usages` on the reported symbol to check call-site context
        - `search_for_pattern` for design comments ("intentional", "by design", etc.)
    - Findings that don't survive verification are downgraded or dropped

2. Track verification results as metadata on each finding

3. Budget: Allocate ~20% of root agent iterations to verification (after aggregation, before output)

**Key insight**: This converts the "treat as UNVERIFIED CLAIMS" prompt instruction (Phase 1) into an enforced architectural step. The root agent _must_ verify, not just _should_ verify.

### Phase 4: Verification Agent (Second Opinion)

**Effort**: Medium-High (5–8 days)
**Expected impact**: 20–40% FP reduction

**Implementation plan**:

1. After the primary review, run a second model pass with a "verification-only" persona:
    - Input: the findings (not the full diff), plus the tool audit trail
    - Task: "For each finding, use tools to verify the claim. Mark as CONFIRMED, REFUTED, or UNCERTAIN."
    - Constraint: The verification agent can only read files and search — no new findings

2. Findings marked REFUTED are dropped; UNCERTAIN findings are downgraded one severity level

3. Alternative: Use the same model with a different system prompt emphasizing skepticism. This costs less than a separate model but provides less diversity.

**Key insight**: Self-verification (the LLM checking its own work) is inherently limited by the same blind spots that created the FP. An architecturally separate verification step with fresh context avoids this.

### Phase 5: Static Analysis Integration + Feedback Loops

**Effort**: High (ongoing)
**Expected impact**: 15–30% additional FP reduction

**Implementation plan**:

1. **Static analysis**: Query `vscode.languages.getDiagnostics()` for compiler/linter errors and warnings. Cross-reference with LLM findings:
    - LLM findings confirmed by diagnostics → high confidence
    - LLM findings contradicted by diagnostics (e.g., "type could be null" but TS strict mode prevents it) → drop or downgrade

2. **Feedback loops**: If Lupa is used via PR comments or chat, track which findings users dismiss. After N dismissals of a pattern, add it to the FP Pattern Catalog programmatically.

---

## 7. Design Principles for Quality

Distilled from triage analysis and industry research. Reference these when designing any quality improvement.

### Principle 1: External Checks Beat Self-Judgment

Prompt-based quality control asks the LLM to judge its own work — which is limited by the same blind spots that produced the FP. Move critical verification to external mechanisms:

- Programmatic validation (file exists? line range valid?)
- Tool-based re-verification (separate tool call to check the claim)
- Architectural enforcement (verification phase is mandatory, not optional)

### Principle 2: Prompt Improvements Have Diminishing Returns

Each additional prompt instruction competes for context window attention. Beyond ~20 quality gates in the prompt, adding more text may _decrease_ quality as the LLM struggles to track all constraints. Improvements should move to code-level enforcement.

### Principle 3: Verification is Cheaper Than Generation

A verification pass that checks 10 findings with 2–3 tool calls each (20–30 calls) is far cheaper than the initial review (100+ calls across subagents). The ROI on verification is extremely high because it targets high-severity findings where FPs are most costly.

### Principle 4: Structured Output Enables Programmatic Quality

Free-text findings can't be systematically validated. JSON-schema output with required evidence fields enables:

- Automated fact-checking (file existence, line range validity)
- Audit trail cross-referencing (was this tool actually called?)
- Statistical analysis (which finding types have highest FP rates?)
- Feedback loop integration (dimiss patterns → auto-suppress)

### Principle 5: Diversity Breaks Blind Spots

A single model with a single prompt has consistent blind spots. Introducing diversity — different models, different prompts, different investigation strategies — catches what any individual approach misses. Even temperature variation helps.

### Principle 6: Subagent Output is Untrusted Input

Subagents are useful for parallelization but introduce the same risks as any untrusted data source: they may confabulate, inflate severity, or report findings based on incomplete context. Root agents should treat subagent findings like user input — validate before trusting.

---

## 8. Measurement Framework

To track improvement, measure these metrics across reviews:

| Metric                | How to Measure                                             | Target                                              |
| --------------------- | ---------------------------------------------------------- | --------------------------------------------------- |
| **FP Rate**           | Manual triage of N random findings per review              | < 30%                                               |
| **Severity Accuracy** | CRITICAL/HIGH findings confirmed as real bugs              | > 80% confirmed                                     |
| **Evidence Coverage** | % of findings with verifiable tool call evidence           | > 90%                                               |
| **File Coverage**     | % of changed files with ≥1 finding or explicit "no issues" | 100%                                                |
| **Finding Density**   | Findings per 100 lines of changed code                     | 0.5–2.0 (too low = missed issues, too high = noise) |
| **Disproof Rate**     | % of initial hypotheses disproved during review            | 40–60% (healthy skepticism)                         |

---

## Appendix A: FP Examples by Category

### Design Intent Blindness

| Finding                                            | Why It's FP                                         | What Would Have Caught It         |
| -------------------------------------------------- | --------------------------------------------------- | --------------------------------- |
| "`MAX_TOOL_RESPONSE_CHARS` should be configurable" | It's an LLM context budget, documented with comment | JSDoc/comment check (Phase 1)     |
| "Tool X missing from subagent mode"                | `ROOT_ONLY_TOOLS` by architecture                   | Mode awareness, find_usages check |
| "`AsyncSemaphore.acquire()` could get non-integer" | Every call site passes literal `1`                  | Call-site verification (Phase 1)  |

### Wrong Factual Premise

| Finding                            | Why It's FP                               | What Would Have Caught It                   |
| ---------------------------------- | ----------------------------------------- | ------------------------------------------- |
| "Uses 8K context window"           | Model has 128K+; reviewer confused models | Programmatic fact-check (Phase 2)           |
| "Function missing from tool table" | Listed under different name               | Structured output cross-reference (Phase 2) |

### Mode/Context Confusion

| Finding                                      | Why It's FP                       | What Would Have Caught It                 |
| -------------------------------------------- | --------------------------------- | ----------------------------------------- |
| "Webview should use vscode API"              | Browser context, no vscode access | Architecture injection in reviewer prompt |
| "Finalization tools missing from restricted" | They're ROOT_ONLY, not restricted | Mode awareness reinforcement              |

### Theoretical-Only Concerns

| Finding                            | Why It's FP                       | What Would Have Caught It              |
| ---------------------------------- | --------------------------------- | -------------------------------------- |
| "Quadratic complexity in markdown" | Input bounded by LLM token limits | Reachability check, call-site analysis |
| "Race condition in semaphore"      | Node.js single-threaded           | Language-aware review gate (existing)  |

### Complementary Block Misunderstanding

| Finding                               | Why It's FP                                      | What Would Have Caught It           |
| ------------------------------------- | ------------------------------------------------ | ----------------------------------- |
| "Standard guide missing tool details" | `tool_selection_guide` has comprehensive docs    | Full prompt visibility for reviewer |
| "No quality guidance for subagents"   | `thinkAboutInvestigation` injects quality checks | Cross-reference documentation       |
