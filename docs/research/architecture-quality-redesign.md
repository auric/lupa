# Lupa Architecture & Quality Redesign — Implementation Recommendations

> **Status**: Research & Planning (not yet implemented)
> **Date**: March 2026
> **Scope**: Pipeline architecture, GPT-4.1 quality, webview visualization, tool reduction

---

## Executive Summary

Lupa's analysis pipeline is functionally powerful but architecturally opaque. Six post-analysis stages evolved organically into a 430-line monolithic method with implicit ordering, hidden conditions, and no shared abstraction. GPT-4.1 calibration optimized the wrong axis (motivation instead of procedure), and the webview provides zero visibility into which pipeline phase produced which tool calls.

This document proposes three parallel improvement tracks:

| Track            | Problem                                              | Solution                                                                 | Expected Impact                              |
| ---------------- | ---------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------- |
| **Architecture** | Spaghetti pipeline, tool leaking between phases      | Typed pipeline steps with declarative tool sets                          | Code clarity, maintainability, extensibility |
| **Quality**      | GPT-4.1 finds nothing, GPT-5 mini finds too many FPs | Procedural prompts, evidence cross-referencing, multi-review aggregation | 50-70% FP reduction, 2-3× GPT-4.1 recall     |
| **Visibility**   | Users can't tell which tools ran in which phase      | Phase-annotated tool calls, accordion UI per step                        | User understanding, debugging capability     |

---

## Part 1: Architecture Assessment

### Current Pipeline (7 phases, 6 post-analysis stages)

```
Entry: AnalysisOrchestrator
  │
  ├─ Phase 1-6: Setup (state, tools, prompts, calibration)
  │
  ├─ Phase 7: MAIN CONVERSATION LOOP (up to 100 iterations)
  │   ├─ 19 tools available (minus model-specific disabled)
  │   ├─ Wind-down nudges at 85%/92% iterations
  │   ├─ Token management (cleanup at 90%)
  │   └─ Terminates: submit_review OR max iterations
  │
  └─ POST-ANALYSIS PIPELINE (postAnalysisPipeline.ts)
      ├─ Stage 1:  Workflow Enforcement    [LLM, 30 iterations, conditional]
      ├─ Stage 1b: Zero-Finding Challenge  [LLM, 15 iterations, conditional]
      ├─ Stage 2:  Evidence Audit          [Programmatic]
      ├─ Stage 3:  Finding Validation      [Programmatic + LSP]
      ├─ Stage 4:  Adversarial Verification [LLM subagents, 3 concurrent]
      ├─ Stage 5:  Finding Scoring         [Programmatic, 12 signals]
      ├─ Stage 5b: Self-Reflection         [LLM, 10 iterations]
      └─ Stage 6:  Unified Rewrite         [LLM, conditional]
```

### Identified Architectural Gaps

#### GAP 1: Rewrite Phase Gets Full Tool Set (MEDIUM risk)

**Location**: `postAnalysisPipeline.ts` Stage 6
**Issue**: The unified rewrite passes `options.availableTools` (all 18 tools). The model should only rewrite text and call `submit_review`, but has access to `record_finding`, `run_subagent_batch`, all investigation tools.
**Fix**: Restrict to `[think, submit_review]`.

#### GAP 2: No Explicit Phase Model (DESIGN debt)

**Issue**: Pipeline phases are implicit in code flow. No `AnalysisPhase` enum, no phase transitions, no phase-aware tool filtering. Tool access controlled via ad-hoc `Set<string>` mutations.
**Impact**: Adding tools requires checking multiple locations. Phase boundaries enforced by convention, not types.

#### GAP 3: Post-Analysis is a 430-Line Monolith

**Issue**: `PostAnalysisPipeline.run()` is one giant method with 8 stages inlined. Each stage has different: execution type (LLM/programmatic/subagent), tool requirements, skip conditions, budget, prompts. All mixed together with scattered state accumulation (`droppedTitles`, `additionalToolCallRecords`, `selfReflectionScores`).

#### GAP 4: Redundant Quality Steps

**Issue**: Finding Scoring (programmatic, 12 signals) and Self-Reflection (LLM, 1-10 score) overlap significantly. Both assess finding quality/confidence. Self-reflection adds LLM judgment but costs 10 iterations.
**Question**: Can we merge these into a severity-tiered verification where the level of scrutiny scales with finding severity?

#### GAP 5: Workflow Enforcement Re-entry Gets Full Tools

**Issue**: 30-iteration re-entry includes `retract_finding` and all investigation tools. Model could undo findings or start new investigations instead of completing workflow.

#### GAP 6: No Phase Metadata for Webview

**Issue**: All tool calls from all stages pushed into a single flat `ToolCallRecord[]`. No `phase` field. Users see 47 tool calls with no indication which happened during main analysis vs adversarial verification vs rewrite.

#### GAP 7: `score_finding` Globally Disabled But Bypass Invisible

**Issue**: All calibration profiles disable `score_finding`, but `selfReflectionScorer.ts` fetches it directly from registry, bypassing the disabled set. Working correctly but invisible to code readers.

---

## Part 2: External Tool Research — Key Findings

### Manki (`xdustinface/manki`) — Most architecturally relevant

| Feature                     | How Manki Does It                                                                                             | Lupa Takeaway                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Multi-pass intersection** | Run N reviews, shuffle diff ordering, intersect at ≥ceil(N/2)                                                 | **Priority 1**: Stochastic filtering eliminates 40-60% FPs                 |
| **7 specialist agents**     | Security, Architecture, Correctness, Testing, Performance, Maintainability, Dependencies                      | Already done via subagent decomposition                                    |
| **Memory/Suppressions**     | Separate GitHub repo stores learnings. `@manki remember/dismiss` commands. Auto-learns from developer replies | **Priority 2**: Extend FeedbackStore to pre-filter before expensive stages |
| **Judge agent**             | Opus-level model re-severities, deduplicates, dismisses                                                       | Similar to adversarial verification                                        |
| **Dynamic team sizing**     | 3/5/7 agents by diff size                                                                                     | Already have adaptive file grouping                                        |

### Cerberus (`misty-step/cerberus`) — Best prompt engineering

| Feature                       | How Cerberus Does It                             | Lupa Takeaway                                              |
| ----------------------------- | ------------------------------------------------ | ---------------------------------------------------------- |
| **Prompt deconfliction**      | Each reviewer explicitly declares scope (in/out) | **Priority 3**: Add scope declarations to subagent prompts |
| **Confidence gating**         | <0.7 excluded from verdicts, <0.6 never reported | Similar to scoring thresholds                              |
| **Trust boundary markers**    | PR content wrapped in `<UNTRUSTED>` tags         | **Priority 4**: Wrap PR metadata in trust boundaries       |
| **Eval-driven prompts**       | 40 Promptfoo test cases for prompt regression    | **Priority 5**: Build labeled test dataset                 |
| **Deterministic aggregation** | Code-based verdicts, not LLM consensus           | Already have programmatic stages                           |

### PR-Agent (`qodo-ai/pr-agent`) — Best model adaptation

| Feature                       | How PR-Agent Does It                                       | Lupa Takeaway                        |
| ----------------------------- | ---------------------------------------------------------- | ------------------------------------ |
| **Two-pass self-reflection**  | Generate → score with separate model → filter              | Similar to self-reflection scorer    |
| **Auto best practices**       | Accepted suggestions → pattern detect → inject into future | Needs feedback UI first              |
| **164-model MAX_TOKENS dict** | Model-specific handler for all quirks                      | Already have ModelCalibrationProfile |
| **Jinja2 templates**          | Single-pass structured output                              | Consider for GPT-4.1 small PRs       |

### Meta-Insight: CR-Bench Results

CR-Bench (arxiv 2603.11078) showed single-pass beats naive multi-agent (F1 18.73% vs 9.22%). But successful production systems (Manki, Cerberus) prove multi-agent works WITH:

1. Non-overlapping specialist scopes (deconfliction)
2. Deterministic aggregation (code-based verdicts)
3. Quality gating (confidence thresholds, multi-pass intersection)

Lupa's decomposed review avoids the CR-Bench failure mode by splitting by file groups (non-overlapping), not perspectives (overlapping).

---

## Part 3: Recommended Pipeline Architecture

### The Typed Pipeline Steps Pattern

Replace the monolithic `run()` with a declarative array of self-documenting pipeline steps:

```typescript
/** Discriminator for webview visualization */
type PipelineStepKind = 'llm-conversation' | 'programmatic' | 'llm-subagent';

/** Uniform interface for all pipeline steps */
interface PipelineStep {
    readonly name: string; // Machine-readable identifier
    readonly label: string; // Human-readable label for webview
    readonly description: string; // What this step does and why
    readonly kind: PipelineStepKind; // Execution type (for UI icons/styling)

    shouldRun(context: PipelineContext): boolean;
    execute(context: PipelineContext): Promise<PipelineStepResult>;
}

/** What each step returns */
interface PipelineStepResult {
    findingsDropped: number;
    findingsDowngraded: number;
    toolCallRecords: ToolCallRecord[]; // Empty for programmatic steps
    summary?: string; // Human-readable for webview
}

/** Per-step execution record for webview */
interface StepRecord {
    name: string;
    label: string;
    kind: PipelineStepKind;
    status: 'completed' | 'skipped' | 'cancelled';
    durationMs: number;
    result?: PipelineStepResult;
}

/** Shared mutable state flowing through pipeline */
interface PipelineContext {
    readonly options: PostAnalysisPipelineOptions;
    readonly droppedTitles: string[];
    readonly additionalToolCallRecords: ToolCallRecord[];
    selfReflectionScores: SelfReflectionScore[];
    rewrittenAnalysis: string | undefined;
    readonly cancellationToken: CancellationToken;
}
```

### Refactored Pipeline Configuration

```typescript
async run(options: PostAnalysisPipelineOptions): Promise<PipelineRunResult> {
    const context = createPipelineContext(options);

    const steps: PipelineStep[] = [
        this.createWorkflowEnforcementStep(),     // LLM, 30 iter, conditional
        this.createZeroFindingChallengeStep(),     // LLM, 15 iter, conditional
        this.createEvidenceAuditStep(),            // Programmatic
        this.createFindingValidationStep(),        // Programmatic + LSP
        this.createAdversarialVerificationStep(),  // LLM subagents, conditional
        this.createFindingScoringStep(),           // Programmatic
        this.createSelfReflectionStep(),           // LLM, 10 iter, conditional
        this.createRewriteStep(),                  // LLM, conditional
    ];

    const stepRecords = await runPipeline(steps, context);

    return { result: buildResult(context), stepRecords };
}
```

Each step factory returns a `PipelineStep` with:

- Clear `shouldRun()` that documents skip conditions at a glance
- Self-contained `execute()` with its own tool set, prompt, and budget
- Metadata (`name`, `label`, `kind`) for webview visualization

The runner function (`runPipeline`) is ~25 lines handling: condition check → timing → execution → cancellation → record creation. Pure orchestration, zero business logic.

### Tool Access Per Step (Explicit Declaration)

| Step                         | Tools                                                 | Rationale                         |
| ---------------------------- | ----------------------------------------------------- | --------------------------------- |
| **Main Analysis**            | All minus model-disabled                              | Full investigation capability     |
| **Workflow Enforcement**     | Investigation + recording tools, NO `retract_finding` | Complete missing work, don't undo |
| **Zero-Finding Challenge**   | Investigation + recording tools                       | Find what was missed              |
| **Evidence Audit**           | None (programmatic)                                   | Cross-reference tool call logs    |
| **Finding Validation**       | None (programmatic + direct LSP)                      | Structural checks                 |
| **Adversarial Verification** | Investigation + `submit_verdict`, NO `record_finding` | Verify, don't create              |
| **Finding Scoring**          | None (programmatic)                                   | Composite score signals           |
| **Self-Reflection**          | `score_finding` only                                  | Score, nothing else               |
| **Rewrite**                  | `think` + `submit_review` only                        | Rewrite text, don't investigate   |

### Tool Reduction Recommendations

#### Remove entirely:

| Tool             | Reason                                                       | Migration                                         |
| ---------------- | ------------------------------------------------------------ | ------------------------------------------------- |
| `get_pr_context` | Minor utility (branch + commits). Content already available. | Inject PR context into system prompt user message |

#### Make model-conditional (keep for capable models):

| Tool                   | Disable For         | Reason                                                                                                                                                       |
| ---------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `batch_tools`          | GPT-4.1             | GPT-4.1 is good at native parallel tool calling. Keep for Raptor Mini — it doesn't call multiple tools at once without batch_tools. Rarely used but helpful. |
| `get_symbols_overview` | GPT-4.1, GPT-5 mini | Overlaps with `find_symbol` + `read_file`. Only useful for capable models doing broad exploration                                                            |
| `update_plan`          | GPT-4.1             | Planning overhead without execution quality. GPT-4.1 follows procedures, not plans                                                                           |

**Net result**: 19 → 18 tools (remove 1), with 3 more conditionally disabled. GPT-4.1 sees **13 tools** (down from 15).

---

## Part 4: GPT-4.1 Quality Strategy

### Root Cause

GPT-4.1 is a hyper-literal instruction follower (IFEval: 87.4%). Current calibration operates on the **motivation axis** (prosecution mode, "investigate aggressively", removed FP guides). This creates a model _motivated_ to find issues but lacking _procedure_ for doing so correctly.

**Result**: Two failure modes:

1. Default → rubber-stamps (0 findings)
2. Under prosecution → generates findings to satisfy instructions (91% FP)

Neither involves genuine reasoning. The fix: operate on the **procedure axis**.

### Strategy 1: Algorithmic Reasoning Steps (HIGHEST IMPACT, no code changes)

Replace motivational text with explicit verification algorithms in the system prompt:

```
## Investigation Procedure

For each changed file:
1. get_file_diff → identify all changed functions/methods
2. For each changed function:
   a. read_file → full function body with 30 lines context
   b. find_usages → all callers of this function
   c. For EACH caller, verify:
      - New null return? → Does caller check for null?
      - New error throw? → Does caller have try-catch?
      - Changed parameter type? → Does caller pass correct type?
      - Removed validation? → Does any caller depend on it?
   d. If caller CANNOT handle the change → record_finding
   e. If ALL callers handle it correctly → move to next function
3. After all functions checked:
   - Any new error paths not propagated to callers?
   - Any new resources acquired but not released?
   - Any changed control flow that breaks existing invariants?
4. think_about_completion with checklist of what was verified
```

**Why it works**: Transforms "review this code" (open-ended, GPT-4.1 fails) into "execute this algorithm" (structured, GPT-4.1 excels). The 87.4% IFEval score means it will follow this procedure faithfully.

### Strategy 2: Few-Shot Examples (HIGH IMPACT, no code changes)

Add 2-3 concrete examples in the system prompt under `#Examples` (OpenAI's recommended section):

**Example A — Real finding discovered:**

```
I called find_usages for parseConfig(). Found 3 callers:
- loadSettings() at settings.ts:45 → passes result to JSON.stringify() without null check
- initApp() at app.ts:12 → wraps in try-catch ✓
- testHelper() at test.ts:30 → test code, not production

parseConfig() now returns null on invalid input (new change in this PR).
loadSettings() will throw TypeError on JSON.stringify(null).

→ record_finding: "loadSettings() doesn't handle null return from parseConfig()"
```

**Example B — Hypothesis correctly dismissed:**

```
I called find_usages for validateInput(). Found 3 callers:
- All wrap the call in try-catch and handle the new ValidationError.
- No finding — change is safely handled by all callers.
```

**Example C — Fabricated finding avoided:**

```
I called find_symbol for DatabaseClient. The tool returned the class definition.
I notice it has a close() method. But this PR doesn't change resource management.
Do NOT record a finding about missing close() — it's pre-existing, not introduced by this PR.
```

### Strategy 3: Evidence-vs-Claim Cross-Referencing (HIGH IMPACT)

New post-analysis stage: after Evidence Audit, before Adversarial Verification.

For each finding:

1. Identify tool calls that investigated the finding's file/function
2. Extract actual tool result text
3. Programmatically check: does the tool output contain evidence for the claim?
    - Finding claims "function X doesn't handle null" → check if tool results show function X
    - Finding claims "caller Y doesn't catch error" → check if caller Y appears in tool results
4. If no supporting evidence found in any tool result → flag for removal

**Implementation**: Add `EvidenceClaimCrossReferencer` as a programmatic pipeline step after Evidence Audit. Uses string matching and heuristics, no LLM call needed for basic version.

### Strategy 4: Phase-Based Tool Progression

Instead of all tools available from turn 1, progressively unlock tools:

| Phase           | Turns               | Tools Available                                                        | Purpose              |
| --------------- | ------------------- | ---------------------------------------------------------------------- | -------------------- |
| **Orient**      | 1-3                 | `get_file_diff`, `read_file`, `think`                                  | Understand the PR    |
| **Investigate** | 4+                  | + `find_symbol`, `find_usages`, `search_for_pattern`, `validate_claim` | Deep code navigation |
| **Record**      | After investigation | + `record_finding`, `think_about_completion`, `submit_review`          | Record and complete  |

**Implementation**: Extend `ConversationRunner` with turn-based tool filtering, or inject phase instructions into system prompt ("In your first 3 turns, focus on reading diffs and understanding the changes before investigating").

### Strategy 5: Single-Pass Mode for Small PRs

For PRs with ≤2 changed files, bypass multi-turn tool-calling:

1. Inline full diff + 50 lines surrounding context per changed function
2. Ask for structured findings in a single response
3. Apply post-analysis pipeline normally on the output

**Why**: CR-Bench shows single-pass beats multi-turn for GPT-4.1. Small PRs fit in context window without tools.

### GPT-5 Mini False Positive Reduction

| Strategy                                                | Expected FP Reduction | Implementation                                             |
| ------------------------------------------------------- | --------------------- | ---------------------------------------------------------- |
| **Multi-review aggregation** (N=3, keep ≥2)             | 40-60%                | Run 3 reviews with shuffled diff, fuzzy-match intersection |
| **Cross-model validation** (GPT-4.1 validates findings) | 20-40%                | GPT-4.1's dismissiveness validates GPT-5 mini output       |
| Raise self-reflection threshold (8→9)                   | 5-10%                 | Config change                                              |
| Stricter adversarial for aggressive models              | 10-15%                | Calibration: higher adversarial budget                     |

**Best combination**: Multi-review aggregation + cross-model validation.

---

## Part 5: Webview Step Visualization

### Data Model Changes

Add to `ToolCallRecord`:

```typescript
interface ToolCallRecord {
    // ... existing fields
    phase?: PipelinePhase; // NEW: which pipeline step produced this call
}

type PipelinePhase =
    | 'main-analysis'
    | 'workflow-enforcement'
    | 'zero-finding-challenge'
    | 'evidence-audit'
    | 'finding-validation'
    | 'adversarial-verification'
    | 'finding-scoring'
    | 'self-reflection'
    | 'rewrite';
```

Add to analysis result:

```typescript
interface ToolCallsData {
    // ... existing fields
    phases?: PipelinePhaseInfo[]; // NEW: metadata per phase
}

interface PipelinePhaseInfo {
    phase: PipelinePhase;
    label: string; // "Main Analysis", "Adversarial Verification", etc.
    kind: 'llm' | 'programmatic' | 'subagent';
    status: 'completed' | 'skipped' | 'cancelled';
    durationMs: number;
    toolCallCount: number;
    findingsDropped: number;
    findingsDowngraded: number;
    summary?: string; // "2 findings dropped (no evidence)"
}
```

### UI Design

Replace flat tool call list with collapsible phase sections:

```
┌─ 📊 Pipeline Overview: 47 calls · 8 phases · 2m34s ─────────┐
│                                                                │
│ ▼ 🔍 Main Analysis              32 calls · 1m45s              │
│   ├─ read_file("src/auth.ts")            120ms                │
│   ├─ 🤖 Subagent: security review        12s                  │
│   │   ├─ find_symbol("validateToken")     45ms                │
│   │   └─ find_usages("validateToken")     230ms               │
│   └─ submit_review ①                     2ms                  │
│                                                                │
│ ▶ ✅ Workflow Enforcement        skipped                       │
│                                                                │
│ ▼ 🔎 Evidence Audit             programmatic · 45ms            │
│   └─ 📋 2 findings dropped (fabricated evidence)               │
│                                                                │
│ ▶ 📋 Finding Validation         programmatic · 12ms            │
│                                                                │
│ ▼ ⚔️ Adversarial Verification    9 calls · 28s                 │
│   ├─ 🤖 Verify: "SQL Injection"   → CONFIRMED                 │
│   └─ 🤖 Verify: "Race Condition"  → REFUTED (dropped)         │
│                                                                │
│ ▼ 📊 Finding Scoring            programmatic · 8ms             │
│   └─ 📋 1 finding dropped (score: 22/100, threshold: 25)      │
│                                                                │
│ ▼ 🤔 Self-Reflection            3 calls · 8s                  │
│   ├─ score_finding("SQL Injection") → 8/10 ✓                  │
│   └─ score_finding("XSS Risk") → 4/10 ✗ (dropped)            │
│                                                                │
│ ▼ ✍️ Rewrite                     2 calls · 5s                  │
│   └─ submit_review ② (final)                                  │
│      Removed: "Race Condition", "Unused Import", "XSS Risk"   │
└────────────────────────────────────────────────────────────────┘
```

### Implementation Steps

1. **Add `phase` field to `ToolCallRecord`** (1 line in types)
2. **Add `currentPhase` tracking to `toolCallingAnalysisProvider.ts`** — stamp on each tool call in `onToolCallComplete` callback
3. **Add `setPhase()` callback to `PostAnalysisPipeline`** — update before each stage
4. **Collect `StepRecord[]` in pipeline** — timing, status, dropped counts
5. **Pass `PipelinePhaseInfo[]` to webview** — add to `ToolCallsData`
6. **Group tool calls by phase in `ToolCallsTab.tsx`** — render `PhaseSection` per group
7. **Add programmatic stage summaries** — evidence audit, validation, scoring results

---

## Part 6: Post-Analysis Step Simplification

### Current Problem

Five filtering stages that partially overlap:

1. Evidence Audit — catches fabricated evidence (programmatic)
2. Finding Validation — catches structural invalidity (programmatic + LSP)
3. Adversarial Verification — skeptical review per finding (LLM subagents, EXPENSIVE)
4. Finding Scoring — 12-signal composite (programmatic)
5. Self-Reflection — model re-scores 1-10 (LLM, EXPENSIVE)

### Recommended Simplification: Severity-Tiered Verification

Merge adversarial + self-reflection into a unified "LLM Verification" step with effort scaled by severity:

| Finding Severity | Verification Level                           | Cost |
| ---------------- | -------------------------------------------- | ---- |
| **CRITICAL**     | Full adversarial subagent (current behavior) | High |
| **HIGH**         | Full adversarial subagent                    | High |
| **MEDIUM**       | Self-reflection score only (no subagent)     | Low  |
| **LOW**          | Programmatic scoring only (no LLM)           | Zero |

**Benefits**:

- Reduces total LLM calls (LOW/MEDIUM findings skip expensive adversarial)
- Clearer purpose: "higher severity = more verification"
- Single pipeline step instead of two separate ones
- Still catches the most impactful false positives (CRITICAL/HIGH get full scrutiny)

### Alternative: Keep Separate But Conditional

If merging is too risky, make each step explicitly conditional:

- **Adversarial**: Only for findings with score > 45 (from Finding Scoring)
- **Self-Reflection**: Only for findings NOT already adversarial-verified
- Move Finding Scoring BEFORE Adversarial (currently after)

This reordering means:

1. Evidence Audit (cheap, catches fabricated evidence)
2. Finding Validation (cheap, catches structural issues)
3. Finding Scoring (cheap, gives quality signal)
4. LLM Verification (expensive, only for survivors above threshold)
5. Rewrite (only if anything dropped)

---

## Part 7: Implementation Phases

### Phase 1: Pipeline Architecture Foundation (1-2 sessions)

**Goal**: Typed pipeline steps, but no behavior changes.

| Task                                                              | Risk     | Lines Changed     |
| ----------------------------------------------------------------- | -------- | ----------------- |
| Define `PipelineStep`, `PipelineContext`, `StepRecord` interfaces | Zero     | ~40 new           |
| Implement `runPipeline()` orchestrator function                   | Zero     | ~25 new           |
| Extract Evidence Audit into `PipelineStep`                        | Low      | Move ~40 lines    |
| Extract Finding Validation into `PipelineStep`                    | Low      | Move ~30 lines    |
| Extract Finding Scoring into `PipelineStep`                       | Low      | Move ~25 lines    |
| Extract remaining steps (LLM conversation steps)                  | Medium   | Move ~200 lines   |
| Delete old monolithic code                                        | Low      | Delete ~430 lines |
| Add `StepRecord[]` to `PipelineRunResult`                         | Additive | ~10 lines         |

**Validation**: All existing tests pass, `npm run check-types` passes.

### Phase 2: Tool Access Control Per Step (1 session)

**Goal**: Each pipeline step declares its tool set. No more tool leaking.

| Task                                                         | Risk |
| ------------------------------------------------------------ | ---- |
| Add `tools: string[]` to each step factory                   | Low  |
| Restrict Rewrite to `[think, submit_review]`                 | Low  |
| Restrict Workflow Enforcement (remove `retract_finding`)     | Low  |
| Restrict Self-Reflection to `[score_finding]` (already done) | N/A  |

### Phase 3: Webview Phase Visualization (1-2 sessions)

**Goal**: Users see tool calls grouped by pipeline phase.

| Task                                            | Risk            |
| ----------------------------------------------- | --------------- |
| Add `phase` field to `ToolCallRecord`           | Zero (additive) |
| Stamp phase in `toolCallingAnalysisProvider.ts` | Low             |
| Pass `PipelinePhaseInfo[]` to webview           | Low             |
| New `PhaseSection` component                    | Low             |
| Modify `ToolCallsTab` to group by phase         | Medium          |

### Phase 4: GPT-4.1 Prompt Improvements (1 session)

**Goal**: Replace motivation-based prompts with procedure-based prompts.

| Task                                                          | Risk                   |
| ------------------------------------------------------------- | ---------------------- |
| Add algorithmic reasoning steps to dismissive model prompt    | Medium (prompt change) |
| Add 2-3 few-shot examples under `#Examples` section           | Medium (prompt change) |
| Add checklist-based task reframe                              | Medium (prompt change) |
| Add prompt-based phase instructions ("first 3 turns: orient") | Low                    |

**Validation**: Run against known test PRs. Compare TP/FP rates before/after.

### Phase 5: Evidence-vs-Claim Cross-Referencing (1 session)

**Goal**: Programmatic check that tool outputs support finding claims.

| Task                                      | Risk                    |
| ----------------------------------------- | ----------------------- |
| Implement `EvidenceClaimCrossReferencer`  | Medium                  |
| Add as pipeline step after Evidence Audit | Low (using new pattern) |
| Test against known TP/FP examples         | N/A                     |

### Phase 6: Tool Reduction (1 session)

**Goal**: Remove `get_pr_context` and `batch_tools`. Conditionally disable `get_symbols_overview` and `update_plan`.

| Task                                                    | Risk                                   |
| ------------------------------------------------------- | -------------------------------------- |
| Inject PR context into system prompt user message       | Low                                    |
| Remove `get_pr_context` tool                            | Low                                    |
| Remove `batch_tools` tool                               | Medium (verify no model depends on it) |
| Add `get_symbols_overview` to GPT-4.1/5m disabled tools | Low                                    |
| Add `update_plan` to GPT-4.1 disabled tools             | Low                                    |

### Phase 7: Post-Analysis Simplification (1 session)

**Goal**: Reorder stages, make adversarial conditional on scoring.

| Task                                                         | Risk   |
| ------------------------------------------------------------ | ------ |
| Move Finding Scoring before Adversarial                      | Medium |
| Make Adversarial conditional: score > 45 AND severity ≥ HIGH | Medium |
| Make Self-Reflection: only non-adversarial-verified findings | Medium |

### Phase 8: Multi-Review Aggregation (2 sessions)

**Goal**: Run N=2-3 reviews, intersect findings.

| Task                                                      | Risk   |
| --------------------------------------------------------- | ------ |
| Add `reviewPasses` to `ModelCalibrationProfile`           | Low    |
| Implement review orchestrator (run N passes)              | High   |
| Implement fuzzy finding matcher (file + line ± 5 + title) | Medium |
| Intersection logic (keep ≥ ceil(N/2))                     | Low    |

### Phase 9: Eval-Driven Prompt Regression Suite (ongoing)

**Goal**: Labeled test dataset to prevent quality regressions.

| Task                                                  | Risk   |
| ----------------------------------------------------- | ------ |
| Select 20 labeled PR examples (known TP/FP)           | N/A    |
| Build eval harness (run analysis → compare to labels) | Medium |
| Track recall, precision, F1 per model                 | N/A    |
| Integrate into CI for prompt change PRs               | Low    |

---

## Part 8: Appendix

### A. Complete Tool Catalog (Current)

| #   | Tool                     | Type         | Keep/Remove     | Rationale                                                                  |
| --- | ------------------------ | ------------ | --------------- | -------------------------------------------------------------------------- |
| 1   | `find_files_by_pattern`  | Navigation   | Keep            | Core exploration                                                           |
| 2   | `find_symbol`            | Navigation   | Keep            | Core investigation                                                         |
| 3   | `find_usages`            | Navigation   | Keep            | Core investigation                                                         |
| 4   | `read_file`              | Navigation   | Keep            | Essential                                                                  |
| 5   | `search_for_pattern`     | Navigation   | Keep            | Regex search                                                               |
| 6   | `get_symbols_overview`   | Navigation   | **Conditional** | Disable for GPT-4.1/5m                                                     |
| 7   | `get_file_diff`          | Diff         | Keep            | Core diff access                                                           |
| 8   | `get_pr_context`         | Diff         | **Remove**      | Inject into prompt                                                         |
| 9   | `record_finding`         | Finding      | Keep            | Core output                                                                |
| 10  | `retract_finding`        | Finding      | Keep            | Self-correction                                                            |
| 11  | `think`                  | Reasoning    | Keep            | Essential CoT                                                              |
| 12  | `think_about_completion` | Control      | Keep            | Quality gate                                                               |
| 13  | `update_plan`            | Planning     | **Conditional** | Disable for GPT-4.1                                                        |
| 14  | `validate_claim`         | Verification | Keep            | LSP ground truth                                                           |
| 15  | `score_finding`          | Scoring      | Keep (special)  | Self-reflection only                                                       |
| 16  | `submit_verdict`         | Verification | Keep (special)  | Adversarial only                                                           |
| 17  | `batch_tools`            | Meta         | **Conditional** | Disable for GPT-4.1 (good at parallel); keep for Raptor Mini (needs batch) |
| 18  | `run_subagent_batch`     | Delegation   | Keep            | Core recursive                                                             |
| 19  | `submit_review`          | Completion   | Keep            | Terminal tool                                                              |

### B. Competitor Feature Matrix

| Feature                  | Lupa            | Manki              | Cerberus           | PR-Agent                 | AsyncReview   |
| ------------------------ | --------------- | ------------------ | ------------------ | ------------------------ | ------------- |
| Recursive LLM            | ✅              | ✅                 | ❌                 | ❌                       | ✅            |
| Multi-agent              | ✅              | ✅ (7 specialists) | ✅ (6 personas)    | ❌                       | ❌            |
| Tool-calling             | ✅ (19 tools)   | ❌ (fixed format)  | ❌ (fixed format)  | ❌                       | ✅ (code-gen) |
| Adversarial verification | ✅              | ✅ (judge)         | ✅ (deterministic) | ✅ (2-pass)              | ❌            |
| Multi-pass intersection  | ❌              | ✅                 | ❌                 | ❌                       | ❌            |
| Memory/feedback          | Partial         | ✅ (full)          | ❌                 | ✅ (auto best practices) | ❌            |
| Trust boundaries         | ❌              | ❌                 | ✅                 | ❌                       | ❌            |
| Prompt eval suite        | ❌              | ❌                 | ✅ (Promptfoo)     | ❌                       | ❌            |
| Model calibration        | ✅ (5 profiles) | ✅ (2 models)      | ✅ (8+ models)     | ✅ (164 models)          | ❌            |
| Confidence gating        | ✅ (scoring)    | ✅ (multi-pass)    | ✅ (<0.7 gated)    | ❌                       | ❌            |

### C. Priority Summary

| Priority | Item                                          | Impact           | Effort | Dependencies          |
| -------- | --------------------------------------------- | ---------------- | ------ | --------------------- |
| **P0**   | Algorithmic reasoning steps in GPT-4.1 prompt | Very High        | Low    | None                  |
| **P0**   | Few-shot examples in system prompt            | Very High        | Low    | None                  |
| **P1**   | Pipeline architecture (typed steps)           | High             | Medium | None                  |
| **P1**   | Webview phase visualization                   | High             | Medium | Pipeline architecture |
| **P1**   | Evidence-vs-claim cross-referencing           | High             | Medium | None                  |
| **P2**   | Tool access control per step                  | Medium           | Low    | Pipeline architecture |
| **P2**   | Tool reduction (remove 2, conditional 2)      | Medium           | Low    | None                  |
| **P2**   | Post-analysis step reordering                 | Medium           | Medium | Pipeline architecture |
| **P3**   | Multi-review aggregation                      | High             | High   | None                  |
| **P3**   | Trust boundary markers                        | Medium           | Low    | None                  |
| **P3**   | Prompt deconfliction for subagents            | Medium           | Low    | None                  |
| **P4**   | Eval-driven regression suite                  | High (long-term) | High   | Labeled test dataset  |
| **P4**   | Learned suppression pre-filter                | Medium           | Medium | Feedback UI           |

---

## Part 9: Programmatic Steps Assessment

### Verdict: Keep All Three, Improve Each

The three programmatic steps serve **different, non-redundant purposes**:

| Step                  | Purpose                                   | Cost        | Question                    |
| --------------------- | ----------------------------------------- | ----------- | --------------------------- |
| **Evidence Auditor**  | "Did you actually investigate this file?" | ~0ms        | Catches fabricated evidence |
| **Finding Validator** | "Is this finding structurally valid?"     | ~50ms (LSP) | Catches invalid findings    |
| **Finding Scorer**    | "How strong is the overall evidence?"     | ~0ms        | Composite quality signal    |

They are NOT redundant — each answers a fundamentally different question.

### Evidence Auditor — Keep, Strengthen

**What it catches**: Fabricated evidence (model claims tools never called on file), insufficient investigation depth (HIGH+ needs depth ≥4), deletion safety (proved safe but still reported).

**Current weakness**: Fabrication check is too lenient — only triggers when **zero** tools called on the finding's file. If any tool was called, it passes even if the tool output doesn't support the claim.

**Improvements**:

1. **Add claim-vs-output cross-referencing**: After confirming tools _were_ called on the file, check if the tool output text actually supports the finding's claim. Example: finding says "function X doesn't handle null" but `find_usages` result doesn't mention function X at all.
2. **Pattern-specific evidence checks**: For "missing error handling" claims → check if read_file output shows the function body. For "caller doesn't handle return value" → check if find_usages actually returned callers.
3. **Strengthen depth thresholds**: Currently CRITICAL/HIGH need depth ≥4, MEDIUM needs ≥2. Consider: does a score of 4 reliably indicate meaningful investigation, or can it be gamed with shallow repetitive calls?

### Finding Validator — Keep As-Is (Strong)

**What it catches**:

- File not in diff (common hallucination)
- Deleted file findings
- Invalid line ranges
- Invalid category taxonomy
- Concurrency FP in single-threaded runtimes (.js, .ts, .rb, etc.)
- Excluded patterns (test suggestions, missing docs, runtime validation in typed code)
- Missing disproof attempt (CRITICAL/HIGH/MEDIUM must have tried disproof)
- LSP refutation (definitive LSP evidence that claim is false)

**Assessment**: All checks are sound and catch real problems. The LSP validation is the most powerful check — it uses VS Code's language server to verify claims at the type level. No changes needed.

### Finding Scorer — Keep, Simplify Weights

**12 current signals**:

| Signal                      | Weight | Assessment                                                                                                                            |
| --------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `supportingToolCalls`       | 25     | ✅ Core — verifies tool call IDs exist in records                                                                                     |
| `investigationDepth`        | 20     | ✅ Core — file-level tool call count                                                                                                  |
| `absencePattern`            | 15     | ⚠️ May penalize legitimate absence findings (-15 max). Consider reducing to -10 for absence without concrete failure mechanism        |
| `affectedComponentVerified` | 15     | ⚠️ Gives -5 for unverified components — could penalize findings where affected component is described in prose, not as a symbol token |
| `disproofAttempted`         | 15     | ✅ Binary — important quality signal                                                                                                  |
| `lspValidation`             | 15     | ✅ Gives 15 for verified, 8 for inconclusive, 0 for refuted                                                                           |
| `severityEvidenceRatio`     | 10     | ✅ Checks evidence count vs severity requirement                                                                                      |
| `crossFileEvidence`         | 10     | ✅ Rewards multi-file investigation                                                                                                   |
| `feedbackHistory`           | 10     | ✅ User feedback learning (only with ≥5 entries)                                                                                      |
| `modelBias`                 | 8      | ✅ Correctly gives 0 for dismissive+prosecution                                                                                       |
| `categoryRisk`              | 5      | ✅ Minor boost for high-risk categories                                                                                               |
| `descriptionQuality`        | 2      | ❌ Nearly useless — just measures description length. Remove                                                                          |

**Recommended changes**:

1. Remove `descriptionQuality` (2 weight = noise, only measures string length)
2. Reduce `absencePattern` penalty from -15 to -10 for non-concrete mechanisms
3. Reduce `affectedComponentVerified` penalty from -5 to -3 for unverified components

---

## Part 10: Architecture Design Flaw Findings

### Current Gap

The allowed finding categories are:

```
logic_error, security_vulnerability, resource_leak, api_misuse,
error_handling_gap, data_integrity, regression_risk
```

**There is NO architecture-level category.** This means:

- Models cannot record architectural findings (FindingValidator drops unknown categories)
- Prompts don't guide models to look for architectural issues
- The user noted Raptor Mini produces good findings but lacks architectural flaw detection

### The Challenge

Architectural findings are fundamentally different from code-level findings:

- **Code findings**: "This function doesn't handle null" — verifiable with LSP, specific file/line
- **Architecture findings**: "This change introduces tight coupling between modules" — requires understanding of module boundaries, dependency patterns, design intent

Architectural analysis needs:

1. Broader context (multiple files, module structure)
2. Understanding of existing design patterns
3. Assessment of how changes affect the broader system
4. No specific line range (affects entire files/modules)

### Recommendation: Architecture Analysis Subagent

Add a dedicated architecture analysis step as an **optional subagent task** in the main analysis:

1. **New category**: Add `architecture_design` to `ALLOWED_FINDING_CATEGORIES`
2. **Architecture-specific prompts**: Add prompt guidance for detecting:
    - Separation of concerns violations
    - Increased coupling between modules
    - Missing abstractions (code duplication across changed files)
    - Inconsistent patterns (new code doesn't follow established conventions)
    - Scalability concerns introduced by the change
3. **Architecture subagent**: In recursive mode, one of the subagent tasks could be specifically "analyze the architectural impact of these changes"
4. **Relaxed validation for architecture findings**: Architecture findings may not have specific line ranges → allow broader ranges, don't require LSP validation

### Implementation Priority

**P3** — Architecture findings are valuable but require careful prompt engineering to avoid generating vague/generic observations. Start with adding the category and prompt guidance, measure results before adding a dedicated subagent.

---

## Part 11: Exploration Mode Assessment

### Current State

Exploration mode is triggered when no slash command is used in the `@lupa` chat participant. It provides codebase Q&A with tool-calling.

**What it has**:

- Separate prompt (`createExplorationPromptBuilder`: 5 blocks — ExplorerRole, ExplorationToolGuide, SubagentGuidance, Reflection, OutputFormat)
- Filtered tools: removes `submit_review`, `update_plan`, `think_about_completion`, `get_file_diff`, `record_finding`, `retract_finding`, `get_pr_context`
- Conversation history support (multi-turn)
- Full subagent infrastructure (spawn investigator subagents)
- Uses `ConversationRunner` with same max iterations as analysis

**What it lacks**:

1. **No model calibration**: Exploration prompt ignores `ModelCalibrationProfile`. GPT-4.1 in exploration gets the same prompt as Claude — but GPT-4.1 needs procedural guidance for any task.
2. **No tool filtering per model**: All models get the same tool set in exploration.
3. **No `validate_claim` tool**: Could be useful for verifying user's questions about code behavior.
4. **No `batch_tools`**: Listed under `INVESTIGATION_TOOLS` which is not filtered out, but worth confirming.

### Recommended Changes

| Change                                                       | Priority | Effort |
| ------------------------------------------------------------ | -------- | ------ |
| Pass `ModelCalibrationProfile` to exploration prompt builder | P2       | Low    |
| Apply model-specific `disabledTools` to exploration mode     | P2       | Low    |
| Add calibration-aware tool guidance in exploration prompt    | P3       | Low    |

These are **minor fixes** that can be done alongside the unified entry point work (Part 12).

---

## Part 12: Unified Entry Point — Webview & Chat Participant

### The Problem

Two completely separate code paths run the same analysis:

| Aspect       | Webview Path                                                     | Chat Participant Path                   |
| ------------ | ---------------------------------------------------------------- | --------------------------------------- |
| **Entry**    | `AnalysisOrchestrator` → `ToolCallingAnalysisProvider.analyze()` | `ChatParticipantService.runAnalysis()`  |
| **Model**    | `CopilotModelManager` (selects from settings)                    | `ChatLLMClient` (wraps `request.model`) |
| **Progress** | Callback function                                                | `stream.progress()`                     |
| **Output**   | Webview panel (tool calls tab, diff tab)                         | Chat response stream                    |
| **Lines**    | ~200 lines in `ToolCallingAnalysisProvider`                      | ~200 lines in `ChatParticipantService`  |

**~200 lines of duplicated setup code**: ConversationManager, ToolExecutor, FindingStore, RecursiveStateManager, SubagentSessionManager, SubagentExecutor, calibration profile, prompt generation, token validation, finding store reminder, coverage gap callback, post-analysis pipeline invocation.

**Risk**: Every new feature (phase tracking, tool changes, pipeline steps) must be implemented TWICE, in both paths. Forgetting one causes divergence.

### Current `CopilotModelManager` Usage

`CopilotModelManager` is in `ChatParticipantDependencies` but is **never used** by `ChatParticipantService`. The chat path creates `ChatLLMClient(request.model, timeoutMs)` directly from the VS Code-provided model. The `CopilotModelManager` dependency is vestigial and should be removed.

### Solution: Extract `AnalysisEngine`

Introduce a shared `AnalysisEngine` class that owns ALL analysis logic. Both paths become thin adapters:

```typescript
interface AnalysisEngineInput {
    diff: string;
    llmClient: ILLMClient;
    model: ModelInfo; // { family, id, name, maxInputTokens }
    token: vscode.CancellationToken;
    userPromptSuffix?: string; // Extra user instructions
}

interface AnalysisEngineOutput {
    onProgress(message: string, increment?: number): void;
    onToolCallStart?(
        id: string,
        name: string,
        args: Record<string, unknown>
    ): void;
    onToolCallComplete?(record: ToolCallRecord): void;
    onIterationStart?(current: number, max: number): void;
}

interface AnalysisEngineResult {
    analysisText: string;
    toolCallRecords: ToolCallRecord[];
    completed: boolean;
    wasCancelled: boolean;
    error?: string;
    iterationsUsed?: number;
    selfReflectionScores: SelfReflectionScore[];
    stepRecords: StepRecord[]; // For webview phase visualization
}

class AnalysisEngine {
    constructor(
        private readonly toolRegistry: ToolRegistry,
        private readonly promptGenerator: PromptGenerator,
        private readonly workspaceSettings: WorkspaceSettingsService,
        private readonly diffEnricher: DiffEnricher,
        private readonly findingValidator: FindingValidator
    ) {}

    async analyze(
        input: AnalysisEngineInput,
        output: AnalysisEngineOutput
    ): Promise<AnalysisEngineResult> {
        // ALL shared logic lives here:
        // 1. Parse diff
        // 2. Enrich with LSP (code intelligence brief)
        // 3. Resolve calibration profile from model family/id
        // 4. Create per-analysis state (ConversationManager, FindingStore,
        //    SubagentSessionManager, SubagentExecutor, RecursiveStateManager, etc.)
        // 5. Create ToolExecutor, ConversationRunner
        // 6. Generate system + user prompts
        // 7. Run main conversation loop
        // 8. Run PostAnalysisPipeline
        // 9. Return structured result
    }
}
```

### Callers Become Thin Adapters

**Webview path** (`AnalysisOrchestrator`):

```typescript
async analyzePR() {
    const model = await this.copilotModelManager.getCurrentModel();
    const result = await this.analysisEngine.analyze(
        {
            diff: diffText,
            llmClient: this.copilotModelManager,  // implements ILLMClient
            model: { family: model.family, id: model.id, name: model.name, maxInputTokens: model.maxInputTokens },
            token: cancellationToken,
        },
        {
            onProgress: (msg, inc) => progress.report({ message: msg, increment: inc }),
            onToolCallComplete: (record) => { /* optional webview-specific handling */ },
        }
    );
    // Display in webview
    this.uiManager.displayAnalysisResults(title, result.analysisText, result.toolCallRecords, ...);
}
```

**Chat path** (`ChatParticipantService`):

```typescript
async runAnalysis(request, stream, token, diffResult) {
    const { debouncedHandler, adapter } = this.createStreamAdapter(stream, gitRootUri);
    const result = await this.analysisEngine.analyze(
        {
            diff: diffResult.diffText,
            llmClient: new ChatLLMClient(request.model, timeoutMs),
            model: { family: request.model.family, id: request.model.id, ... },
            token,
            userPromptSuffix: request.prompt,
        },
        {
            onProgress: (msg) => stream.progress(`${ACTIVITY.analyzing} ${msg}`),
            onToolCallStart: adapter.onToolCallStart?.bind(adapter),
            onToolCallComplete: (record) => adapter.onToolCallComplete?.(...),
            onIterationStart: adapter.onIterationStart?.bind(adapter),
        }
    );
    debouncedHandler.flush();
    streamMarkdownWithAnchors(stream, result.analysisText, gitRootUri);
}
```

### What Gets Removed

1. **`CopilotModelManager` from `ChatParticipantDependencies`** — never used
2. **~200 lines of duplicated setup in `ChatParticipantService.runAnalysis()`** — replaced by thin adapter
3. **`ToolCallingAnalysisProvider`** — replaced by `AnalysisEngine` (rename + refactor)
4. **Duplicated `createCoverageGapCallback()`** — exists in both paths, moves to `AnalysisEngine`
5. **Duplicated context status suffix logic** — both paths build the same token/finding reminder string

### What Stays Separate

- **Exploration mode**: Different prompt, different tools, no analysis pipeline — keeps its own logic in `ChatParticipantService`
- **Model acquisition**: Webview uses `CopilotModelManager`, chat uses `request.model` — the `ILLMClient` abstraction hides this
- **Output rendering**: Webview → panel with tabs, chat → markdown stream — callers handle their own display

### Migration Plan

| Phase | Task                                                                                      | Risk    |
| ----- | ----------------------------------------------------------------------------------------- | ------- |
| 1     | Extract `AnalysisEngine` from `ToolCallingAnalysisProvider` (rename + extract interfaces) | Low     |
| 2     | Update `AnalysisOrchestrator` to use `AnalysisEngine` directly                            | Low     |
| 3     | Rewrite `ChatParticipantService.runAnalysis()` to use `AnalysisEngine`                    | Medium  |
| 4     | Remove `CopilotModelManager` from `ChatParticipantDependencies`                           | Low     |
| 5     | Delete `ToolCallingAnalysisProvider` (now empty)                                          | Low     |
| 6     | Verify both paths produce identical results on same diff                                  | Testing |

**This should be done BEFORE the pipeline architecture refactor (Part 3)** — otherwise the pipeline changes need to be duplicated across both paths first, then unified.

---

## Part 13: Implementation Session Plan

### How to Implement This Document

Each numbered item below is one implementation session (one chat conversation). Items with (P0) are highest priority. Dependencies are noted.

#### Track A: Foundation (do first)

| #      | Session                        | Scope                                                                                             | Dependencies                       |
| ------ | ------------------------------ | ------------------------------------------------------------------------------------------------- | ---------------------------------- |
| **A1** | **Unified Entry Point** (P0)   | Extract `AnalysisEngine`, unify webview + chat paths, remove `CopilotModelManager` from chat deps | None                               |
| **A2** | **Pipeline Architecture** (P1) | `PipelineStep` interface, `runPipeline()`, extract all 8 steps into typed steps                   | A1 (only need to change one place) |
| **A3** | **Tool Access Control** (P2)   | Each pipeline step declares its tool set. Fix rewrite/workflow enforcement tool leaking           | A2                                 |

#### Track B: Quality (can start in parallel with A2+)

| #      | Session                             | Scope                                                                                    | Dependencies |
| ------ | ----------------------------------- | ---------------------------------------------------------------------------------------- | ------------ |
| **B1** | **GPT-4.1 Prompt Surgery** (P0)     | Algorithmic reasoning steps, few-shot examples, checklist reframe in system prompt       | None         |
| **B2** | **Evidence Cross-Referencing** (P1) | Strengthen Evidence Auditor with claim-vs-output matching                                | None         |
| **B3** | **Scorer Simplification** (P2)      | Remove `descriptionQuality`, adjust `absencePattern`/`affectedComponentVerified` weights | None         |
| **B4** | **Architecture Findings** (P3)      | Add `architecture_design` category, prompt guidance, relaxed validation                  | B1           |

#### Track C: Visibility (needs A2)

| #      | Session                   | Scope                                                                             | Dependencies |
| ------ | ------------------------- | --------------------------------------------------------------------------------- | ------------ |
| **C1** | **Phase Annotation** (P1) | Add `phase` to `ToolCallRecord`, stamp in `AnalysisEngine` + pipeline steps       | A2           |
| **C2** | **Webview Phase UI** (P1) | `PhaseSection` components, grouped tool call display, programmatic step summaries | C1           |

#### Track D: Advanced (future)

| #      | Session                               | Scope                                                                  | Dependencies |
| ------ | ------------------------------------- | ---------------------------------------------------------------------- | ------------ |
| **D1** | **Multi-Review Aggregation** (P3)     | Run N reviews, fuzzy-match intersection                                | A1           |
| **D2** | **Exploration Mode Calibration** (P2) | Pass calibration profile to exploration, model-specific tool filtering | A1           |
| **D3** | **Trust Boundaries** (P3)             | Wrap PR content in `<UNTRUSTED>` tags                                  | None         |
| **D4** | **Prompt Eval Suite** (P4)            | Labeled test dataset, eval harness, precision/recall tracking          | B1           |

### Recommended Execution Order

```
Week 1:  A1 (unified entry) + B1 (GPT-4.1 prompts) — in parallel
Week 2:  A2 (pipeline architecture) + B2 (evidence cross-ref) — in parallel
Week 3:  A3 (tool access) + C1 (phase annotation) + B3 (scorer)
Week 4:  C2 (webview UI) + B4 (architecture findings)
Future:  D1-D4 as needed
```

### Session Instructions Template

When starting each session, provide the AI:

```
Implement session [ID] from docs/research/architecture-quality-redesign.md.

Context: [brief description of what this session does]
Scope: [specific files to change]
Dependencies: [what was done in previous sessions]

Remember:
- Follow CLAUDE.md workflow (subagent-first, commit discipline)
- Run npm run check-types after each change
- Run relevant tests
- Commit after each meaningful chunk
- Don't over-engineer — implement exactly what the doc specifies
```

### Per-Session Completion Criteria

Each session is done when:

1. `npm run check-types` passes
2. Relevant tests pass (run specific test files, not full suite)
3. Changes are committed with descriptive message
4. No behavior regression in existing features
