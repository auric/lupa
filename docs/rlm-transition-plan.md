# Recursive Language Model (RLM) Architecture Transition Plan

> **Based on**: [Recursive Language Models](https://arxiv.org/abs/2512.24601) (Zhang, Kraska, Khattab — MIT CSAIL, Dec 2025)
> **Target**: Lupa VS Code Extension — PR Analysis with GPT-4.1
> **Status**: Implemented — this document is retained as a historical design reference. Some settings described below (e.g., `maxIterations`, `maxSubagentsPerSession`) are now hardcoded constants in `ANALYSIS_LIMITS` rather than user-configurable settings. See `src/models/workspaceSettingsSchema.ts` for current values.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Theoretical Foundation](#2-theoretical-foundation)
3. [Current Architecture Analysis](#3-current-architecture-analysis)
4. [RLM Mapping: Paper → Extension](#4-rlm-mapping-paper--extension)
5. [Architecture Design](#5-architecture-design)
6. [RecursiveStateManager Design](#6-recursivestatemanager-design)
7. [Prompt Architecture](#7-prompt-architecture)
8. [Implementation Phases](#8-implementation-phases)
9. [File Change Inventory](#9-file-change-inventory)
10. [GPT-4.1 Optimization Strategy](#10-gpt-41-optimization-strategy)
11. [Risk Assessment & Mitigations](#11-risk-assessment--mitigations)
12. [Testing Strategy](#12-testing-strategy)
13. [Configuration & Settings](#13-configuration--settings)
14. [Migration & Rollback](#14-migration--rollback)

---

## 1. Executive Summary

### The Problem

Lupa's current review architecture is **linear**: the LLM receives the full diff, iteratively calls tools to gather context, and produces a monolithic review. On large PRs (20+ files), this causes **context rot** — the model's reasoning quality degrades as its context window fills with accumulated tool results, leading to missed issues and shallow analysis.

### The Solution

Adopt the **Recursive Language Model (RLM)** paradigm from MIT CSAIL's research. Instead of one agent doing everything, the review is decomposed into focused sub-reviews handled by isolated recursive agents, each operating within their optimal context window size.

### Key Insight from the Paper

> "Context management is a learnable skill, not a hardware constraint."

The RLM approach treats the codebase as an **external environment** the LLM programmatically queries, rather than injecting everything into a single context window. The model spawns recursive sub-calls to itself, each processing a manageable slice of the problem, with results flowing back to the parent for aggregation.

### Expected Benefits for GPT-4.1

| Metric               | Current (Linear)             | RLM (Recursive)               | Improvement          |
| -------------------- | ---------------------------- | ----------------------------- | -------------------- |
| Context per agent    | 30-80K tokens                | 10-20K tokens                 | 3-4x reduction       |
| Review thoroughness  | Degrades >20 files           | Consistent at 50+ files       | Major quality gain   |
| Issue detection rate | Misses deep deps             | Follows chains recursively    | Better coverage      |
| Token efficiency     | Wasted on irrelevant context | Focused per concern           | Similar total cost   |
| Failure resilience   | All-or-nothing               | Partial results from N agents | Graceful degradation |

---

## 2. Theoretical Foundation

### 2.1 The RLM Paper's Core Architecture

The paper (arXiv:2512.24601) proposes three components:

1. **Context as External Environment Variable**: The input is stored in a programming environment (Python REPL) as a variable, not injected into the LLM prompt. The LLM writes code to inspect it.

2. **REPL Environment**: The LLM operates inside an execution environment where it can:
    - Peek at slices of the context (`context[:1000]`)
    - Search with regex (`re.findall(pattern, context)`)
    - Partition and iterate (`context.split(...)`)
    - Transform and filter programmatically

3. **Recursive Sub-Agent Calls**: `rlm_agent(query, context)` spawns an isolated child LLM instance with its own context window. The parent writes an algorithm that calls this function, and results flow back into the parent's execution.

### 2.2 Key Results

- **OOLONG-Pairs benchmark**: GPT-5 scored 0.1 F1. RLM(GPT-5) scored 58.0 F1.
- **BrowseComp-Plus (1000 docs)**: Vanilla models scored 0.0% (context limit). RLM scored 91.3%.
- **RLM-Qwen3-8B** (post-trained 8B model) approached GPT-5 quality on 3 benchmarks.
- Processes inputs up to **100x beyond context window** with no quality degradation.

### 2.3 Context Decomposition vs. Task Decomposition

Standard agent frameworks do **task decomposition** (break a complex problem into simpler sub-problems). RLMs additionally perform **context decomposition** (break a large input into manageable pieces). Standard agents decide _what to do_. RLMs also decide _what to look at_.

This distinction is critical for code review: a 50-file PR needs both task decomposition ("review security", "review performance") AND context decomposition ("this agent examines files A-E", "that agent examines files F-J").

### 2.4 Emergent Strategies (from the paper)

The research observed models independently discovering:

- **Peeking**: Examining initial characters to understand structure before acting
- **Grepping**: Writing regex to narrow relevant content from massive contexts
- **Partition + Map**: Chunking context and recursively processing each piece
- **Programmatic Processing**: Writing complete programs for structured tasks

These map directly to our tool-calling architecture (see Section 4).

---

## 3. Current Architecture Analysis

### 3.1 Analysis Flow (Linear)

```
User triggers "Analyze PR"
    │
    ▼
ToolCallingAnalysisProvider.analyze()
    ├── Creates per-analysis state (ConversationManager, Executors, etc.)
    ├── Generates system prompt + injects FULL DIFF into user message
    │
    ▼
ConversationRunner.run() — Main Loop (up to maxIterations)
    ├── LLM receives: system prompt + full diff + accumulated tool results
    ├── LLM calls tools: read_file, find_symbol, search_for_pattern, etc.
    ├── LLM may call run_subagent_batch (flat, depth=1 only)
    ├── Tool results accumulate in conversation history
    ├── Context window fills → quality degrades
    │
    ▼
LLM calls submit_review → Final review output
```

### 3.2 Current Subagent System (Flat, Depth=1)

- **SubagentSessionManager**: Flat counter (total spawns, can-spawn check)
- **SubagentExecutor**: Spawns isolated agents with filtered tools
- **RunSubagentTool**: The LLM-callable tool for spawning
- **DISALLOWED_TOOLS**: `['run_subagent_batch', 'update_plan', 'submit_review', ...]`
    - Subagents **cannot** call `run_subagent_batch` → no recursion
    - Subagents **cannot** see the diff → investigate current code only

### 3.3 Current Prompt Architecture

- **PromptBuilder**: Fluent builder composes modular prompt blocks
- **System Prompt**: Role → Tool Inventory → Tool Guide → Subagent Guidance → Reflection → Methodology → Output Format
- **User Prompt**: `<files_to_review>` (full diff) → `<user_focus>` (optional) → `<analysis_task>` (reminders)
- **Subagent Prompt**: Focused investigation role + tools + constraints + response requirements

### 3.4 Key Limitations Identified

| Limitation                 | Impact                              | RLM Solution                                           |
| -------------------------- | ----------------------------------- | ------------------------------------------------------ |
| Full diff in root context  | Context rot on large PRs            | Root decomposes, children inspect                      |
| Flat subagent structure    | Can't follow deep dependency chains | Recursive depth (max 2-3)                              |
| Free-text subagent results | Parent wastes tokens parsing        | Structured summary protocol                            |
| All-in-one review          | One bad agent = no review           | Multiple focused agents, partial results               |
| Fixed iteration budget     | Not allocated efficiently           | Independent per-agent budget (DEFAULT_CHILD_BUDGET=50) |
| Subagents can't see diff   | Limits their usefulness             | Children receive relevant diff hunks via context       |

---

## 4. RLM Mapping: Paper → Extension

### 4.1 Concept Mapping

| RLM Paper Concept         | Lupa Extension Equivalent           | Notes                                                 |
| ------------------------- | ----------------------------------- | ----------------------------------------------------- |
| **Python REPL**           | `ToolRegistry` + `ToolExecutor`     | Tools ARE the environment interface                   |
| **Context variable** `C`  | Git diff + codebase                 | Accessible via ReadFile, FindSymbol, SearchForPattern |
| **`rlm_agent(q, C)`**     | `run_subagent_batch(task, context)` | Spawns isolated ConversationRunner                    |
| **REPL stdout**           | `ToolResult` strings                | Text-based tool responses                             |
| **Environment `E`**       | `ExecutionContext`                  | Per-analysis dependencies                             |
| **Recursion depth**       | `currentDepth` in ExecutionContext  | Tracked by RecursiveStateManager                      |
| **Context decomposition** | Root's decomposition phase          | Diff → concern groups → sub-tasks                     |
| **Result aggregation**    | Root's synthesis phase              | Structured findings → final review                    |
| **`exec(code)`**          | `ToolExecutor.executeTool()`        | Controlled execution environment                      |

### 4.2 Operation Mapping

| RLM REPL Operation              | VS Code Tool                         | Status                                  |
| ------------------------------- | ------------------------------------ | --------------------------------------- |
| `context[:1000]` (peek)         | `read_file` with line range          | ✅ Exists                               |
| `re.findall(pattern, context)`  | `search_for_pattern` (ripgrep)       | ✅ Exists                               |
| `context.split('\n')` + iterate | `get_changed_files` + per-file reads | ✅ Exists                               |
| `rlm_agent(query, chunk)`       | `run_subagent_batch(task, context)`  | ⚠️ Needs recursion support              |
| `len(context)`                  | Diff statistics                      | ✅ Available                            |
| Custom filtering                | `find_symbol`, `find_usages`         | ✅ Exists                               |
| Structured output               | `submit_review`                      | ⚠️ Needs structured format for children |

### 4.3 The "Operating System" Metaphor

The RLM paper describes the REPL as an "operating system" the LLM interacts with. In Lupa:

| OS Concept         | Lupa Equivalent                                      |
| ------------------ | ---------------------------------------------------- |
| File System        | Git repository (via ReadFileTool, ListDirTool)       |
| Process Spawning   | RunSubagentTool (spawn child review agents)          |
| Search/Grep        | SearchForPatternTool (ripgrep-based)                 |
| Symbol Resolution  | FindSymbolTool, FindUsagesTool (LSP-based)           |
| Memory Management  | TokenValidator (context window tracking)             |
| Process Management | RecursiveStateManager (limits, tree tracking)        |
| IPC                | Structured summary protocol (child → parent results) |

---

## 5. Architecture Design

### 5.1 New Analysis Flow (Recursive)

```
User triggers "Analyze PR"
    │
    ▼
ToolCallingAnalysisProvider.analyze()
    ├── Creates RecursiveStateManager (depth tracking, budget allocation)
    ├── Creates per-analysis state (same as before + recursiveState)
    ├── Generates ROOT AUDITOR system prompt
    ├── Injects diff into user message (same format)
    │
    ▼
ConversationRunner.run() — Root Agent Loop
    ├── ROOT AGENT Phase 1: DECOMPOSE
    │   ├── Review <diff_metadata> for full scope
    │   ├── Read 1 key diff (largest/riskiest file) for orientation
    │   │   └── ⚠️ Stop after 1 diff — sub-agents read all remaining diffs
    │   ├── Classify changes into concern groups
    │   ├── Call update_plan with decomposition plan
    │   │
    │   ▼
    ├── ROOT AGENT Phase 2: DELEGATE
    │   ├── Spawn Sub-Agent #1: "Security review of auth/* changes"
    │   │   ├── context: relevant diff hunks + concern description
    │   │   ├── Sub-Agent #1 uses tools to investigate
    │   │   ├── Sub-Agent #1 MAY spawn Sub-Sub-Agent #1.1 (if depth < max)
    │   │   │   └── "Trace validateToken() dependency chain"
    │   │   └── Returns: structured findings summary
    │   │
    │   ├── Spawn Sub-Agent #2: "Logic review of dataService changes"
    │   │   ├── context: relevant diff hunks + concern description
    │   │   ├── Sub-Agent #2 uses tools to investigate
    │   │   └── Returns: structured findings summary
    │   │
    │   ├── Spawn Sub-Agent #3: "API surface review"
    │   │   └── ... (same pattern)
    │   │
    │   ▼
    ├── ROOT AGENT Phase 3: AGGREGATE
    │   ├── Merge sub-agent findings
    │   ├── Identify cross-concern patterns
    │   ├── Assess overall risk
    │   │
    │   ▼
    └── ROOT AGENT Phase 4: SYNTHESIZE
        ├── Call think_about_completion
        └── Call submit_review with final structured review
```

### 5.2 Recursion Depth Strategy

```
Depth 0 — ROOT AUDITOR (Controller)
├── Role: Decompose → Delegate → Aggregate → Synthesize
├── Tools: All tools available
├── Budget: maxIterations (hardcoded, currently 600)
├── Diff: Metadata in prompt; reads diffs on-demand via get_file_diff
│
├── Depth 1 — RECURSIVE REVIEWER (Investigator)
│   ├── Role: Focused investigation of specific concern
│   ├── Tools: All except update_plan, submit_review, main-only reflection
│   ├── Budget: DEFAULT_CHILD_BUDGET (50 iterations, independent of parent)
│       ├── Diff: Reads diffs on-demand via get_file_diff
│       └── Can recurse: NO (leaf node)
```

### 5.3 Budget Allocation Model

**Independent per-agent budgets** following the RLM paper model:

```
Root agent:  maxIterations (hardcoded, currently 600)
Child agents: RecursionConstants.DEFAULT_CHILD_BUDGET (50) each
              — independent of parent budget, NOT deducted from parent

Total compute bounded by:
  - maxSubagentsPerSession (currently 200): session-level hard cap across all depths
  - maxRecursionDepth (default 2): limits nesting depth
  - RecursionConstants.MIN_VIABLE_BUDGET (3): minimum to spawn a new agent

Example with maxSubagentsPerSession=200:
  Root: 100 iterations
  Up to 30 child agents, each with 30 iterations
  Total worst-case: 100 + (30 × 30) = 1000 iterations
```

### 5.4 ExecutionContext Changes

```typescript
// Current
interface ExecutionContext {
    planManager?: PlanSessionManager;
    subagentSessionManager?: SubagentSessionManager;
    subagentExecutor?: SubagentExecutor;
    cancellationToken: vscode.CancellationToken;
}

// New (additive — backward compatible)
interface ExecutionContext {
    planManager?: PlanSessionManager;
    subagentSessionManager?: SubagentSessionManager;
    subagentExecutor?: SubagentExecutor;
    cancellationToken: vscode.CancellationToken;
    // NEW fields for recursive architecture
    recursiveState?: RecursiveStateManager;
    currentDepth?: number; // 0 = root, 1 = child, 2 = grandchild
    currentAgentId?: string; // "root", "child-1", "child-1.1"
}
```

---

## 6. RecursiveStateManager Design

### 6.1 Interface

```typescript
// src/sessions/recursiveStateManager.ts

interface RecursiveStateNode {
    agentId: string; // "root", "child-1", "child-1.1"
    depth: number;
    parentId: string | undefined;
    task: string;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
    findings: RecursiveReviewFinding[];
    filesExamined: string[];
    iterationBudget: number;
    childIds: string[];
    startTime: number;
    endTime: number | undefined;
    error: string | undefined; // Stored by failAgent for tree summary diagnostics
}

interface RecursiveReviewFinding {
    severity: 'critical' | 'high' | 'medium' | 'low';
    category: string;
    file: string;
    line: number | undefined;
    title: string;
    description: string;
    confidence: 'verified' | 'likely' | 'uncertain';
    agentId: string; // Which agent found this
}

class RecursiveStateManager {
    private tree: Map<string, RecursiveStateNode>;
    private maxDepth: number;

    // Lifecycle
    registerAgent(
        parentId: string | undefined,
        task: string,
        budget: number
    ): string;
    startAgent(agentId: string): void;
    completeAgent(
        agentId: string,
        findings?: RecursiveReviewFinding[],
        filesExamined?: string[]
    ): void;
    failAgent(agentId: string, error: string): void;
    cancelAgent(agentId: string): void;

    // Guards
    canSpawnChild(parentId: string): { allowed: boolean; reason?: string };
    getDepthOf(agentId: string): number;
    getTotalAgentCount(): number;
    getRemainingBudget(): number;

    // Deduplication
    isFileAlreadyCovered(file: string): boolean;
    getCoveredFiles(): Set<string>;
    getCoverageGapMessage(allFiles: string[]): string | undefined;

    // Aggregation
    getAllFindings(): RecursiveReviewFinding[];
    getTreeSummary(): string;

    // Budget
    allocateChildBudget(parentId: string): number;
}
```

### 6.2 Agent ID Scheme

```
root              — Depth 0 (the Root Auditor)
child-1           — Depth 1, first child of root
child-2           — Depth 1, second child of root
child-1.1         — Depth 2, first child of child-1
child-1.2         — Depth 2, second child of child-1
child-2.1         — Depth 2, first child of child-2
```

Hierarchical naming enables:

- Visual tree structure in logs
- Parent-child relationship tracking
- Depth inference from ID format

### 6.3 Loop Prevention

1. **Hard depth limit**: `maxDepth` setting (default 2)
2. **Session spawn cap**: `maxSubagentsPerSession` constant (currently 200)
3. **Minimum budget**: Won't spawn with < MIN_VIABLE_BUDGET (3) iterations allocated
4. **File deduplication**: Warns if spawning agent for files already covered
5. **Cancellation cascade**: Parent cancel → all children cancelled

---

## 7. Prompt Architecture

### 7.1 Root Auditor System Prompt

````markdown
You are a Lead Architect performing a **recursive pull request review**. You operate as a
review controller that decomposes the PR into focused investigations and synthesizes findings.

## Your Architecture

You are the ROOT AGENT in a recursive review system:

1. **Decompose** — Break the PR into logical review concerns
2. **Delegate** — Spawn focused sub-agents for each concern via `run_subagent_batch`
3. **Aggregate** — Synthesize sub-agent findings into a coherent review
4. **Cross-cut** — Identify issues that span multiple concerns

## Critical Rules

- **Delegate investigations** — Use `run_subagent_batch` for deep code inspection
- **You may orient yourself** using `list_directory`, `get_symbols_overview`, `read_file` (sparingly)
- **Your primary tool is `run_subagent_batch`** — It does the heavy investigation
- For each concern, include relevant diff hunks in the `context` field
- Sub-agents can investigate both current code AND diff changes you provide

## Decomposition Strategy

### Step 1: Scan the Diff

Read the diff structure:

- Which files changed and how much
- Identify logical groupings (auth, API, data layer, tests, config)
- Assess risk areas (security, correctness, breaking changes)

### Step 2: Create Investigation Plan

Call `update_plan` with your decomposition:

```markdown
## Recursive Review Plan

### Concern Groups

1. [Group name] — Files: [list] — Risk: [level] — Agent: pending
2. [Group name] — Files: [list] — Risk: [level] — Agent: pending

### Cross-Concern Items

- [Any cross-cutting concerns to check after agents complete]
```
````

### Step 3: Spawn Sub-Agents

For each concern group, call `run_subagent_batch`:

```
task: "Review [concern] in [files].
Questions:
1. [Specific question about the change]
2. [Specific question about the change]
Focus on: [what to prioritize]
Examine functions: [key functions]"

context: "## Diff Context
[paste relevant diff hunks from <files_to_review>]

## Concern
[why this needs investigation — what could go wrong]"
```

**Include relevant diff hunks in `context`** — sub-agents need to see what changed.

### Step 4: Aggregate Findings

After all sub-agents return:

- Merge findings by severity (critical first)
- Remove duplicates across agents
- Identify cross-concern patterns (e.g., same anti-pattern in multiple files)
- Assess overall PR risk
- **Address coverage gaps**: The system programmatically checks which files were reviewed via `get_file_diff` and injects a gap report. Spawn additional sub-agents for any uncovered files.

### Step 5: Self-Reflect and Submit

- Call `think_about_completion` to verify coverage
- Call `submit_review` with the final structured review

## When NOT to Spawn Sub-Agents

- Trivial PRs (1-2 files, <30 lines changed): Review directly
- Config-only changes: Quick verification, no deep investigation needed
- If remaining budget is too low for meaningful delegation

## Sub-Agent Capabilities

Sub-agents receive the tools you don't need for coordination:

- `find_symbol`, `find_usages`, `read_file`, `search_for_pattern`, etc.
- They CAN see diff context you provide in the `context` field
- They CAN spawn their own sub-agents for deep dependency tracing
- They return structured findings you can directly incorporate

````

### 7.2 Recursive Reviewer Prompt (Depth 1+)

```markdown
You are a focused investigation agent in a recursive review system. A senior architect
has delegated a specific review concern to you.

<your_task>
${task.task}
</your_task>

${task.context ? `<parent_context>\n${task.context}\n</parent_context>` : ''}

<available_tools>
${toolList}
</available_tools>

## Investigation Approach

You are investigating a specific concern from a pull request review. Your parent agent
provided the relevant diff context above. Your job is to:

1. **Understand the change** using the diff context provided
2. **Investigate the codebase** using your tools to verify correctness
3. **Trace dependencies** — if a changed function calls other functions, verify they
   handle the new behavior correctly
4. **Report structured findings** back to your parent agent

### Tool Usage
- Use `find_symbol` to read function implementations
- Use `find_usages` to check all callers of changed functions
- Use `search_for_pattern` to find related patterns across the codebase
- Use `read_file` for configuration files or when you need full file context
${canRecurse ? `- Use \`run_subagent_batch\` to delegate deep dependency investigations` : ''}

### When to ${canRecurse ? 'Recurse (Spawn Sub-Agents)' : 'Stay Focused'}
${canRecurse ? `
If you discover a dependency chain that requires examining 3+ additional files:
- Spawn a sub-agent with a focused question
- Example: "Does validateToken() properly handle expired tokens?"
- Provide relevant context from your investigation
` : `
You cannot spawn sub-agents. Complete your investigation within your iteration
budget and return your findings. Note any uninvestigated areas in your response.
`}

## Response Format (REQUIRED)

Your response MUST use this exact structure:

### Status: [complete|partial]

### Findings
[For each issue discovered:]
- [SEVERITY_EMOJI] **[Title]** at [file.ts:line](file.ts:line)
  - **Issue**: [one-sentence description]
  - **Evidence**: [code snippet or tool output demonstrating the issue]
  - **Impact**: [what happens if unfixed]
  - **Fix**: [suggested resolution]

### Files Analyzed
- [file1.ts] (fully examined)
- [file2.ts] (symbol-level only)

### Unresolved Questions
- [Anything you couldn't determine within your budget]

### Summary
[2-3 sentences summarizing your investigation for the parent agent]

If you find NO issues, explicitly state what you checked and why it passed.
````

### 7.3 Prompt Composition Changes

New builder factory functions:

```typescript
// For root agent (depth 0) when recursive mode is enabled
function createRecursiveRootPromptBuilder(tools: ITool[]): PromptBuilder {
    return new PromptBuilder()
        .addSection(generateRecursiveRootRole())      // NEW
        .addToolInventory(tools)                        // existing
        .addSection(generateRecursiveToolGuide())      // NEW
        .addSection(generateRecursiveDecompositionMethodology()) // NEW
        .addSelfReflection()                            // existing (adjusted)
        .addPROutputFormat();                           // existing
}

// For recursive agents (depth 1+)
// Generated by SubagentPromptGenerator with depth awareness
function generateRecursiveAgentPrompt(
    task: SubagentTask,
    tools: ITool[],
    maxIterations: number,
    canRecurse: boolean
): string { ... }
```

### 7.4 User Prompt Changes

The user prompt (diff injection) stays the same format. The key change is in the `<analysis_task>` section:

```markdown
<analysis_task>
Review the ${fileCount} file(s) above.

**Recursive Review Mode**: Decompose this PR into logical concern groups and spawn
focused sub-agents for each. Include relevant diff hunks in each sub-agent's context.

**Workflow**:

1. Scan the diff structure and classify changes
2. Call `update_plan` with your decomposition plan
3. Spawn `run_subagent_batch` for each concern group (include diff context!)
4. After all agents return, aggregate findings
5. Check for cross-concern issues
6. Call `think_about_completion`, then `submit_review`
   </analysis_task>
```

---

## 8. Implementation Phases

### Phase 1: RecursiveStateManager (Foundation)

**New file**: `src/sessions/recursiveStateManager.ts`

Create the state tracking service:

- Tree data structure for agent hierarchy
- Depth tracking and limit enforcement
- Budget allocation logic
- Agent lifecycle management (register, start, complete, fail)
- File coverage tracking via `get_file_diff` calls only (contextual reads via `read_file` do not count)
- Coverage gap detection: `getCoverageGapMessage()` compares covered files against full diff list
- Findings aggregation

**Test file**: `src/__tests__/recursiveStateManager.test.ts`

### Phase 2: ExecutionContext Extension

**Modify**: `src/types/executionContext.ts`

Add new optional fields:

- `recursiveState?: RecursiveStateManager`
- `currentDepth?: number`
- `currentAgentId?: string`

**Modify**: `src/__tests__/testUtils/mockFactories.ts`

Update `createMockExecutionContext()` to support new fields.

### Phase 3: SubagentExecutor Enhancement

**Modify**: `src/services/subagentExecutor.ts`

Changes:

- Accept `recursionDepth` parameter in `execute()`
- Conditionally filter tools based on depth vs. maxDepth
- When `depth < maxDepth`: Include `run_subagent_batch` in available tools + provide `subagentExecutor` and `subagentSessionManager` in child's ExecutionContext
- When `depth >= maxDepth`: Exclude `run_subagent_batch` (current behavior)
- Pass `recursiveState`, `currentDepth`, `currentAgentId` via ExecutionContext
- Use depth-aware prompt generation

Key logic:

```typescript
async execute(task, token, subagentId, options?: { recursionDepth?: number }): Promise<SubagentResult> {
    const depth = options?.recursionDepth ?? 0;
    const maxDepth = this.workspaceSettings.getRecursionMaxDepth?.() ?? 0;
    const canRecurse = depth < maxDepth;

    // Determine disallowed tools based on recursion capability
    const disallowed = canRecurse
        ? MAIN_ANALYSIS_ONLY_TOOLS  // Allow run_subagent_batch, block main-only tools
        : SubagentLimits.DISALLOWED_TOOLS;  // Block everything including run_subagent_batch

    // Create depth-aware ExecutionContext
    const childContext: ExecutionContext = {
        cancellationToken: token,
        recursiveState: this.recursiveState,
        currentDepth: depth + 1,
        currentAgentId: agentNodeId,
        ...(canRecurse && {
            subagentExecutor: this,
            subagentSessionManager: this.sessionManager,
        }),
    };

    // Generate depth-appropriate prompt
    const systemPrompt = this.promptGenerator.generateRecursiveAgentPrompt(
        task, filteredTools, maxIterations, canRecurse
    );
}
```

### Phase 4: RunSubagentTool Enhancement

**Modify**: `src/tools/runSubagentTool.ts`

Changes:

- Read `currentDepth` from ExecutionContext (default 0)
- Pass `recursionDepth: currentDepth` to SubagentExecutor
- Register agent node in RecursiveStateManager (if available)
- Enhanced result formatting based on depth

### Phase 5: Prompt Architecture

**New files**:

- `src/prompts/blocks/recursiveRootRole.ts` — Root auditor role definition
- `src/prompts/blocks/recursiveMethodology.ts` — Decomposition + aggregation methodology
- `src/prompts/blocks/recursiveToolGuide.ts` — Tool guidance for recursive controller

**Modify**:

- `src/prompts/promptBuilder.ts` — Add `createRecursiveRootPromptBuilder()` factory
- `src/prompts/subagentPromptGenerator.ts` — Add depth-aware prompt generation with `canRecurse` flag
- `src/models/promptGenerator.ts` — Add recursive-mode user prompt variant

### Phase 6: ToolCallingAnalysisProvider Integration

**Modify**: `src/services/toolCallingAnalysisProvider.ts`

Changes in `analyze()`:

- Create `RecursiveStateManager` with configured limits
- Pass `recursiveState`, `currentDepth: 0`, `currentAgentId: "root"` in ExecutionContext
- Select prompt builder based on recursive mode setting
- Store recursiveState for potential post-analysis reporting

### Phase 7: Settings & Constants

**Modify**: `src/models/toolConstants.ts`

- Add `RecursionConstants` with defaults
- Add `MAIN_ANALYSIS_ONLY_TOOLS` constant (extracted from current DISALLOWED_TOOLS logic)

**Modify**: `src/services/workspaceSettingsService.ts`

- Add settings: `maxRecursionDepth`, `maxSubagentsPerSession`
- Add getters with defaults
- Add to `resetSettingsToDefaults()`

**Modify**: `src/config/settingsSchema.ts` (or equivalent)

- Add schema entries for new settings

### Phase 8: Testing

- Unit tests for RecursiveStateManager
- Tests for depth-aware SubagentExecutor
- Tests for RunSubagentTool with depth tracking
- Tests for prompt generation at each depth
- Integration test for recursive flow (mocked LLM)

---

## 9. File Change Inventory

### New Files

| File                                              | Purpose                                                       |
| ------------------------------------------------- | ------------------------------------------------------------- |
| `src/sessions/recursiveStateManager.ts`           | Recursion tree tracker, budget allocator, findings aggregator |
| `src/prompts/blocks/recursiveRootRole.ts`         | Root auditor role and decomposition instructions              |
| `src/prompts/blocks/recursiveMethodology.ts`      | Decomposition → delegation → aggregation workflow             |
| `src/prompts/blocks/recursiveToolGuide.ts`        | Tool selection guide for recursive controller                 |
| `src/__tests__/recursiveStateManager.test.ts`     | RecursiveStateManager unit tests                              |
| `src/__tests__/recursiveSubagentExecutor.test.ts` | Depth-aware subagent executor tests                           |

### Modified Files

| File                                          | Changes                                                                     |
| --------------------------------------------- | --------------------------------------------------------------------------- |
| `src/types/executionContext.ts`               | Add `recursiveState`, `currentDepth`, `currentAgentId` fields               |
| `src/services/subagentExecutor.ts`            | Add `recursionDepth` param, conditional tool filtering, depth-aware context |
| `src/tools/runSubagentTool.ts`                | Read depth from context, pass to executor, register in state tree           |
| `src/prompts/promptBuilder.ts`                | Add `createRecursiveRootPromptBuilder()` factory function                   |
| `src/prompts/subagentPromptGenerator.ts`      | Add `canRecurse` parameter, generate depth-aware prompts                    |
| `src/models/promptGenerator.ts`               | Add recursive-mode user prompt + system prompt selection                    |
| `src/services/toolCallingAnalysisProvider.ts` | Create RecursiveStateManager, pass to context, select prompt mode           |
| `src/models/toolConstants.ts`                 | Add recursion constants, extract MAIN_ANALYSIS_ONLY_TOOLS                   |
| `src/services/workspaceSettingsService.ts`    | Add recursion settings with getters/defaults                                |
| `src/__tests__/testUtils/mockFactories.ts`    | Update `createMockExecutionContext()`                                       |

### Unchanged Files (Architecture Preserved)

| File                                  | Why Unchanged                                                |
| ------------------------------------- | ------------------------------------------------------------ |
| `src/tools/baseTool.ts`               | Interface is already flexible enough                         |
| `src/models/conversationRunner.ts`    | Loop is tool-agnostic, works for all depths                  |
| `src/models/conversationManager.ts`   | Each agent already gets fresh instance                       |
| `src/models/toolExecutor.ts`          | Execution mechanics are depth-agnostic                       |
| `src/tools/*.ts` (all existing tools) | Individual tools don't need recursion awareness              |
| `src/services/serviceManager.ts`      | Per-analysis creation happens in ToolCallingAnalysisProvider |
| `src/webview/*`                       | UI receives final result regardless of internal architecture |

---

## 10. GPT-4.1 Optimization Strategy

### 10.1 Why RLM Benefits GPT-4.1 Specifically

GPT-4.1 characteristics relevant to this transition:

| GPT-4.1 Property                 | Impact on RLM Design                                              |
| -------------------------------- | ----------------------------------------------------------------- |
| **Good at tool-calling**         | Natural fit for tool-based "REPL" equivalent                      |
| **Moderate context window**      | Benefits most from distributed context approach                   |
| **No internal CoT**              | Needs explicit methodology in prompts (our self-reflection tools) |
| **Good instruction following**   | Will follow decomposition/delegation prompts reliably             |
| **Weaker on very long contexts** | RLM prevents context rot by keeping each agent focused            |
| **Cost-effective**               | Multiple small calls ≈ one large call in cost, but better quality |

### 10.2 Token Distribution Model

**Current (Linear)**:

```
Root Agent: [2K system] + [15K diff] + [20K tool_results] + [5K reflection] = 42K tokens
                                         ^^^^^^^^^^^^^^^^
                                         This is where context rot happens
```

**RLM (Recursive)**:

```
Root Agent:   [3K system] + [15K diff] + [5K tool_calls] + [3K summaries] = 26K tokens
Sub-Agent 1:  [2K system] + [2K context] + [8K tool_results] = 12K tokens
Sub-Agent 2:  [2K system] + [2K context] + [8K tool_results] = 12K tokens
Sub-Agent 3:  [2K system] + [2K context] + [8K tool_results] = 12K tokens

Total: ~62K tokens (distributed across 4 agents, each <26K)
```

Each agent operates in GPT-4.1's **optimal performance range** (10-25K tokens).

### 10.3 Prompt Optimization for GPT-4.1

Key principles applied in all prompts:

1. **XML tags for structure** — GPT-4.1 parses XML-tagged sections reliably
2. **Tables for rules** — "When to spawn" tables are more reliable than prose
3. **Examples over descriptions** — Show the task format, don't just describe it
4. **Explicit workflow steps** — Numbered steps prevent LLM from skipping
5. **Required sections** — "MUST include" headers in response format
6. **Severity emojis** — Visual markers aid both LLM parsing and human reading

---

## 11. Risk Assessment & Mitigations

| Risk                                            | Likelihood | Impact   | Mitigation                                                                                        |
| ----------------------------------------------- | ---------- | -------- | ------------------------------------------------------------------------------------------------- |
| GPT-4.1 ignores decomposition, reviews directly | Medium     | High     | Strong prompt guidance; root agent continues with direct investigation if no decomposition occurs |
| Too many API calls (slow analysis)              | Medium     | Medium   | Budget allocation limits total calls; configurable maxSubagentsPerSession                         |
| Sub-agents return unstructured results          | Medium     | Low      | Structured format is prompted; parent can still use free-text                                     |
| Recursive loop (infinite spawning)              | Low        | Critical | Hard depth limit + total agent cap + budget exhaustion                                            |
| Cross-concern issues missed                     | Medium     | Medium   | Root agent does cross-concern analysis after aggregation                                          |
| Increased complexity for contributors           | Medium     | Medium   | Feature flag, clear documentation, encapsulated in 2-3 files                                      |
| Budget allocation too aggressive                | Medium     | Medium   | Conservative defaults (flat DEFAULT_CHILD_BUDGET=50 per child, bounded by maxSubagentsPerSession) |
| Subagent fails → partial review                 | Low        | Low      | Other agents compensate; root reports partial coverage                                            |

### Fallback Mechanism

The root agent naturally falls back to direct investigation if decomposition isn't appropriate — no explicit iteration-counting mechanism is needed. The prompt instructs the root agent to decompose when beneficial, and for simple PRs it simply proceeds with direct analysis. Budget limits and session caps ensure resources are bounded regardless of approach.

### Coverage Gap Enforcement

The system programmatically verifies that every changed file has been reviewed via `get_file_diff` — the tool that shows actual PR changes. Other tools (`read_file`, `find_symbol`, etc.) read current file state for context but do not constitute reviewing a file's diff.

**Mechanism**: An `afterToolCalls` callback on `ConversationRunnerConfig` fires after each tool execution iteration. When `run_subagent_batch` calls complete, `RecursiveStateManager.getCoverageGapMessage()` compares covered files (aggregated from ALL completed agents across all depths) against the full changed-file list. If gaps exist, a message listing uncovered files is injected into the conversation, instructing the root to spawn additional subagents.

**Why root-level tracking is sufficient**: The root's coverage view is global — it aggregates `get_file_diff` calls from every agent in the tree (depth 0, 1, 2...). If a depth-2 sub-sub-agent skips a file, the root catches the gap after the batch completes. The root can then re-assign uncovered files to new subagents, regardless of which branch originally "owned" them.

**What "covered" means**: Only files accessed via `get_file_diff` count as covered. If a sub-sub-agent calls `read_file('docs/architecture.md')` to understand context for its own subtask, that documentation file is NOT marked as covered — nobody reviewed its changed lines. This prevents false coverage signals from contextual reads.

---

## 12. Testing Strategy

### 12.1 Unit Tests

**RecursiveStateManager** (`recursiveStateManager.test.ts`):

- Tree construction: register agents at various depths
- Depth limits: reject spawns beyond maxDepth
- Session spawn limits: reject spawns beyond maxSubagentsPerSession
- Budget allocation: correct splitting at each depth
- Minimum budget enforcement: reject spawns with < MIN_VIABLE_BUDGET (3) iterations
- Findings aggregation: collect findings across all agents
- File coverage tracking: only `get_file_diff` calls count as reviewed
- Coverage gap detection: `getCoverageGapMessage` reports uncovered files
- Agent lifecycle: pending → running → completed/failed transitions

**SubagentExecutor depth awareness** (`recursiveSubagentExecutor.test.ts`):

- Depth 0 child includes `run_subagent_batch` in tools
- Depth maxDepth child excludes `run_subagent_batch`
- ExecutionContext properly populated at each depth
- Budget passed correctly to ConversationRunner

**RunSubagentTool** (extend existing tests):

- Reads depth from ExecutionContext
- Passes depth to SubagentExecutor
- Registers in RecursiveStateManager when available

**Prompt generation** (extend existing tests):

- Recursive root prompt contains decomposition methodology
- Recursive agent prompt is depth-aware
- `canRecurse=true` includes sub-agent guidance
- `canRecurse=false` excludes sub-agent guidance

### 12.2 Integration Tests

**Recursive flow** (mocked LLM):

- Root agent spawns 2 sub-agents → sub-agents complete → root aggregates
- Sub-agent at depth 1 spawns depth 2 agent → completes → results propagate
- Cancellation at root propagates to all children
- Budget exhaustion prevents over-spawning
- Fallback to linear mode when decomposition doesn't happen

### 12.3 Manual Testing Scenarios

1. **Small PR (1-3 files)**: Root should review directly without spawning
2. **Medium PR (5-10 files)**: Root decomposes into 2-3 sub-agents
3. **Large PR (20+ files)**: Root decomposes into 4-5 sub-agents, some may recurse
4. **Security-focused PR**: Dedicated security sub-agent spawned
5. **Multi-concern PR**: Multiple concern groups with cross-concern analysis

---

## 13. Configuration & Settings

### New Settings in `lupa.json`

```json
{
    "maxRecursionDepth": 2
}
```

> Note: `maxSubagentsPerSession` (200) and `maxIterations` (100) are now hardcoded constants in `ANALYSIS_LIMITS`, not user-configurable settings.

### Setting Definitions

| Setting             | Type   | Default | Range | Description                                         |
| ------------------- | ------ | ------- | ----- | --------------------------------------------------- |
| `maxRecursionDepth` | number | 2       | 0-3   | Maximum recursive depth (0 = flat/current behavior) |

### Behavior When `maxRecursionDepth = 0`

Identical to current linear behavior. SubagentExecutor uses existing DISALLOWED_TOOLS (no `run_subagent_batch` for children). Backward compatible.

### Constants (Non-Configurable)

> **Note**: The original plan used a ratio-based budget model (ROOT_BUDGET_RATIO, CHILD_BUDGET_RATIO).
> During implementation this was replaced with flat per-child allocation to avoid exponential budget depletion after 3+ spawns.

```typescript
const RecursionConstants = {
    MIN_VIABLE_BUDGET: 3, // Min iterations to justify spawning a new agent
    DEFAULT_CHILD_BUDGET: 50, // Each child gets a flat 50-iteration budget (independent of parent)
    TIMEOUT_PER_ITERATION_MS: 30_000, // ~30s per iteration for subagent timeout calculation
    MIN_SUBAGENT_TIMEOUT_MS: 120_000, // 2-minute minimum timeout floor
};
```

---

## 14. Migration & Rollback

### Forward Migration

1. Deploy with `maxRecursionDepth: 2` (default ON)
2. All new analyses use recursive architecture
3. Old SubagentSessionManager still works internally (RecursiveStateManager wraps it)
4. No breaking schema changes — new settings (`maxRecursionDepth`, `maxSubagentsPerSession`) have backward-compatible defaults. Existing configurations work unchanged

### Rollback

1. Set `maxRecursionDepth: 0` in settings
2. System behaves identically to pre-RLM architecture
3. No code removal needed — depth=0 path is the old path

### Compatibility

- Setting `maxRecursionDepth: 0` → identical to current behavior
- Setting `maxRecursionDepth: 1` → current flat subagent behavior (no change)
- Setting `maxRecursionDepth: 2+` → new recursive behavior

---

## Appendix A: RLM Paper Key Quotes

> "We propose Recursive Language Models (RLMs), a general inference paradigm that treats long prompts as part of an external environment and allows the LLM to programmatically examine, decompose, and recursively call itself over snippets of the prompt."

> "RLMs can successfully process inputs up to two orders of magnitude beyond model context windows and, even for shorter prompts, dramatically outperform the quality of vanilla frontier LLMs."

> "It's not the sub-agent having access to a grepper that matters; it's that the sub-agent is called from and communicates inside of the REPL." — Alex Zhang, co-author

> "The model doesn't just passively receive information—it actively queries, decomposes, and delegates processing tasks."

## Appendix B: Reference Implementation

- Paper: https://arxiv.org/abs/2512.24601
- Official codebase: https://github.com/alexzhang13/rlm
- Minimal implementation: https://github.com/alexzhang13/rlm-minimal
- Author blog: https://alexzhang13.github.io/blog/2025/rlm/

## Appendix C: Sequence Diagram — Full Recursive Review

```
┌─────────┐    ┌──────────────┐    ┌───────────────┐    ┌──────────────┐
│  User    │    │Root Auditor  │    │ Sub-Agent #1  │    │Sub-Agent #1.1│
│          │    │ (Depth 0)    │    │ (Depth 1)     │    │ (Depth 2)    │
└────┬─────┘    └──────┬───────┘    └──────┬────────┘    └──────┬───────┘
     │                 │                    │                     │
     │ Analyze PR      │                    │                     │
     │────────────────>│                    │                     │
     │                 │                    │                     │
     │                 │── update_plan ──>  │                     │
     │                 │<─ plan created ──  │                     │
     │                 │                    │                     │
     │                 │── run_subagent_batch > │                  │
     │                 │  (auth concern)    │                     │
     │                 │                    │── find_symbol ──>   │
     │                 │                    │<─ function body ──  │
     │                 │                    │                     │
     │                 │                    │── run_subagent_batch > │
     │                 │                    │  (trace dep chain)  │
     │                 │                    │                     │── find_usages
     │                 │                    │                     │<─ usages
     │                 │                    │                     │── read_file
     │                 │                    │                     │<─ content
     │                 │                    │                     │
     │                 │                    │<─ structured ─────  │
     │                 │                    │   findings          │
     │                 │                    │                     │
     │                 │<─ structured ────  │                     │
     │                 │   findings         │                     │
     │                 │                    │                     │
     │                 │── run_subagent_batch > │2                 │
     │                 │  (logic concern)   │                     │
     │                 │<─ findings ──────  │                     │
     │                 │                    │                     │
     │                 │── think_completion │                     │
     │                 │── submit_review    │                     │
     │                 │                    │                     │
     │<── Final Review │                    │                     │
     │                 │                    │                     │
```
