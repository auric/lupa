# Lupa Rescue — Implementation Instructions v2

> **Status**: Active. Supersedes `implementation-instructions.md`.
> **Companion**: [lupa-rescue-playbook_v3.md](lupa-rescue-playbook_v3.md) — the _what and why_. This file is the _when and how_.
>
> This document tells the implementing agent and the maintainer **in what order** to land Quests, **what gates** each release must pass, and **how to roll back** if eval regresses. Phase numbering matches the playbook.

---

## How to use this document

- One Quest = one PR = one commit boundary (see `CLAUDE.md` → Commit Discipline).
- Before any Quest: re-read the Quest body in the playbook, read the files it cites, and confirm the hints are still accurate (code may have drifted).
- Use sequential thinking **inside a subagent** when a Quest's design has real trade-offs (per `CLAUDE.md`). Main agent orchestrates; subagents do deep reading and bulk edits.
- Never stack more than one Quest per branch. If a Quest is > 300 LOC net, split it.
- Every Quest ends with `npm run check-types` passing and any touched tests passing.

---

## Release wave plan

Waves are deployable milestones. Each wave has a clear user-facing win and a kill-switch.

### Wave 0 — Foundation (eval harness first)

**Goal**: "We can measure." No prompt / tool changes yet.

**Quests**: 8.3 → 8.1 → 8.2 → 0.1 (ADR written and committed). 8.3 (headless entry point) is a hard prerequisite for 8.1 — the eval runner has nothing to invoke without it.

**Gate**: eval runs end-to-end on all supported profiles with `N = 3` seeds; baseline numbers (mean ± stddev) recorded in `eval/results/baseline-<date>.md`.

**Why first**: every later wave must prove itself against this baseline.

### Wave 1 — Stop the bleeding

**Goal**: Zero silent data loss; deterministic tool behavior; cache eliminates repeat reads.

**Quests**: 1.1 → 1.2 → 1.3 → 1.4.

**Gate**: synthetic 100-iteration test produces results; Raptor-trace repeat-read pathology gone on fixture PRs; `toolError` kinds covered by unit tests.

**Kill-switch**: none needed — all four Quests are low-risk bug fixes.

**Expected eval delta**: small precision bump (hallucinations from free-form errors go away) + measurable cost/iteration drop from cache.

### Wave 2 — Thinking + scaffolding

**Goal**: Older models actually reason.

**Quests**: 2.1 → 2.2 → 2.3.

**Gate**: on GPT-4.1 / Raptor, `sequential_thinking` call ratio ≥ 15 %; ReAct violations ≤ 5 %; eval precision and recall both ≥ baseline.

**Kill-switch**: feature flag `lupa.thinking.v2` rollbacks to old `think` tool.

**Expected eval delta**: material recall improvement on GPT-4.1-family models.

### Wave 3 — Subagent IO

**Goal**: Siblings share notes; main-agent context stops bloating.

**Quests**: 4.1 → 4.2 → 4.3.

**Gate**: duplicate-finding rate drops on multi-subagent fixtures; main-agent token count per iteration drops.

**Kill-switch**: `lupa.subagent.structured` flag — reverts to raw markdown returns.

### Wave 4 — Big picture

**Goal**: Final review has a narrative; per-repo conventions respected.

**Quests**: 3.1 → 3.2 → 3.3.

**Gate**: 100 % of fixture outputs include a `narrative` section; auto-ingest unit tests pass; snapshot test confirms `<project_conventions>` block rendered.

**Kill-switch**: disable `prOverviewBuilder` and `conventionFileLoader` via workspace setting.

**Expected eval delta**: findings better targeted to PR intent; false positives from "didn't know about our conventions" drop.

### Wave 5 — Tool pruning + externalized checklists

**Goal**: Smaller always-on prompt; checklist content iterable without releases.

**Quests**: 7.1 → 7.2 → 7.3.

**Gate**: tool counts per profile within budget; bundled checklists render via `read_file`; workspace override works.

**Kill-switch**: restore deleted tools from git; revert per-profile budgets.

### Wave 6 — Recursion + budgets

**Goal**: Dense 2-file PRs trigger fan-out; models pace themselves.

**Quests**: 5.1 → 5.2 → 5.3.

**Gate**: on the dense-2-file fixture, ≥ 2 subagents spawned; budget-overrun rate drops.

**Kill-switch**: per-profile override that restores the old heuristic.

### Wave 7 — Verification moat (the biggest lever)

**Goal**: Every MEDIUM+ finding is grounded; unverified findings dropped.

**Quests**: 11.0 → 11.3 → 11.1 → 11.2.

**Gate**: ≥ 80 % of shipped findings carry a `sources` array; verification drop-rate between 10–40 % (too high = prompt too strict; too low = `verify_finding` not called).

**Kill-switch**: `lupa.verification.v2` flag — when off, `sources` optional, no Judge stage, no drop on unverified.

**Expected eval delta**: large precision improvement; small recall trade-off acceptable if precision rises enough to push resolution-rate ≥ baseline + 10 %.

### Wave 8 — Pipeline refactor

**Goal**: 8 steps → 3 stages; roles specialized; recursion capped at 1.

**Quests**: 12.4 → 12.3 → 12.2 → 12.1.

**Gate**: `lupa.pipeline.v2` flag produces outputs equivalent or better to baseline; average wall-clock for post-analysis drops; depth-1 invariant enforced in CI.

**Kill-switch**: `lupa.pipeline.v2=false` reverts to old pipeline.

### Wave 9 — Compaction

**Goal**: Iteration cap no longer loses deep investigations.

**Quests**: 6.1 → 6.2 → 6.3.

**Gate**: on synthetic long-trace fixture, compact-and-continue succeeds; at most one extension used.

**Kill-switch**: disable `compact_history` tool per profile.

### Wave 10 — Multi-model + polish

**Goal**: Claude family works end-to-end; cheaper models handle compaction.

**Quests**: 10.1 → 10.3 → 10.2 → 9.1.

**Gate**: Claude profile produces valid runs; auxiliary-model split saves cost without regressing eval.

### Wave 11 — Scoring + carry-overs

**Goal**: Deterministic scorer; remaining items from original playbook.

**Quests**: 13.1 → 13.2 → 14.1 → 14.2 → 14.3.

**Gate**: scoring reproducible across runs; `architecture_design` category renders; trust-boundary block passes injection-string tests.

---

## Cheapest wins you can ship this week

If you want order-of-magnitude improvement in a few days without the full playbook, ship these six Quests in order. All are low-risk, evidence-grounded, and low-LOC:

1. **Quest 1.1** — unconditional post-analysis pipeline run. _(Prevents silent data loss — the highest-impact bug fix.)_
2. **Quest 1.3** — structured stub returns. _(Deterministic model reactions to tool failures.)_
3. **Quest 1.4** — per-analysis file cache. _(Kills Raptor's "same file 8×" cost drain.)_
4. **Quest 3.3** — convention-file auto-ingest. _(Adds per-repo persistence for free.)_
5. **Quest 2.1** — sequential-thinking tool. _(Older models finally reason in a loop.)_
6. **Quest 11.3** — mandatory `sources` grounding. _(Kills most hallucinated findings with a one-field schema change.)_

Wave 0's eval harness should ideally exist before step 5 so you can measure the gain; in a pinch, land 1–4 without eval and add eval before 5.

---

## Per-Quest checklist (apply to every Quest)

Before opening the PR:

- [ ] Re-read the Quest body in `lupa-rescue-playbook_v3.md`.
- [ ] Re-read `rlm-tools-deep-dive.md` sections cited by the Quest.
- [ ] For any file hint: `view` it and confirm the referenced symbol/path still exists.
- [ ] For design trade-offs: spawn a subagent with explicit instructions to use sequential thinking.
- [ ] Implementation lives behind a feature flag if the Quest touches prompt surface, pipeline shape, or tool registration (in practice: Wave 2 onwards). The kill-switch is the wave-level rollback — see `Decision gates and rollback` below.
- [ ] `npm run check-types` passes.
- [ ] Affected tests updated (never create new test files unless the playbook Quest names one).
- [ ] Eval harness (once Wave 0 is in) run against fixtures — results attached to PR description.
- [ ] Commit message follows `CLAUDE.md` conventions: `feat:` / `refactor:` / `fix:` prefix, concise WHAT+WHY.
- [ ] Surgical changes only (per `CLAUDE.md` → Surgical Changes): no drive-by refactors.

---

## Decision gates and rollback

**Decision gate** — before merging a wave:

1. Eval resolution-rate must not regress by > 5 % vs the prior wave's baseline.
2. Eval precision must not drop > 10 pp without an explicit rationale in the PR description.
3. Recall must not drop > 10 pp without an explicit rationale.
4. Wall-clock per analysis must not increase > 30 % without an explicit rationale.

**Rollback** — if a wave regresses after landing:

1. Flip the wave's kill-switch flag (listed in the wave entry above).
2. Open a follow-up issue citing the eval diff.
3. Do **not** revert the commit unless the flag isn't sufficient — flag-based rollback keeps forward motion on unrelated waves.

---

## Cross-reference table (Quest → source hints)

| Quest | Primary source files to read                                                           |
| ----- | -------------------------------------------------------------------------------------- |
| 1.1   | `src/services/analysisEngine.ts`, `src/models/conversationRunner.ts`                   |
| 1.2   | `src/utils/investigationAudit.ts`, `src/services/executionContext.ts`                  |
| 1.3   | `src/types/toolResultTypes.ts`, every `src/tools/*Tool.ts`                             |
| 1.4   | `src/tools/readFileTool.ts`, `src/tools/getFileDiffTool.ts`, `src/services/*`          |
| 2.1   | `src/tools/thinkTool.ts`, `src/services/executionContext.ts`                           |
| 2.2   | `src/prompts/blocks/`, `src/models/modelCalibration.ts`                                |
| 2.3   | `src/prompts/*.ts`, `src/models/conversationRunner.ts`                                 |
| 3.1   | new `src/services/prOverviewBuilder.ts`, `src/services/analysisEngine.ts`              |
| 3.2   | `src/tools/submitReviewTool.ts`, output renderer                                       |
| 3.3   | new `src/services/conventionFileLoader.ts`, VS Code workspace API                      |
| 4.1   | `src/sessions/findingStore.ts`, `src/prompts/subagentPromptGenerator.ts`               |
| 4.2   | `src/tools/runSubagentBatchTool.ts`, `src/models/subagentRunner.ts` (or equivalent)    |
| 4.3   | `src/prompts/subagentPromptGenerator.ts`                                               |
| 5.1   | `src/prompts/blocks/recursiveMethodology.ts`, `src/models/modelCalibration.ts`         |
| 5.2   | new `decompose_concerns` tool, `src/services/executionContext.ts`                      |
| 5.3   | `src/models/modelCalibration.ts`, `src/models/conversationRunner.ts`                   |
| 6.1   | new `src/tools/compactHistoryTool.ts`, `src/services/chatHistoryService.ts`            |
| 6.2   | `src/utils/tokenValidator.ts`                                                          |
| 6.3   | `src/models/conversationRunner.ts`, `src/services/analysisEngine.ts`                   |
| 7.1   | `src/tools/*`, `src/models/modelCalibration.ts`                                        |
| 7.2   | `src/models/modelCalibration.ts`                                                       |
| 7.3   | new `resources/checklists/*.md`, `src/tools/readFileTool.ts`                           |
| 8.1   | new `scripts/eval/run-eval.ts`, `eval/fixtures/synthetic/`, `eval/fixtures/real/`      |
| 8.2   | `scripts/eval/run-eval.ts`, resolution classifier                                      |
| 8.3   | new `src/eval/headlessRunner.ts`, `src/services/analysisEngine.ts`, `.vscode-test.mjs` |
| 9.1   | `src/services/analysisEngine.ts`, new consensus module                                 |
| 10.1  | `src/models/modelCalibration.ts`, `src/services/chatLLMClient.ts`                      |
| 10.2  | webview components, event bus                                                          |
| 10.3  | `src/models/modelCalibration.ts`, `src/services/prOverviewBuilder.ts`, compaction tool |
| 11.0  | `src/types/findingTypes.ts`, output renderer, `src/services/pipeline/steps/*`          |
| 11.1  | new `src/tools/verifyFindingTool.ts`, `src/services/ripgrepSearchService.ts`           |
| 11.2  | new `src/services/pipeline/stages/judgeStage.ts`                                       |
| 11.3  | `src/tools/recordFindingTool.ts`, `src/services/pipeline/`, output renderer            |
| 12.1  | `src/services/postAnalysisPipeline.ts`, all `src/services/pipeline/steps/*`            |
| 12.2  | `src/prompts/`, `src/tools/toolConstants.ts`, `src/models/recursiveStateManager.ts`    |
| 12.3  | `ARCHITECTURE.md`, `src/tools/toolConstants.ts`, new CI lint                           |
| 12.4  | `src/models/modelCalibration.ts`, `src/models/recursiveStateManager.ts`                |
| 13.1  | `src/services/pipeline/steps/findingScoringStep.ts`                                    |
| 13.2  | `src/tools/scoreFindingTool.ts`, `src/prompts/`                                        |
| 14.1  | `src/types/findingTypes.ts`                                                            |
| 14.2  | `src/services/analysisEngine.ts`, webview                                              |
| 14.3  | `src/prompts/`, PR context assembly                                                    |

---

## Subagent delegation hints (how I'd split this work)

For agents coming back to this doc in a fresh session:

- **Research subagents**: use Tavily / DeepWiki per `CLAUDE.md` guidance. Most of the external research is already in `rlm-tools-deep-dive.md`; new research should verify API signatures and current source layout.
- **Wave 7 (Verification moat)** deserves the heaviest subagent investment: at least one subagent per Quest, each with explicit instructions to verify schema changes don't break existing tool consumers.
- **Wave 8 (Pipeline refactor)** should be one subagent per step-deletion (so you can revert individually if eval bisects a regression to a single removed step).
- **Never delegate the full wave** to one subagent — break per Quest.

---

## What did _not_ make this document (intentional)

- Exact line counts per Quest. Estimates don't survive contact with the real codebase.
- Scheduling against calendar weeks. The waves are ordered by dependency, not time.
- Prompt text. The playbook says what each prompt should **express**; drafting the actual prose is the implementing agent's job and requires live context.

---

_End of v2 instructions._
