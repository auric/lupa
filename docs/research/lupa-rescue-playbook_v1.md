# Lupa Rescue Playbook — Squeezing Maximum from Older Models

> **Status**: Active. Supersedes the next-step ordering in [implementation-playbook.md](implementation-playbook.md). Acts 1–4 from that document are assumed landed; Act 5 (Scorer Simplification) is **deferred** with rationale below. Acts 6–12 from the original remain valid but are re-sequenced into the Phases below where they fit.
>
> **Audience**: An expert agent (Opus-class) who will research deeply before implementing each Quest. Quests are intentionally written as user stories with rich context, not as step-by-step instructions. The implementing agent is expected to:
>
> - Re-read the cited code and prior research
> - Run subagents to validate assumptions
> - Use sequential-thinking for design decisions
> - Make the call on exact APIs / file layouts
>
> **Stack reminders**: TypeScript · VS Code Extension API · Vitest · React 19. Conventions in [CLAUDE.md](../../CLAUDE.md) and [ARCHITECTURE.md](../../ARCHITECTURE.md) are non-negotiable.

---

## Why this document exists

The current [implementation-playbook.md](implementation-playbook.md) was written before we had real run data from older models. Now that we have a 39 000-line Raptor Mini trace ([tool_calls_raptor_mini.md](../../tool_calls_raptor_mini.md)) and a complete inventory of tools, prompts, and pipeline state (see session memory `sub-A` … `sub-G`), the gap between the original Act ordering and the actual failure modes is large enough to warrant re-prioritization.

The Raptor Mini trace is the single most important piece of evidence. It shows:

- **464 iterations · 350 tool calls · 23 failures · ONE finding produced.**
- `think` was called 14 times (4 % of calls), used as plan-checkpoint not as reasoning.
- Four parallel subagents and three recursive verification subagents all drilled the **same** bug because they could not see each other's hypotheses.
- The same `investigationAudit` diff appeared in context **8+ times** across redundant fetches.
- No PR-level narrative was produced; obvious cross-module duplication was missed.
- The model did not hit the iteration cap — it **soft-gave-up**, locking on one finding and re-verifying it instead of broadening coverage.

Almost every user-reported pain point is reproduced in that trace. The Quests below are derived directly from those failure modes.

---

## Diagnosis (10 confirmed root causes)

| #   | Root cause                                                                                                                                                                   | Evidence                                                            |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 1   | `think` tool is too weak — generic `think(thought: string)` has no schema-driven loop                                                                                        | Raptor used it 4 % of calls; `src/tools/thinkTool.ts`; sub-C, sub-F |
| 2   | Sibling subagents have **no shared in-flight scratchpad**; FindingStore is shared but only post-commit, and prompts don't tell subagents to query it                         | sub-B §10–11, sub-F §3                                              |
| 3   | Subagent results return as **raw markdown** to the parent (up to 150 K chars), causing filename/diff echo bloat                                                              | sub-B §13, sub-G §9, sub-F                                          |
| 4   | Main agent **never sees the full diff** → no PR-level overview can be produced                                                                                               | sub-B §6, sub-C §6, sub-F                                           |
| 5   | `extractFilesExamined` only counts `get_file_diff` calls — symbol/read/usage investigation gets no coverage credit, enabling re-spawn loops                                  | sub-G §10                                                           |
| 6   | Recursion heuristic is **file-count based**, codified in the prompt as "1–2 files <30 LOC: review directly" — small but dense diffs collapse to flat review                  | sub-C §5                                                            |
| 7   | **Zero summarization** anywhere; `cleanupContext` deletes oldest tool results at 90 % context                                                                                | sub-G §4, sub-C §8                                                  |
| 8   | At main iteration cap (100), the loop just exits — **the entire post-analysis pipeline is silently lost** because it gates on `analysisCompleted`                            | sub-G §1 (CRITICAL bug)                                             |
| 9   | No GPT-4.1 best-practice scaffolding (OpenAI cookbook persistence/tool-calling/planning sentences); prompts don't repeat instructions at the end where 4.1 weights them most | sub-E §1–2, sub-C                                                   |
| 10  | Adversarial framing in `record_finding` prompt over-suppresses recording — Raptor recorded 1 finding from 350 tool calls                                                     | sub-C §10, sub-F                                                    |

A short eleventh: **tool overload**. 19 tools, including `update_plan` (legacy from full-diff era), `find_files_by_pattern` (used once by Raptor in 350 calls), `get_pr_context` (auto-injectable). Per-model disable matrix exists but is under-used. (Evidence: sub-B §1 §4, sub-F.)

---

## Why Act 5 is deferred

Act 5 changes three scoring signal weights:

- Remove `descriptionQuality` signal
- `absencePattern` from −15 to −10
- `affectedComponentVerified` from −5 to −3

These are calibration tweaks on a scorer that runs **after** findings are produced. The Raptor trace produced **one** finding. The scorer is not the bottleneck — production of high-quality findings is. Tuning scorer signals while the upstream still produces 1 finding from 350 tool calls is fixing the thermostat in a building with no heaters.

Act 5 should land **after** Phases 1–6 below. It is preserved verbatim as Phase 9.

---

## Phase ordering and dependencies

```
Phase 1 (Correctness)  ─┐
                        ├─► Phase 2 (Thinking)  ──┐
Phase 4 (Subagent IO)  ─┤                         ├─► Phase 5 (Recursion) ──┐
                        └─► Phase 3 (Overview)  ──┘                         │
Phase 6 (Compaction)   ──── independent, do anytime after Phase 1           │
Phase 7 (Tool pruning) ──── do alongside Phase 4                            │
Phase 8 (Multi-model)  ──── after Phase 2                                   │
                                                                            ▼
                                                        Phase 9 (was Act 5: scorer)
```

Recommended landing order: **1 → 2 → 4 → 3 → 7 → 5 → 6 → 8 → 9.**

Phase 1 first because it is a silent correctness bug (lost pipeline). Phase 2 next because it is the cheapest leverage point for older models. Phase 4 before Phase 3 because the PR-overview artifact (Phase 3) needs the new structured-IO substrate (Phase 4) to plug into.

---

## Phase 1 — Stop the bleeding

Two correctness bugs hide everything else. Land these before any prompt or scoring work.

### Quest 1.1 — Never lose the post-analysis pipeline

**As** a reviewer running Lupa on a hard PR,
**I want** the post-analysis pipeline (evidence audit, adversarial verification, scoring) to **always** run on whatever findings the main agent recorded,
**so that** I see results even when the main agent hit its 100-iteration cap.

Current behaviour: `AnalysisEngine.analyze()` runs `PostAnalysisPipeline` only inside an `if (analysisCompleted)` branch. When `ConversationRunner` exits because iterations ran out, `analysisCompleted` is false and the entire pipeline is skipped. The user sees nothing or sees raw findings that never went through `evidenceAuditStep`, `findingScoringStep`, or adversarial verification.

What "done" looks like:

- The pipeline runs unconditionally if **any** findings were recorded (even if `submit_review` was never called).
- The UI clearly distinguishes "analysis completed normally" vs "analysis truncated at iteration cap — partial results shown".
- A test reproduces the bug (synthetic 100-iteration run) and proves the fix.
- The "force-finalize" prompt at iteration 92/100 still fires, but the pipeline runs even if the model ignores it.

Hints (verify before relying):

- `src/services/analysisEngine.ts` — find the `analysisCompleted` gate
- `src/models/conversationRunner.ts` — `wasCancelled`, `hitMaxIterations` flags
- `src/sessions/findingStore.ts` — query for "any findings recorded"
- `src/services/postAnalysisPipeline.ts` — confirm it is safe to run on a partial findings set

### Quest 1.2 — Credit all investigation tools for file coverage

**As** the recursive controller,
**I want** files investigated via `find_symbol`, `read_file`, `find_usages`, and `search_for_pattern` to count toward coverage,
**so that** I do not re-spawn subagents to re-investigate files we already studied, and so I do not under-credit thorough non-diff investigation.

Currently `extractFilesExamined` only inspects `get_file_diff` tool-call args. The Raptor trace shows the model studied a file via `find_symbol` + `read_file` and then was steered (by the coverage-gap callback) to spawn another subagent for the same file. This wastes budget and dilutes findings.

What "done" looks like:

- A unified `extractFilesTouched(toolCalls)` that walks every investigation-tool result and extracts file paths (use `normalizeRelativePath` from `utils/investigationAudit.ts` per repo memory).
- Coverage-gap callback uses the broader set.
- `investigatedFiles` set in `ExecutionContext` is populated from this broader extractor, not just diff fetches.
- Tests cover each tool's path-extraction edge cases (Windows separators, `./` prefix, `..`).
- No regression in legitimate "you forgot file X" reminders.

---

## Phase 2 — Make the model think (cheapest leverage, biggest win for GPT-4.1 / Raptor)

The single highest-leverage change for older models. Three Quests, all small.

### Quest 2.1 — Replace `think` with a sequential-thinking-style tool

**As** GPT-4.1 / Raptor Mini doing a complex review,
**I want** a thinking tool that makes me **want** to call it repeatedly,
**so that** I actually do chain-of-thought instead of jumping straight to action tools.

The current `thinkTool` schema is `{ thought: string }`. The model has no structural reason to call it more than once per "checkpoint". The sequential-thinking MCP server (`modelcontextprotocol/servers` → `sequentialthinking`) demonstrates the design that makes models loop: required `nextThoughtNeeded: boolean`, `thoughtNumber: int`, `totalThoughts: int`, and optional `isRevision`/`revisesThought`/`branchFromThought`/`branchId`. The required boolean **is** the loop trigger.

What "done" looks like:

- New `sequential_thinking` tool replacing `think`. Schema mirrors the MCP server's contract closely (do not invent new field names — convergence with a known pattern is the point).
- Tool implementation is mostly bookkeeping: store the chain in `ExecutionContext`, expose it to downstream pipeline (post-analysis can mine it), do not execute side effects.
- The chain is shared into the FindingStore-blackboard so subagents can see prior reasoning when relevant (see Phase 4).
- Tool description in 1–2 paragraphs; place the rich guidance in the system prompt body (Anthropic finding: complex think guidance belongs in system prompt, not tool description).
- Backward-compat: keep `think` as a thin wrapper for one release that forwards to `sequential_thinking` with `thoughtNumber: 1, totalThoughts: 1, nextThoughtNeeded: false` so existing prompts do not break mid-rollout.
- Eval target: `sequential_thinking` calls / total-tool-calls should rise from 4 % (Raptor baseline) to ≥ 15 % on the same PR.

### Quest 2.2 — Apply OpenAI's GPT-4.1 prompting scaffolding

**As** GPT-4.1 (and Raptor Mini, which inherits 4.1 tendencies),
**I want** the official OpenAI persistence / tool-calling / planning instructions in my system prompt,
**so that** I do not terminate early, do not guess when I should call a tool, and do not skip planning between tool calls.

Three short paragraphs from the OpenAI GPT-4.1 prompting cookbook (verify exact wording when implementing): persistence ("keep going until the user's query is completely resolved … only terminate when you are sure"), tool-calling ("if you are not sure about file content or codebase structure, use your tools — do NOT guess"), planning ("you MUST plan extensively before each function call and reflect extensively on outcomes — DO NOT do this entire process by making function calls only").

GPT-4.1 weights the **end** of the prompt more heavily than the middle (sub-E §2). Repeat the planning sentence at the very end of the prompt as a closer.

What "done" looks like:

- Prompt block file (`src/prompts/blocks/`) for the 3-sentence scaffolding, applied in `promptBuilder.ts` for any model in calibration profiles `gpt-4.1`, `gpt-4o`, `raptor-mini`, `gpt-5-mini`.
- Closing reminder at the bottom of the system prompt for the same models.
- Do not apply to Claude profile — Claude has native extended thinking and does not need this scaffolding (and benefits from terseness — sub-E §10).
- A vitest snapshot test pins the exact insertion points to prevent drift.

### Quest 2.3 — ReAct enforcement: a thought between actions

**As** the analysis loop,
**I want** to require a `sequential_thinking` call between any two non-thinking tool calls,
**so that** the model interleaves reasoning with action instead of running tool-only sequences.

This is the prompt-level rule from sub-E §4 (Anthropic measured +54 % when both prompt-and-tool guidance are present vs tool alone). Implement as **prompt instruction** plus **soft enforcement** — if the model emits two non-think tool calls in a row, inject a system message: "Reminder: call `sequential_thinking` to plan before the next action."

What "done" looks like:

- Prompt rule clearly stated in main + subagent + recursive-root prompts (for GPT-4.1 family only — Claude does not need it).
- Soft-enforcement injection in `ConversationRunner` after detecting two consecutive non-think tool calls. Inject at most once per "violation streak" to avoid nagging.
- 2–3 in-prompt examples of the right pattern (think → tool → think → tool), keyed to a real review scenario.
- Eval: zero tool-tool sequences for GPT-4.1 in test runs (or detect-and-recover within one nudge).

---

## Phase 3 — Restore the missing big picture

The main agent never sees the diff. The prompt asks for a 2–3 sentence TL;DR but nothing in the system can produce it well without the full picture.

### Quest 3.1 — PR Overview pre-step

**As** the main agent kicking off a review,
**I want** a pre-computed narrative summary of the PR — what changed, why (per commit messages), risk hotspots — written as an artifact in my `ExecutionContext`,
**so that** I have a global mental model from iteration 1 without re-fetching the full diff.

This is a one-call, cheap-model preprocessing step. It runs **before** `AnalysisEngine.analyze()` enters the conversation loop. It uses the same model that the main agent uses (or a configurable cheaper alternative — gpt-4o-mini etc.) and emits a strict-format artifact.

Artifact shape (proposal — implementing agent decides exact fields after re-reading `ExecutionContext`):

```typescript
interface PROverview {
    intent: string; // 2-3 sentences: what is this PR doing and why
    changeShape: {
        // factual, computed (not LLM)
        fileCount: number;
        addedLines: number;
        removedLines: number;
        languages: string[];
        primaryDirectories: string[];
    };
    riskHotspots: Array<{
        // LLM-produced
        file: string;
        reason: string;
    }>;
    reviewPlan: string[]; // 4-7 bullet points: what to check
}
```

What "done" looks like:

- New service `src/services/prOverviewBuilder.ts`. Given the parsed diff + commit messages, calls the model once with a strict short prompt and returns `PROverview`.
- Output is injected into the main system prompt as a `<pr_overview>` XML block.
- Output is also written to FindingStore (or adjacent shared store) so subagents can see it.
- Output drives the **mandatory `update_plan` initial state** so the model's plan starts from the overview, not from scratch.
- Failure mode: if the overview call fails, log and continue with empty overview — never block the analysis.
- Token budget: the overview itself ≤ 600 tokens. The full diff sent to the overview model is bounded — use a strategy like "first 8 K tokens of diff + file list + commit messages" for huge PRs.

### Quest 3.2 — Mandatory PR narrative in final review output

**As** a human reviewer reading the final report,
**I want** a "What this PR does" section at the top — 2–3 paragraphs — before the findings,
**so that** I can frame the findings against the PR's intent.

The `submit_review` tool / output formatter currently does not require this section. With Quest 3.1 in place, producing it is cheap: synthesize the PR overview + the findings into a narrative. The agent does not need to re-derive intent; it composes.

What "done" looks like:

- `submit_review` schema gains a required `narrative` field with a description like: "2–3 paragraphs explaining what this PR does, framed around the changes you investigated and the issues you found. Reference the PR overview where useful."
- Output renderer places `narrative` above `findings`.
- The main system prompt's output-format section is updated to demand the narrative.
- Snapshot test on the rendered output.

---

## Phase 4 — Subagent IO redesign (kill token waste, enable real collaboration)

The biggest structural problem. Subagents return raw markdown to the parent (up to 150 K chars) and cannot see each other's work in flight. Fix both at once.

### Quest 4.1 — Promote FindingStore to an explicit blackboard

**As** a subagent investigating a hypothesis,
**I want** to see what other subagents have already recorded (or partially recorded as in-flight observations),
**so that** I do not re-investigate the same hypothesis from scratch.

The FindingStore is already a single shared instance per analysis (sub-B §10). What is missing:

1. A **read** tool that subagents can call: `list_findings(filter?)` returns IDs, severity, file, 1-line summary.
2. A **shared scratchpad** — a low-ceremony channel for in-flight observations that are not yet findings (call it `note(content, tags?)` and `list_notes(filter?)`). Persists for the duration of the analysis. Same store, different table.
3. Subagent prompts that **tell** them to call `list_findings` and `list_notes` before starting work and after major reasoning steps.

What "done" looks like:

- New tools `list_findings`, `note`, `list_notes`. Each ≤ 100 LOC.
- FindingStore extended with a `notes` collection (or sibling `NoteStore`).
- Subagent prompt block updated with: "Before investigating, call `list_findings` and `list_notes`. If your concern overlaps an existing finding/note, refine or contradict — do not duplicate."
- Notes are surfaced in the post-analysis pipeline (audit step can use them as supporting evidence).
- Soft cap: max 200 notes per analysis to prevent abuse.

### Quest 4.2 — Restructure `runSubagentBatch` return contract

**As** the main agent,
**I want** subagent batch results as a compact structured summary — finding IDs, note IDs, files touched, key conclusions — **not** as 150 K chars of markdown,
**so that** my context stays clean across multiple subagent waves.

The current return is `### Subagent #N — task ... <response> <compact audit>` raw markdown, proportionally truncated. The parent has to parse natural language to know what was found.

What "done" looks like:

- `runSubagentBatch` returns a structured object the runner serializes compactly:

```typescript
interface SubagentBatchResult {
    perAgent: Array<{
        taskHash: string;
        durationMs: number;
        iterations: number;
        status: 'completed' | 'degraded' | 'cancelled';
        findingsRecordedIds: string[]; // pulled from FindingStore by run scope
        notesRecordedIds: string[]; // pulled from NoteStore by run scope
        filesTouched: string[]; // from extractFilesTouched (Quest 1.2)
        summary: string; // ≤ 200 tokens, ENFORCED
    }>;
    aggregateSummary: string; // ≤ 400 tokens, computed across agents
}
```

- The "summary" field is requested by the subagent's `submit_subagent_result` tool with a strict ≤ 200-token instruction. If the model overshoots, truncate.
- Filenames are not in the summary text — they are in the structured `filesTouched` array, rendered separately in the parent's view (or not rendered at all if the parent never needs them surfaced as text).
- The audit/coverage-gap message uses the structured data, not regex parsing of markdown.
- This kills the "8x diff appearance" Raptor trace pathology.

### Quest 4.3 — Stop filename echo in subagent prompts

**As** the system,
**I want** subagent prompts to **not** ask the subagent to enumerate which files it examined,
**so that** the subagent does not waste tokens echoing what we already track programmatically.

Per sub-C §7, current subagent prompts demand truncated filenames + per-finding `Location: file:line`. The location-on-finding is fine (it lives on the recorded finding). The "tell me what files you examined" instruction is pure echo waste — Quest 1.2's `extractFilesTouched` already knows.

What "done" looks like:

- Remove the "report which files you examined" instruction from subagent prompts.
- Add: "The system tracks examined files automatically via your tool calls. Do not list them in your summary."
- Keep `Location: file:line` on findings (necessary for human readers and for evidence audit).
- The subagent's `summary` field (Quest 4.2) is ≤ 200 tokens, focused on **conclusions**, not bookkeeping.

### Quest 4.4 — Opaque IDs everywhere appropriate

**As** the analysis system,
**I want** findings, notes, and large tool outputs identified by short opaque IDs that can be referenced without repasting content,
**so that** prompt history stays compact even as the analysis gets long.

Findings already have IDs. Confirm and extend:

- Notes get IDs (Quest 4.1 already implies this).
- Large tool outputs (`read_file` > 4 K tokens, `get_file_diff` for a big file) get a content-addressable ID. The model can reference `read:abc123` to ask the system "remind me of region X of that read" via a `recall` tool, instead of re-issuing the full read.
- This is more involved — implementing agent should weigh complexity vs gain. If not worth it now, document as a Phase 4.4-deferred item.

---

## Phase 5 — Force recursion on volume, not file count

### Quest 5.1 — Volume-aware recursion heuristic

**As** the main agent reviewing a 2-file PR with 800 lines of churn,
**I want** the prompt to push me toward subagent fan-out on the **dense** file,
**so that** I do not collapse to a flat read-everything-in-context review and miss issues.

Current prompt rule: "1–2 files <30 LOC: review directly". This bakes file-count blindness in. Replace with a **change-volume** rule keyed on hunks and added/removed lines:

Decision rule (proposal — implementing agent tunes thresholds with the eval suite):

- `totalChangedLines < 60 && fileCount <= 2 && hunkCount <= 3` → direct review allowed
- `totalChangedLines >= 60 || hunkCount >= 4 || fileCount >= 3` → MUST spawn subagents
- Spawning unit is **concern**, not file. A 1-file 500-line change can spawn 4 concern-subagents.

What "done" looks like:

- The thresholds live in `src/models/modelCalibration.ts` (configurable per profile — older models may need lower thresholds).
- The recursive-root prompt explicitly states "if change volume meets the threshold, you MUST decompose into concerns and spawn at least 2 subagents — one per concern".
- A new prompt block: "Concern decomposition checklist" — the model lists 3–7 concerns explicitly before spawning. This forces analysis even on small dense diffs.
- Eval: on the test set, zero `2-file dense PR → 1 subagent` outcomes.

### Quest 5.2 — Concern-decomposition output as a first-class artifact

**As** the post-analysis pipeline,
**I want** the model's concern decomposition saved as an artifact,
**so that** the audit step can verify each concern was investigated, and the final review can reference unexamined concerns explicitly.

Tied to Quest 5.1: the decomposition is not just prompt scaffolding, it is structured output. New `decompose_concerns(concerns: Array<{name, rationale, targetFiles}>)` tool that the model calls once early. Subsequent `run_subagent_batch` tasks reference concern IDs.

What "done" looks like:

- `decompose_concerns` tool added with a Zod schema.
- `ExecutionContext` carries the decomposition.
- Audit step in post-analysis cross-references findings against concerns; concerns with zero findings get an "investigated, no issues" note vs concerns never investigated get flagged.
- Subagent task descriptions include the concern ID for traceability.

---

## Phase 6 — Compaction and graceful budget handling

### Quest 6.1 — Model-callable `compact_history` tool

**As** the model approaching context saturation (or just feeling crowded),
**I want** a tool that summarizes my older conversation turns into a compact note,
**so that** I can keep working without losing the gist of what I have done.

Sub-G §4 confirmed there is zero summarization today; only `cleanupContext` deletes oldest tool results outright. That is information loss disguised as context management.

What "done" looks like:

- `compact_history` tool. When called, it:
    1. Selects all turns older than the most recent N (configurable; default keep last 8 turns intact).
    2. Sends them to the same model with a prompt: "Summarize the following conversation history into ≤ 600 tokens, preserving: hypotheses tested, files examined, findings recorded (by ID), open questions."
    3. Replaces the selected turns with a single system-or-assistant message containing the summary.
- The summary is also persisted to the analysis log (so the post-analysis audit can read the full unsummarized history if needed).
- Compaction is **never** invoked mid-tool-call (Cline / Cursor have known infinite-loop bugs from this — see sub-D §8).
- Compaction count is tracked per analysis and exposed via the iteration-status display.

### Quest 6.2 — Replace `cleanupContext` deletion with summarization at 70 %

**As** the analysis loop,
**I want** auto-compaction at 70 % context (instead of the current "delete oldest tool results at 90 %"),
**so that** the model loses information gracefully instead of cliff-falling into deleted state.

Re-use the Quest 6.1 mechanism. At 70 % auto-trigger compaction; at 90 % escalate (compact more aggressively); at 100 % force-finalize as today.

What "done" looks like:

- `TokenValidator.cleanupContext` either delegates to `compact_history` or is replaced by it.
- The trigger thresholds become configurable (`workspaceSettingsSchema.ts`).
- Older models (GPT-4.1, Raptor) get more aggressive thresholds (60/80/95) because their effective context is shorter than nominal.

### Quest 6.3 — Compact-and-continue at iteration cap (with safeguards)

**As** a reviewer on a hard PR,
**I want** the system to compact and grant a one-shot iteration extension at the iteration cap, instead of hard-stopping,
**so that** a deep investigation that needed more turns gets to finish — but bounded so we never loop forever.

This is the user's "smart fix at the iteration limit" intuition. RLM-canonical does not do this (sub-D §5), but production agents (Cline `Auto Compact`) do, and it works when scoped.

What "done" looks like:

- At iteration cap, instead of exiting:
    1. If `compactionsUsed < MAX_COMPACTIONS_PER_ANALYSIS` (default 1, configurable), compact aggressively, reset iteration counter, inject a system message: "You have been granted N additional iterations after compaction. Use them to finalize. Do not start new investigation directions."
    2. Else exit and run the post-analysis pipeline (Quest 1.1 ensures this works).
- The injected instruction explicitly forbids new subagent spawns to bound the additional cost.
- Telemetry: log compaction-and-continue events so we can tune `MAX_COMPACTIONS_PER_ANALYSIS` from real data.
- Default `MAX_COMPACTIONS_PER_ANALYSIS = 1` to start conservative.

---

## Phase 7 — Tool pruning

### Quest 7.1 — Delete or merge legacy tools

**As** GPT-4.1 / Raptor Mini facing a tool list,
**I want** ≤ 12 tools available,
**so that** I do not suffer cognitive overload picking the right tool.

Audit (per sub-B and sub-F):

| Tool                    | Decision                                                                                                                                                                                                                                                    | Rationale                                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `update_plan`           | **Remove**. Replace its initial-plan role with the PR-overview artifact's `reviewPlan` (Quest 3.1). Keep an internal "plan state" object in `ExecutionContext` that the model can update via a thin `set_plan_step_status` tool, or drop tracking entirely. | User-flagged legacy. Used 2x in Raptor 350-call trace. Markdown blob with no downstream consumer.                    |
| `find_files_by_pattern` | **Remove**. Already disabled for GPT-4.1/4o via `disabledTools`. Used 1x in Raptor trace.                                                                                                                                                                   | Functionally subsumed by `search_for_pattern` + diff metadata.                                                       |
| `get_pr_context`        | **Remove**. Auto-inject PR context (overview, diff metadata) into the system prompt at analysis start.                                                                                                                                                      | User-flagged. The information is needed by every analysis — make it ambient, not on-demand.                          |
| `get_symbols_overview`  | **Keep but disable for older models** (already disabled per calibration). Document the rationale in code.                                                                                                                                                   | Older models do not benefit from broad-overview tools; they benefit from targeted ones.                              |
| `batch_tools`           | **Keep but disable for GPT-4.1/4o** (already disabled). Audit prompt mentions and remove stale references.                                                                                                                                                  | sub-C noted prompts still mention `batch_tools` despite calibration disabling it — confusing for the model.          |
| `validate_claim`        | **Keep**. High-value gate before `record_finding`.                                                                                                                                                                                                          | Cited in sub-C §10 as MUST-before-record — keep but rebalance the surrounding prompt to not over-suppress recording. |
| `record_finding` schema | **Slim**. 11 fields is too many. Reduce to ≤ 7 required + the rest optional.                                                                                                                                                                                | sub-B §9 flagged this as friction.                                                                                   |

What "done" looks like:

- Each removed tool: deleted from `src/tools/`, registry entry removed, prompt mentions purged, tests deleted.
- Each kept-but-restricted tool: calibration matrix in `modelCalibration.ts` updated; prompt mentions gated on `disabledTools`.
- Tool count for GPT-4.1 profile: target ≤ 12.
- Snapshot test on the rendered tool list per profile to prevent regression.

### Quest 7.2 — Per-model tool budget as a calibration constant

**As** the prompt builder,
**I want** an explicit `maxToolsExposed` per calibration profile,
**so that** future tool additions are forced to consider which model gets them.

Default: GPT-4.1 / Raptor Mini = 12, GPT-5 mini = 14, Claude = 18. Build-time assertion that no profile exposes more than its budget.

---

## Phase 8 — Multi-model coverage

### Quest 8.1 — Claude Haiku 4.5 calibration profile + Copilot system-message workaround

**As** a Lupa user with Claude Haiku 4.5 enabled,
**I want** the system to actually work with Claude despite the Copilot API stripping system messages,
**so that** I can compare model performance fairly.

Sub-E §11 documents that historically Copilot's API converted system→assistant for Claude (litellm#19873). The reliable workaround: wrap the full system prompt inside a `<system_instructions>...</system_instructions>` XML block in the **first user message**, and restate the 3 most important rules at the end of the user message. Claude follows XML tags strongly.

What "done" looks like:

- New `claude-haiku-4.5` profile in `modelCalibration.ts` (or extend the generic `claude` profile with sub-variants).
- `chatLLMClient` (or wherever the message is assembled) detects Claude family and switches assembly mode: system content inlined into user message wrapped in `<system_instructions>`.
- A test that verifies the assembled message structure for Claude vs OpenAI families.
- Document the workaround in `ARCHITECTURE.md` so future maintainers do not get confused.

### Quest 8.2 — Cross-model eval harness

**As** the team maintaining Lupa,
**I want** a small reproducible eval harness across models,
**so that** prompt or tool changes can be compared rather than guessed at.

Original playbook Act 12 covers this. Pull it forward to land alongside Phase 8.1. Minimum viable: 5 sealed PRs with hand-labeled expected findings; a script that runs each PR through each calibrated model and reports precision/recall/F1.

What "done" looks like:

- `scripts/eval/run-eval.ts` runner.
- 5 sealed PRs in `eval/fixtures/` with `expected.json` labels.
- Output: a markdown report showing per-model precision, recall, F1, mean iterations, mean tokens.
- Run before merging any prompt-affecting PR.

---

## Phase 9 — Scorer simplification (was Act 5)

Land **after** Phases 1–6 because:

1. The Raptor trace produced 1 finding from 350 calls. Scorer tweaks have nothing to act on.
2. Phase 4 changes the FindingStore contract (notes added, structured subagent results). Phase 5 changes what counts as "investigated" (concerns artifact). Both have downstream signal implications. Re-tuning the scorer **before** these land means re-tuning twice.
3. The proposed weight changes (descriptionQuality removed, absencePattern −15→−10, affectedComponentVerified −5→−3) are sensible directionally — they reduce over-suppression. But the right values are an **eval-driven** decision (Phase 8.2), not a guess.

What "done" looks like:

- Apply the three changes from the original Act 5 verbatim **only after** Phases 1–6 have landed and the eval harness (Phase 8.2) is producing baseline numbers.
- Re-baseline the eval suite immediately after the change.
- If precision drops, revert and try smaller increments.

---

## Open questions for the implementing agent

1. **Quest 3.1 (PR Overview)**: Should the overview model be the same as the analysis model, or always a cheap fast one (e.g. gpt-4o-mini)? Trade-off: same model = consistent voice + extra tokens; cheap model = faster + risk of mismatch. Recommend: configurable, default cheap.
2. **Quest 4.4 (Opaque IDs)**: Does the existing `LargeToolResultStore` (if any — verify) already handle this? If yes, extend rather than build new.
3. **Quest 6.3 (Compact-and-continue)**: Is `MAX_COMPACTIONS_PER_ANALYSIS = 1` too tight? The eval data will tell us.
4. **Quest 7.1 (`update_plan` removal)**: There may be UI components that render the plan. Verify before deletion. If the UI relies on it, replace its data source with the PR-overview artifact.
5. **Phase ordering**: Is Phase 4 truly before Phase 3? Phase 3's PR-overview artifact does not strictly need Phase 4's structured-subagent-IO. They could land in parallel. The given order minimizes mid-flight refactors of the prompt.

---

## What is **not** in this playbook (and why)

- **Multi-pass aggregation (Manki style, original Act 9)**: Valuable but expensive and orthogonal. Land after Phases 1–8 if eval data shows recall is still the bottleneck.
- **Exploration-mode calibration (original Act 10)**: Already covered partially by Phases 4 and 5; revisit after they land.
- **Trust-boundary tags (original Act 11)**: Niche. Worth doing eventually. Not in the critical path.
- **Webview UI work (original Act 6)**: Independent. Does not affect model quality.
- **`architecture_design` finding category (original Act 7)**: Cosmetic categorization. Defer.

---

## Memory hygiene for the implementing agent

When implementing each Quest:

1. Re-read the cited evidence (`/memories/session/sub-*.md` and the source files cited in the diagnosis table).
2. Use sequential-thinking (in a subagent — do not pollute main context) for any non-trivial design call.
3. Commit per Quest, not per Phase. Each Quest should be a green-CI commit with `npm run check-types` passing.
4. Update [implementation-playbook.md](implementation-playbook.md) with a `> Superseded by [lupa-rescue-playbook.md]: see Phase X` note next to any Act being replaced.
5. After landing each Phase, update the eval baseline (Phase 8.2) and append the result to a `## Eval Baselines` section in this document.
