# Review Quality Improvement: Reducing False Positives in AI Code Review

**Date:** June 2025 (updated March 2026)
**Based on:** Empirical triage of 58 findings across 4+ review rounds + extensive industry research
**Companion document:** [quality-architecture-design.md](quality-architecture-design.md) — concrete architecture for the next quality improvement PR

---

## Executive Summary

AI code review tools produce **60–85% false positive rates** on complex codebases without targeted mitigation. Lupa's current prompt-based quality architecture provides ~20 prompt-level gates, 5 tool-level checkpoints, and ~14 programmatic validations, but FPs still slip through because **prompt-only quality control plateaus around 60–70% accuracy**.

The highest-ROI improvements shift verification from self-judgment (LLM evaluating its own claims) to external checks (programmatic validation, tool-based re-verification, structured output schemas). All recommended approaches are **language-agnostic** — they work across TypeScript, Python, Java, Go, C#, Rust, and any other language without per-language tooling. This document catalogs root causes, maps the current architecture, and provides a prioritized roadmap.

**Key blind spot discovered**: Beyond FP reduction, Lupa's own review consistently _misses_ real bugs that competitors find — particularly **context-conditional correctness** issues where code behaves correctly in one execution mode but incorrectly in another. Reducing FPs and improving true positive recall are complementary goals requiring different techniques (see Section 2.6 and Appendix C).

**Next step**: Seven novel architectural approaches were brainstormed and evaluated (see Appendix D). Six survived; the full design is in [quality-architecture-design.md](quality-architecture-design.md). The core innovation is **LSP-grounded verification** — using VS Code's live type checker to provide compiler-grade ground truth for LLM claims, a capability architecturally impossible for cloud-based competitors.

---

## 1. Empirical FP Data

### Triage Results

| Round     | Source           | Findings | FP     | Debatable | Valid  | FP Rate    |
| --------- | ---------------- | -------- | ------ | --------- | ------ | ---------- |
| 1         | Lupa self-review | 10       | 7      | 2         | 1      | 70–90%     |
| 2         | External LLM     | 10       | 8      | 2         | 0      | 80–100%    |
| 3         | External LLM     | 20       | 12     | 3         | 5      | 60–75%     |
| 4         | Multi-tool       | 18       | 12     | 1         | 5      | 67–72%     |
| **Total** |                  | **58**   | **39** | **8**     | **11** | **67–81%** |

_Range depends on whether debatable findings are counted as FP._

### Industry Benchmarks (Approximate)

| Tool                   | Reported FP Rate | Notes                                                               |
| ---------------------- | ---------------- | ------------------------------------------------------------------- |
| cubic                  | ~11%             | Structured output, verification agents, multi-pass                  |
| CodeRabbit             | ~15%             | Evidence verification scripts, AST analysis, user feedback loops    |
| Qodo 2.0               | ~11% better      | Multi-agent system, context engineering across repos and prior PRs  |
| BitsAI-CR (ByteDance)  | 25% (75% prec.)  | Two-stage pipeline: RuleChecker + ReviewFilter, 12K+ WAU            |
| diffray                | Not published    | Layered defense: RAG + multi-agent verification + structured output |
| First-gen AI reviewers | 40–50%+          | Single-pass prompt-only approaches                                  |

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

**Fix targets**: Counterexample requirement (existing), call-site verification (implemented), reachability analysis prompts (partial), tool-based reachability verification via CoVe (gap).

### 2.5 Complementary Block Misunderstanding (~10% of FPs)

**Pattern**: The reviewer reports a gap in prompt section A, not realizing that section B already covers it. The LLM sees prompts incrementally and loses the full picture.

**Examples from triage**:

- "Standard guide missing tool details" — `tool_selection_guide` has comprehensive tool docs
- "No quality guidance for subagents" — `thinkAboutInvestigationTool` injects quality checks
- "Missing coverage tracking" — `recursiveMethodology` Step 4 checks file coverage

**Root cause**: Prompt blocks are composed at runtime; the LLM reviewing one block doesn't have full visibility into all other blocks. This is unique to reviewing prompt-based systems.

**Fix targets**: Cross-reference documentation in prompt blocks (partial), full prompt dump for reviewer context (gap), programmatic complementarity checking (unlikely to be feasible).

### 2.6 Missed True Positives: Context-Conditional Correctness (new in Round 4)

**Pattern**: The reviewer does NOT produce a false positive — instead, it **fails to find a real bug**. Code that works correctly in one execution context produces incorrect behavior in another, but the reviewer never checks alternative contexts.

**Examples from competitor reviews (findings Lupa missed)**:

- `thinkAboutContextTool` guidance hardcodes "sub-agents have `get_file_diff`" — but in exploration mode, `parsedDiff` is undefined and `get_file_diff` is unavailable
- `thinkAboutInvestigationTool` guidance says "use `get_file_diff`" unconditionally — same issue
- `extractFilesExamined` only handles array `file_paths` — but ToolCallRecord stores pre-Zod args, so newline-delimited strings are silently missed

**Root cause**: The reviewer examines code in its "happy path" context (analysis mode with a diff) and never asks: "what other execution contexts can this code run in?" This is the inverse of Mode/Context Confusion (Section 2.3) — there, the reviewer is confused about modes. Here, the reviewer fails to consider that the code itself may be mode-unaware.

**Why generic techniques fail to catch this**:

- **CoVe** asks "is this claim factually true?" — but the code IS correct in analysis mode, so fact-checking confirms it
- **Devil's Advocate** challenges findings that exist — it doesn't generate missing findings
- **Self-consistency** reproduces the same blind spot across runs
- **Structured output validation** catches format errors, not missing investigation paths

**What would catch it**:

- **Domain-specific investigation patterns**: "For each tool, check: can it run in exploration mode? If yes, does it reference diff-specific functionality without checking `context.parsedDiff`?"
- **Execution context matrix**: Cross-reference optional `ExecutionContext` fields against tool behavior
- **Taxonomy-guided generation with context categories**: BitsAI-CR's taxonomy approach applied to execution-mode correctness

**Fix targets**: Domain-specific review patterns in prompt taxonomy (gap), execution-mode verification prompts (gap), context-conditional correctness as explicit finding category (gap).

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

| #   | Gap                                                        | Impact                                                                                                                       | FP Category Affected                          | Severity |
| --- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | -------- |
| 1   | **No programmatic validation of finding content**          | Findings with invalid file paths, wrong line numbers, or missing evidence pass through                                       | Wrong Factual Premise                         | High     |
| 2   | **No cross-validation between findings**                   | Contradictory findings (e.g., "too much validation" + "missing validation") both survive                                     | All categories                                | Medium   |
| 3   | **No deduplication logic at aggregation**                  | Multiple subagents report same issue from different angles                                                                   | Noise                                         | Medium   |
| 4   | **No verification agent / second opinion**                 | Single model judges its own work; self-assessment is unreliable                                                              | All categories                                | High     |
| 5   | **No feedback loop from FP → prompt refinement**           | Known FP patterns require manual prompt editing                                                                              | All categories                                | Medium   |
| 6   | **Root agent trusts subagent severity without re-scoring** | Subagents tend to inflate severity; root passes it through                                                                   | Severity inflation                            | Medium   |
| 7   | **No tool-based verification phase (CoVe-style)**          | Findings are never re-verified with independent tool calls after generation                                                  | Theoretical-Only, Wrong Factual Premise       | High     |
| 8   | **Single-model, single-pass for initial review**           | No diversity of perspective; one model's blind spots dominate                                                                | Design Intent Blindness                       | Medium   |
| 9   | **No confidence scoring on individual findings**           | Binary include/exclude decision; no graduated confidence                                                                     | All categories                                | Low      |
| 10  | **No domain-specific investigation patterns**              | Reviewer has generic patterns but no codebase-specific review checklist (e.g., "check all execution contexts for each tool") | Context-Conditional Correctness, Mode/Context | High     |

---

## 5. Industry Approaches to FP Reduction

Based on extensive research of published papers, architectures, and blog posts. All approaches below are **language-agnostic** — they don't require per-language static analyzers or AST parsers.

### 5.1 Chain-of-Verification (CoVe) — Post-Generation Fact-Checking

**Source**: Meta AI (ICLR 2024), widely adopted across domains. ConVerTest (2026) applied it to code generation.

After generating findings, the LLM re-verifies its own claims through a structured 4-stage pipeline:

1. **Draft** initial findings
2. **Plan verification questions** for each finding ("Does this file path exist?", "Can this function actually receive null?", "Is there a comment explaining this design?")
3. **Answer questions independently** using tool calls, isolated from the initial finding's context to avoid confirmation bias
4. **Revise or drop** findings based on verification results

- **FP reduction**: 28% improvement in FACTSCORE; up to 96% hallucination reduction when combined with other techniques (diffray). ConVerTest showed CoVe improves test validity and reduces subtle logical flaws.
- **Complexity**: Low-Medium — purely prompt engineering + structured tool usage
- **Language-agnostic**: YES — verification uses `read_file`, `search_for_pattern`, `find_usages` — tools that work on any language
- **Key insight**: "LLMs are often more truthful when asked to verify a particular fact than when asked to use it in their own answer" (Meta AI). Isolated verification questions break the coherence bias that sustains FPs.
- **Applicable to Lupa**: Very high fit. Directly implementable with existing tools. The verification phase replaces static analysis for fact-checking.

### 5.2 Two-Stage Pipeline: Generate + Filter (BitsAI-CR / ByteDance)

**Source**: BitsAI-CR (ByteDance, FSE 2025) — production system with 12,000+ Weekly Active Users.

A dedicated filtering pass validates findings from the initial generation:

- **Stage 1 (RuleChecker)**: Taxonomy-guided LLM generates findings
- **Stage 2 (ReviewFilter)**: A separate LLM pass that ONLY validates/filters findings from Stage 1
- **Result**: Precision improved from 60% → 75% (+25% relative improvement)

- **FP reduction**: 15–25% precision improvement (production-measured at ByteDance)
- **Complexity**: Medium — requires a second LLM pass, but it's cheaper than generation (filter is simpler than investigation)
- **Language-agnostic**: YES — the filter evaluates finding quality, not language syntax
- **Key insight from paper**: "While LLMs can identify potential issues, their tendency to produce false positives and hallucinations necessitates a robust validation mechanism." The taxonomy-guided version achieved 57% precision vs 17% for generic — a 3.4x improvement from taxonomy alone.
- **Applicable to Lupa**: High fit. Could be implemented as a "ReviewFilter" subagent that receives findings + tool audit trail.

### 5.3 Multi-Agent Debate / Devil's Advocate

**Source**: DEBATE framework (ICLR), Microsoft CORE framework, academic multi-agent research (2024–2026).

Multiple agents with different roles challenge and refine findings:

- **Reviewer Agent**: Proposes findings
- **Critic/Devil's Advocate**: "Here are 3 reasons this finding is wrong" — attacks each finding
- **Judge**: Resolves the debate, keeps survivors

- **FP reduction**: 10–16% improved correlation with human judgments; Microsoft CORE reduced FPs by 25.8%; multi-agent architectures showed 85.5% consistency improvement (diffray)
- **Complexity**: Medium-High — 2–3 model passes per review
- **Language-agnostic**: YES — debate is purely reasoning-based
- **Key insight**: "LLMs are yes-men. They rarely correct themselves once they start writing. You need a designated hater" (Alex Ewerlöf). Self-verification is limited because the same blind spots that produced the FP also limit the model's ability to catch it.
- **Applicable to Lupa**: High fit. Could spawn a "Devil's Advocate" subagent that receives findings and tries to refute each one.

### 5.4 Evidence Chain Enforcement (CodeRabbit-style)

**Source**: CodeRabbit production architecture.

Before posting any comment, generate verification scripts to confirm assumptions:

- CodeRabbit "generates shell/Python checks (think grep, ast-grep) to confirm an assumption or extract proof from the codebase before posting the comment."
- "Comments come with receipts. That translates into less noise."

- **FP reduction**: Significant — every finding is grounded in verifiable evidence
- **Complexity**: Low — Lupa already has `search_for_pattern`, `read_file`, `find_usages` tools
- **Language-agnostic**: YES — grep and search are language-agnostic
- **Key insight**: The "evidence chain" approach doesn't need AST parsing or type checking — it uses the same search/read tools that work on any language. The key is requiring that the evidence is _cited_ and _verifiable_.
- **Applicable to Lupa**: Very high fit. Require tool_call_id references in findings, programmatically verify they exist in the audit trail.

### 5.5 Self-Consistency Sampling / Majority Voting

**Source**: Wang et al. (2022), extensively studied. Applied to code review by Qodo 2.0's multi-agent system.

Run the same review multiple times, keep only findings that appear consistently:

- Same diff with different temperatures or prompt variations
- Only findings reported by ≥2/3 runs survive
- "If a response is factual, then repeated queries should give consistent responses, whereas hallucinated content would give responses with high variability" (SelfCheckGPT)

- **FP reduction**: +17–18% accuracy on reasoning tasks (GSM8K); up to +27.6% in some benchmarks
- **Complexity**: High — 2–3x inference cost; latency-insensitive for PR reviews (CodeRabbit embraces this: "trades a bit of extra compute time for thoroughness")
- **Language-agnostic**: YES — just re-run the same review
- **Key insight**: Could be applied selectively — only to CRITICAL/HIGH findings to keep costs manageable
- **Applicable to Lupa**: Medium fit. Expensive but effective for high-stakes findings.

### 5.6 Structured Output + Programmatic Validation

Force JSON-schema output with required evidence fields, then validate programmatically.

- **How it works**: Each finding must include `file_path`, `line_range`, `evidence_tool_call_id`, `disproof_attempted`. Programmatic checks verify: file exists, line range valid, referenced tool call exists in audit trail.
- **FP reduction**: 10–20% estimated (catches Wrong Factual Premise cheaply)
- **Complexity**: Low — schema already partially exists in `submit_review`
- **Key insight**: BitsAI-CR's "Outdated Rate" metric (% of flagged lines later modified by developers) enables continuous automated evaluation. Structured output makes this measurable.
- **Applicable to Lupa**: Very high fit. Lowest-cost, highest-certainty improvement.

### 5.7 Taxonomy-Guided Generation (BitsAI-CR)

Instead of reviewing generically, provide a structured taxonomy of what to look for.

- **How it works**: BitsAI-CR uses 219 categorized review rules. The taxonomy-guided version achieved **57% precision vs 17% for generic** — a 3.4x improvement from taxonomy alone.
- **FP reduction**: Up to 3.4x precision improvement vs unstructured prompts
- **Complexity**: Low — purely prompt engineering (Lupa already does this partially)
- **Key insight**: Specific, categorized instructions dramatically outperform "review this code for issues." The taxonomy constrains the model's attention to known-valuable issue types.
- **Applicable to Lupa**: Partially implemented. Could enhance by making finding categories more explicit and mapping each to required verification steps.

### 5.8 User Feedback Loops (cubic, Greptile, CodeRabbit)

Track which findings users dismiss as FP. Use this data to tune prompts or train classifiers.

- **How it works**: Users mark findings as "not helpful." Over time, findings matching dismissed patterns are auto-downgraded. Greptile reports: "After 2–3 weeks of team feedback via 👍/👎 reactions, noise reduces significantly while ensuring high bug detection."
- **FP reduction**: 15–25% estimated over multiple review cycles
- **Complexity**: Medium — requires telemetry, storage, and analysis pipeline
- **Applicable to Lupa**: Medium fit long-term. Requires adoption volume for statistical significance.

### 5.9 Why Not Static Analysis?

Multiple tools (CodeRabbit, BugBot, IRIS) pair LLMs with static analyzers for impressive results (IRIS: 89.5% precision, 55 vulnerabilities vs CodeQL's 27). However, this approach requires **per-language maintenance**:

- TypeScript needs TSC + ESLint
- Python needs mypy + pylint/ruff
- Java needs PMD + SpotBugs
- Go needs go vet + staticcheck
- C# needs Roslyn analyzers
- Rust needs clippy

For a multi-language tool like Lupa, maintaining and integrating analyzers for every supported language is a significant ongoing burden. The language-agnostic approaches above (CoVe, evidence chains, multi-agent debate) provide **comparable FP reduction without per-language tooling** — they work by verifying claims through tool-based investigation rather than compiler-specific checks.

**When static analysis IS warranted**: If Lupa eventually specializes in 1–2 languages, or if VS Code's built-in diagnostics (`vscode.languages.getDiagnostics()`) become comprehensive enough to serve as a universal interface.

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

### Phase 3: CoVe-Style Verification Phase (Tool-Based Fact-Checking)

**Effort**: Medium (3–5 days)
**Expected impact**: 20–30% FP reduction
**Research basis**: Chain-of-Verification (Meta AI, ICLR 2024) — 28% FACTSCORE improvement; ConVerTest (2026); up to 96% hallucination reduction in layered approaches (diffray)

After subagent aggregation, before final output, the root agent enters a structured verification phase inspired by CoVe:

**Implementation plan**:

1. **Plan verification questions** for each CRITICAL/HIGH finding:
    - "Does the cited file and line range contain the code described in this finding?"
    - "Are there comments, JSDoc, or documentation explaining this as intentional?"
    - "Do the call sites actually pass the values this finding claims are problematic?"
    - "Is the concern reachable given the runtime constraints (single-threaded, bounded input, etc.)?"

2. **Answer questions with independent tool calls** (key CoVe insight: answer in isolation to avoid confirmation bias):
    - `read_file` on the cited location to verify the claim
    - `find_usages` on the reported symbol to check call-site context
    - `search_for_pattern` for design comments ("intentional", "by design", "not user-configurable")

3. **Revise findings** based on verification:
    - Findings where verification contradicts the claim → DROP
    - Findings where verification is inconclusive → downgrade one severity level
    - Findings where verification confirms → mark as TOOL_VERIFIED

4. Budget: Allocate ~20% of root agent iterations to verification (after aggregation, before output)

**Why this replaces static analysis**: CoVe-style verification catches the same FP categories (Wrong Factual Premise, Theoretical-Only) by using the existing tools (`read_file`, `find_usages`, `search_for_pattern`) that work on ANY language. No per-language analyzer needed.

**Key insight**: This converts the "treat as UNVERIFIED CLAIMS" prompt instruction (Phase 1) into an enforced architectural step. The root agent _must_ verify, not just _should_ verify. Meta AI demonstrated that LLMs are "more truthful when asked to verify a particular fact than when asked to use it in their own answer."

### Phase 4: ReviewFilter Agent (Devil's Advocate)

**Effort**: Medium-High (5–8 days)
**Expected impact**: 20–40% FP reduction
**Research basis**: BitsAI-CR two-stage pipeline (60% → 75% precision); DEBATE framework (10–16% human correlation improvement); Microsoft CORE (25.8% FP reduction); multi-agent debate research (85.5% consistency improvement)

A dedicated adversarial filtering agent that challenges each finding:

**Implementation plan**:

1. After the primary review, spawn a "ReviewFilter" subagent with a Devil's Advocate persona:
    - Input: the findings (structured JSON), the tool audit trail, and the diff
    - Task: "For each finding, construct the STRONGEST counterargument. Use tools to verify your counterargument. Mark each finding as CONFIRMED, REFUTED, or UNCERTAIN."
    - Constraint: Can only read files and search — cannot generate new findings
    - Key prompt: "Your job is to find reasons why each finding is WRONG. If you cannot construct a strong counterargument with tool-based evidence, the finding survives."

2. Finding resolution:
    - REFUTED with tool evidence → DROP
    - UNCERTAIN → downgrade one severity level
    - CONFIRMED (counterargument failed) → high-confidence, keep at current severity

3. Implementation options (choose based on cost tolerance):
    - **Same model, different persona** (cheapest): Use existing model with skeptical system prompt
    - **Same model, different temperature**: Generate at temp=0 for deterministic challenge
    - **Different model** (best diversity): Use a different model family for maximum blind-spot coverage

**Why this is better than self-verification**: "LLMs are yes-men. They rarely correct themselves once they start writing. You need a designated hater" (Alex Ewerlöf). A fresh context with an adversarial mandate breaks the coherence bias inherent in self-review.

### Phase 5: Selective Self-Consistency + Feedback Loops

**Effort**: Medium-High (ongoing)
**Expected impact**: 15–30% additional FP reduction
**Research basis**: Self-consistency sampling (+17–18% accuracy, Wang et al.); SelfCheckGPT; Greptile feedback loops; CodeRabbit user reactions

**Implementation plan**:

1. **Self-consistency for critical findings**: For CRITICAL-severity findings only (highest cost of FP), re-run verification with different prompt framing. If the finding is inconsistent across runs, downgrade or drop.
    - Budget: Only apply to findings that survive Phase 3+4 AND are CRITICAL
    - "If a response is factual, repeated queries should give consistent responses; hallucinated content shows high variability" (SelfCheckGPT)

2. **Feedback loops**: Track which findings users dismiss as FP via UI reactions.
    - After N dismissals of a pattern, add it to the FP Pattern Catalog automatically
    - Track "Outdated Rate" (BitsAI-CR metric): % of flagged code lines later modified by developers. This measures real-world adoption.
    - Greptile reports: "After 2–3 weeks of team feedback via 👍/👎 reactions, noise reduces significantly"

3. **Taxonomy refinement**: Use FP patterns from feedback to refine the finding taxonomy (Section 5.7), creating a data flywheel that improves quality with each review.

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

### Principle 7: Language-Agnostic Scales; Per-Language Doesn't

Static analysis (linters, type checkers, AST parsers) provides high-precision fact-checking but requires per-language maintenance. For multi-language tools, this creates unbounded maintenance cost. Language-agnostic approaches — CoVe verification questions, evidence chain enforcement, adversarial debate — provide comparable FP reduction through tool-based investigation (grep, read, search) that works identically on TypeScript, Python, Java, Go, Rust, or any language.

### Principle 8: Adversarial Review Beats Self-Review

A model checking its own work inherits the same blind spots that produced errors. Research consistently shows that adversarial/debate approaches (DEBATE framework: +10–16% human correlation, Microsoft CORE: -25.8% FP) outperform self-review. The architectural separation — fresh context, different persona, explicit mandate to refute — breaks the coherence bias that sustains false positives.

### Principle 9: Guidance Text IS Code

In a tool-calling system, string literals that guide LLM behavior are as impactful as conditional logic — they directly control what the model does next. A wrong string in guidance can cause the LLM to call unavailable tools, investigate irrelevant paths, or skip critical checks. Review guidance text with the same rigor as executable code: check it against all execution contexts, verify referenced tools/features exist, and test conditional availability.

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
| "Uses 8K context window"           | Model has 128K+; reviewer confused models | CoVe verification phase (Phase 3)           |
| "Function missing from tool table" | Listed under different name               | Structured output cross-reference (Phase 2) |

### Mode/Context Confusion

| Finding                                      | Why It's FP                       | What Would Have Caught It                 |
| -------------------------------------------- | --------------------------------- | ----------------------------------------- |
| "Webview should use vscode API"              | Browser context, no vscode access | Architecture injection in reviewer prompt |
| "Finalization tools missing from restricted" | They're ROOT_ONLY, not restricted | Mode awareness reinforcement              |

### Theoretical-Only Concerns

| Finding                            | Why It's FP                       | What Would Have Caught It                |
| ---------------------------------- | --------------------------------- | ---------------------------------------- |
| "Quadratic complexity in markdown" | Input bounded by LLM token limits | CoVe reachability verification (Phase 3) |
| "Race condition in semaphore"      | Node.js single-threaded           | Language-aware review gate (existing)    |

### Complementary Block Misunderstanding

| Finding                               | Why It's FP                                      | What Would Have Caught It           |
| ------------------------------------- | ------------------------------------------------ | ----------------------------------- |
| "Standard guide missing tool details" | `tool_selection_guide` has comprehensive docs    | Full prompt visibility for reviewer |
| "No quality guidance for subagents"   | `thinkAboutInvestigation` injects quality checks | Cross-reference documentation       |

---

## Appendix B: Key Research References

| Paper / Source                         | Year        | Key Contribution                                                                |
| -------------------------------------- | ----------- | ------------------------------------------------------------------------------- |
| Chain-of-Verification (CoVe), Meta AI  | 2024 (ICLR) | 4-stage self-verification reduces hallucinations 28%+                           |
| BitsAI-CR, ByteDance (FSE)             | 2025        | Two-stage pipeline (RuleChecker + ReviewFilter) achieves 75% precision at scale |
| DEBATE Framework                       | 2024        | Devil's Advocate agent improves evaluation quality 10-16% over single-agent     |
| Microsoft CORE Framework               | 2024        | Multi-agent code review reduces FPs by 25.8%                                    |
| ConVerTest                             | 2026        | Combines self-consistency + CoVe for test generation validation                 |
| SelfCheckGPT (Manakul et al.)          | 2023        | Inconsistency across samples indicates hallucination                            |
| Self-Consistency (Wang et al.)         | 2022        | Majority voting over reasoning paths: +17-18% accuracy                          |
| diffray Layered Defense                | 2025        | RAG + multi-agent + structured output = up to 96% hallucination reduction       |
| Qodo 2.0                               | 2026        | Multi-agent system with context engineering across repos and prior PRs          |
| CodeRabbit Evidence Verification       | 2025-2026   | Generates shell/grep checks to confirm assumptions before posting comments      |
| A Roadmap for Modern Code Review (ACM) | 2025        | Survey: RAG + prompt engineering as cost-efficient alternative to fine-tuning   |

---

## Appendix C: Missed True Positives — Why Lupa Fails to Find Real Bugs

Beyond false positives, Lupa's review pipeline has a **recall problem**: it consistently misses real bugs that competitor tools (GitHub Copilot, CodeRabbit) find. This appendix analyzes the pattern.

### Observed Missed Findings (Round 4)

| Finding                                               | Found By       | Category                  | Why Lupa Missed It                                               |
| ----------------------------------------------------- | -------------- | ------------------------- | ---------------------------------------------------------------- |
| `thinkAboutContextTool` hardcodes diff guidance       | GitHub Copilot | Context-conditional       | Reviewer never checked exploration mode path                     |
| `thinkAboutInvestigationTool` hardcodes diff guidance | GitHub Copilot | Context-conditional       | Same — code correct in primary mode, wrong in secondary          |
| `extractFilesExamined` ignores string `file_paths`    | GitHub Copilot | Pre-Zod/post-Zod mismatch | Reviewer doesn't trace data through Zod coercion boundary        |
| Missing root registration in test                     | CodeRabbit     | Test correctness          | Reviewer treats tests as ground truth, doesn't verify test setup |
| Fake timer cleanup leak                               | CodeRabbit     | Test isolation            | Reviewer doesn't check cross-test side effects                   |

### Root Cause Analysis

**1. Happy-path bias**: The reviewer investigates code in its primary execution context. If the code works correctly there, the investigation ends. It never asks: "what other contexts can this code run in?" This is a fundamental limitation of single-pass review — the reviewer forms a mental model early and stops exploring once that model is satisfied.

**2. Boundary blindness**: The reviewer doesn't trace data across transformation boundaries (Zod schema coercion, JSON serialization, pre/post processing). `extractFilesExamined` sees `file_paths` as a string but doesn't connect this to `coerceToStringArray` running during tool execution (not during recording). This requires understanding the full data pipeline from LLM output → JSON parse → ToolCallRecord → extractFilesExamined.

**3. Guidance-as-data assumption**: The reviewer treats string literal guidance as documentation ("just explanation text") rather than as executable behavior that controls the LLM. In tool-calling systems, guidance text has the same impact as branching logic — it determines what the model calls next.

**4. Test trust bias**: The reviewer assumes existing tests are correct and focuses on whether code matches tests. It rarely asks whether the test itself is wrong (missing setup, wrong assertions, leaked state). CodeRabbit caught both a missing `registerAgent` call and a leaked `useFakeTimers()` that Lupa's review accepted uncritically.

### Implications for Improvement Roadmap

Reducing FPs and improving recall require **different interventions**:

| Goal           | Technique                                                         | Why                            |
| -------------- | ----------------------------------------------------------------- | ------------------------------ |
| Reduce FPs     | CoVe, Devil's Advocate, structured validation                     | Challenges _existing_ findings |
| Improve recall | Domain-specific investigation patterns, execution-mode checklists | Expands _investigation scope_  |

FP reduction techniques (Phases 2–5) won't improve recall because they filter and challenge findings that already exist. To find bugs the reviewer currently misses, we need **investigation augmentation**:

- **Execution context enumeration**: For each changed tool/service, enumerate all `ExecutionContext` modes it can run in (analysis, exploration, subagent). Check behavior in each.
- **Data boundary tracing**: For data that crosses transformation boundaries (Zod, JSON, serialization), verify the code handles both pre-transformation and post-transformation shapes.
- **Test skepticism prompts**: "Does the test setup match production usage? Are there leaked mocks/timers? Does beforeEach register all required state?"
- **Taxonomy-guided investigation**: BitsAI-CR's 3.4x precision improvement from taxonomy suggests that **category-specific investigation checklists** would also improve recall. Instead of generic "review this code," provide: "For tool code, check: (1) all ExecutionContext paths, (2) guidance text accuracy per mode, (3) schema coercion boundaries."

These patterns should be added to the review prompt taxonomy (Phase 2 enhancement) and to the CoVe verification questions (Phase 3 enhancement).

---

## Appendix D: Novel Approaches Brainstorming Evaluation (March 2026)

Seven architectural improvements were brainstormed to address the gaps identified in Sections 2 and 4. Each was evaluated against the current RLM architecture, existing capabilities, competitor approaches, and implementation cost. The full design is in [quality-architecture-design.md](quality-architecture-design.md).

### Evaluation Summary

| #   | Approach                      | Effort | Verdict             | Rationale                                                                                                                                          |
| --- | ----------------------------- | ------ | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Provenance-Enriched Results   | 2 days | **KEEP (merge)**    | Data already exists in `ToolCallRecord[]`, just discarded at `formatResult` boundary                                                               |
| 2   | Investigation Depth Scoring   | 2 days | **KEEP (merge)**    | Mechanical computation from tool calls; merged with #1 as "Investigation Audit"                                                                    |
| 3   | Evidence Ledger               | 4 days | **KEEP (redesign)** | User's original idea; most valuable in deep RLM trees where evidence degrades at each level                                                        |
| 4   | LSP-Grounded Validation       | 7 days | **KEEP (core)**     | THE technical moat — compiler-grade ground truth, architecturally impossible for cloud competitors                                                 |
| 5   | Adversarial Verification      | 3 days | **KEEP (scoped)**   | Only for CRITICAL findings; merged with CoVe for HIGH/MEDIUM                                                                                       |
| 6   | Semantic Diff Enrichment      | 4 days | **KEEP**            | Pre-computed LSP context; reduces tool call waste, improves severity assessment                                                                    |
| 7   | MapReduce Aggregation         | 7 days | **ABANDON**         | RLM recursive tree already provides hierarchical aggregation; adds cost without information gain                                                   |
| 8   | Incremental Finding Recording | 4 days | **KEEP (new)**      | Competitor analysis: `store_comment` pattern commits findings during investigation, not at end. Enables LSP pre-validation at record time (novel). |

### Key Insights

1. **LSP validation is the moat.** Cloud-based competitors (CodeRabbit, Qodo, Greptile, cubic) cannot validate LLM claims against a live type checker. This single capability addresses ~75% of FP root cause categories (Design Intent: check references; Factual Premise: check types; Theoretical-Only: check reachability).

2. **Evidence infrastructure is the foundation.** Without structured evidence flow, every quality improvement operates on unstructured prose. Investigation Audit + Evidence Ledger convert opaque agent outputs into queryable, auditable data.

3. **Adversarial verification merges with CoVe.** A standalone adversarial agent per finding is expensive. For CRITICAL findings, spawn a lightweight adversary. For HIGH/MEDIUM, enforce CoVe verification questions with LSP queries. Same outcome, lower cost.

4. **MapReduce doesn't pull its weight.** The RLM tree IS the hierarchy. Adding reducer agents adds LLM call latency without adding information. The problem is evidence quality at each level, not fan-in structure.

### Architecture: Three Pillars

The six surviving approaches compose into three pillars:

- **Pillar 1 — Evidence Infrastructure**: Investigation Audit (#1+#2), Evidence Ledger (#3), Incremental Finding Recording (#8)
- **Pillar 2 — LSP-Grounded Verification**: Semantic Diff Enrichment (#6), LSP Validation (#4)
- **Pillar 3 — Architectural Quality Enforcement**: Structured Output, CoVe+LSP verification, Adversarial verification for CRITICAL (#5)

See [quality-architecture-design.md](quality-architecture-design.md) for the complete design, implementation phases, and acceptance criteria.
