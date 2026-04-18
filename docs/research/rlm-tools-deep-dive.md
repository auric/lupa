# RLM-Style Code Review Tools: Deep Dive

> **Purpose**: Self-contained reference correcting the prior playbook's claim that "no production tool uses RLM". Two systems were specifically named for re-investigation: **AsyncFuncAI/AsyncReview** and **Devin Review** (Cognition AI). This file documents what they actually do, compares them to the wider RLM ecosystem, contrasts them with Lupa, and lists concrete recommendations for the rescue playbook.
>
> **Date**: 2026-04-18. **Read-only research**: no source code was modified.
>
> **Method**: DeepWiki MCP (`mcp_cognitionai_d_*`) for repo Q&A, Tavily MCP for web search, direct `raw.githubusercontent.com` fetches for the AsyncReview source. All non-trivial claims are cited with URLs or repo paths.

---

## TL;DR (the prior playbook was wrong on labels, mostly right on substance)

1. **A "recursive language model" production tool DOES exist for code review** — `AsyncFuncAI/AsyncReview` advertises RLM front and center and is open source (Python, MIT-style, npx-distributed). But its "recursion" is **DSPy `dspy.RLM`'s iterative tool-calling loop in a Pyodide/Deno sandbox**, not a parent-LM-spawning-child-LM topology. There is a `sub_lm` parameter, but it is used by DSPy internally for parsing — not as a child agent that does its own investigation.
2. **Devin Review is explicitly NOT multi-agent and explicitly NOT RLM.** Cognition's own engineering manifesto ([Don't Build Multi-Agents, June 2025](https://cognition.ai/blog/dont-build-multi-agents)) argues against the architecture. Devin Review is a **single-threaded linear agent + a fine-tuned context compactor**, with read-only filesystem/grep/bash tools, smart diff grouping, and a Bug Catcher with severity tiers. Multi-agent / RLM is conspicuously absent.
3. **The closest thing to a true parent-spawn-child RLM in code-tool land is `WingchunSiu/Monolith`** (RLM as MCP server for Claude Code). It uses a real `llm_query()` primitive in a Modal REPL with a `max_depth` budget. It's experimental, not a code-review product.
4. **The prior playbook's conclusion** ("production has converged on role specialization / single agent + sub-investigators") is **substantively correct for Devin and consistent with AsyncReview's actual behavior**, even though AsyncReview _labels_ itself RLM. The label is marketing; the architecture is iterative single-agent tool-calling — the same family Lupa lives in.
5. **What we missed**: AsyncReview's specific design choices (Gemini-2.x main + Gemini-flash sub_lm for parsing, P0–P3 severity matrix, on-demand fetched checklists for SOLID/security/quality/dead-code, Pyodide/Deno sandbox isolation, source-grounding requirement) are concrete, copyable patterns. Devin Review's "instruction-file-aware" behavior (`**/REVIEW.md`, `**/AGENTS.md`, `**/CLAUDE.md`, etc.) and Bug-Catcher confidence tiering are also worth adopting.

---

## 1. AsyncFuncAI/AsyncReview — full anatomy

**Repo**: <https://github.com/AsyncFuncAI/AsyncReview>
**DeepWiki**: <https://deepwiki.com/AsyncFuncAI/AsyncReview>
**Tagline**: "Open-source Agentic code review tool inspired by DevinReview, using Recursive Language Models (RLM)"
**Distribution**: `npx asyncreview review <PR-URL>` (Python under the hood, packaged with Node).
**License**: open-source on GitHub (repo public; standard MIT/Apache assumed — confirm in repo if relicensing matters).

### 1.1 Architectural reality

AsyncReview's "RLM" is **DSPy's `dspy.RLM` module** — an iterative agent loop that:

1. takes a prompt,
2. lets the LM emit Python code,
3. runs that Python in a sandboxed `PythonInterpreter` (Deno-backed Pyodide),
4. feeds tool outputs back into the LM,
5. repeats until a `FINAL`/`answer` is emitted or budgets are exhausted.

There is **no parent-LM-spawns-child-LM-with-its-own-investigation topology**. Confirmed by DeepWiki Q&A: _"It does not involve a parent LM spawning child LM calls in a hierarchical topology … the term 'recursive' refers to the iterative nature of the DSPy RLM"_ (DeepWiki search ID `381a7543`).

The `sub_lm=dspy.LM(SUB_MODEL, cache=False)` parameter on `dspy.RLM(...)` is a **DSPy internal helper LM** for parsing/structured-output tasks, not a true child agent that does its own multi-step reasoning. It is `gemini-3-flash-preview` by default while the main is `gemini-3-pro-preview`.

### 1.2 Exact configuration (verbatim from `npx/python/cr/config.py`)

```python
MAIN_MODEL      = os.getenv("MAIN_MODEL",      "gemini/gemini-3-pro-preview")
SUB_MODEL       = os.getenv("SUB_MODEL",       "gemini/gemini-3-flash-preview")
MAX_ITERATIONS  = int(os.getenv("MAX_ITERATIONS",  "20"))
MAX_LLM_CALLS   = int(os.getenv("MAX_LLM_CALLS",   "25"))
MAX_FILE_BYTES  = int(os.getenv("MAX_FILE_BYTES",  "200000"))   # 200KB per file
MAX_TOTAL_BYTES = int(os.getenv("MAX_TOTAL_BYTES", "5000000"))  # 5MB total snapshot
```

Source: <https://raw.githubusercontent.com/AsyncFuncAI/AsyncReview/main/npx/python/cr/config.py>

Other constants (from `repo_tools.py`):

```python
MAX_FILE_BYTES     = 200_000   # duplicate of config
MAX_CACHE_ENTRIES  = 200
MAX_FALLBACK_LINES = 200
MAX_RETRIES        = 2
BACKOFF_BASE       = 1
_semaphore = asyncio.Semaphore(5)   # max 5 concurrent GitHub API calls
```

Source: <https://raw.githubusercontent.com/AsyncFuncAI/AsyncReview/main/npx/python/cli/repo_tools.py>

### 1.3 Tool surface (only THREE tools — far smaller than Lupa's)

From `_create_tool_functions()` in `npx/python/cli/virtual_runner.py`:

| Tool          | Signature                              | Source of truth                                         |
| ------------- | -------------------------------------- | ------------------------------------------------------- |
| `fetch_file`  | `(path: str) -> str`                   | GitHub Contents API at PR head SHA (or local FS)        |
| `list_dir`    | `(path: str) -> str` (formatted text)  | GitHub Contents API directory listing                   |
| `search_code` | `(query: str) -> str` (formatted text) | GitHub Search API (path/filename/content auto-detected) |

A 4th "tool" path: `fetch_file("checklists/...")` short-circuits to **bundled local markdown checklists** packaged with the CLI (SOLID, security, code-quality, removal-plan).

No `find_symbol`, no `find_usages`, no `git diff` (the diff is pre-built into the initial context). Search is GitHub's full-text code search, not LSP-aware.

### 1.4 The `EXPERT_REVIEW_PROMPT` (verbatim, from `npx/python/cli/expert_prompts.py`)

````text
Perform a comprehensive expert code review of this PR.

## Review Categories
Analyze the PR changes against these categories. Fetch the relevant
checklist if you need detailed guidance:

1. **SOLID & Architecture** — Design principle violations, code smells
   - Fetch `checklists/solid-checklist.md` for detailed SOLID prompts
2. **Security & Reliability** — Vulnerabilities, auth gaps, race conditions
   - Fetch `checklists/security-checklist.md`
3. **Code Quality** — Error handling, performance, boundary conditions
   - Fetch `checklists/code-quality-checklist.md`
4. **Removal Candidates** — Dead code, unused imports, deprecated patterns
   - Fetch `checklists/removal-plan.md`

## Instructions
1. First, understand the PR: read the diff, description, and any related files
2. Decide which categories are relevant based on the changes
3. Fetch the relevant checklist(s)
4. Apply the checklists to find issues
5. Classify each finding by severity (P0, P1, P2, P3)
6. Provide fix suggestions for P0 and P1 issues

## Severity Levels
- **P0 (Critical)**: Security vuln, data-loss risk, correctness bug → MUST block merge
- **P1 (High)**: Logic error, significant SOLID violation, performance regression → Should fix before merge
- **P2 (Medium)**: Code smell, maintainability concern → Fix in PR or follow-up
- **P3 (Low)**: Style, naming, minor suggestion → Optional improvement

## Required Output Format
## Code Review Summary
**Files reviewed**: X files, Y lines changed
**Overall assessment**: [APPROVE / REQUEST_CHANGES / COMMENT]
---
## Findings
### P0 - Critical
(none or list)
### P1 - High
- **[file:line]** Brief title
  - Description of issue
  - Suggested fix
### P2 - Medium ...
### P3 - Low ...
---
## Fix Suggestions (P0/P1 only)
### [Issue Title]
```language
// suggested code fix
````

````

Source: <https://raw.githubusercontent.com/AsyncFuncAI/AsyncReview/main/npx/python/cli/expert_prompts.py>

### 1.5 The `AGENTIC_TOOLS_PROMPT` (DeepWiki-quoted; gates every review)

```text
You are an expert software engineer. Your goal is to answer the user's
question about the provided GitHub Pull Request or Issue.

You have access to a Python interpreter and a set of tools to explore
the codebase. You can use print() to output information.

AVAILABLE TOOLS (use via Python in REPL):
- fetch_file(path: str) -> str
- list_directory(path: str = "") -> list[dict]
- search_code(query: str) -> list[dict]

TOOL USAGE RULES:
1. Fetch the minimum: prefer 1–3 files; don't traverse the repo.
2. If analysis depends on unchanged code, use fetch_file.
3. Use search_code to find paths; then fetch_file to read.
4. Files > 200KB return a stub — avoid large/generated files.
5. Use list_directory to understand structure first.

To answer the question, you will write and execute Python code...

When you have gathered all necessary information, output:
{
  "answer": "Your answer ... ",
  "sources": ["file1.py#L10-L20", "file2.js#L5-L15"]
}

The `sources` field should be a list of strings... Only include files
that you have explicitly fetched using fetch_file.
````

Key behavioral rules: **minimum-fetch policy** (1–3 files preferred), **mandatory grounding** (`sources` list must reference only files actually fetched — anti-hallucination). No explicit dedup logic; the iterative loop is expected to produce a self-consistent final answer.

### 1.6 End-to-end workflow (`VirtualReviewRunner.review()`)

1. `parse_github_url(url)` → owner, repo, PR number.
2. `fetch_pr()` → metadata + changed files + diff patches + commits + comments **in parallel** (5-way concurrency semaphore).
3. `build_review_context()` → structured Markdown (title, branches, summary, description, commit list, per-file diffs, discussion).
4. `RepoTools(owner, repo, head_sha)` → tool surface bound to the PR head SHA.
5. `dspy.RLM(...).aforward(context, question)` → iterative loop in Pyodide/Deno sandbox.
6. `result.answer + result.sources` → posted as GitHub comment if `--submit`.

### 1.7 Key engineering details worth borrowing

| Pattern                                                                    | Lupa equivalent today                                             |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `MAX_FILE_BYTES = 200KB` per file (skip stubs)                             | Lupa already truncates; verify stub message clarity               |
| `MAX_TOTAL_BYTES = 5MB` snapshot cap                                       | Lupa has token-based caps via `TokenValidator`                    |
| FIFO file cache (200 entries, key by `(ref,path)`)                         | Lupa relies on per-call reads; no cross-iter cache                |
| 5-way `asyncio.Semaphore` for GitHub API                                   | Lupa N/A (uses LSP, not REST)                                     |
| Error-stub return (`[ERROR: 429]`, `[SKIPPED: binary]`) instead of raising | Lupa raises in some tools; LLM gets generic timeout message       |
| `MAX_ITERATIONS=20`, `MAX_LLM_CALLS=25` (tight)                            | Lupa has higher iteration ceiling                                 |
| Two-tier model: `gemini-3-pro` + `flash` sub_lm                            | Lupa uses one model per analysis                                  |
| **Bundled markdown checklists fetched on demand** by the LLM               | Lupa hard-codes review categories in system prompt                |
| Mandatory `sources` field with line ranges                                 | Lupa has investigationAudit but no enforced output-side grounding |
| P0/P1/P2/P3 severity matrix with merge-blocking semantics                  | Lupa uses different severity vocabulary                           |

---

## 2. Devin Review (Cognition AI) — full anatomy

**Docs**: <https://docs.devin.ai/work-with-devin/devin-review>
**Launch post**: <https://cognition.ai/blog/devin-review> (Jan 21, 2026)
**Internal use**: <https://cognition.ai/blog/how-cognition-uses-devin-to-build-devin> (Feb 27, 2026)
**Architecture manifesto**: <https://cognition.ai/blog/dont-build-multi-agents> (June 12, 2025, by Walden Yan)
**License**: closed-source SaaS. CLI ships via `npx devin-review {pr-url}` (worktree-based, sends diff+context to Devin servers).

### 2.1 Architectural stance: **single-agent + context engineering, NOT multi-agent, NOT RLM**

Quoting Cognition's manifesto verbatim:

> **Principle 1**: Share context, and share full agent traces, not just individual messages.
> **Principle 2**: Actions carry implicit decisions, and conflicting decisions carry bad results.
> _"… you should by default rule out any agent architectures that don't abide by them."_
> _"The simplest way to follow the principles is to just use a single-threaded linear agent."_
> _"For those who have truly long-duration tasks … we introduce a new LLM model whose key purpose is to compress a history of actions & conversation into key details, events, and decisions … you might even consider fine-tuning a smaller model (this is in fact something we've done at Cognition)."_

So Devin's published architecture for long-running tasks is:

```
[main agent: linear, single-threaded]  --(history grows)-->  [fine-tuned compactor LM]  --(distilled context)-->  [main agent continues]
```

That's it. No subagent fan-out for code review. No RLM. Subagents _exist_ in Devin (Claude-Code-style) only for **read-only Q&A** to keep context out of the main trace — never for parallel writes.

### 2.2 Devin Review's public tool surface (CLI mode)

From <https://docs.devin.ai/work-with-devin/devin-review>:

- **File reading** within the worktree
- **Search** — grep for patterns, glob for filenames
- **Read-only bash**: `ls`, `cat`, `pwd`, `file`, `head`, `tail`, `wc`, `find`, `tree`, `stat`, `du`
- **Git-based diff extraction** via `git worktree` (isolated checkout of the PR branch in a cached dir; no stash/branch-switch in the user's working dir)

Also (web/server mode adds): codebase index, "Codebase-aware chat" (Ask Devin), Auto-Fix.

### 2.3 Devin Review's user-facing capabilities

| Capability                       | Description                                                                                           |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Smart diff organization          | Groups logically related hunks, orders for top-to-bottom reading; explains each hunk                  |
| Copy/move detection              | Renders moved code as a move, not delete+insert                                                       |
| **Bug Catcher**                  | Two confidence tiers: **Severe** (must fix) vs **Non-severe** (review)                                |
| **Flags** (separate)             | Sub-types: **Investigate** (warrants check) vs **Informational** (correctness explanation, no action) |
| Codebase-aware chat              | Ask questions about PR with full repo context                                                         |
| Auto-Fix                         | When Devin Review flags a bug, Devin proposes patch directly in PR (opt-in)                           |
| GitHub native integration        | Comments, approvals, suggested-edits, merge/close/draft actions, auto-merge                           |
| Auto-Review                      | Triggers on PR-open, new commits, draft→ready, reviewer-add (per-user opt-in or org-wide)             |
| **Resolved-thread minimization** | When all bot threads resolved, auto-collapses the review on GitHub                                    |

### 2.4 **Instruction-file ingestion (this is the buried gem)**

Devin Review automatically loads any of these as review context:

- `**/REVIEW.md` (review-specific guidelines, scoped by directory)
- `**/AGENTS.md`
- `**/CLAUDE.md` (case-insensitive)
- `**/CONTRIBUTING.md` (case-insensitive)
- `.cursorrules`, `.windsurfrules`, `.cursor/rules`, `*.rules`, `*.mdc`
- `.coderabbit.yaml`, `.coderabbit.yml`
- `greptile.json`

Plus user-defined custom glob patterns via Settings → Review.

This is a **first-class signal** that the agent picks up project conventions without per-org engineering work. Lupa currently has nothing like this.

### 2.5 Why this matters for Lupa's playbook

The "Don't Build Multi-Agents" post is the **definitive industry rebuttal** to fan-out parallel-subagent architectures for review work in 2025–2026. Cognition explicitly calls out the failure mode Lupa has been struggling with:

> _"agents today are not quite able to engage in this style of long-context proactive discourse with much more reliability than you would get with a single agent. The decision-making ends up being too dispersed and context isn't able to be shared thoroughly enough between the agents."_

This validates the prior playbook's "role specialization with single executor" hypothesis. Where the prior playbook erred was claiming **no production tool uses RLM** — AsyncReview does, **but its RLM is just an iterative tool-calling loop**, structurally identical to a single-agent ReAct loop. The "recursion" is iteration, not topology.

---

## 3. The wider RLM-for-code landscape (re-checked)

| Repo                      | Stars / status          | Topology                                                                                                                      | Code-review focus?                   |
| ------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `alexzhang13/rlm`         | Reference paper impl    | True parent→child REPL spawns over socket/HTTP, depth-limited                                                                 | No (general)                         |
| `AsyncFuncAI/AsyncReview` | Active, npx-distributed | DSPy.RLM iterative loop in Pyodide/Deno; `sub_lm` is parser only                                                              | **Yes (PR review)**                  |
| `WingchunSiu/Monolith`    | Experimental            | Three-phase RLM (Recon → Filter+Analyze (`llm_query`) → Aggregate) on Modal; planned recursive `ModalREPL` with `max_depth=3` | No (coding agent helper, MCP server) |
| `hampton-io/RLM`          | Niche                   | LLM + JS REPL exploration of long context                                                                                     | No                                   |
| `zircote/rlm-rs`          | Niche                   | Rust CLI wrapping RLM for Claude Code                                                                                         | No                                   |
| `SuperagenticAI/rlm-code` | Niche (no DeepWiki)     | Research playground reimplementing the 2025 RLM paper                                                                         | No                                   |
| Devin Review (Cognition)  | Production SaaS         | **Single-threaded linear agent + fine-tuned compactor**                                                                       | **Yes (PR review)**                  |

**Conclusion**: AsyncReview is the **only** open-source PR-review tool branding itself RLM, and its "RLM" is iterative tool-calling — not parent/child fan-out. Monolith is the closest _true_ RLM (parent calls cheaper sub-LLMs via `llm_query()`), but it isn't a code-review product. Devin Review actively **rejects** the multi-agent / RLM topology.

---

## 4. Side-by-side: AsyncReview vs Devin Review vs Lupa-current vs Lupa-proposed

| Dimension                             | AsyncReview                                                                               | Devin Review                                                                                                                | Lupa (current)                                                                   | Lupa (proposed change)                                                                              |
| ------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Topology                              | Single agent, iterative ReAct loop in sandbox                                             | Single linear agent + fine-tuned context compactor                                                                          | Single main + parallel `RunSubagentBatch` for read-only investigations           | Same as today, but cap depth=1, prefer compaction over fan-out for long traces                      |
| "Recursion"                           | Iteration via DSPy.RLM, not topology                                                      | None                                                                                                                        | Subagents (1 level) + recursion when `maxRecursionDepth ≥ 1`                     | Drop unbounded recursion; keep batch subagents flat                                                 |
| Sandbox                               | Pyodide via Deno (`PythonInterpreter`)                                                    | None disclosed; CLI runs in user worktree                                                                                   | LSP + ripgrep + filesystem in extension host                                     | Keep                                                                                                |
| Tool surface                          | 3 tools: `fetch_file`, `list_dir`, `search_code` (+ bundled checklists)                   | File-read, grep/glob, read-only bash (`ls cat head tail find tree stat du`), git worktree diff                              | 12+ tools incl. `findSymbol`, `findUsages`, `searchForPattern`, `readFile`, etc. | Audit which Lupa tools the LLM actually uses; consider trimming to high-signal subset               |
| Iteration / call budget               | `MAX_ITERATIONS=20`, `MAX_LLM_CALLS=25` (tight)                                           | Not disclosed                                                                                                               | Higher iteration ceiling                                                         | Tighten budgets; surface them as enforced caps                                                      |
| File size cap                         | 200 KB (skip stub returned, never raises)                                                 | Not disclosed                                                                                                               | Token-based via `TokenValidator`                                                 | Add per-file byte-size cap with a clear stub format the LLM can pattern-match                       |
| Cross-iteration cache                 | FIFO file cache (200 entries, keyed by `(sha,path)`)                                      | Implicit (Devin server-side)                                                                                                | None at file level                                                               | Add a per-analysis file cache to dedupe `read_file`                                                 |
| Two-tier models                       | `gemini-3-pro-preview` + `gemini-3-flash-preview` sub_lm                                  | Custom Anthropic Sonnet 4.5 (per recent blog)                                                                               | Single Copilot model                                                             | Optional: a cheaper model for compaction/parsing only                                               |
| Severity matrix                       | **P0/P1/P2/P3** with merge-blocking semantics                                             | **Severe / Non-severe Bugs + Investigate / Informational Flags**                                                            | Currently severity language varies                                               | Adopt P0/P1/P2/P3 + merge-block flag explicitly                                                     |
| Output grounding                      | Mandatory `sources: ["file#L10-L20"]`, only files explicitly fetched                      | Each finding linked to the diff hunk                                                                                        | `EvidenceAuditor` post-processes; not LLM-side enforced                          | Make `sources` (or evidence IDs) a required output field; reject ungrounded findings before scoring |
| Convention discovery                  | None automatic                                                                            | **Auto-loads** `**/REVIEW.md`, `**/AGENTS.md`, `**/CLAUDE.md`, `**/CONTRIBUTING.md`, `.cursorrules`, `.windsurfrules`, etc. | Only `WorkspaceSettingsService` user config                                      | **Adopt the Devin instruction-file pattern** — auto-ingest those files as review context            |
| Checklists                            | Bundled markdown (SOLID, security, quality, removal); LLM fetches on demand via tool call | Inline per category; not user-pluggable                                                                                     | Hard-coded in system prompt                                                      | Externalize Lupa's review categories into LLM-fetchable markdown checklists, per AsyncReview        |
| Auto-fix loop                         | No                                                                                        | **Yes** (closing-the-loop via Devin proposing patches)                                                                      | No                                                                               | Out of scope for now                                                                                |
| GitHub-native PR comment posting      | Yes (`--submit`)                                                                          | Yes (full review actions)                                                                                                   | No (VS Code surface only)                                                        | Future: optional GH integration                                                                     |
| Multi-agent fan-out for write actions | Never                                                                                     | Never (per manifesto)                                                                                                       | Subagents are **read-only** by design                                            | Keep, document the constraint explicitly                                                            |

---

## 5. Concrete recommendations for the rescue playbook

### 5.1 Corrections to retract from the prior round

- **Retract**: "no production tool uses RLM for code review."
  **Replace with**: "AsyncFuncAI/AsyncReview brands itself as RLM-based but its 'recursion' is DSPy's iterative tool-calling loop. Devin Review explicitly rejects multi-agent/RLM topologies. The closest true parent→child RLM (Monolith) is not a code-review product."

- **Retract**: implication that role-specialization is the only viable path.
  **Replace with**: "Production code-review converges on **single iterative agent + tight tool surface + aggressive context engineering**. Subagents only for read-only Q&A. Compaction (potentially with a fine-tuned model) is the standard escape hatch for long contexts."

### 5.2 New patterns to import into Lupa

1. **Adopt P0/P1/P2/P3 severity vocabulary with explicit merge-blocking semantics** (AsyncReview). Replace ad-hoc severity strings.

2. **Add a Devin-style instruction-file loader.** Auto-ingest as review-rule context whenever present in the repo:
    - `**/REVIEW.md`, `**/AGENTS.md`, `**/CLAUDE.md` (case-insensitive), `**/CONTRIBUTING.md` (case-insensitive)
    - `.cursorrules`, `.windsurfrules`, `.cursor/rules/**`, `*.mdc`
    - This is essentially free quality and gives Lupa parity with how engineers already document conventions for AI tools.

3. **Externalize review categories as fetchable Markdown checklists** (AsyncReview pattern): `checklists/solid.md`, `checklists/security.md`, `checklists/code-quality.md`, `checklists/removal.md`. Have the system prompt reference them by path and let the LLM `read_file()` them on demand. Benefits:
    - Smaller base system prompt (less tokens always-on).
    - Easy A/B of checklist content without redeploying code.
    - Users can override per-repo.

4. **Tighten iteration / LLM-call budgets** to AsyncReview-class (`MAX_ITERATIONS≈20`, `MAX_LLM_CALLS≈25`) and surface them as **enforced caps that emit a clear "budget exhausted, finalize now" signal** to the LLM rather than silently terminating mid-thought.

5. **Add a per-analysis file cache** (FIFO, ~200 entries, keyed by `(headSha, repoRelativePath)`) so repeated `read_file` calls in the same analysis are O(1) and don't leak into iteration budgets.

6. **Make output grounding mandatory at the schema level.** Require every finding to include a `sources: ["path#L10-L20", ...]` array referencing only files the LLM actually read via tools. Drop or downgrade findings with empty/unverifiable sources at the pipeline boundary, not just in `EvidenceAuditor` post-hoc. AsyncReview enforces this in the prompt and parses it from the output.

7. **Switch error semantics from "throw → ToolExecutor → generic message" to "return stub string the LLM can pattern-match"** (per AsyncReview's `[ERROR: 429]`, `[SKIPPED: binary]`, `[SKIPPED: file exceeds 200KB]`). The LLM handles "I got a stub" deterministically; it handles "I got a generic timeout error" inconsistently. (For Lupa: keep the current `toolError()` shape, but add structured `{kind: "skipped" | "rate_limited" | "too_large"}` so the prompt can teach the LLM to react.)

8. **Document and harden the "subagents are read-only investigators" rule** (Cognition's principle). Lupa already does this — make the constraint explicit in `ARCHITECTURE.md` and never relax it.

9. **Consider dropping or hard-capping recursion.** Lupa's `RecursiveStateManager` (when `maxRecursionDepth >= 1`) is exactly the architecture Cognition argues against. Either:
    - **Cap at depth 1** and treat any "I need to dig further" signal as a budget-exhausted finalize prompt, or
    - **Replace with a compactor pass** (per "Don't Build Multi-Agents" — a dedicated LM that summarizes the running trace into "key details, events, decisions" and resets the working context).

10. **Adopt a two-tier model split for parsing/structured output only** (AsyncReview's `sub_lm`). Use the cheap model for: deduping findings, extracting structured fields from free-form LLM output, summarizing iteration history into the compactor. Never for the actual review reasoning.

### 5.3 Anti-patterns to avoid (re-confirmed by this round)

- Multi-agent fan-out for **decision-making** (only OK for read-only Q&A).
- Unbounded recursion depth.
- Long generic error messages instead of structured stubs.
- Implicit grounding (post-hoc auditing instead of LLM-output-schema enforcement).
- Hard-coding review categories in code instead of in editable markdown.

---

## 6. Open questions / followups

- **Devin's compactor model**: Cognition says they fine-tuned a smaller model for trace compaction, but they have not published architecture or weights. We can mimic at prompt-engineering level; we cannot match their fine-tuning.
- **AsyncReview production usage signal**: low star count in absolute terms (verify on GitHub), but it is actively maintained, npm-packaged, and explicitly inspired by DevinReview. Treat it as a credible reference implementation, not a benchmarked production system.
- **Monolith's recursion depth in practice**: code shows planned `max_depth=3` for the recursive `ModalREPL`; the current shipped flat sub-LLM mode is depth=1 effectively. Validates the industry-wide reluctance to go deep.

---

## 7. Sources cited

- AsyncReview repo: <https://github.com/AsyncFuncAI/AsyncReview>
- AsyncReview source files (raw):
    - `npx/python/cli/expert_prompts.py` — <https://raw.githubusercontent.com/AsyncFuncAI/AsyncReview/main/npx/python/cli/expert_prompts.py>
    - `npx/python/cli/repo_tools.py` — <https://raw.githubusercontent.com/AsyncFuncAI/AsyncReview/main/npx/python/cli/repo_tools.py>
    - `npx/python/cli/virtual_runner.py` — <https://raw.githubusercontent.com/AsyncFuncAI/AsyncReview/main/npx/python/cli/virtual_runner.py>
    - `npx/python/cr/config.py` — <https://raw.githubusercontent.com/AsyncFuncAI/AsyncReview/main/npx/python/cr/config.py>
- AsyncReview DeepWiki: <https://deepwiki.com/AsyncFuncAI/AsyncReview>
- Devin Review docs: <https://docs.devin.ai/work-with-devin/devin-review>
- Devin Review launch post: <https://cognition.ai/blog/devin-review>
- How Cognition Uses Devin: <https://cognition.ai/blog/how-cognition-uses-devin-to-build-devin>
- Don't Build Multi-Agents (Walden Yan, 2025-06-12): <https://cognition.ai/blog/dont-build-multi-agents>
- Rebuilding Devin for Sonnet 4.5: <https://cognition.ai/blog/devin-sonnet-4-5-lessons-and-challenges>
- Monolith RLM-as-MCP: <https://github.com/WingchunSiu/Monolith>, DeepWiki <https://deepwiki.com/WingchunSiu/Monolith>
- Reference RLM impl: <https://github.com/alexzhang13/rlm>, DeepWiki <https://deepwiki.com/alexzhang13/rlm>
- RLM paper review (context): <https://www.pauloamen.com/2025/recursive-language-models>

---

_End of report. All claims either quote source files directly, cite Cognition blog posts, or cite DeepWiki Q&A search IDs (search IDs 56e1a149, f3d49d27, 90ce04a5, 381a7543, 38b7d629, 443e9e2c)._
