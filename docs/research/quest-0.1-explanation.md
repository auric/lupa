# Quest 0.1 — What It Means and What We'll Have

## What Quest 0.1 Actually Is

**Quest 0.1 is a documentation task, not a coding task.** It is the act of **writing and committing an Architecture Decision Record (ADR)** that locks in the post-rescue architecture before any Phase 11/12 code is written.

The playbook is explicit:

> _"As the implementing agent, I want to commit to a single post-rescue architecture **before** writing Phase 11/12 code, so that later Quests have a consistent target and we don't half-build two architectures."_

Think of it as a contract with your future self. You are deciding now so you don't waffle later.

---

## The Decision: Option A vs. Option D++

| Option                | Description                                                                                                                                                                                | Pros                                                                                                                                     | Cons                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **A**                 | Keep the current 8-step pipeline. Apply Phases 1–10 (correctness, thinking, caching, verification) verbatim.                                                                               | Conservative. Guaranteed forward motion. Low risk.                                                                                       | Leaves root causes #12–13 unaddressed. Does not fix the fundamental pipeline bloat. |
| **D++** (Recommended) | Role-specialized single-threaded main agent + read-only parallel Investigators (max depth=1) + fresh-context Judge + deterministic Synthesizer + compaction. Collapse 8 steps to 3 stages. | Fixes root causes #12–13. Eliminates pipeline bloat. Investigators are read-only (safe parallelism). Judge gets fresh context (no bias). | Larger change. Requires feature flag. Risk of regression if eval degrades.          |

**The playbook recommends Option D++**, implemented incrementally behind a `lupa.pipeline.v2` feature flag. This means:

- Phases 1–10 ship to everyone (architecture-agnostic improvements)
- Phases 11–12 ship behind the flag (architectural redirect)
- If eval regresses, you flip the flag off — no rollback needed

---

## The Deliverable

When Quest 0.1 is "done," you will have **one document** committed to the repo:

```
docs/architecture/ADR-001-investigator-judge.md
```

This document must contain:

### 1. The Decision

A clear statement: _"We choose Option D++ (role-specialized Investigator-Judge-Synthesizer) over Option A (keep current pipeline)."_

### 2. The Rationale

Why D++? Cite the research:

- `rlm-tools-deep-dive.md` §2 — Devin's single-threaded main + compactor pattern
- `rlm-tools-deep-dive.md` §5.1 — Retract "no production tool uses RLM" (we DO use it, just differently)
- `rlm-tools-deep-dive.md` §5.3 — Anti-patterns to avoid (e.g., recursive agents with write access)

### 3. The Scope

Explicitly state which phases realize the redirect:

- **Phases 1–10:** Architecture-agnostic. Ship regardless of this ADR.
- **Phases 11–12:** Realize the D++ redirect. Ship behind `lupa.pipeline.v2` flag.

### 4. The Kill-Switch

Document the regression threshold:

- _"If eval resolution rate drops by > X % after enabling `lupa.pipeline.v2`, disable the flag and file a bug. Do not revert the commit."_
- (You choose X — probably 5% or 10%, depending on your noise floor.)

### 5. The Incremental Path

How do we get there without big-bang rewrites?

- Phase 11: Add Judge stage, P0–P3 severity, `verify_finding` tool (works with old pipeline)
- Phase 12: Collapse 8 steps → 3 stages, cap depth at 1, role specialization (requires flag)

---

## What You Will NOT Have After Quest 0.1

- **No new code.** This is a document.
- **No feature flag yet.** The flag is created in Phase 11/12.
- **No working D++ pipeline.** That's Phase 12.
- **No removed code.** The old pipeline stays until the flag is proven.

---

## Why This Matters

Without Quest 0.1, you risk:

1. **Half-building two architectures.** You start adding a Judge stage (Quest 11.2) but keep the old 8-step pipeline. Now you have 11 steps. No one wants 11 steps.

2. **Inconsistent design decisions.** Quest 12.1 says "collapse to 3 stages" but Quest 11.2 was built assuming 8 stages. Refactoring 8→3 after 11.2 is merged is painful.

3. **No criteria for reverting.** When eval regresses, do you revert 12 commits or flip a flag? The ADR decides this now.

4. **Wasted work.** If you later decide Option A was better, all Phase 11/12 work is sunk cost.

---

## Acceptance Criteria (Done)

From the playbook:

- [ ] 1-page ADR at `docs/architecture/ADR-001-investigator-judge.md`
- [ ] Cites `rlm-tools-deep-dive.md` §2, §5.1, and §5.3
- [ ] Kill-switch criteria documented (eval regression > X %)
- [ ] Explicitly states which Phases realize the redirect (11, 12) and which are architecture-agnostic (1–10)

---

## Suggested Structure for the ADR

```markdown
# ADR-001: Investigator-Judge-Synthesizer Architecture

## Status

Accepted

## Context

Lupa's current 8-step post-analysis pipeline is slow, context-hungry, and...

## Decision

We will adopt Option D++: role-specialized agents with...

## Consequences

- Positive: ...
- Negative: ...
- Neutral: ...

## Incremental Rollout

- Phases 1–10: architecture-agnostic, ship to all
- Phases 11–12: behind `lupa.pipeline.v2` flag

## Kill-Switch

If eval resolution rate drops by > 5 %, disable flag and investigate.

## References

- rlm-tools-deep-dive.md §2, §5.1, §5.3
- Cognition: "Don't Build Multi-Agents"
```

---

## Timeline

Quest 0.1 should take **1–2 hours** to write and commit. It is the last item in Wave 0 (Foundation). After it is done, you are ready for Wave 1 (Stop the bleeding).

---

## Relation to Other Work

| Quest                                                         | Depends on 0.1? | Why                                                                                                                              |
| ------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1.1–1.4, 2.1–2.3, 3.1–3.3, 4.1–4.4, 5.1–5.3, 6.1–6.3, 7.1–7.3 | **No**          | Architecture-agnostic. Can proceed in parallel with 0.1.                                                                         |
| 8.1, 8.2, 8.3                                                 | **No**          | Already done. Eval harness is architecture-agnostic.                                                                             |
| 11.0, 11.1, 11.2, 11.3                                        | **Partially**   | Can start without 0.1, but 11.2 (Judge stage) needs to know if it's the final Judge or an intermediate step. ADR clarifies this. |
| 12.1, 12.2, 12.3, 12.4                                        | **Yes**         | These ARE the architectural redirect. Cannot start without 0.1 committed.                                                        |

---

## Bottom Line

**Quest 0.1 = one markdown file + one git commit.**

It is the cheapest quest in the entire playbook, but it prevents the most expensive mistake: building the wrong architecture for 10+ phases.
