# Lupa Rescue — Implementation Instructions

> **Companion to** [lupa-rescue-playbook.md](lupa-rescue-playbook.md). The playbook is the _what and why_; this doc is the _when and how_.
>
> **For whom**: The implementing agent (Opus-class). Read both docs end-to-end before starting any Phase. For each Quest, run a research subagent first to verify hints, then implement.

---

## TL;DR — recommended schedule

| Order | Phase                 | Quests                       | Cost (est.) | Risk | Quality lever                         | Decision gate before next?                           |
| ----- | --------------------- | ---------------------------- | ----------- | ---- | ------------------------------------- | ---------------------------------------------------- |
| 1     | **Phase 0**           | 0.1 (ADR)                    | S           | none | none — sets direction                 | Yes — get user sign-off on Option D+                 |
| 2     | **Phase 1**           | 1.1, 1.2                     | S           | low  | correctness fix                       | No — land both immediately                           |
| 3     | **Phase 8** (partial) | 8.1 only                     | M           | low  | enables measurement                   | Yes — establish baseline before any prompt change    |
| 4     | **Phase 2**           | 2.1, 2.2, 2.3                | M           | low  | + (older models)                      | Yes — measure baseline shift                         |
| 5     | **Phase 4**           | 4.1, 4.2, 4.3 (4.4 deferred) | M           | med  | + (kills echo waste, enables sharing) | No — Phase 3 right after                             |
| 6     | **Phase 3**           | 3.1, 3.2                     | M           | low  | + (PR overview restored)              | No                                                   |
| 7     | **Phase 7**           | 7.1, 7.2                     | S           | low  | + (cognitive load relief)             | No                                                   |
| 8     | **Phase 5**           | 5.1, 5.2                     | S           | low  | + (small-dense PRs)                   | Yes — full eval checkpoint                           |
| 9     | **Phase 11**          | 11.1, 11.2                   | L           | med  | ++ (the moat)                         | No — Phase 12 immediately follows                    |
| 10    | **Phase 12**          | 12.1, 12.2                   | L           | high | ++ (architectural simplification)     | Yes — full eval; possible feature-flag rollback gate |
| 11    | **Phase 8** (rest)    | 8.2                          | S           | low  | enables hill-climb                    | No                                                   |
| 12    | **Phase 6**           | 6.1, 6.2, 6.3                | M           | med  | + (graceful degradation)              | No                                                   |
| 13    | **Phase 9**           | 9.1                          | M           | med  | + (FP suppression on hard PRs)        | No                                                   |
| 14    | **Phase 10**          | 10.1, 10.2                   | M           | low  | + (Claude support, UX)                | No                                                   |
| 15    | **Phase 13**          | (was Act 5)                  | S           | low  | scorer tuning                         | Yes — final eval                                     |
| 16    | **Phase 14**          | 14.1, 14.2, 14.3             | S           | low  | carry-overs                           | No                                                   |

Cost legend: S = ≤ 1 work session, M = 2–4, L = 5+. Risk is regression risk to user-visible behaviour.

Quality lever: `+` = noticeable improvement, `++` = step-change.

---

## Why this order

The order is not the order of perceived importance — it is the order that minimizes throwaway work.

1. **Phase 0 first** — every Quest in Phases 11–12 changes shape based on the architecture decision. Decide once, then build.
2. **Phase 1 (correctness) second** — silent bugs hide everything. The lost-pipeline bug means we may have been shipping broken results without knowing it. Fix before measuring anything.
3. **Phase 8.1 (eval harness) third** — you cannot tell if any subsequent change helped without it. Land 8.1 before any prompt change.
4. **Phase 2 (think + GPT-4.1 scaffolding) fourth** — cheapest leverage, biggest win for older models. Easy to measure delta on the new eval.
5. **Phase 4 before Phase 3** — Phase 3 (PR Overview) is much cleaner if it can write to the structured blackboard Phase 4 builds. Otherwise we'd build Phase 3 against the old markdown-blob substrate, then refactor when Phase 4 lands.
6. **Phase 7 (tool pruning) before Phase 5** — pruning removes `update_plan` (touched by Phase 5's recursion prompt). Doing 5 first means writing prompts that mention a tool we'd then delete.
7. **Phase 5 then full eval checkpoint** — by this point we've changed the model's mental model significantly. Pause and measure.
8. **Phase 11 then 12** — verification (11) builds the receipts substrate the Judge stage (12.2) leans on. Doing 12 first would mean the Judge has weaker evidence to work with.
9. **Phase 8.2 (resolution metric) after 12** — we need finalised pipeline structure before measuring resolution. Earlier and the metric would baseline against the wrong shape.
10. **Phase 6 (compaction) late** — useful but not blocking. Lands when older models start hitting limits because the new tools (Phase 11/12) cost more iterations.
11. **Phase 9 (multi-pass) after 6** — multi-pass amplifies single-pass cost; have compaction first.
12. **Phase 10 (multi-model + UX)** — Claude profile is independent; webview UI needs Phases 11/12 phase strip to render against.
13. **Phase 13 (scorer)** — last because the Judge stage in Phase 12 may have rendered some scorer signals obsolete.
14. **Phase 14 (carry-overs)** — independent, do anytime after their dependency Phase.

---

## Per-Phase implementation protocol

For **every** Quest:

1. **Refresh context** — Read the corresponding section of the playbook + cited evidence files in `/memories/session/sub-*.md`. Re-read the cited source files.
2. **Research subagent** — Spawn a focused subagent: "Verify the hints in Quest X.Y. Tell me what's accurate, what's stale, and what's missing." Do NOT proceed to implementation until you have confirmed the current state.
3. **Sequential thinking for design calls** — Any non-trivial API decision: spawn a subagent that runs sequential-thinking. Do NOT run sequential-thinking in your main context — its output is large.
4. **Implement** — Surgical changes per CLAUDE.md `Surgical Changes` section. Keep diffs reviewable.
5. **Validate** — `npm run check-types` must pass. Add/update tests for the change.
6. **Commit** — Per Quest, not per Phase. Use a descriptive message that references the Quest number: `feat(rescue): Quest 4.2 — structured runSubagentBatch return contract`.
7. **Eval** — After every Phase that touches prompts, tools, or pipeline, run the eval harness (once it exists). Compare against the prior baseline. If regression > 5 %, stop and investigate before moving on.
8. **Update progress** — Edit a `## Progress` section in `lupa-rescue-playbook.md` checking off completed Quests with the commit SHA.

---

## Decision gates (where you must stop and consult the user)

These gates require the user to look at data and approve before continuing:

### Gate G0 — After Phase 0 (Quest 0.1)

The ADR proposes Option D+ (Investigator + Judge). User must explicitly approve. If the user prefers Option A (no architectural redirect), Phases 11 and 12 are removed from the schedule and the Phase 1–10 sequence stands.

### Gate G1 — After Phase 8.1 (eval harness exists, baseline captured)

User reviews the baseline numbers. This is the "before" snapshot we'll measure everything against. If the baseline is shocking (e.g., resolution rate < 30 %), confirm with user that the schedule still makes sense.

### Gate G2 — After Phase 5 (volume-aware recursion)

By this point we've changed prompts substantially. Run a full eval. User reviews precision/recall/F1 + sample reviews. If quality regressed, root-cause before Phase 11.

### Gate G3 — After Phase 12 (Investigator-Judge refactor)

The biggest architectural change. User reviews:

- Eval numbers vs Gate G2 baseline
- Sample reviews showing the new pipeline shape
- Any judge-stage telemetry (drop rates, etc.)
- Decision: keep `lupa.pipeline.v2 = true` as default, or revert to feature-flagged opt-in.

### Gate G4 — Final (after Phase 13)

Full eval. Compare to original Raptor baseline (1 finding from 350 calls). User signs off on production rollout.

---

## Per-Quest "before you start" checklist

Before opening the editor for any Quest:

- [ ] Read the Quest in [lupa-rescue-playbook.md](lupa-rescue-playbook.md)
- [ ] Read this doc's section for the parent Phase
- [ ] Read the cited evidence file(s) under `/memories/session/sub-*.md`
- [ ] Spawn research subagent to verify the playbook's "Hints" against current code
- [ ] If design choices are non-trivial: spawn sequential-thinking subagent
- [ ] Confirm `npm run check-types` is clean on `main` (so any new failure is yours)
- [ ] Note the current commit SHA — needed for the rollback gate

---

## Rollback strategy

Every Phase is committed as a sequence of small green-CI commits. Phases 11 and 12 land behind the `lupa.pipeline.v2` feature flag. Rollback options:

1. **Quest-level rollback**: `git revert <sha>` on the failed Quest. Re-validate.
2. **Phase-level rollback**: `git revert <range>` of the Phase's Quest commits.
3. **Feature-flag rollback**: For Phase 12, set `lupa.pipeline.v2 = false` workspace-wide. The old 8-step pipeline path remains intact until Phase 12 final cleanup (which only happens after a successful production bake).
4. **Architectural rollback**: If Phase 12 fails badly post-bake, revert Phases 11 and 12 entirely. Phases 1–10 remain valid (they are architecture-agnostic).

---

## What to do if a Phase produces unexpected eval regressions

1. Don't immediately revert. Investigate first.
2. Run the failing fixture PR through manually with logging on.
3. Compare model trajectory to a pre-Phase trajectory on the same fixture.
4. Categorize regression: is it a false-negative spike (we lost good findings) or false-positive spike (we added bad ones)?
5. If false-negative spike: probably a prompt regression — the model is being told to do less.
6. If false-positive spike: probably a verification gap — the new path bypassed something.
7. If genuinely architectural: revert per the Rollback strategy and reassess.

---

## Anti-patterns to avoid

- **Skipping Phase 0**: tempting to "just start". Don't. The ADR forces the user to commit to the direction.
- **Skipping Phase 8.1 because "we'll add tests later"**: every change without an eval baseline is a guess. Measure first.
- **Bundling multiple Quests in one commit**: hurts rollback granularity.
- **Implementing Phase 12 before Phase 11**: the Judge with no receipts is a downgraded version of what the playbook proposes.
- **Letting `npm run check-types` fail "just for this commit"**: never. The commit discipline section of CLAUDE.md is non-negotiable.
- **Running sequential-thinking in main context**: it pollutes the context window. Always in a subagent.

---

## Estimated total scope

- **Total Quests**: 26 (across Phases 0–14)
- **Cost-equivalent**: ~25 work sessions if executed cleanly with subagents per CLAUDE.md
- **Critical path** (must-do for biggest wins): Phases 0, 1, 2, 4, 11, 12 → 12 Quests, ~14 sessions
- **Long-tail polish** (Phases 7, 9, 10, 13, 14): ~10 sessions

The critical path captures most of the quality lift. The long tail is real value but can be parallelized or deferred.

---

## How to use this doc going forward

- **Start a session?** Open this doc, find your next Phase, run the per-Quest checklist.
- **Got blocked?** Re-read the cited evidence file. The playbook's "Hints" are starting points, not contracts.
- **Found something the playbook is wrong about?** Update the playbook AND this doc in the same commit. Do not let the docs drift.
- **Finished a Phase?** Update the `## Progress` section in the playbook and notify the user — they may want to gate before the next Phase.
