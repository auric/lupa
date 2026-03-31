# Future Enhancements — Lupa Analysis Quality

Roadmap of research-backed improvements for reducing false positives and improving detection across all models. Each item includes rationale, research evidence, implementation sketch, and expected impact.

---

## Table of Contents

1. [Self-Reflection Scoring (Qodo-Style 2nd Pass)](#1-self-reflection-scoring)
2. [Evidence-vs-Claim Cross-Referencing](#2-evidence-vs-claim-cross-referencing)
3. [Adaptive Tool Budget per PR Complexity](#3-adaptive-tool-budget)
4. [Tool Description RAG](#4-tool-description-rag)
5. [Cross-Model Validation](#5-cross-model-validation)
6. [Scratchpad Tool with Forced Reasoning](#6-scratchpad-tool)
7. [Finding Pattern Learning](#7-finding-pattern-learning)
8. [Enhanced Think Tool with Persistent Analysis](#8-enhanced-think-tool)
9. [Multi-Review Aggregation](#9-multi-review-aggregation)
10. [Global Tool Pruning](#10-global-tool-pruning)
11. [Post-Analysis Self-Critique with Different Model](#11-post-analysis-self-critique)
12. [Structured Output Enforcement](#12-structured-output-enforcement)

---

## 1. Self-Reflection Scoring

**Status: ✅ IMPLEMENTED** (v0.2.0) | **Priority: HIGH** | **Expected FP Reduction: 30-50%** | **Complexity: Medium**

> **Implementation**: `src/services/selfReflectionScorer.ts` — Qodo-style 2nd pass integrated into PostAnalysisPipeline Stage 5b. All surviving findings are presented simultaneously with diff context snippets; model scores each 1-10. Per-model thresholds via `ModelCalibrationProfile.selfReflectionThreshold`. Replaces the binary self-critique pass.

### Rationale

Qodo PR-Agent's highest-ROI technique: after the primary review, a second LLM pass scores each finding on a 1-10 confidence scale. Findings below a threshold (e.g., 7) are dropped. This catches the "plausible-sounding but wrong" findings that survive investigation.

### Research Evidence

- Qodo PR-Agent uses this as its primary FP filter
- GPT-4.1 beats Claude 3.7 Sonnet (54.9% to 45.1% on 200 real PRs, judged by o3-mini) using simple YAML + self-reflection scoring
- Constitutional AI research shows self-consistency improves factual accuracy

### Implementation Sketch

```
Location: src/services/postAnalysisPipeline.ts (new stage)
Trigger: After adversarial verification, before unified rewrite

For each surviving finding:
  1. Build a prompt with the finding + its evidence + the diff context
  2. Ask the SAME model: "Score this finding 1-10 for confidence.
     Consider: Is the evidence from tool output? Is the scenario concrete?
     Could this be intentional design?"
  3. Parse the numeric score
  4. Drop findings scoring below threshold (configurable per model)

Thresholds:
  - Dismissive models (GPT-4.1/4o): 5 (lower bar — they already under-report)
  - Balanced models (Claude, Raptor): 7 (standard bar)
  - Aggressive models (GPT-5-mini): 8 (high bar — they over-report)
```

### Dependencies

- PostAnalysisPipeline stage infrastructure (exists)
- Per-finding scoring prompt template (new)
- CalibrationProfile: `selfReflectionScoreThreshold: number`

---

## 2. Evidence-vs-Claim Cross-Referencing

**Priority: HIGH** | **Expected FP Reduction: 15-25%** | **Complexity: Medium-High**

### Rationale

The EvidenceAuditor currently checks "did you call tools on this file?" but never reads what the tools actually returned. When the model claims "find*usages showed 0 callers" but the tool result actually says "3 references found in src/bar.ts", the auditor has no way to detect this. Self-reflection scoring (Enhancement #1) won't catch these because the model is \_confidently wrong* — it will self-score high on a fabricated claim.

This addresses a distinct class of FPs: **confident hallucinations about tool output**. The `ToolCallRecord.result` field contains the actual tool output but is currently only read by the narrow `checkDeletionSafety` check.

### Research Evidence

- LLM hallucination research consistently shows self-consistency checks fail for confident fabrications
- RAG literature: grounding responses in retrieved content requires explicit verification, not self-assessment
- Current data: `checkDeletionSafety` already demonstrates the pattern works (reads `tc.result` to verify zero-reference claims)

### Implementation Sketch

```
Location: src/services/evidenceAuditor.ts (extend existing audit)
Trigger: During evidence audit, after fabrication check passes

Option A — Heuristic (no LLM calls, ~1-2 days):
  For each finding with supporting tool calls:
    1. Extract key claims from evidence text (numbers, "no callers", "not found")
    2. Read corresponding ToolCallRecord.result content
    3. Check for contradictions:
       - Finding claims "0 results" but tool result has numbered matches
       - Finding claims "X is missing" but tool result shows X exists
       - Finding claims specific line numbers but tool result doesn't contain them
    4. Downgrade or drop contradicted findings

Option B — LLM-based (higher quality, ~3-5 days):
  For each finding:
    1. Collect finding claim + all supporting ToolCallRecord.result texts
    2. Send to LLM: "Does this evidence support this claim? YES/NO + reason"
    3. Drop findings where evidence contradicts the claim
    Reuses existing subagent infrastructure from AdversarialVerifier

Option C — Hybrid (recommended, ~2-3 days):
  Heuristic catches obvious contradictions (zero/nonzero mismatches)
  LLM-based only for ambiguous cases where heuristic is uncertain
```

### Dependencies

- Self-Reflection Scoring implemented first (filters easy FPs, leaving cleaner signal)
- ToolCallRecord.result access (already available)
- For Option B/C: async EvidenceAuditor (pipeline change)

### Risks

- Heuristic version may have low recall (many ways to misstate evidence)
- LLM version adds latency (N calls per finding)
- Need to handle non-string tool results (some tools return JSON objects)

### Sequencing Note

Implement **after** Self-Reflection Scoring (#1). Self-reflection will filter ~30-50% of FPs. Remaining FPs will reveal what percentage are "confident fabrications" vs other causes, informing whether Option A (cheap) or Option B (thorough) is needed.

---

## 3. Adaptive Tool Budget

**Priority: MEDIUM** | **Expected Impact: Efficiency** | **Complexity: Low**

### Rationale

GPT-4.1 made 580 tool calls on a moderate PR — most were redundant or investigating self-generated hypotheses. A dynamic budget based on PR size could prevent over-investigation-to-dismissal.

### Implementation Sketch

```
Location: src/models/modelCalibration.ts

New field: toolBudgetFormula: (fileCount: number, diffLines: number) => number

GPT-4.1 formula: Math.min(fileCount * 15, 200)
  - 5 files × 15 = 75 calls max (vs 580 actual)
  - Forces prioritization over exhaustive investigation

Balanced formula: Math.min(fileCount * 25, 500)
  - More generous for models that use tools effectively

Enforcement: ConversationRunner checks toolCallCount against budget.
When budget exhausted → force think_about_completion → submit_review
```

### Dependencies

- PR metadata (file count, diff lines) available at review start
- ConversationRunner budget enforcement mechanism

---

## 4. Tool Description RAG

**Priority: MEDIUM** | **Expected Impact: Tool Selection Accuracy** | **Complexity: Medium**

### Rationale

LangChain research shows that with many tools, LLMs select wrong tools 3x more often. RAG over tool descriptions — showing only the 5-8 most relevant tool descriptions per turn — dramatically improves selection accuracy.

### Research Evidence

- LangChain blog: "Fewer tools = better accuracy, RAG on descriptions helps"
- Currently all 12-18 tool descriptions are sent every turn (~2000 tokens of tool metadata)

### Implementation Sketch

```
Location: src/services/toolCallingAnalysisProvider.ts

Per-turn tool filtering:
  1. Before each LLM call, analyze the LLM's last message
  2. Classify intent: "reading diffs", "investigating symbols", "recording findings"
  3. Select 5-8 most relevant tools for that intent phase
  4. Only include those tool descriptions in the request

Phase → Tools mapping:
  - Orientation: get_file_diff, get_pr_context, update_plan, think
  - Investigation: find_symbol, find_usages, search_for_pattern, validate_claim
  - Recording: record_finding, retract_finding, think
  - Completion: think_about_completion, submit_review
```

### Dependencies

- Intent classification logic (keyword-based or light-weight)
- Tool set rotation mechanism in ConversationRunner
- vscode.lm API: confirm tools can be changed between turns (verified: yes)

---

## 5. Cross-Model Validation

**Priority: LOW** | **Expected FP Reduction: 40-60%** | **Complexity: High**

### Rationale

Different models have different blind spots. Running the same PR through 2+ models and intersecting findings that both agree on would dramatically reduce FPs. A finding reported by both GPT-4.1 and Claude is far more likely to be real.

### Implementation Sketch

```
New command: "Lupa: Cross-Model Review"

Flow:
  1. Run review with Model A (e.g., GPT-4.1)
  2. Run review with Model B (e.g., Claude 3.7 Sonnet)
  3. Intersect findings: match by file + line range + category
  4. Report only findings present in both (or weighted scoring)

Intersection logic:
  - Exact match: same file, overlapping line range, same category → KEEP (high confidence)
  - Partial match: same file, same category, different lines → REVIEW (medium confidence)
  - Single-model only: present in one model → DROP or flag as uncertain
```

### Dependencies

- Multi-model orchestration (new coordinator)
- Finding deduplication/matching algorithm
- UI for displaying cross-validated findings
- Cost/latency doubled (2 full reviews)

---

## 6. Scratchpad Tool with Forced Reasoning

**Priority: MEDIUM (blocked)** | **Expected Impact: GPT-4.1 reasoning quality** | **Complexity: Low (when unblocked)**

### Rationale

OpenAI specifically recommends a "scratchpad" tool + `tool_choice="required"` to force GPT-4.1 to reason before every action. This boosted SWE-bench scores by ~20%. The existing `think` tool is similar but the vscode.lm API doesn't support `tool_choice`.

### Research Evidence

- OpenAI agent best practices: "Use a scratchpad tool with tool_choice required"
- SWE-bench: +20% with explicit planning between actions
- +4% with explicit CoT instructions alone

### Implementation Sketch (when vscode.lm adds tool_choice)

```
Location: src/services/conversationRunner.ts

Before each LLM turn:
  1. Set tool_choice = { type: "function", function: { name: "think" } }
  2. This forces the LLM to call think before any other tool
  3. After think completes, release tool_choice for the actual action

Alternative (no API support needed):
  - After each tool result, prepend: "Before your next action, call think()
    to plan what you learned and what to do next."
  - Weaker but doesn't require API support
```

### Blocker

- `vscode.lm` API does not support `tool_choice` parameter
- Track: https://github.com/microsoft/vscode/issues — search for "tool_choice" in language model API
- Alternative: prompt-based forcing (weaker, already partially implemented via PLANNING instruction)

---

## 7. Finding Pattern Learning

**Priority: LOW** | **Expected Impact: Long-term FP reduction** | **Complexity: High**

### Rationale

Over time, certain finding patterns are consistently confirmed or rejected by developers. Learning from this feedback loop could dynamically adjust finding thresholds and even teach models which patterns to avoid.

### Implementation Sketch

```
Storage: workspace-level JSON file (.lupa/finding-patterns.json)

Per finding pattern:
  {
    "pattern": "missing-error-handling-in-async",
    "times_reported": 12,
    "times_accepted": 2,
    "times_rejected": 10,
    "acceptance_rate": 0.167,
    "auto_action": "suppress"  // when rate < 0.2
  }

Integration:
  - PostAnalysisPipeline: check pattern acceptance rate
  - If rate < threshold → auto-suppress or downgrade severity
  - If rate > threshold → boost severity
  - Prompt injection: include top-5 suppressed patterns as "avoid these"
```

### Dependencies

- Developer feedback mechanism (accept/reject finding in UI)
- Pattern classification taxonomy
- Persistence layer for pattern data

---

## 8. Enhanced Think Tool with Persistent Analysis

**Priority: MEDIUM** | **Expected Impact: Better reasoning continuity** | **Complexity: Low**

### Rationale

Currently the `think` tool discards the LLM's `analysis` field — it counts risks and returns a canned response. Storing the analysis would enable:

- Cross-checkpoint reasoning (reference earlier thoughts)
- Post-hoc audit of reasoning quality
- Triggering follow-up based on analysis content (not just risk count)

### Implementation Sketch

```
Location: src/tools/thinkTool.ts

Changes:
  1. Store analysis text in a checkpointHistory on the context
  2. Return previous checkpoint summaries in the response
  3. For dismissive models: if analysis mentions "looks fine" or "no issues"
     but identified_risks is non-empty, flag the inconsistency

New context field:
  thinkCheckpoints: Array<{
    topic: string;
    analysis: string;
    risks: string[];
    callIndex: number;
  }>

Response enhancement:
  "Checkpoint 'auth changes': 2 risks identified.
   Previous checkpoint 'config changes' had 3 risks — have you investigated all of them?"
```

### Dependencies

- ExecutionContext: new `thinkCheckpoints` array
- ThinkTool: store + reference previous checkpoints
- Context size management (don't let history grow unbounded)

---

## 9. Multi-Review Aggregation

**Priority: LOW** | **Expected Impact: Confidence scoring** | **Complexity: Medium**

### Rationale

Running the same review multiple times with the same model produces different findings each time (LLM non-determinism). Findings that appear in 3/5 runs are more likely real than one-off findings.

### Implementation Sketch

```
New command: "Lupa: Aggregated Review (N runs)"

Flow:
  1. Run N independent reviews (default N=3)
  2. Collect all findings across runs
  3. Score each finding by occurrence frequency
  4. Report only findings appearing in >= ceil(N/2) runs
  5. Show frequency as confidence indicator

Finding matching:
  - Hash: file + line_range + category + first_sentence_of_description
  - Fuzzy match for line range (within ±5 lines)
```

### Dependencies

- Parallel review orchestration
- Finding deduplication with fuzzy matching
- Cost: N× the compute of a single review
- UI for displaying aggregation confidence

---

## 10. Global Tool Pruning

**Priority: MEDIUM** | **Expected Impact: Simplicity, maintenance** | **Complexity: Low**

### Rationale

Some tools provide marginal value for code review while adding cognitive load for all models. Candidates for removal or consolidation:

### Candidates

| Tool                    | Current Usage                              | Recommendation                                                                            |
| ----------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `list_directory`        | Rarely used in reviews                     | **Remove globally** — `find_symbol` and `search_for_pattern` are better for locating code |
| `find_files_by_pattern` | Occasionally useful for finding test files | **Keep** but lower priority in tool guide                                                 |
| `get_symbols_overview`  | Useful for understanding file structure    | **Keep** but consider merging with `find_symbol`                                          |
| `batch_tools`           | Speeds up models that avoid parallel calls | **Keep for mini models** — disabled only for GPT-4.1/4o where it adds confusion           |

### Implementation

```
Phase 1: Remove list_directory globally (already disabled for GPT-4.1/4o) — ✅ DONE (v0.2.0)
Phase 2: Monitor tool usage metrics across models
Phase 3: Further pruning based on actual usage data
```

---

## 11. Post-Analysis Self-Critique with Different Model

**Priority: MEDIUM** | **Expected FP Reduction: 20-40%** | **Complexity: Medium**

### Rationale

Using a different model to critique findings avoids the self-consistency bias where a model validates its own reasoning. A Claude critique of GPT-4.1 findings (or vice versa) catches more FPs than self-critique.

### Implementation Sketch

```
Location: src/services/postAnalysisPipeline.ts (new stage)

Flow:
  1. Primary review generates findings with Model A
  2. For each MEDIUM+ finding, send to Model B with:
     - The finding description + evidence
     - The relevant diff
     - Prompt: "Is this finding valid? Score 1-10. Explain why or why not."
  3. Drop findings where Model B scores < 6

Model pairing:
  - GPT-4.1 findings → Claude critique (catches dismissive gaps)
  - Claude findings → GPT-4.1 critique (catches over-reporting)
  - Raptor findings → Claude critique
```

### Dependencies

- Multi-model access via vscode.lm API
- Cross-model prompt compatibility
- Cost: ~30% additional compute per review
- User preference for which models to use

---

## 12. Structured Output Enforcement

**Priority: LOW** | **Expected Impact: Parsing reliability** | **Complexity: Medium**

### Rationale

Currently findings are extracted from free-text LLM output via `record_finding` tool calls. If the model fails to call the tool (as GPT-4.1 does), findings are lost. Structured output (JSON mode) would guarantee parseable findings even without tool collaboration.

### Implementation Sketch

```
Applicable to: Single-pass mode (Enhancement #2)

When vscode.lm API supports response_format:
  1. Set response_format = { type: "json_schema", schema: FindingsSchema }
  2. LLM output is guaranteed to be valid FindingsSchema JSON
  3. Parse directly — no tool calling needed

FindingsSchema:
  {
    findings: Array<{
      file: string,
      line_range: [number, number],
      severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
      category: string,
      description: string,
      evidence: string
    }>,
    summary: string,
    recommendation: "approve" | "request_changes"
  }
```

### Blocker

- `vscode.lm` API does not support `response_format` parameter
- Track: vscode API evolution for structured output support

---

## Implementation Priority Matrix

| #   | Enhancement              | Priority | Blocked? | Est. FP Impact    | Prerequisite         |
| --- | ------------------------ | -------- | -------- | ----------------- | -------------------- |
| 1   | Self-Reflection Scoring  | HIGH     | No       | -30-50% FP        | None                 |
| 2   | Evidence-vs-Claim Xref   | HIGH     | No       | -15-25% FP        | Self-Reflection (#1) |
| 3   | Adaptive Tool Budget     | MEDIUM   | No       | Efficiency        | PR metadata          |
| 4   | Tool Description RAG     | MEDIUM   | No       | Tool accuracy     | Intent classifier    |
| 8   | Enhanced Think Tool      | MEDIUM   | No       | Reasoning quality | Context changes      |
| 10  | Global Tool Pruning      | MEDIUM   | No       | Simplicity        | Usage metrics        |
| 11  | Cross-Model Critique     | MEDIUM   | No       | -20-40% FP        | Multi-model access   |
| 6   | Scratchpad (Forced)      | MEDIUM   | **Yes**  | GPT-4.1 reasoning | vscode.lm API        |
| 5   | Cross-Model Validation   | LOW      | No       | -40-60% FP        | Multi-model orch.    |
| 7   | Finding Pattern Learning | LOW      | No       | Long-term         | Feedback UI          |
| 9   | Multi-Review Aggregation | LOW      | No       | Confidence        | Parallel orch.       |
| 12  | Structured Output        | LOW      | **Yes**  | Parsing           | vscode.lm API        |

## Recommended Sequence

1. **Self-Reflection Scoring** — Highest ROI, builds on existing pipeline, no new infra
2. **Evidence-vs-Claim Cross-Referencing** — Catches confident fabrications that self-reflection misses
3. **Enhanced Think Tool** — Cheap improvement, better reasoning chain
4. **Global Tool Pruning** — Simplifies codebase, reduces tool noise
5. **Adaptive Tool Budget** — Prevents over-investigation pattern
6. **Tool Description RAG** — Improves tool selection for all models
7. **Cross-Model Critique** — When multi-model is needed
8. Everything else based on observed needs

---

## References

- **CR-Bench (2024)**: "Code Review in the Age of AI" — single-pass vs multi-agent benchmarks
- **Qodo PR-Agent**: GPT-4.1 beats Claude 3.7 Sonnet 54.9%-45.1% on 200 real PRs
- **OpenAI Agent Best Practices**: Scratchpad tool, explicit CoT, planning prompts
- **LangChain Tool Research**: Tool count vs accuracy relationship, RAG on tools
- **Multi-turn Degradation Study**: ~39% accuracy loss in multi-turn for non-reasoning models
- **SWE-bench**: Claude 3.7 Sonnet 62.3% vs GPT-4.1 54.6% (agent benchmark, different task)
