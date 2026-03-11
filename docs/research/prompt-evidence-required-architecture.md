# Research Prompt: Evidence-Required Architecture for FP Reduction

> **Instructions**: Paste this entire prompt into a NEW chat session. Select Claude Opus 4.6 as the model. The agent should use sequential thinking (in subagents) and subagent delegation for research.

---

## Context

**Lupa** is a VS Code extension that performs PR code review using GitHub Copilot models. It uses a tool-calling architecture where the LLM dynamically requests context via tools, then records findings.

### The Problem: 100% False Positive Rate

After **4 rounds** of testing with different approaches, the system has a **100% false positive rate** across all models (GPT-4.1, GPT-4o). Every finding from the LLM is wrong. Attempted approaches:

1. **Regex FP detection** — model ignored guidance (100% FP)
2. **CoVe self-verification** — model fills fields but content is wrong (100% FP)
3. **Cascade adversarial verification** — same model blind spots (100% FP)
4. **3-layer defense** (taxonomy + programmatic filters + few-shot) — deployed but untested yet

### Root Cause Analysis

The fundamental issue: **the LLM is GENERATING bugs by hallucination, not discovering real ones**. The models don't understand:

- Architectural patterns (centralized error handlers)
- Language runtime guarantees (JS single-threading, TS type safety)
- Framework conventions (Express middleware, React lifecycle)
- When "absence" is intentional design

### What the Research Says (2025 State of Art)

**Every successful production system runs deterministic analysis FIRST, then uses LLM as triage/filter:**

| System               | Approach                                          | FP Reduction                |
| -------------------- | ------------------------------------------------- | --------------------------- |
| SAST-Genius          | Semgrep + fine-tuned LLM                          | 89.5% precision (was 35.7%) |
| LLMPFA               | Static analysis + LLM hybrid                      | 94-98% FP elimination       |
| Vulnhalla            | CodeQL + LLM agent                                | 96% FP reduction            |
| Datadog Bits AI      | LLM classification on SAST output                 | Production-deployed         |
| Claude Code Security | Multi-stage verification + deterministic baseline | "Tiered pipeline"           |

**Key insight from Praetorian**: "Treat the LLM as a nondeterministic kernel wrapped in a deterministic runtime"

### Our System Does the OPPOSITE

Current pipeline:

1. LLM discovers bugs via tool calls → **hallucination-prone**
2. LLM records findings via `RecordFindingTool` → **no evidence required**
3. `FindingValidator` post-filters → **limited scope, reactive**
4. Adversarial verification (another LLM) → **same blind spots**

The `verifiableClaims` field exists in `RecordedFinding` but is **completely dormant** — `RecordFindingTool` never populates it, so `FindingValidator.runLspValidation()` always skips.

### Current Architecture (Key Files)

**Finding Recording**:

- `src/tools/recordFindingTool.ts` — Records findings to FindingStore. Schema:
    ```typescript
    schema = z.object({
        severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
        category: z.enum(ALLOWED_FINDING_CATEGORIES),
        title: z.string().max(120),
        file: z.string(),
        startLine: z.number().int().positive(),
        endLine: z.number().int().positive(),
        description: z.string().min(50).max(2000),
        supportingToolCalls: z.array(z.string()).min(1),
        disproof: z.object({
            attempted: z.boolean(),
            method: z.string(),
            result: z.string(),
        }),
        // NOTE: No verifiableClaims field in schema!
    });
    ```

**Finding Validation**:

- `src/services/findingValidator.ts` — Post-processing validation pipeline:
    1. `checkFileInDiff` — Is file in changed files?
    2. `checkFileDeleted` — Is file deleted?
    3. `checkLineRange` — Valid line range?
    4. `checkCategoryAllowed` — Category in taxonomy?
    5. `checkConcurrencyFalsePositive` — Concurrency in single-threaded lang?
    6. `checkExcludedPatterns` — Missing tests/docs/runtime validation?
    7. `checkDisproof` — Did agent attempt disproof?
    8. `runLspValidation` — **DORMANT**: validates `verifiableClaims` via LSP

**LSP Validation (dormant but fully wired)**:

- `src/types/claimTypes.ts` — Claim types:

    ```typescript
    type ClaimType =
        | 'symbol_unused'
        | 'type_mismatch'
        | 'symbol_missing'
        | 'not_exported'
        | 'no_callers'
        | 'no_implementation';

    interface VerifiableClaim {
        claimType: ClaimType;
        file: string;
        line: number;
        symbol: string;
        assertion: string;
    }
    ```

- `src/services/lspValidationService.ts` — Actually queries VS Code LSP for:
    - Symbol existence (`symbol_missing`)
    - Reference count (`no_callers`, `symbol_unused`)
    - Type information (`type_mismatch`)
    - Export status (`not_exported`)

**The LLM's Available Tools**:

- `find_symbol` — Find symbol definitions with body (uses LSP)
- `find_usages` — Find all references to a symbol (uses LSP)
- `search_for_pattern` — Ripgrep search
- `read_file` — Read file content
- `list_directory` — List directory structure
- `get_file_diff` — Get diff for a file (RLM approach)
- `record_finding` — Record a bug finding
- `retract_finding` — Remove a previously recorded finding
- `validate_claim` — Deterministically validate a claim via LSP
- `think` — Scratchpad for reasoning

**Model Calibration**:

- `src/models/modelCalibration.ts` — Per-model profiles control prompt behavior
- GPT-4.1 has `includeFalsePositiveGuide: false` (too dismissive with FP guidance)
- GPT-4o has `includeFalsePositiveGuide: true`

**Analysis Orchestration**:

- `src/services/toolCallingAnalysisProvider.ts` — Main analysis loop
- Root agent creates plan → spawns subagents → aggregates findings
- Each subagent has its own conversation with tool access

## Research Task

### Phase 1: Deep Research (run in subagents with sequential thinking)

1. **Research evidence-based code review architectures**:
    - Tavily: "evidence-based automated code review LLM verification 2025"
    - Tavily: "LLMPFA hybrid static analysis LLM false positive reduction"
    - Tavily: "specification grounded code review SGCR 2025"
    - DeepWiki: `microsoft/vscode` — LSP capabilities for code analysis

2. **Research our dormant infrastructure** (read codebase via subagents):
    - Read `src/services/lspValidationService.ts` — What validation is already possible?
    - Read `src/tools/validateClaimTool.ts` — How does the validate_claim tool work?
    - Read `src/tools/recordFindingTool.ts` — How to add verifiableClaims to schema?
    - Read `src/prompts/subagentPromptGenerator.ts` — How are subagent prompts built?
    - Read `src/prompts/blocks/findingQualityGuidance.ts` — Current FP prevention prompts

3. **Research what "evidence" means for different finding types**:
    - `logic_error` → What LSP evidence can prove logical errors? (callers, data flow)
    - `security_vulnerability` → Input validation, sanitization references
    - `resource_leak` → Disposal patterns, reference lifecycle
    - `api_misuse` → API signatures, type info, documentation references
    - `error_handling_gap` → Error handler coverage, try-catch patterns
    - `data_integrity` → Data flow, mutation patterns
    - `regression_risk` → Test coverage, dependent code

### Phase 2: Architecture Design (use sequential thinking)

Design an **evidence-required architecture** where findings MUST cite deterministic evidence to survive. Consider these approaches:

**Approach A: Activate verifiableClaims**

- Add `verifiableClaims` to `RecordFindingTool` schema
- Require at least 1 claim per finding
- `FindingValidator.runLspValidation()` verifies via LSP
- If ANY claim is refuted, drop the finding
- Pros: Infrastructure exists, minimal new code
- Cons: Limited to LSP-verifiable claims, may be too restrictive

**Approach B: Specification-Grounded Review (SGCR)**

- Define a taxonomy of review rules (like ESLint rules but semantic)
- Each subagent checks 2-3 specific rules against assigned files
- Findings must cite the rule + tool evidence
- Rules are language-aware and scope-limited
- Pros: Focused, reduces hallucination surface
- Cons: Requires defining good rule set, may miss novel issues

**Approach C: Deterministic-First Pipeline (Flip the architecture)**

- Phase 1: Programmatic analysis of diff (pattern matching, AST, LSP diagnostics)
- Phase 2: LLM validates/enriches deterministic candidates
- Phase 3: LLM searches for semantic issues tools missed (with evidence requirement)
- Pros: Proven approach (SAST-Genius, LLMPFA, Vulnhalla all do this)
- Cons: Major refactor, limited deterministic analysis without SAST

**Approach D: Mandatory validate_claim Before record_finding**

- Enforce that `validate_claim` tool must be called before `record_finding`
- Post-hoc check: if finding has no preceding validate_claim calls, drop it
- Pros: Uses existing tools, forces evidence gathering
- Cons: Model may hallucinate claim validation too

**Approach E: Hybrid — Combine A + B + D**

- Add verifiableClaims to RecordFindingTool (Approach A)
- Add SGCR-style rule set to subagent prompts (Approach B)
- Track validate_claim calls per finding (Approach D)
- This creates multiple overlapping evidence layers

**Consider GPT-4.1 specifically**:

- GPT-4.1 finds fewer issues (scores 52.4% on Aider benchmark vs Claude at 64.9%)
- GPT-4.1 handles SIMPLE, focused tasks better than complex open-ended analysis
- The SGCR approach (specific rules per subagent) may benefit GPT-4.1 most
- Each subagent gets 1-2 files + 2-3 specific rules to check = within GPT-4.1's sweet spot

### Phase 3: Implementation Plan

For the chosen approach:

1. What files need to change?
2. What new files are needed?
3. How does the prompt change? (System prompt, subagent prompt, finding guidance)
4. What tests need to be written?
5. What's the migration path? (Can we deploy incrementally?)
6. What configuration should be per-model? (GPT-4.1 may need different strategy than GPT-4o)

### Phase 4: Implement

Implement the chosen solution following all conventions in CLAUDE.md and ARCHITECTURE.md:

- Run `npm run check-types` after changes
- Write tests for new behavior
- Commit with descriptive messages
- Follow BaseTool pattern for any new tools
- Update model calibration profiles if needed

## Expected Output

1. **Analysis**: Comparison of approaches with pros/cons for Lupa's specific constraints
2. **Design**: Detailed architecture for the chosen approach, including data flow
3. **Implementation**: Code changes across all affected files
4. **Tests**: Comprehensive test coverage for new behavior
5. **GPT-4.1 strategy**: Specific recommendations for task decomposition that plays to GPT-4.1's strengths
6. **Prompt changes**: Updated system prompt, subagent prompt, and finding guidance
