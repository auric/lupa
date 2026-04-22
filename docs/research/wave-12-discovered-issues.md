# Wave 12 — Discovered During Implementation

A running backlog of issues, gaps, and opportunities found during the rescue implementation that are **not covered by any existing Quest** in the `lupa-rescue-playbook_v3.md`.

Items are promoted to full quests only when they block a wave, corrupt eval results, or are security vulnerabilities.

---

## Active Backlog

### BUG-001: Race Condition in `sleepWithCancellation`

**File:** `src/models/conversationRunner.ts:1069–1088`
**Severity:** High — affects eval harness and all async timeout/cancellation paths
**Status:** Found during code review. Not covered by any quest.
**Action:** Fix in current PR. See detailed explanation in `docs/research/bug-explanations/BUG-001-sleepWithCancellation-race.md`.

---

### OPS-001: Integration Test with Real GitHub PR

**Description:** The eval harness uses synthetic fixtures. We have no end-to-end test that runs against a real PR from a real repo.
**Why it matters:** Fixtures may not capture real-world noise (merge conflicts, large binary files, submodules, etc.)
**Status:** Backlog. Not blocking.

---

### PERF-001: Profile Token Usage Per Tool Call

**Description:** No telemetry on which tools consume the most tokens. We are flying blind on context efficiency.
**Why it matters:** Needed to validate that Quest 1.4 (file cache) and Quest 6.2 (summarization) actually save tokens.
**Status:** Backlog. Nice-to-have after Wave 6.

---

### SEC-001: Sanitize File Paths to Prevent Directory Traversal

**Description:** Tool schemas accept `file` parameters. No validation prevents `../../../etc/passwd` or paths outside the workspace.
**Why it matters:** Security boundary violation if Lupa is ever exposed to untrusted PRs.
**Status:** Backlog. Important but not blocking rescue.

---

### OBS-001: Structured Telemetry for Production Debugging

**Description:** Errors and warnings are logged via the `Log` service, but there is no structured event stream (e.g., JSON Lines) for post-hoc analysis.
**Why it matters:** When a user says "Lupa missed a bug," we have no data to replay what happened.
**Status:** Backlog. Operational hardening.

---

### RES-001: Model Fallback on Rate Limit / Timeout

**Description:** If the primary model (e.g., Copilot GPT-4.1) returns 429 or times out, Lupa fails the analysis. No fallback to a cheaper/alternative model.
**Why it matters:** Reliability. Quest 10.3 (two-tier model split) partially addresses this but doesn't cover failure fallback.
**Status:** Backlog. Related to Wave 10.

---

### MIG-001: Migration Guide — Legacy Severity to P0–P3

**Description:** Quest 11.0 introduces P0/P1/P2/P3 severity. Existing findings, configs, and user expectations use CRITICAL/HIGH/MEDIUM/LOW.
**Why it matters:** Breaking change for users who have custom severity filters or downstream integrations.
**Status:** Backlog. Must be done before Wave 11 ships to users.

---

### DOC-001: Update ARCHITECTURE.md After Wave 8

**Description:** The pipeline collapses from 8 steps to 3 in Quest 12.1. `ARCHITECTURE.md` will be out of date.
**Why it matters:** New team members read ARCHITECTURE.md first. Stale docs are worse than no docs.
**Status:** Backlog. Blocker for Wave 8 completion.

---

### ALIGN-001: Quest 6.2 Compactor Retention Policy

**Description:** The ADR references "recent tool results" as what the compactor preserves, but Quest 6.2 is vague on the exact retention policy (count-based, token-based, or heuristic).
**Why it matters:** If the ADR and Quest disagree, implementers won't know whether to preserve "latest 3" or "last 10K tokens" or something else.
**Status:** Backlog. Update Quest 6.2 when Wave 6 begins.
**Action:** Define exact retention policy in Quest 6.2 acceptance criteria.

---

### ALIGN-002: Quest 8.2 Per-PR-Size Band Reporting

**Description:** The ADR defines a 5% Monster-vs-Large resolution rate gap as the trigger for context rot mitigation. Quest 8.2 currently reports aggregate `resolutionRate` only.
**Why it matters:** The eval harness must produce per-band (Small / Large / Monster) resolution rates for the ADR trigger to be actionable.
**Status:** Backlog. Small quest-level addition to 8.2 before Wave 0 closes.
**Action:** Add per-band reporting to `metrics.ts` and `reporter.ts`.

---

### ALIGN-003: Quest 11.3 PreJudgeGate Grounding Check

**Description:** The ADR defines `PreJudgeGate` as a programmatic validation stage. Quest 11.3 mentions `PreJudgeGate` in the playbook overview but the Quest body focuses on `sources` schema enforcement. The grounding check (`lupa.findingGrounding.mode`) should be explicitly described in the Quest.
**Why it matters:** Implementers need to know exactly what PreJudgeGate validates and how the flag behaves.
**Status:** Backlog. Update Quest 11.3 when Wave 7 begins.

---

### ALIGN-004: Quest 12.1 PreJudgeGate Composition

**Description:** The ADR says PreJudgeGate is "schema, grounding, dedup, workflow." The playbook says it combines `evidenceAuditStep` (programmatic part) + `findingValidationStep` + `workflowEnforcementStep`. The Quest body should resolve this precisely.
**Why it matters:** Quest 12.1 is the pipeline collapse. Ambiguity about what PreJudgeGate contains will cause incorrect step deletion.
**Status:** Backlog. Update Quest 12.1 when Wave 8 begins.
**Action:** Define exact step mapping in Quest 12.1 body.

---

### ALIGN-005: Quest 12.1 Split Decision

**Description:** The ADR suggests splitting Quest 12.1 into 3 sub-Quests if scope exceeds one sprint. This is not in the playbook.
**Why it matters:** Wave 8 scope estimation should happen before implementation starts.
**Status:** Backlog. Evaluate during Wave 8 planning.

---

## Promoted Items (moved to full quests)

_None yet._

---

## How to Promote an Item

1. Open a discussion referencing this file.
2. State: **(a)** which wave it blocks, **(b)** why it can't wait, or **(c)** the security impact.
3. If approved, create a new Quest number (e.g., `12.1`) and add it to `lupa-rescue-playbook_v3.md`.
4. Move the item from this backlog to the "Promoted Items" section above with the new Quest number.

---

## Notes

- Do **not** let this backlog grow indefinitely. Review it at the end of every wave.
- If an item is "easy" (< 20 LOC) and you are already touching the relevant file, just fix it inline. Don't create a quest for trivia.
- The goal of the rescue is to fix the 18 root causes. This backlog is for everything else.
