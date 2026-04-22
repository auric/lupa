# ADR-001: Investigator–Judge–Synthesizer Pipeline Architecture

**Status:** Accepted  
**Date:** 2026-04-22  
**Decision Maker:** Lupa engineering team  
**Stakeholders:** Implementing agents, eval harness (Quest 8.1/8.2), users of the VS Code extension

---

## Context

Lupa's current post-analysis pipeline has **eight sequential steps** (investigation, evidence audit, finding scorer, severity adjuster, impact analyzer, duplication checker, summary generator, final formatter). The pipeline is slow, context-hungry, and conflates investigation with verification. Worse, the current code allows `maxRecursionDepth = 2`, which means subagents can spawn subagents. This creates a multi-agent topology where decision-making is dispersed across nested contexts — the exact failure mode the industry has converged on rejecting (see Cognition's "Don't Build Multi-Agents" analysis below).

We need to decide, **before writing Phase 11/12 code**, whether to:

- **Option A** — Keep the current 8-step pipeline, apply Phases 1–10 (correctness, thinking, caching, verification tools) verbatim.
- **Option D++** — Redirect to a role-specialized, staged pipeline: single-threaded Reviewer → read-only parallel Investigators (depth = 1) → fresh-context Judge → deterministic Synthesizer.

This ADR records the decision and the rationale so that later Quests have a consistent target and we do not half-build two architectures.

---

## Decision

**We adopt Option D++**, implemented incrementally behind a `lupa.pipeline.v2` feature flag.

---

## What Option D++ Is

| Component                     | Role                             | Key Properties                                                                                                                                                                                            |
| ----------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Reviewer** (main agent)     | Single-threaded, linear executor | Makes all write decisions (`record_finding`, `submit_review`). Spawns Investigators via `run_subagent_batch`. Owns the ReAct loop.                                                                        |
| **Investigators** (subagents) | Read-only parallel workers       | Depth-capped at 1 — they **cannot spawn children**. Can only read files, search code, and write to a shared blackboard (`FindingStore`).                                                                  |
| **Judge**                     | Fresh-context verification stage | Receives findings + evidence **without** the Reviewer's reasoning trace. Verifies grounding, checks for false positives, assigns P0–P3 severity. Not a subagent — does not investigate or spawn children. |
| **Synthesizer**               | Deterministic post-processor     | Combines, deduplicates, and formats findings from the blackboard. No LLM call — pure code.                                                                                                                |
| **Compactor**                 | Context manager                  | When the Reviewer's trace grows too long, a compaction pass (potentially model-assisted) distills key decisions and drops investigative noise.                                                            |

The 8-step pipeline collapses to **3 stages**:

```
PreJudgeGate (Reviewer + Investigators) → Judge → Synthesizer
```

---

## What Option D++ Is Not

To prevent terminology confusion that has plagued prior Lupa documentation:

- **It is NOT canonical RLM.** A Recursive Language Model (Zhang et al., arXiv:2512.24601) requires a REPL environment where the model writes code to inspect context programmatically and calls `llm_query()` from within that environment. Lupa uses standard tool-calling orchestration. The "RLM" label in older documents was incorrect and is hereby retracted [§5.1].
- **It is NOT multi-agent collaboration.** Cognition's critique of multi-agent systems targets parallel agents making write decisions without shared full traces. Option D++ has **one** decision-maker (the Reviewer). Investigators are read-only; the Judge and Synthesizer are post-processing stages.
- **It is NOT unbounded recursion.** `maxRecursionDepth` is hard-capped at 1 (Quest 12.4). Investigators cannot spawn children. Any "dig deeper" signal routes to compaction + continuation on the Reviewer, not to nested subagents.

---

## Why Not Option A

Option A is conservative and guaranteed forward motion, but it leaves two critical root causes unaddressed:

1. **Root cause #12 — Pipeline bloat.** Eight steps mean eight opportunities for context loss, miscommunication, and compounding latency. Without collapsing stages, we are polishing a fundamentally inefficient design.
2. **Root cause #13 — No separation of investigation from verification.** The current pipeline mixes "find the bug" with "is this really a bug?" in the same context. A fresh-context Judge (Quest 11.2) is the biggest quality lever we have — it requires architectural support that Option A does not provide.

Additionally, Option A preserves the current `maxRecursionDepth = 2` behavior, which violates the industry consensus that nested subagent spawning creates fragile, hard-to-debug systems [§2].

---

## Why Option D++

### Alignment with Industry Principles

Cognition's "Don't Build Multi-Agents" (Walden Yan, June 2025) establishes two principles for reliable long-running agents [§2]:

> **Principle 1:** Share context, and share full agent traces, not just individual messages.  
> **Principle 2:** Actions carry implicit decisions, and conflicting decisions carry bad results.

Option D++ follows both:

- **Principle 1:** The Reviewer sees the full trace. Investigators share a blackboard (`FindingStore`) so their work is visible. The Judge receives findings **plus** raw evidence, not just summaries.
- **Principle 2:** Only the Reviewer takes write actions. Investigators are read-only. The Judge verifies; it does not act. No parallel agent can make a conflicting decision because no parallel agent can make decisions at all.

Cognition's own Devin Review uses exactly this pattern: a single-threaded linear agent for all work, with subagents used **only** for read-only Q&A to keep context out of the main trace [§2]. The "compactor" model (a smaller LM that distills long traces) is their escape hatch for long contexts — not nested subagents.

### Addresses All 18 Root Causes

Option D++ provides the architectural substrate for:

- **Quest 11.2** (Judge stage) — requires a fresh-context verification step.
- **Quest 12.1** (pipeline collapse) — requires replacing 8 steps with 3 stages.
- **Quest 12.3** (read-only Investigators) — requires role separation.
- **Quest 12.4** (depth = 1 cap) — requires hard-capping recursion.
- **Quest 6.1/6.2/6.3** (compaction) — requires a compactor pass in the main loop.

---

## Incremental Rollout

Phases 1–10 are **architecture-agnostic** — they improve correctness, thinking, caching, and tooling without depending on the D++ redirect. They ship to all users regardless of this ADR.

Phases 11–12 **realize the D++ redirect** and ship behind a `lupa.pipeline.v2` feature flag so we can revert per-analysis if eval regresses.

| Phase | Quests                                                        | Architecture Dependency                                                              | Ship Strategy                  |
| ----- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------ |
| 1–10  | 1.1–1.4, 2.1–2.3, 3.1–3.3, 4.1–4.4, 5.1–5.3, 6.1–6.3, 7.1–7.3 | None — agnostic                                                                      | Ship to all                    |
| 11    | 11.0–11.3                                                     | Partial — Judge stage (11.2) can work with old pipeline, but is designed for 3-stage | Behind `lupa.pipeline.v2` flag |
| 12    | 12.1–12.4                                                     | Full — requires the 3-stage pipeline                                                 | Behind `lupa.pipeline.v2` flag |

**Current code status:** The existing `maxRecursionDepth = 2` default and `RecursiveStateManager` are scheduled for removal in Quest 12.4. Until then, they remain as legacy code paths.

---

## Kill-Switch Criteria

If the eval harness (Quest 8.1/8.2) reports degradation after enabling `lupa.pipeline.v2`, we follow this escalation ladder:

| Threshold                                      | Metric                                    | Action                                                                                                             |
| ---------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **> 5 % drop** in resolution rate vs. baseline | `resolutionRate` per fixture/model        | Disable `lupa.pipeline.v2` flag for that analysis. Investigate. Do **not** revert commits.                         |
| **> 10 % drop** in resolution rate             | `resolutionRate` per fixture/model        | Disable flag. Investigate whether Phase 11 changes (independent of flag) are the cause.                            |
| **> 15 % drop** or persistent instability      | `resolutionRate` + `precision` + `recall` | Revert Phase 12 commits. Phase 11 commits may remain if individually sound. Phase 1–10 commits are never reverted. |
| **Security vulnerability** or data-loss bug    | Manual review                             | Immediate flag disable + hotfix.                                                                                   |

**Baseline definition:** The eval baseline is the resolution rate from the most recent `main` branch run **before** the first Phase 11 commit merged. Baselines are recomputed after each Wave 0 eval run.

---

## Terminology Corrections

Prior Lupa documents used "RLM" loosely to describe subagent spawning. This ADR formally retracts that usage:

- **"RLM"** refers to Zhang et al.'s Recursive Language Model (REPL-based, programmatic context decomposition). Lupa does not implement this.
- **"Recursion"** in Lupa means the Reviewer spawning read-only Investigators (depth = 1). It is external orchestration, not model-driven recursive decomposition.
- **"Iteration"** means one turn of the Reviewer's ReAct loop. It is not recursion.

These definitions follow the rescue playbook v3 terminology section.

---

## Anti-Patterns We Explicitly Reject

These patterns are documented as harmful in our research and are architecturally excluded by Option D++ [§5.3]:

1. **Multi-agent fan-out for decision-making.** Only the Reviewer makes write decisions. Parallel agents making conflicting assumptions is the failure mode Cognition describes.
2. **Unbounded recursion depth.** Hard cap at 1. No nested subagents.
3. **Implicit grounding.** Every MEDIUM+ finding must have `sources: [...]` (Quest 11.3). No post-hoc auditing.
4. **Long generic error messages.** Tools return structured stubs (Quest 1.3), not prose.
5. **Hard-coded review categories in prompts.** Categories live in editable markdown (Quest 7.3).

---

## Risks and Mitigations

| Risk                                             | Likelihood | Impact | Mitigation                                                                                            |
| ------------------------------------------------ | ---------- | ------ | ----------------------------------------------------------------------------------------------------- |
| Flag toggle causes state corruption mid-analysis | Low        | High   | Flag is read **once** at analysis start and cached in `AnalysisContext`. No mid-flight toggling.      |
| Judge stage adds latency                         | Medium     | Medium | Judge is a single LLM call, not a full investigation. Can be parallelized with Synthesizer if needed. |
| Users confused by P0–P3 severity                 | Medium     | Low    | Provide mapping table in UI. Legacy CRITICAL/HIGH/MEDIUM/LOW mapping documented in Quest 11.0.        |
| Compactor loses critical decisions               | Low        | High   | Compactor preserves all `record_finding` calls and tool results. Only investigative noise is dropped. |
| Phase 12 refactor is too large                   | Medium     | High   | Split 12.1 into 3 sub-Quests (extract Judge, extract Synthesizer, collapse pipeline).                 |

---

## Context Rot and Known Limitations

Option D++ **does not solve context rot** — it manages it. This is a deliberate trade-off, not an oversight.

### What Is Context Rot?

As the Reviewer's ReAct loop accumulates tool calls and reasoning, the conversation trace grows. When it approaches the context window limit, compaction (Quest 6.x) replaces old turns with a lossy summary. The model gradually loses access to:

- Early hypotheses it formed
- Why it dismissed certain files
- The full reasoning behind a finding
- Connections between findings it noticed mid-trace

This is **context rot**: the degradation of the model's working memory as its history is compressed.

### How RLM Solves This (And Why We Don't Use It)

Canonical RLM (Zhang et al.) eliminates context rot by storing the full context in an **external REPL variable** rather than the prompt. The model writes Python to `grep`, `slice`, and `filter` the context on demand. The full data is always reachable; nothing is ever "forgotten."

We do **not** adopt canonical RLM because:

1. **Infrastructure gap:** Lupa runs inside a VS Code extension host with `vscode.lm` API access. There is no Python REPL, no `llm_query()` primitive, and no programmatic context variable. Building true RLM would require re-architecting the extension host boundary.
2. **No production precedent:** No code-review product (Devin, CodeRabbit, Qodo, Ellipsis) uses canonical RLM. The industry has converged on managed rot via compaction.
3. **Bounded problem:** A PR diff is finite. The raw code does not grow during analysis — only the reasoning trace does. The Reviewer delegates file reading to Investigators; the blackboard persists findings. The trace is bounded by the iteration cap.

### How D++ Mitigates Context Rot

| Mechanism                                   | What It Preserves                                          | What It Drops                            | When It Triggers                      |
| ------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------- | ------------------------------------- |
| **PR Overview** (Quest 3.1)                 | Intent, risk hotspots, review plan, `changeShape` metadata | Full raw diff                            | Before first iteration                |
| **Blackboard** (Quest 4.1)                  | All findings, notes, files touched                         | Investigator reasoning traces            | Continuous                            |
| **Model-initiated compaction** (Quest 6.1)  | Hypotheses, examined files, finding IDs, open questions    | Old tool outputs, intermediate reasoning | When model calls `compact_history`    |
| **System-initiated compaction** (Quest 6.2) | Same as above, automatic                                   | Same as above                            | At 70 % context usage                 |
| **Compact-and-continue** (Quest 6.3)        | Scaffolding of investigation                               | Deep reasoning                           | At iteration cap (one extension only) |
| **Multi-pass** (Quest 9.1)                  | Intersection of findings across independent runs           | Per-run reasoning traces                 | Auto-trigger on very large PRs        |

The playbook explicitly acknowledges rot as a constraint:

- Quest 6.3 gives **one** extension, then forces finalization: _"Do NOT start new investigation directions."_
- Quest 9.1 exists because _"one pass isn't enough for hard PRs."_
- The blackboard holds **findings**, not reasoning traces. The Reviewer remembers _what_ was found, but may forget _how_ it was concluded.

### When Context Rot Matters

| PR Size                                   | Rot Severity | Primary Mitigation                                                                       |
| ----------------------------------------- | ------------ | ---------------------------------------------------------------------------------------- |
| **Small** (3–10 files, <500 lines)        | Negligible   | Reviewer stays within budget without compaction                                          |
| **Large** (20+ files, 2000+ lines)        | Moderate     | Investigators do deep reading; blackboard holds findings; Reviewer only orchestrates     |
| **Monster** (50+ files, complex refactor) | Severe       | Multi-pass (Quest 9.1): 2–3 independent Reviewers with fresh context, intersect findings |

### Future Direction: Hybrid Approaches

If eval shows that context rot degrades quality on large PRs beyond acceptable thresholds, we can evolve toward a **hybrid architecture** without abandoning D++:

1. **Structured reasoning graph:** Instead of a flat conversation history, maintain a graph of hypotheses → evidence → findings. The Reviewer queries this graph (not the raw chat) when it needs to recall prior reasoning. This is cheaper than full RLM but more structured than compaction.
2. **Investigator-as-database:** Investigators write structured outputs (AST paths, symbol references, data-flow chains) to the blackboard in a machine-readable format. The Reviewer can "re-query" this structured data without re-reading files.
3. **External context index:** For very large PRs, build a lightweight in-memory index (file → symbols → findings) that the Reviewer can query via a tool, similar to how RLM queries a REPL variable but with a much smaller surface area.

These are **not** part of the initial rescue. They are documented here as potential Phase 15+ work if eval warrants it.

### Bottom Line

Option D++ accepts managed context rot as the cost of a simple, debuggable, production-proven architecture. The rescue prioritizes:

1. **Fixing the 18 root causes** (correctness, verification, pipeline collapse)
2. **Establishing a measurable baseline** (Wave 0 eval)
3. **Iterating from data** (not from theoretical perfection)

If the baseline shows that context rot is the dominant quality bottleneck, we will design a targeted improvement — potentially hybrid — in a future phase. For now, compaction + multi-pass + blackboard is the right level of complexity.

---

## References

1. **Cognition, "Don't Build Multi-Agents"** (Walden Yan, June 2025) — Establishes the two principles of context engineering and the single-threaded linear agent as the default. Cited in `rlm-tools-deep-dive.md` §2.
2. **Zhang, Kraska, Khattab, "Recursive Language Models"** (arXiv:2512.24601, Dec 2025) — Formal definition of canonical RLM. Used here to clarify what Lupa is **not** building. Cited in `rlm-tools-deep-dive.md` §5.1.
3. **`rlm-tools-deep-dive.md` §2** — Devin Review architecture: single-threaded agent + fine-tuned compactor, read-only tools, no multi-agent fan-out.
4. **`rlm-tools-deep-dive.md` §5.1** — Retraction of prior claim that "no production tool uses RLM." Correction: production converges on single iterative agent + tight tool surface + aggressive context engineering.
5. **`rlm-tools-deep-dive.md` §5.3** — Anti-patterns confirmed by this round: multi-agent fan-out for decision-making, unbounded recursion, implicit grounding, long error messages, hard-coded categories.
6. **`lupa-rescue-playbook_v3.md`** — Quest definitions, terminology, and phase ordering.
7. **`implementation-instructions_v2.md`** — Wave ordering, quality gates, and rollback strategy.

---

## Appendix: Option D++ vs. Option A at a Glance

| Dimension                      | Option A (Current Pipeline)                            | Option D++ (Adopted)                             |
| ------------------------------ | ------------------------------------------------------ | ------------------------------------------------ |
| Main agent topology            | Single-threaded, but subagents can recurse (depth = 2) | Single-threaded, depth = 1 cap                   |
| Pipeline stages                | 8 sequential steps                                     | 3 stages (PreJudgeGate → Judge → Synthesizer)    |
| Investigation vs. verification | Mixed in same context                                  | Separated: Reviewer investigates, Judge verifies |
| Subagent role                  | Can spawn children, limited write access               | Read-only, no children, blackboard-only output   |
| Long-context strategy          | None (hits iteration cap)                              | Compaction + continue                            |
| Quality lever                  | Heavier prompting                                      | Fresh-context Judge + structured verification    |
| Eval risk                      | Baseline is current behavior                           | Baseline measured before flag enablement         |
| Rollback                       | Revert commits                                         | Flip flag off                                    |

---

_End of ADR_
