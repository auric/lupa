# Quality Architecture Design: Evidence-Grounded Code Review

**Date:** March 2026
**Status:** Design — not yet implemented
**Prerequisite reading:** [review-quality-improvement.md](review-quality-improvement.md) (FP taxonomy, current architecture, industry research)
**Context:** Lupa v0.2.0 with RLM architecture (recursive agent tree, per-analysis isolation)

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Strategic Position: Why Lupa Can Win](#2-strategic-position-why-lupa-can-win)
3. [Target Architecture](#3-target-architecture)
4. [Pillar 1: Evidence Infrastructure](#4-pillar-1-evidence-infrastructure)
5. [Pillar 2: LSP-Grounded Verification](#5-pillar-2-lsp-grounded-verification)
6. [Pillar 3: Architectural Quality Enforcement](#6-pillar-3-architectural-quality-enforcement)
7. [Approach Evaluation: What Lives and What Dies](#7-approach-evaluation-what-lives-and-what-dies)
8. [Implementation Phases](#8-implementation-phases)
9. [Key Design Decisions](#9-key-design-decisions)
10. [Acceptance Criteria](#10-acceptance-criteria)
11. [Risks and Mitigations](#11-risks-and-mitigations)
12. [What Was Abandoned and Why](#12-what-was-abandoned-and-why)

---

## 1. Problem Statement

### The Quality Gap

After 4 rounds of empirical triage (58 findings), Lupa's review pipeline has two distinct quality problems:

1. **False positive rate: 67–81%.** Most findings are wrong — wrong factual premises, design intent misunderstandings, theoretical-only concerns. The current 20+ prompt gates and 14 programmatic validations reduce FPs but can't eliminate them because all quality control is LLM self-judgment.

2. **True positive recall gap.** Competitors (GitHub Copilot, CodeRabbit) find real bugs that Lupa misses — particularly context-conditional correctness issues (code correct in one mode, wrong in another), data boundary bugs, and test setup errors. Current investigation patterns never explore alternate execution contexts.

### Root Cause

Both problems share a root cause: **the system has no source of truth external to the LLM.** Every fact-check, every verification, every quality gate is the model evaluating its own output. When the model is wrong, nothing catches it. When the model doesn't look somewhere, nothing prompts it to.

### What "Best" Means

The target is < 20% FP rate on complex codebases with high recall — finding bugs that matter, not just reporting noise. This requires moving from prompt-only quality control to a hybrid architecture where programmatic verification, compiler-grade ground truth, and structured evidence flow work alongside LLM reasoning.

---

## 2. Strategic Position: Why Lupa Can Win

### What Lupa Has That Competitors Don't

| Capability                 | Lupa              | CodeRabbit    | Qodo           | cubic          | BitsAI-CR   |
| -------------------------- | ----------------- | ------------- | -------------- | -------------- | ----------- |
| Live Language Server (LSP) | ✅ Hot in VS Code | ❌ Cloud-only | ❌ Cloud-only  | ❌ Cloud-only  | ❌ Internal |
| Type checking on findings  | Possible          | Impossible    | Impossible     | Impossible     | Possible\*  |
| Reference counting         | Possible          | grep only     | grep only      | grep only      | Possible\*  |
| Symbol resolution          | Full LSP          | Pattern match | Pattern match  | Pattern match  | AST-based   |
| Recursive agent tree       | ✅ RLM            | ❌ Flat       | ✅ Multi-agent | ✅ Multi-agent | ❌ Pipeline |
| Per-analysis isolation     | ✅                | ?             | ?              | ?              | ❌          |

\*BitsAI-CR is internal to ByteDance; they can integrate internal tooling. External competitors cannot.

### The Moat

**VS Code's Language Server Protocol gives Lupa compiler-grade ground truth for LLM claims.** The LLM says "function X is never called" — `executeReferenceProvider` refutes that in milliseconds. The LLM says "parameter Y can be null" — `executeHoverProvider` extracts the actual type. No prompt engineering, no re-investigation, no LLM judgment. Just facts.

This is architecturally impossible for API-only competitors. They can't run `executeReferenceProvider` because they don't have a running language server with the project loaded. They approximate with grep/regex, which misses type information, generics, interface implementations, and re-exports.

**LSP validation alone could address ~75% of FP root cause categories:**

- Design Intent Blindness (40% of FPs): "Is this function unused?" → executeReferenceProvider → 30 references → DROP
- Wrong Factual Premise (20%): "Type doesn't match" → executeHoverProvider → type is correct → DROP
- Theoretical-Only (15%): "Function could receive null" → hover shows non-nullable parameter → DROP

### What Competitors Do Better (Today)

- **CodeRabbit**: Evidence verification scripts (grep/ast-grep checks before posting). Lupa has the tools but doesn't enforce evidence chains.
- **BitsAI-CR**: Taxonomy-guided generation (219 categorized rules → 3.4x precision). Lupa has some taxonomy but not as structured.
- **cubic/Qodo**: Multi-pass verification agents. Lupa has prompt gates but no architectural enforcement of verification.

The quality architecture addresses all three gaps.

---

## 3. Target Architecture

### Pipeline Overview

```
┌─────────────────────────────────────────────────────────────┐
│  PHASE 0: Intelligence Preparation                          │
│                                                             │
│  Parse Diff → Identify Changed Symbols                      │
│  LSP Enrichment: types, references, callers, test coverage  │
│  Output: Code Intelligence Brief (structured metadata)      │
│                                                             │
│  Components: DiffEnricher, LSP queries via SymbolExtractor  │
├─────────────────────────────────────────────────────────────┤
│  PHASE 1: Investigation (RLM Tree)                          │
│                                                             │
│  Root plans → spawns concern-group subagents                │
│  Subagents investigate with tools + Intelligence Brief      │
│  Evidence recorded to shared Evidence Ledger                │
│  Investigation depth tracked per-file per-agent             │
│  Cross-agent evidence queries enabled                       │
│                                                             │
│  Components: EvidenceLedger, InvestigationAudit,            │
│              record_evidence tool, query_evidence tool       │
├─────────────────────────────────────────────────────────────┤
│  PHASE 2: Aggregation + Verification                        │
│                                                             │
│  Root receives structured subagent results                  │
│  (provenance trails, depth scores, evidence refs)           │
│  Root synthesizes findings                                  │
│  For CRITICAL/HIGH: CoVe verification with LSP queries      │
│  Structured finding output with required evidence fields    │
│  Programmatic validation (file exists, line valid, etc.)    │
│                                                             │
│  Components: LSPValidationService, validate_claim tool,     │
│              structured output schema, programmatic gates   │
├─────────────────────────────────────────────────────────────┤
│  PHASE 3: Final Quality Gate (CRITICAL only)                │
│                                                             │
│  Lightweight adversarial mini-agent per CRITICAL finding    │
│  Independent investigation with fresh context               │
│  Returns CONFIRMED / REFUTED / UNCERTAIN with evidence      │
│                                                             │
│  Components: Reuse SubagentExecutor with adversarial prompt │
└─────────────────────────────────────────────────────────────┘
```

### Data Flow Through Phases

```
Diff ──→ Phase 0 ──→ Intelligence Brief ──→ Phase 1 ──→ Evidence Ledger
                                                              │
                                                              ▼
                                              Structured Subagent Results
                                              (provenance + depth + evidence)
                                                              │
                                                              ▼
                                              Phase 2: Root Aggregation
                                              + CoVe/LSP Verification
                                                              │
                                                              ▼
                                              Structured Findings (JSON)
                                              + Programmatic Validation
                                                              │
                                                              ▼
                                              Phase 3: Adversarial Check
                                              (CRITICAL only)
                                                              │
                                                              ▼
                                              Final Review Output
```

---

## 4. Pillar 1: Evidence Infrastructure

Makes the invisible visible. Converts opaque agent prose into queryable, auditable, structured data.

### 4.1 Investigation Audit (Provenance + Depth Scoring)

**What**: Enrich each subagent's result with structured metadata derived from its `ToolCallRecord[]`. The root sees not just the prose response but what code was actually examined and how deeply.

**Why**: Currently `RunSubagentTool.formatResult()` returns only `toolCallsMade` count + prose. The full `ToolCallRecord[]` (which files were read, which symbols resolved, which usages checked) is passed as metadata but never surfaced to the root LLM. This is information destruction at an interface boundary.

**Design**:

```typescript
interface InvestigationAudit {
    filesRead: { path: string; lineRange: [number, number] }[];
    symbolsResolved: { name: string; file: string; kind: string }[];
    usagesChecked: { symbol: string; referenceCount: number }[];
    patternsSearched: { query: string; matchCount: number }[];
    diffsExamined: string[]; // file paths from get_file_diff
    depthScores: Map<string, InvestigationDepth>; // per-file depth 0-10
}

interface InvestigationDepth {
    score: number; // 0-10
    breakdown: string; // e.g., "diff(2) + read(2) + symbols(2) = 6"
}
```

**Depth Scoring Scale**:
| Score | Tools Used | Investigation Quality |
|-------|------------|----------------------|
| 0 | None | Not examined |
| 2 | `get_file_diff` only | Diff skimmed |
| 4 | + `read_file` | Code read |
| 6 | + `find_symbol` (with body) | Symbols understood |
| 8 | + `find_usages` on changed symbols | Call-site context |
| 10 | + `search_for_pattern` or cross-file validation | Full investigation |

**Implementation**:

- New utility function `buildInvestigationAudit(toolCalls: ToolCallRecord[]): InvestigationAudit`
- Modify `RunSubagentTool.formatResult()` to append a structured `## Investigation Audit` section
- Root agent uses audit to: (a) assess subagent thoroughness, (b) identify under-investigated files, (c) decide whether to re-investigate

**Files to create/modify**:

- `src/utils/investigationAudit.ts` — audit builder + depth scorer
- `src/tools/runSubagentTool.ts` — enrich `formatResult()`
- `src/types/investigationTypes.ts` — interfaces

**Estimated effort**: 2-3 days
**Risk**: Zero — purely additive, read-only transformation of existing data

### 4.2 Evidence Ledger (Shared Epistemic State)

**What**: A per-analysis, queryable evidence store that any agent in the recursive tree can write to and read from. Structured entries with provenance, typed by evidence category.

**Why**: In a recursive agent tree, evidence flows bottom-up through prose summaries. At each level, fidelity degrades — the parent sees a summary of a summary. The ledger bypasses the hierarchy, making every agent's raw discoveries available to every other agent (and to the root).

**When is it most valuable?**:

- Deep RLM trees (depth ≥ 2): sub-subagent discovers a fact, root needs it 2 levels up
- Overlapping concerns: Agent reviewing `auth.ts` discovers type info that Agent reviewing `middleware.ts` needs
- Root aggregation: instead of parsing prose for facts, root queries structured evidence

**When is it NOT needed?**:

- Flat reviews (single subagent or no recursion)
- Fully disjoint concern groups (no overlap between subagent investigations)

**Design**:

```typescript
interface EvidenceEntry {
    id: string;
    agentId: string; // provenance
    timestamp: number;
    category: EvidenceCategory;
    file: string;
    symbol: string | undefined;
    line: number | undefined;
    claim: string; // "Function X has 30 callers"
    rawSnippet: string | undefined; // relevant code snippet
    confidence: 'high' | 'medium' | 'low';
    source: 'tool_result' | 'lsp_query' | 'observation';
}

type EvidenceCategory =
    | 'behavior_observation' // "this function returns early on null"
    | 'type_constraint' // "parameter X is non-nullable"
    | 'caller_pattern' // "function Y is called from 30 sites"
    | 'error_handling' // "no try-catch around this call"
    | 'api_contract' // "interface Z requires field W"
    | 'design_intent' // "comment says: intentional for perf"
    | 'test_coverage'; // "3 test files reference this function"

interface EvidenceQuery {
    file?: string;
    symbol?: string;
    category?: EvidenceCategory;
    agentId?: string;
    text?: string; // free-text search in claim/rawSnippet
}
```

**Tools**:

- `record_evidence` — writes a structured entry to the ledger. Available to all agents.
- `query_evidence` — searches the ledger by file, symbol, category, or free text. Returns matching entries with provenance.

**Implementation**:

- `EvidenceLedger` class: `Map<string, EvidenceEntry>` with query methods. Per-analysis lifecycle (created in `ToolCallingAnalysisProvider.analyze()`)
- Added to `ExecutionContext` as `evidenceLedger?: EvidenceLedger`
- Both tools extend `BaseTool` with Zod schemas
- Evidence entries are lightweight (claim string + metadata, not full file contents)

**Files to create/modify**:

- `src/sessions/evidenceLedger.ts` — EvidenceLedger class
- `src/tools/recordEvidenceTool.ts` — record_evidence tool
- `src/tools/queryEvidenceTool.ts` — query_evidence tool
- `src/types/evidenceTypes.ts` — interfaces and categories
- `src/services/serviceManager.ts` — register tools
- `src/services/toolCallingAnalysisProvider.ts` — create ledger per-analysis

**Token budget concern**: Each `record_evidence` call costs the agent ~50 tokens (writing) and each `query_evidence` result costs the reader ~100 tokens per entry. With 128K context, this is negligible. But: agents should NOT record low-value observations. Prompt guidance: "Record evidence only when you discover a fact that would be valuable to another agent investigating a related file."

**Estimated effort**: 3-4 days
**Risk**: Low. Evidence quality depends on agent cooperation (writing useful entries). Mitigated by prompt guidance and by making evidence queries optional (agents can ignore the ledger entirely).

---

## 5. Pillar 2: LSP-Grounded Verification

The competitive moat. Uses VS Code's Language Server Protocol to provide compiler-grade ground truth for LLM claims. No amount of prompt engineering or multi-agent debate achieves the certainty of type-checker verification.

### 5.1 LSP Validation Service

**What**: A service that wraps VS Code's LSP APIs into claim-verification interfaces. Takes a structured claim, runs the corresponding LSP query, returns a verification result.

**Why**: The #1 source of FPs is wrong factual claims — "function is unused" (30 references), "type doesn't match" (it does), "no error handling" (catch block exists 3 lines below). LSP can mechanically verify or refute these claims.

**Claim Types and LSP Mappings**:

| Claim Type                         | LSP API                              | What It Checks                                 |
| ---------------------------------- | ------------------------------------ | ---------------------------------------------- |
| "symbol X is unused/never called"  | `executeReferenceProvider`           | Reference count > 0 → REFUTED                  |
| "parameter/variable Y can be null" | `executeHoverProvider`               | Extract type, check for `\| null \| undefined` |
| "function X doesn't exist"         | `executeDefinitionProvider`          | Resolves → REFUTED                             |
| "type T has N fields"              | `executeHoverProvider` on type       | Extract field list                             |
| "symbol X is not exported"         | `executeHoverProvider` / symbol info | Check export modifier                          |
| "no callers of function X"         | `executeReferenceProvider`           | Count references                               |
| "class X doesn't implement Y"      | `executeHoverProvider`               | Extract implements clause                      |

**Design**:

```typescript
interface ClaimValidationRequest {
    claimType: ClaimType;
    file: string;
    line: number;
    symbol: string;
    expectedValue?: string; // e.g., the type the LLM claims
}

interface ClaimValidationResult {
    verified: boolean;
    confidence: 'definitive' | 'probable' | 'inconclusive';
    evidence: string; // "Found 30 references to X" / "Type is `string | undefined`"
    groundTruth: string; // the raw LSP result
}

type ClaimType =
    | 'symbol_unused' // check reference count
    | 'type_mismatch' // check actual type via hover
    | 'symbol_missing' // check definition exists
    | 'not_exported' // check export status
    | 'no_callers' // check reference count
    | 'no_implementation'; // check implements/extends
```

**Implementation**:

- `LSPValidationService` wraps existing `SymbolExtractor` infrastructure (which already uses LSP APIs)
- Each `ClaimType` maps to a specific LSP query chain
- All queries have per-operation timeouts (using `withCancellableTimeout`)
- Results are deterministic — no LLM involved in validation

**Key constraint**: LSP availability depends on language server being active. TypeScript (via tsserver) is excellent. Other languages depend on installed extensions. The service should report `inconclusive` when LSP doesn't respond, not fail.

**Files to create/modify**:

- `src/services/lspValidationService.ts` — core validation logic
- `src/types/claimTypes.ts` — claim types and result interfaces

**Estimated effort**: 4-5 days
**Risk**: Medium. LSP query reliability varies by language. TypeScript is well-supported; others may have gaps. Mitigate with timeouts and graceful `inconclusive` fallback.

### 5.2 Semantic Diff Enrichment (Code Intelligence Brief)

**What**: Before any LLM sees the diff, programmatically enrich each changed symbol with LSP-derived metadata. The LLM starts the review already knowing reference counts, type signatures, export status, and test file references.

**Why**: Without enrichment, agents spend tool calls discovering basic facts about changed code — "how many callers does this function have?" "is this exported?" "are there tests?" Pre-computation eliminates this discovery phase and ensures every agent has the same baseline context.

**What gets enriched (per changed symbol)**:

| Metadata                     | LSP Source                                | Why It Matters                                  |
| ---------------------------- | ----------------------------------------- | ----------------------------------------------- |
| Full type signature          | `executeHoverProvider`                    | Type changes in exported functions are breaking |
| Reference count              | `executeReferenceProvider`                | High-ref functions need more scrutiny           |
| Exported?                    | Symbol info / hover                       | Public API changes are higher severity          |
| Test file references         | Reference provider filtered to `*.test.*` | "No tests" vs. "3 test files"                   |
| Callers outside current file | Reference provider filtered               | Cross-file impact assessment                    |

**Design**:

```typescript
interface CodeIntelligenceBrief {
    enrichedSymbols: EnrichedSymbol[];
    generatedAt: number;
    timeoutCount: number; // how many symbols timed out during enrichment
}

interface EnrichedSymbol {
    name: string;
    file: string;
    line: number;
    kind: string; // function, class, interface, variable
    typeSignature: string | undefined;
    totalReferences: number;
    externalCallers: number; // references outside the defining file
    testFileReferences: number;
    isExported: boolean;
    /** Time elapsed since last git modification (rough indicator of stability) */
    lastModifiedDaysAgo: number | undefined;
}
```

**Implementation**:

- `DiffEnricher` service: takes `DiffHunk[]`, extracts changed symbols, runs LSP queries in parallel with aggressive timeouts
- Brief injected into system prompt as structured data (not per-subagent — one brief for the whole review)
- If enrichment takes too long (>15s), return partial brief with `timeoutCount`
- Brief size capped to prevent context bloat (top 50 symbols by reference count)

**Files to create/modify**:

- `src/services/diffEnricher.ts` — enrichment orchestration
- `src/types/enrichedDiffTypes.ts` — interfaces
- `src/prompts/` — system prompt generator modification to include brief

**Performance concern**: LSP queries per symbol take ~50-200ms. For a 30-file diff with 100 changed symbols, sequential queries would take 10-20s. Mitigation: parallel queries with concurrency limit (5-10 concurrent), aggressive 2s per-symbol timeout, graceful degradation.

**Estimated effort**: 3-4 days
**Risk**: Medium. Performance is the main concern. Must not delay review start. If enrichment is slow, skip it and let agents discover context through tool calls (existing behavior).

### 5.3 validate_claim Tool

**What**: A tool that the root agent (or any agent) can call to verify a specific claim against LSP ground truth.

**Why**: The Code Intelligence Brief provides proactive enrichment, but agents will also make ad-hoc claims during investigation. `validate_claim` lets them get immediate ground truth on any factual claim about the code.

**Usage pattern**: Root agent receives a subagent finding: "Function `processItems` is called only once and could be inlined." Root calls `validate_claim({ claimType: 'no_callers', file: 'utils.ts', line: 42, symbol: 'processItems' })` → Response: `{ verified: false, evidence: "Found 12 references across 5 files" }` → Root drops the finding.

**Implementation**: Thin wrapper around `LSPValidationService`. Extends `BaseTool` with Zod schema.

**Files to create/modify**:

- `src/tools/validateClaimTool.ts` — tool implementation
- `src/services/serviceManager.ts` — register tool

**Scope decision**: Available to root agent and subagents (not ROOT_ONLY). Any agent can verify its own claims before reporting them. This is more efficient than relying on the root to verify everything.

**Estimated effort**: 1-2 days (dependent on LSP Validation Service)
**Risk**: Low. Thin wrapper around already-built service.

---

## 6. Pillar 3: Architectural Quality Enforcement

Converts prompt-level quality suggestions into structural requirements the system enforces.

### 6.1 Structured Output Schema

**What**: Require findings in JSON format with mandatory evidence fields. Programmatically validate before accepting.

**Design** (extends the schema from review-quality-improvement.md Phase 2):

```typescript
interface StructuredFinding {
    id: string;
    severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
    category: string;
    title: string;
    file_path: string;
    line_range: [number, number];
    description: string;
    evidence: {
        tool_calls: string[]; // tool names used to support this finding
        key_observation: string; // the specific code/behavior observed
    };
    disproof: {
        attempted: boolean;
        method: string; // what was checked
        result: string; // what was found
    };
    verifiable_claims: VerifiableClaim[]; // NEW: claims suitable for LSP validation
}

interface VerifiableClaim {
    claim_type: ClaimType;
    file: string;
    line: number;
    symbol: string;
    assertion: string; // "processItems has no callers"
}
```

**Programmatic validation after `submit_review`**:

1. `file_path` exists in repository → reject if not
2. `line_range` is within file bounds → reject if not
3. `evidence.tool_calls` are not empty for severity > LOW → reject if empty
4. `disproof.attempted` is true for CRITICAL/HIGH → reject if false
5. `verifiable_claims` are validated against LSP → findings with refuted claims flagged

**Key insight**: The `verifiable_claims` field is the bridge between structured output and LSP validation. The LLM specifies what factual claims underpin its finding, and the system mechanically verifies them. This is the hybrid approach — LLM identifies what's verifiable, system runs the checks.

### 6.2 CoVe Verification Phase (with LSP)

**What**: After root aggregation, before final output, a structured verification phase that combines Meta's Chain-of-Verification with LSP ground truth.

**Flow**:

1. Root synthesizes findings from subagents
2. For each CRITICAL/HIGH finding, root generates verification questions:
    - "Does the cited file/line contain the described code?" → `read_file`
    - "Is the claimed type correct?" → `validate_claim`
    - "Are there callers/references?" → `validate_claim`
    - "Is there documentation explaining this as intentional?" → `search_for_pattern`
3. Root answers questions with tool calls (independent of original investigation context)
4. Root revises findings:
    - LSP-refuted → DROP
    - Verification confirms → mark VERIFIED
    - Inconclusive → downgrade one severity level

**Budget**: Allocate ~20% of root iterations to verification (after aggregation, before submit_review).

**Why this is better than standalone CoVe**: Standard CoVe uses the LLM to both generate and answer verification questions — the same model with the same blind spots. LSP-enhanced CoVe uses compiler ground truth for factual claims. The LLM handles only the questions that are inherently subjective ("is this design intentional?").

### 6.3 Adversarial Verification (CRITICAL Only)

**What**: For CRITICAL-severity findings that survive CoVe, spawn a lightweight adversarial subagent to independently investigate and attempt to refute.

**Why**: CoVe helps, but the root agent has already read the finding's reasoning and may anchor on it (confirmation bias). A separate agent with fresh context and an explicit "disprove this" mandate avoids anchoring.

**Scope**: CRITICAL findings only (typically 0-3 per review). This keeps the cost low — at most 3 lightweight subagent spawns.

**Design**:

- Adversary receives: finding title, file, line range, claimed behavior. NOT the original reasoning.
- Adversary has: full tool access including `validate_claim`
- Adversary's task: "Find evidence that this finding is WRONG. Check: Does the code actually handle this? Is this intentional? Do tests cover this? Are there comments explaining this?"
- Iteration budget: 5-10 (lightweight)
- Returns: `CONFIRMED` (couldn't disprove), `REFUTED` (found counterevidence), `UNCERTAIN` (insufficient evidence either way)

**Implementation**: Reuse existing `SubagentExecutor` with an adversarial prompt. No new infrastructure — just a new prompt generator and orchestration in the root's post-aggregation phase.

**Files to create/modify**:

- `src/prompts/adversarialPromptGenerator.ts` — adversarial system prompt
- `src/services/toolCallingAnalysisProvider.ts` — orchestration in root's end phase

**Estimated effort**: 2-3 days
**Risk**: Low. Reuses existing infrastructure entirely.

---

## 7. Approach Evaluation: What Lives and What Dies

### Original 7 Brainstormed Approaches

| #   | Approach                    | Verdict                                      | Reasoning                                                                                                                                                                              |
| --- | --------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Provenance-Enriched Results | **KEEP → merged into Investigation Audit**   | Data already exists in `ToolCallRecord[]`. Just needs transformation.                                                                                                                  |
| 2   | Investigation Depth Scoring | **KEEP → merged into Investigation Audit**   | Mechanical scoring from same data. Natural extension of #1.                                                                                                                            |
| 3   | Evidence Ledger             | **KEEP → redesigned**                        | Original design preserved, but scoped for RLM trees. Primary value: root aggregation + deep recursion.                                                                                 |
| 4   | LSP-Grounded Validation     | **KEEP → elevated to core pillar**           | THE differentiator. Addresses 75% of FP categories. Architecturally impossible for cloud competitors.                                                                                  |
| 5   | Adversarial Verification    | **KEEP → scoped to CRITICAL only**           | Full adversarial agent per finding is expensive. CRITICAL-only (0-3 per review) keeps cost manageable. HIGH/MEDIUM handled by CoVe+LSP instead.                                        |
| 6   | Semantic Diff Enrichment    | **KEEP → renamed "Code Intelligence Brief"** | Pre-computation reduces tool call waste. Most valuable for root's severity assessment.                                                                                                 |
| 7   | MapReduce Aggregation       | **ABANDON**                                  | RLM tree IS hierarchical aggregation. Adding reducer agents adds latency and LLM cost without adding information. The problem is evidence quality at each level, not fan-in structure. |

### What's Missing from the Original 7 (Added)

**Structured Output + Programmatic Validation** — already in the quality improvement roadmap (Phase 2) but not in the brainstorming. Included in Pillar 3 as a required foundation for LSP validation integration.

**CoVe Verification Phase** — already in the roadmap (Phase 3) but enhanced with LSP integration. This is the bridge between prompt-level verification (existing) and programmatic ground truth (new).

---

## 8. Implementation Phases

Each phase delivers standalone value. Later phases build on earlier ones but aren't blocked by them.

### Phase 1: Evidence Infrastructure (Foundation)

**Goal**: Make investigation quality visible and queryable.

| Component               | Files                                                                                                                                                                                                                              | Estimated Effort | Dependencies |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------ |
| Investigation Audit     | `src/utils/investigationAudit.ts`, `src/types/investigationTypes.ts`, modify `src/tools/runSubagentTool.ts`                                                                                                                        | 2-3 days         | None         |
| Evidence Ledger + Tools | `src/sessions/evidenceLedger.ts`, `src/types/evidenceTypes.ts`, `src/tools/recordEvidenceTool.ts`, `src/tools/queryEvidenceTool.ts`, modify `src/services/serviceManager.ts`, modify `src/services/toolCallingAnalysisProvider.ts` | 3-4 days         | None         |

**Acceptance criteria**:

- Root agent sees structured audit in every subagent result
- Depth scores computed correctly for all tool combinations
- Evidence ledger queryable by file, symbol, category
- Cross-agent evidence queries return correct results in multi-subagent scenarios

### Phase 2: LSP-Grounded Verification (The Moat)

**Goal**: Provide compiler-grade ground truth for LLM claims.

| Component               | Files                                                                                      | Estimated Effort | Dependencies                                        |
| ----------------------- | ------------------------------------------------------------------------------------------ | ---------------- | --------------------------------------------------- |
| LSP Validation Service  | `src/services/lspValidationService.ts`, `src/types/claimTypes.ts`                          | 4-5 days         | None (uses existing SymbolExtractor infrastructure) |
| validate_claim Tool     | `src/tools/validateClaimTool.ts`, modify `src/services/serviceManager.ts`                  | 1-2 days         | LSP Validation Service                              |
| Code Intelligence Brief | `src/services/diffEnricher.ts`, `src/types/enrichedDiffTypes.ts`, modify prompt generators | 3-4 days         | LSP Validation Service                              |

**Acceptance criteria**:

- `validate_claim` correctly verifies/refutes at least these claim types: `symbol_unused`, `type_mismatch`, `symbol_missing`, `no_callers`
- Code Intelligence Brief enriches changed symbols with reference counts, types, export status
- Graceful degradation: LSP unavailable/timeout → `inconclusive`, not error
- Brief generation completes in <15s for 100-symbol diffs

### Phase 3: Architectural Quality Enforcement (The Filter)

**Goal**: Enforce quality structurally, not just via prompts.

| Component                | Files                                                         | Estimated Effort | Dependencies                              |
| ------------------------ | ------------------------------------------------------------- | ---------------- | ----------------------------------------- |
| Structured Output Schema | `src/types/findingSchema.ts`, modify `submit_review` tool     | 2-3 days         | None                                      |
| Programmatic Validation  | `src/services/findingValidator.ts`                            | 2-3 days         | Structured Output Schema                  |
| CoVe + LSP Verification  | Modify `src/services/toolCallingAnalysisProvider.ts`, prompts | 3-4 days         | LSP Validation Service, Structured Output |
| Adversarial Verification | `src/prompts/adversarialPromptGenerator.ts`, modify provider  | 2-3 days         | SubagentExecutor (existing)               |

**Acceptance criteria**:

- All findings validated for: file existence, line range validity, non-empty evidence
- CRITICAL/HIGH findings undergo CoVe verification with at least one LSP query
- CRITICAL findings additionally face adversarial mini-agent
- Findings with LSP-refuted claims are dropped or flagged

### Total Estimated Effort

| Phase                            | Days | Cumulative |
| -------------------------------- | ---- | ---------- |
| Phase 1: Evidence Infrastructure | 5-7  | 5-7        |
| Phase 2: LSP Verification        | 8-11 | 13-18      |
| Phase 3: Quality Enforcement     | 9-13 | 22-31      |

**Recommendation**: Implement Phases 1 and 2 as one PR. Phase 3 as a separate PR. Each PR delivers measurable quality improvement.

---

## 9. Key Design Decisions

### D1: Evidence Ledger is per-analysis, not persistent

The ledger lives in memory for one analysis and is discarded. No cross-analysis persistence. Rationale: (a) each PR is a fresh review context, (b) persistent storage adds complexity (serialization, staleness, cleanup), (c) the primary value is cross-agent sharing within one review.

### D2: validate_claim is available to ALL agents, not ROOT_ONLY

Any agent can verify its own claims before reporting them. This is more efficient than relaying unverified claims to the root and having the root verify everything. Subagents with `validate_claim` can self-filter FPs before they propagate.

### D3: Code Intelligence Brief is injected once, not per-subagent

The brief is part of the system prompt, computed once before any subagent spawns. All agents share the same baseline context. This prevents duplicating LSP queries and ensures consistency.

### D4: Adversarial verification only for CRITICAL

The cost of spawning an adversarial agent is ~5-10 LLM iterations + tool calls. For CRITICAL findings (0-3 per review), this is acceptable. For HIGH/MEDIUM (potentially 10-20), it's too expensive. CoVe+LSP verification handles HIGH/MEDIUM.

### D5: Depth scoring is additive, not multiplicative

A file that had `get_file_diff` + `read_file` + `find_symbol` scores 2+2+2=6, not 2×2×2=8. Additive scoring is simpler to reason about and debug. The scale (0-10) maps cleanly to tool combinations.

### D6: LSP queries have aggressive per-operation timeouts

Each LSP query gets 2s max. If the language server is slow or unresponsive, the query returns `inconclusive` rather than blocking the review. The review must never be slower than the current non-LSP version — LSP is additive quality, not a gating dependency.

### D7: Evidence entries are lightweight claims, not full file contents

An evidence entry is: `{ category: "caller_pattern", symbol: "processItems", claim: "has 30 callers across 5 files", confidence: "high" }`. NOT: `{ content: "<entire file contents>" }`. This prevents the ledger from becoming a context dump.

---

## 10. Acceptance Criteria

### Quality Metrics (measured via manual triage of 20+ findings)

| Metric                        | Current                            | Target (Phase 1+2) | Target (Full) |
| ----------------------------- | ---------------------------------- | ------------------ | ------------- |
| FP Rate                       | 67-81%                             | < 40%              | < 20%         |
| CRITICAL/HIGH accuracy        | ~50% estimated                     | > 70%              | > 85%         |
| Evidence coverage             | ~30% (findings with tool evidence) | > 70%              | > 90%         |
| LSP-verified findings         | 0%                                 | > 30%              | > 50%         |
| Adversarial-survived CRITICAL | N/A                                | N/A                | 100%          |

### Performance Constraints

| Operation                          | Budget |
| ---------------------------------- | ------ |
| Code Intelligence Brief generation | < 15s  |
| Per-symbol LSP query               | < 2s   |
| validate_claim response            | < 3s   |
| Overall review time increase       | < 20%  |

### Regression Guards

- All existing 1468+ tests pass
- No increase in review latency beyond 20%
- Graceful degradation when LSP is unavailable (TypeScript TSServer not running, non-TypeScript files)
- Evidence ledger memory usage < 10MB per analysis

---

## 11. Risks and Mitigations

| Risk                                                    | Impact                                                        | Likelihood | Mitigation                                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------- |
| LSP queries unreliable for non-TS languages             | Reduced FP improvement for polyglot repos                     | Medium     | `inconclusive` fallback; TypeScript-first focus                                         |
| Evidence ledger noise (agents record low-value entries) | Token waste, misleading queries                               | Medium     | Prompt guidance: "record only facts valuable to other agents"; entry count cap (200)    |
| Code Intelligence Brief too large for context           | Context bloat reduces LLM quality                             | Low        | Cap at 50 symbols; top-N by reference count                                             |
| validate_claim misclassification                        | Agent sends wrong claim type; query returns misleading result | Medium     | Validate claim_type against file/symbol existence before running LSP query              |
| Performance regression from LSP queries                 | Slower reviews                                                | Low        | Aggressive timeouts (2s/query); parallel queries; graceful skip                         |
| LLM doesn't use new tools effectively                   | Tools exist but agents don't call them                        | Medium     | Prompt engineering + tool description quality; measure adoption via tool call frequency |

---

## 12. What Was Abandoned and Why

### MapReduce Aggregation

**What it proposed**: Reducer agents that merge/dedup subagent outputs before the root sees them. For 15 subagents → 5 reducers → root reads 5 summaries.

**Why abandoned**: The RLM recursive tree already provides hierarchical structure. The root doesn't need to read 15 flat outputs — the tree naturally groups agents by concern. Adding reducer agents costs 3-5 additional LLM calls per review (reducers need their own iterations) without adding new information. The real problem isn't fan-in volume — it's information quality. Better to improve what flows through the existing hierarchy (structured evidence, provenance, depth scores) than to add another hierarchy layer.

**When to reconsider**: If reviews consistently hit context limits at the root level despite structured output. This would indicate the fan-in problem is worse than expected and explicit reduction is needed.

### Standalone Adversarial Agent for Every Finding

**What it proposed**: A separate red-team agent for each finding, spawned as a full subagent with tool access.

**Why scoped to CRITICAL only**: For HIGH/MEDIUM findings, CoVe+LSP verification achieves comparable FP reduction at 10-100x lower cost (one tool call vs. a full subagent conversation). The marginal quality improvement of adversarial agents over CoVe+LSP is significant only for complex, high-stakes findings where anchoring bias matters — exactly the CRITICAL tier.

### Persistent Cross-Analysis Evidence

**What it proposed**: Evidence ledger persisted to disk, reused across PR reviews of the same repo.

**Why abandoned**: Every PR review should start fresh. Stale evidence from a prior review could mislead agents ("in the last review, function X had 5 callers" — but 3 were removed in between). The complexity of staleness detection, cache invalidation, and storage management outweighs the marginal benefit of reuse. LSP queries are cheap enough to re-run.
