# Research Prompt: Evidence-Required Architecture + Model-Specific Quality Optimization

> **Instructions**: Paste this entire prompt into a NEW chat session. Select Claude Opus 4.6 as the model. The agent should use sequential thinking (in subagents) and subagent delegation for research. This is a large, multi-phase task — use subagents aggressively to keep context clean.

---

## Context

**Lupa** is a VS Code extension that performs PR code review using GitHub Copilot models. It uses a **Recursive Language Model (RLM)** approach — an iterative, tool-calling architecture where the LLM dynamically composes its own analysis pipeline via tool calls, then records findings.

### Problem 1: 100% False Positive Rate (All Models)

After **4 rounds** of testing with different approaches, the system has a **100% false positive rate** across all models (GPT-4.1, GPT-4o). Every finding from the LLM is wrong. Attempted approaches:

1. **Regex FP detection** — model ignored guidance (100% FP)
2. **CoVe self-verification** — model fills fields but content is wrong (100% FP)
3. **Cascade adversarial verification** — same model blind spots (100% FP)
4. **3-layer defense** (taxonomy + programmatic filters + few-shot) — deployed but untested yet

**Root cause**: The LLM is **GENERATING bugs by hallucination**, not discovering real ones. The models don't understand:

- Architectural patterns (centralized error handlers)
- Language runtime guarantees (JS single-threading, TS type safety)
- Framework conventions (Express middleware, React lifecycle)
- When "absence" is intentional design

### Problem 2: GPT-4.1 Finds Far Fewer Issues (Model-Specific)

When reviewing PRs:

- **GPT-4o** finds more potential issues per review
- **GPT-4.1** finds noticeably fewer issues, often stops early at 5-8 iterations
- **Claude models** find the most issues
- **All models** have very high false positive rates

GPT-4.1 is the **default model** for many Copilot users. The extension must provide value especially on this model.

### These Problems Are Connected

The architecture must solve BOTH simultaneously:

- **Evidence requirements** prevent hallucinated findings (FP reduction)
- **Model-specific investigation protocols** ensure thorough analysis (finding depth)
- **SGCR-style focused rules** give GPT-4.1 achievable tasks AND reduce hallucination surface
- The same architectural change addresses both: constrain what models CAN report, guide HOW they investigate

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

### Known GPT-4.1 Characteristics (From Research)

1. **Aider Benchmark**: GPT-4.1 scored **52.4%** vs Claude 3.7 Sonnet at 64.9%, Gemini 2.5 Pro at 72.9%
2. **Tool calling behavior**: GPT-4.1 is conservative — calls fewer tools per turn
3. **Complexity handling**: "Can handle significantly less complexity than Claude"
4. **Task focus**: Performs best with simple, focused, well-defined tasks
5. **Early stopping**: Tends to "stop quickly to ask questions" or settle on first finding
6. **Instruction following**: Very good at following explicit instructions, but needs more structure

### Our System Does the OPPOSITE

Current pipeline:

1. LLM discovers bugs via tool calls → **hallucination-prone**
2. LLM records findings via `RecordFindingTool` → **no evidence required**
3. `FindingValidator` post-filters → **limited scope, reactive**
4. Adversarial verification (another LLM) → **same blind spots**

The `verifiableClaims` field exists in `RecordedFinding` but is **completely dormant** — `RecordFindingTool` never populates it, so `FindingValidator.runLspValidation()` always skips.

---

## Current Architecture (Key Files)

### Finding Recording

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

### Finding Validation

- `src/services/findingValidator.ts` — Post-processing validation pipeline:
    1. `checkFileInDiff` — Is file in changed files?
    2. `checkFileDeleted` — Is file deleted?
    3. `checkLineRange` — Valid line range?
    4. `checkCategoryAllowed` — Category in taxonomy?
    5. `checkConcurrencyFalsePositive` — Concurrency in single-threaded lang?
    6. `checkExcludedPatterns` — Missing tests/docs/runtime validation?
    7. `checkDisproof` — Did agent attempt disproof?
    8. `runLspValidation` — **DORMANT**: validates `verifiableClaims` via LSP

### LSP Validation (dormant but fully wired)

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

### LLM-Available Tools

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

### Model Calibration System

- `src/models/modelCalibration.ts` — Per-model profiles control prompt behavior:
    ```typescript
    interface ModelProfile {
        displayName: string;
        maxTokens: number;
        temperature: number;
        promptStyle: PromptStyle;
        adversarialVerificationThreshold: SeverityLevel;
        includeEvidenceGuidance: boolean;
        includeFalsePositiveGuide: boolean;
        includeQualityExamplePrompts: boolean;
        rootMaxIterations: number;
        subagentMaxIterations: number;
    }
    ```
- GPT-4.1 has `includeFalsePositiveGuide: false` (too dismissive with FP guidance — finds 0 issues)
- GPT-4o has `includeFalsePositiveGuide: true`

### RLM Conversation Loop

From `src/models/conversationRunner.ts`:

```typescript
async run(conversation: RecordedConversation, options: ConversationRunnerOptions): Promise<string | undefined> {
    let iteration = 0;
    while (iteration < maxIterations) {
        const response = await this.sendRequest(conversation, tools, ...);

        if (response.finishReason === 'stop') {
            // Model decided it's done - return final message
            return response.content;
        }

        if (response.finishReason === 'tool_calls') {
            // Execute tools, add results, continue loop
            for (const toolCall of response.toolCalls) {
                const result = await tool.execute(toolCall.parameters, context);
                conversation.addToolResult(toolCall.id, result);
            }
        }
        iteration++;
    }
}
```

- `maxIterations = 50 (root) / 30 (subagent)` — but GPT-4.1 often stops at 5-8 iterations
- `beforeAcceptingResponse` callback exists in the runner (can nudge model to continue)

### Analysis Orchestration

- `src/services/toolCallingAnalysisProvider.ts` — Main analysis loop
- Root agent creates plan → spawns subagents → aggregates findings
- Each subagent has its own conversation with tool access
- `src/prompts/subagentPromptGenerator.ts` — How subagent prompts are built
- `src/prompts/rootAgentPromptGenerator.ts` — How root agent plans decomposition
- `src/prompts/blocks/findingQualityGuidance.ts` — Current FP prevention prompts

---

## Research Task

### Phase 1: Deep Internet Research (run in parallel subagents)

**Evidence-based architecture research:**

1. Tavily: "evidence-based automated code review LLM verification 2025"
2. Tavily: "LLMPFA hybrid static analysis LLM false positive reduction"
3. Tavily: "specification grounded code review SGCR 2025"
4. Tavily: "deterministic wrapper LLM nondeterministic kernel code analysis"

**GPT-4.1-specific optimization research:** 5. Tavily: "GPT-4.1 tool calling optimization best practices 2025" 6. Tavily: "GPT-4.1 system prompt instruction following tricks structured output" 7. Tavily: "GPT-4.1 vs Claude code review LLM comparison agentic tasks" 8. Tavily: "agentic coding GPT-4.1 prompt engineering investigation depth early stopping"

**Multi-model quality research:** 9. Tavily: "recursive language model iterative tool use agent quality optimization" 10. Tavily: "LLM code review per-model prompt engineering quality 2025" 11. Tavily: "GPT-4o vs GPT-4.1 vs Claude tool calling behavior differences"

**LSP capabilities research:** 12. DeepWiki: `microsoft/vscode` — LSP capabilities for code analysis, diagnostics API

### Phase 2: Deep Codebase Research (run in parallel subagents)

Read and analyze these files:

1. `src/services/lspValidationService.ts` — What validation is already possible?
2. `src/tools/validateClaimTool.ts` — How does the validate_claim tool work?
3. `src/tools/recordFindingTool.ts` — How to add verifiableClaims to schema?
4. `src/prompts/subagentPromptGenerator.ts` — How are subagent prompts built?
5. `src/prompts/rootAgentPromptGenerator.ts` — How root agent plans decomposition
6. `src/prompts/blocks/findingQualityGuidance.ts` — Current FP prevention prompts
7. `src/models/modelCalibration.ts` — Current per-model profiles
8. `src/models/conversationRunner.ts` — The main loop, `beforeAcceptingResponse` hook
9. `src/services/toolCallingAnalysisProvider.ts` — Subagent spawning logic
10. `src/types/claimTypes.ts` — Current claim types and VerifiableClaim interface

### Phase 3: Architecture Design (use sequential thinking)

Design a unified architecture that solves BOTH problems. Consider and evaluate these approaches:

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
- **KEY FOR GPT-4.1**: This matches its strength profile — focused, binary tasks
- Pros: Focused, reduces hallucination surface, great for GPT-4.1
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

**Approach E: Hybrid — Combine A + B + D + Model-Specific Protocols**

- Add verifiableClaims to RecordFindingTool (Approach A)
- Add SGCR-style rule set to subagent prompts (Approach B)
- Track validate_claim calls per finding (Approach D)
- Model-specific investigation protocols and task decomposition
- This creates multiple overlapping evidence layers

### Phase 4: GPT-4.1-Specific Design (use sequential thinking)

Within the chosen architecture, design GPT-4.1-specific optimizations:

**Hypothesis 1: GPT-4.1 stops too early (finishReason: 'stop' at 5-8 iterations)**

- Fix: Use `beforeAcceptingResponse` callback to check investigation depth
- Track: Was `validate_claim` called? Was `find_usages` called? Did it use `get_file_diff`?
- Nudge with specific message about what's missing

**Hypothesis 2: GPT-4.1 needs structured investigation steps**

- Instead of "investigate these files for bugs", give explicit steps:
    1. "First, read each assigned file completely"
    2. "Then, get the diff for each file"
    3. "For each changed function, find all callers using find_usages"
    4. "For each type used, verify type compatibility using validate_claim"
    5. "Now analyze your investigation data for bugs"

**Hypothesis 3: GPT-4.1 should get DIFFERENT tasks than other models**

- GPT-4.1: "Check if function X handles null input correctly" (binary/focused)
- GPT-4o: "Analyze files X and Y for error handling gaps" (moderate scope)
- Claude: "Investigate the payment flow for security vulnerabilities" (open-ended)

**Hypothesis 4: Per-model iteration nudging in beforeAcceptingResponse**

```typescript
beforeAcceptingResponse: (response, conversation) => {
    const toolCallCount = conversation.toolCalls.length;
    const uniqueToolsUsed = new Set(
        conversation.toolCalls.map((tc) => tc.name)
    );

    if (toolCallCount < 5 && !uniqueToolsUsed.has('validate_claim')) {
        return {
            accept: false,
            nudgeMessage:
                'You stopped too early. Use validate_claim and find_usages before concluding.',
        };
    }
    return { accept: true };
};
```

**Design these model-calibrated settings:**

1. **Minimum investigation requirements** (per model profile):
    - Min tool calls before first `record_finding`
    - Required tools that MUST be called (e.g., `get_file_diff`, `find_usages`)
    - Min unique files read before accepting response

2. **Investigation templates** (especially for GPT-4.1):
    - Step-by-step investigation flow embedded in prompt
    - Each step names the tool to use and what to look for
    - Template varies by investigation type (security, logic, etc.)

3. **Model-specific decomposition strategy**:
    - GPT-4.1: More subagents, each with 1 file + 1 focused question
    - GPT-4o: Moderate subagents, 2-3 files + broader investigation
    - Claude: Fewer subagents, more files, open-ended investigation

4. **Adaptive iteration nudging**:
    - Track investigation quality signals
    - If model stops early, inject nudge message
    - Different nudge strategies per model

### Phase 5: Evidence Requirements Per Finding Type

Research what "evidence" means for each category:

- `logic_error` → What LSP evidence can prove logical errors? (callers, data flow)
- `security_vulnerability` → Input validation, sanitization references
- `resource_leak` → Disposal patterns, reference lifecycle
- `api_misuse` → API signatures, type info, documentation references
- `error_handling_gap` → Error handler coverage, try-catch patterns
- `data_integrity` → Data flow, mutation patterns
- `regression_risk` → Test coverage, dependent code

### Phase 6: Implementation Plan

For the chosen approach:

1. What files need to change?
2. What new files are needed?
3. How does the prompt change? (System prompt, subagent prompt, finding guidance)
4. What tests need to be written?
5. What's the migration path? (Can we deploy incrementally?)
6. What configuration should be per-model? (GPT-4.1 needs different strategy than GPT-4o)

### Phase 7: Implement

Implement the chosen solution following all conventions in CLAUDE.md and ARCHITECTURE.md:

- Run `npm run check-types` after changes
- Write tests for new behavior
- Commit with descriptive messages
- Follow BaseTool pattern for any new tools
- Update model calibration profiles

**Implementation priority order:**

1. Evidence requirements (verifiableClaims activation) — highest impact on FP
2. Model-specific investigation protocols — highest impact on GPT-4.1 depth
3. SGCR-style focused rules — benefits both FP and GPT-4.1
4. `beforeAcceptingResponse` nudging — prevents early stopping
5. Task decomposition granularity — model-specific subagent task sizing

## Constraints

- Follow all conventions in CLAUDE.md and ARCHITECTURE.md
- Run `npm run check-types` after changes
- All changes must be backward compatible
- Must not break existing tests
- Model profiles are in `src/models/modelCalibration.ts`
- The `beforeAcceptingResponse` callback already exists in the conversation runner
- `verifiableClaims` infrastructure (types, LSP service, validator) already exists — just dormant
- Changes must work with VS Code's `vscode.lm` API (no temperature/top_p/system-prompt-role control)

## Expected Output

1. **Internet research synthesis**: Key findings on evidence-based architectures AND model-specific optimization
2. **Architecture design**: Unified approach for FP reduction + investigation depth
3. **GPT-4.1 strategy**: Specific investigation protocol, prompt changes, task decomposition tuned for GPT-4.1's strengths and weaknesses
4. **Multi-model calibration**: How GPT-4o, Claude, and future models should differ in investigation protocol
5. **Implementation**: Code changes across all affected files
6. **Tests**: Comprehensive test coverage for new behavior
7. **Prompt changes**: Updated system prompt, subagent prompt, finding guidance — with model-specific variants
