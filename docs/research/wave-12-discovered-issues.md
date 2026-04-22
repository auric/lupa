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
