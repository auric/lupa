# Subagent Tool Implementation Plan for Lupa

## Overview

This document outlines the design and implementation plan for adding a **subagent tool** to the Lupa VS Code extension, similar to Claude Code's Task tool and GitHub Copilot's runSubagent feature. The subagent tool enables the LLM to spawn isolated agent instances for focused investigation tasks during PR analysis.

## Code Quality Standards

**This implementation MUST produce high-quality TypeScript code:**

- **SOLID Principles**: Single responsibility, dependency inversion, interface segregation
- **DRY**: Extract shared logic, no duplication between main analysis and subagent
- **Meaningful Comments Only**: Explain WHY, never WHAT. No `// Get user` before `getUser()`
- **Clear Naming**: Names reveal intent, no abbreviations except common ones (e.g., `ctx`)
- **Small Functions**: Each function does one thing, typically under 20 lines
- **Type Safety**: Leverage TypeScript's type system, avoid `any`
- **Consistent Patterns**: Follow existing codebase conventions

## Research Summary

### Claude Code Task Tool
- Spawns lightweight agent instances with isolated context windows
- Supports up to 10 concurrent tasks with intelligent queuing
- Subagents have access to the same tools as the parent (except spawning other subagents)
- Only the final result is returned to the main conversation context

### GitHub Copilot runSubagent
- Context-isolated sub-agents for delegating focused tasks
- Each subagent knows nothing about the main chat context
- Returns only the final result to the main conversation
- Uses the same model and tools as the main chat session

### Key Benefits
1. **Context Management**: Keeps main conversation lean while enabling deep dives
2. **Token Optimization**: Subagent context is discarded after task completion
3. **Focused Tasks**: Each subagent has a single, clear objective
4. **Parallel Processing**: Multiple investigations can run concurrently (future)

## Design Philosophy

### Trust the LLM

Early designs included a `SubagentFocusArea` enum (Security, Performance, Impact, etc.), but this was rejected because:

1. **The parent LLM knows what it needs** - Let it describe the task naturally
2. **Artificial constraints limit flexibility** - Real tasks don't fit predefined boxes
3. **Categories don't improve results** - A well-written task beats any label
4. **Matches Claude Code** - Task tool just takes a prompt; guidance is in the system prompt

### SOLID Architecture

The implementation must follow SOLID principles:

1. **Single Responsibility**: ConversationRunner handles loops, SubagentExecutor handles isolation
2. **Open/Closed**: New features via composition, not modification of core loop
3. **Liskov Substitution**: Subagent uses same IConversationRunner interface as main analysis
4. **Interface Segregation**: Tools receive only the interfaces they need
5. **Dependency Inversion**: Depend on abstractions (IConversationRunner), not concretions

### DRY: Extract the Conversation Loop

**Critical insight**: ToolCallingAnalysisProvider and SubagentExecutor share 80% of their logic:
- Send messages to LLM
- Handle tool calls
- Manage iterations
- Validate tokens

**Solution**: Extract a reusable `ConversationRunner` class that both can use.

```
┌─────────────────────────────────────────────────────────────────┐
│                    ToolCallingAnalysisProvider                   │
│  (orchestrates PR analysis - thin wrapper)                       │
│  - Processes diff, generates prompts                             │
│  - Delegates to ConversationRunner                               │
└──────────────────────────┬──────────────────────────────────────┘
                           │ uses
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                     ConversationRunner                           │
│  (EXTRACTED - the reusable conversation loop)                    │
│  - Runs tool-calling loop with configurable limits               │
│  - Handles tool execution via injected executor                  │
│  - Manages token validation and cleanup                          │
└──────────────────────────┬──────────────────────────────────────┘
                           │ also used by
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                     SubagentExecutor                             │
│  (thin wrapper - provides isolation)                             │
│  - Creates isolated ConversationManager                          │
│  - Provides filtered ToolExecutor (no run_subagent)              │
│  - Parses subagent response format                               │
└─────────────────────────────────────────────────────────────────┘
```

This eliminates code duplication and makes testing easier.

## Architecture Design

### 1. Types (Add to existing modelTypes.ts - no new file needed)

```typescript
// Add to src/types/modelTypes.ts - keeps related types together

/** Task definition for spawning an isolated subagent */
interface SubagentTask {
  task: string;
  context?: string;
  maxToolCalls?: number;
}

/** Result from a completed subagent investigation */
interface SubagentResult {
  success: boolean;
  findings: string;
  summary: string;
  answer?: string;
  toolCallsMade: number;
  error?: string;
}

/** Configuration for running a conversation loop */
interface ConversationRunnerConfig {
  systemPrompt: string;
  maxIterations: number;
  tools: ITool[];
  onComplete?: (response: string) => void;
}
```

**No separate types file** - Add to existing modelTypes.ts to keep related types together.

### 2. ConversationRunner (EXTRACTED from ToolCallingAnalysisProvider)

The key DRY refactoring: extract the conversation loop into a reusable class.

```typescript
// src/models/conversationRunner.ts

/**
 * Runs a tool-calling conversation loop.
 * Extracted to enable reuse by both main analysis and subagents.
 */
class ConversationRunner {
  constructor(
    private modelManager: CopilotModelManager,
    private toolExecutor: ToolExecutor
  ) {}

  /**
   * Execute a conversation loop until completion or max iterations.
   * Returns the final response content.
   */
  async run(
    config: ConversationRunnerConfig,
    conversation: ConversationManager,
    token: CancellationToken
  ): Promise<string>
}
```

**This is the core abstraction** - both ToolCallingAnalysisProvider and SubagentExecutor use it.

### 3. SubagentExecutor (Thin Wrapper)

Now SubagentExecutor becomes a thin wrapper that provides isolation:

```typescript
// src/services/subagentExecutor.ts

/**
 * Executes subagent investigations with isolated context.
 * Delegates to ConversationRunner - no loop duplication.
 */
class SubagentExecutor {
  constructor(
    private conversationRunner: ConversationRunner,
    private toolRegistry: ToolRegistry,
    private promptGenerator: SubagentPromptGenerator
  ) {}

  async execute(
    task: SubagentTask,
    token: CancellationToken
  ): Promise<SubagentResult> {
    // 1. Create isolated conversation (fresh ConversationManager)
    // 2. Filter tools (exclude run_subagent)
    // 3. Generate subagent prompt
    // 4. Delegate to conversationRunner.run()
    // 5. Parse response for <findings>, <summary>, <answer>
  }
}
```

**Single responsibility**: Isolation and response parsing. Loop logic is in ConversationRunner.

### 4. Subagent System Prompt Structure

Each subagent receives a focused, intelligent system prompt:

```markdown
You are a focused investigation subagent. Your job is to thoroughly investigate a specific question and return actionable findings.

## Your Task
[TASK_DESCRIPTION]

## Context from Parent Analysis
[CONTEXT_IF_PROVIDED - or "No additional context provided"]

## Available Tools
[DYNAMIC_TOOL_LIST - excludes run_subagent]

## Instructions

1. **Parse the Task**: Identify what needs to be investigated and what deliverables are expected

2. **Investigate Systematically**:
   - Start broad: Use get_symbols_overview or list_directory to orient yourself
   - Go deep: Use find_symbol and read_file to understand specific code
   - Trace impact: Use find_usages for ripple effects
   - Find patterns: Use search_for_pattern for codebase-wide issues

3. **Be Proactive**: If the task is unclear, use tools to gather context that helps clarify it

4. **Return Structured Results**:

<findings>
Detailed findings with evidence:
- Include file paths and line numbers
- Quote relevant code snippets
- Explain implications
</findings>

<summary>
2-3 sentence executive summary of the most important discoveries.
</summary>

<answer>
If the task posed a specific question, provide a direct answer here.
</answer>
```

### 5. Tool Schema (Simplified)

```typescript
// src/tools/runSubagentTool.ts
const schema = z.object({
  task: z.string()
    .min(30, 'Task too brief. Include: what to investigate, where to look, what to return.')
    .describe(
      'Detailed investigation task. A good task includes: ' +
      '1) What to investigate (specific question or concern), ' +
      '2) Where to look (relevant files, directories, symbols), ' +
      '3) What to return (expected deliverables).'
    ),
  context: z.string().optional().describe(
    'Relevant context from your current analysis: code snippets, file paths, ' +
    'findings so far, or symbol names that are relevant to this investigation.'
  ),
  max_tool_calls: z.number().min(1).max(15).default(8).optional().describe(
    'Maximum tool calls the subagent can make (default: 8). ' +
    'Increase for complex investigations, decrease for focused lookups.'
  )
});
```

**Three parameters only** - task (required), context (optional), max_tool_calls (optional with default).

## Implementation Steps

### Phase 0: DRY Refactoring (CRITICAL - Do First)

**Before adding subagents, extract the reusable conversation loop:**

1. **Extract ConversationRunner from ToolCallingAnalysisProvider**

   Create `src/models/conversationRunner.ts`:
   - Move the `conversationLoop()` method logic into this new class
   - Make it configurable via `ConversationRunnerConfig`
   - Accept ConversationManager as parameter (not internal state)
   - ToolCallingAnalysisProvider becomes a thin wrapper that uses ConversationRunner

   **Why first?** This refactoring is independent of subagents and follows the "make the change easy, then make the easy change" principle.

2. **Update ToolCallingAnalysisProvider to use ConversationRunner**
   - Replace internal loop with `conversationRunner.run()`
   - Verify all existing tests still pass
   - No behavior change, just extraction

### Phase 1: Core Subagent Infrastructure

3. **Add types to existing modelTypes.ts** (no new file)
   ```typescript
   export interface SubagentTask {
     task: string;
     context?: string;
     maxToolCalls?: number;
   }

   export interface SubagentResult {
     success: boolean;
     findings: string;
     summary: string;
     answer?: string;
     toolCallsMade: number;
     error?: string;
   }
   ```

4. **Add constants to existing toolConstants.ts** (no new file)
   ```typescript
   export const SubagentLimits = {
     MAX_PER_SESSION: 5,
     MAX_TOOL_CALLS: 15,
     DEFAULT_TOOL_CALLS: 8,
     MIN_TASK_LENGTH: 30,
     TIMEOUT_MS: 60000,
     DISALLOWED_TOOLS: ['run_subagent'] as const,
   };
   ```

5. **Create SubagentPromptGenerator** (`src/prompts/subagentPromptGenerator.ts`)
   - Single responsibility: Generate subagent system prompts
   - Takes task and available tools, returns prompt string
   - No business logic, just prompt construction

6. **Create SubagentExecutor** (`src/services/subagentExecutor.ts`)
   - Thin wrapper using ConversationRunner (DRY!)
   - Single responsibility: Provide isolation and parse results
   - Creates fresh ConversationManager per execution
   - Filters tool registry (removes run_subagent)
   - Parses `<findings>`, `<summary>`, `<answer>` from response

### Phase 2: Tool Implementation

7. **Create RunSubagentTool** (`src/tools/runSubagentTool.ts`)
   - Follows existing BaseTool pattern
   - Simple 3-parameter schema (task, context, max_tool_calls)
   - Delegates to SubagentExecutor
   - Session tracking via injected counter (not internal state)

8. **Create SubagentSessionManager** (`src/services/subagentSessionManager.ts`)
   - Tracks subagent count per analysis session
   - Injected into RunSubagentTool
   - Provides `canSpawn()` and `recordSpawn()` methods
   - Reset when new analysis starts

9. **Register in ServiceManager**
   - Add ConversationRunner, SubagentExecutor, SubagentSessionManager
   - Register RunSubagentTool

### Phase 3: System Prompt Updates

10. **Update ToolAwareSystemPromptGenerator**

    Add guidance that teaches by example:
    ```markdown
    ### run_subagent: Delegate Complex Investigations

    Spawn an isolated agent for investigations requiring multiple tool calls.

    **When to use:**
    - Deep analysis spanning multiple files
    - Impact assessment across codebase
    - Complex pattern discovery

    **When NOT to use:**
    - Simple lookups → find_symbol
    - Single file reads → read_file
    - Quick searches → search_for_pattern

    **Writing Effective Tasks:**
    Include: 1) WHAT to investigate, 2) WHERE to look, 3) WHAT to return

    ✅ "Investigate JWT handling in src/auth/. Check signature validation,
       timing-attack protection, expiry handling. Return: Security issues
       with severity and line numbers."

    ❌ "Check the auth code" (too vague)
    ```

### Phase 4: Testing

11. **Unit tests for new components:**
    - `conversationRunner.test.ts` - Loop behavior, iteration limits
    - `subagentExecutor.test.ts` - Isolation, tool filtering, response parsing
    - `runSubagentTool.test.ts` - Validation, session limits
    - `subagentSessionManager.test.ts` - Count tracking, reset

12. **Integration test:**
    - Full subagent execution with mocked LLM
    - Verify main analysis still works after ConversationRunner extraction

## System Prompt Updates

The key to making subagents work well (especially with smaller LLMs) is excellent system prompt engineering. The guidance teaches by example.

### Addition to Strategic Tool Usage

```markdown
### run_subagent: Delegate Complex Investigations

Spawn an isolated agent to thoroughly investigate a question. The subagent has its own
context, uses tools independently, and returns focused findings to you.

**When to use subagents:**
- Deep analysis spanning multiple files or components
- Impact assessment requiring extensive usage tracing
- Complex investigation that would clutter your main context
- When you need to "go deep" on a specific concern

**When NOT to use (use direct tools instead):**
- Simple symbol lookups → use find_symbol
- Reading a single file → use read_file
- Quick pattern search → use search_for_pattern
- Basic directory exploration → use list_directory

**Writing Effective Tasks:**

A good subagent task has three parts:
1. WHAT to investigate (the specific question or concern)
2. WHERE to look (relevant files, directories, or symbols)
3. WHAT to return (the deliverables you need)

**Examples:**

✅ GOOD - Specific question with clear deliverables:
run_subagent(
  task: "Investigate JWT token handling in src/auth/middleware.ts:
         1. How does validateToken() verify signatures?
         2. Is there timing-attack protection in comparisons?
         3. How are expired/invalid tokens handled?
         Return: Security concerns with severity ratings and line numbers.",
  context: "PR adds new auth middleware, concerned about token validation"
)

✅ GOOD - Impact assessment with scope:
run_subagent(
  task: "Find all callers of UserService.updateProfile() method.
         For each caller, note: file path, whether it handles errors,
         whether it validates input before calling.
         Return: Impact assessment for changing method signature.",
  context: "Considering adding required 'reason' parameter to updateProfile()"
)

❌ BAD - Too vague:
run_subagent(task: "Check the auth code")

❌ BAD - Should use direct tool:
run_subagent(task: "Read src/utils/helper.ts")
```

### Few-Shot Example for Subagent Usage

```xml
<example>
<scenario>Complex security analysis spanning multiple files</scenario>
<analysis_approach>
I see a new authentication middleware being added. This requires deep investigation
across multiple auth-related files - too many tool calls would clutter my context.

I'll spawn a subagent to investigate:

run_subagent(
  task: "Analyze security of the new authenticateRequest() middleware in
         src/middleware/auth.ts. Investigate:
         1) How it validates JWT tokens - check for timing attacks
         2) What user data it extracts and where it's stored
         3) How it handles invalid/expired tokens
         4) Integration with existing auth flows in src/auth/
         Return: Security concerns with severity (Critical/High/Medium/Low)
         and specific code locations.",
  context: "New middleware at line 45. PR description mentions 'faster auth'
            which makes me concerned they may have skipped security checks.",
  max_tool_calls: 12
)

While the subagent investigates auth deeply, I'll continue reviewing other
aspects of the PR. I'll incorporate its findings into my final analysis.
</analysis_approach>
</example>

<example>
<scenario>Assessing impact of API change</scenario>
<analysis_approach>
The PR changes the return type of fetchUserData(). I need to find all consumers
and assess whether they'll break.

run_subagent(
  task: "Find every place that calls fetchUserData() in the codebase.
         For each call site:
         - Note the file path and line number
         - Check how the return value is used
         - Determine if the new return type would break it
         Return: List of call sites that need updates, prioritized by
         complexity of required changes.",
  context: "fetchUserData() changing from Promise<User> to Promise<User | null>"
)
</analysis_approach>
</example>
```

## File Structure

```
src/
├── models/
│   ├── conversationRunner.ts       # NEW: Extracted reusable loop (DRY)
│   └── toolConstants.ts            # MODIFIED: Add SubagentLimits
├── services/
│   ├── subagentExecutor.ts         # NEW: Thin wrapper for isolation
│   ├── subagentSessionManager.ts   # NEW: Session tracking
│   └── toolCallingAnalysisProvider.ts  # MODIFIED: Uses ConversationRunner
├── prompts/
│   ├── subagentPromptGenerator.ts  # NEW: Subagent prompts
│   └── toolAwareSystemPromptGenerator.ts  # MODIFIED: Add run_subagent guidance
├── tools/
│   └── runSubagentTool.ts          # NEW: The tool itself
└── types/
    └── modelTypes.ts               # MODIFIED: Add SubagentTask, SubagentResult
```

**Only 4 new files** - types and constants go in existing files to reduce fragmentation.

## Configuration Constants

Add to existing `src/models/toolConstants.ts`:

```typescript
/** Limits for subagent execution - uses const assertion for type safety */
export const SubagentLimits = {
  MAX_PER_SESSION: 5,
  MAX_TOOL_CALLS: 15,
  DEFAULT_TOOL_CALLS: 8,
  MIN_TASK_LENGTH: 30,
  TIMEOUT_MS: 60_000,
  DISALLOWED_TOOLS: ['run_subagent'] as const,
} as const;

/** Error messages guide the LLM to improve its requests */
export const SubagentErrors = {
  maxExceeded: (max: number) =>
    `Maximum subagents (${max}) reached. Use direct tools for remaining investigations.`,

  taskTooShort: (min: number) =>
    `Task too brief (${min}+ chars needed). Include: WHAT to investigate, WHERE to look, WHAT to return.`,

  timeout: (ms: number) =>
    `Subagent timed out after ${ms / 1000}s. Break into smaller tasks.`,

  failed: (error: string) =>
    `Subagent failed: ${error}`,
} as const;
```

**Why existing file?**
- Keeps all tool-related constants together
- No fragmentation across tiny files
- Easier to find and modify

## Testing Strategy

1. **Unit Tests**
   - SubagentPromptGenerator: Verify prompt structure
   - SubagentExecutor: Test conversation loop, tool execution
   - RunSubagentTool: Schema validation, execution flow

2. **Integration Tests**
   - Full subagent execution with mock LLM responses
   - Tool access verification (ensure no recursive spawning)
   - Token budget enforcement

3. **E2E Tests**
   - Real LLM interaction with subagent
   - Multi-subagent scenarios
   - Error handling and timeouts

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Token explosion from multiple subagents | Hard limits on subagent count and token budget |
| Recursive subagent spawning | Disable run_subagent tool in subagent context |
| Slow analysis from sequential subagents | Consider parallel execution in future |
| Context loss in subagent | Pass relevant parent context in task definition |
| LLM confusion about when to use | Clear prompt guidance with examples |

## Success Criteria

1. Subagent tool is registered and callable by the LLM
2. Subagents execute with isolated context
3. Results are properly returned to main conversation
4. Token budget is respected
5. No recursive subagent spawning is possible
6. System prompt provides clear guidance on usage
7. All tests pass

## Future Enhancements

1. **Parallel Subagent Execution**: Run multiple subagents concurrently
2. **Specialized Subagent Types**: Pre-defined subagents for common tasks
3. **Subagent Memory**: Optional persistence of subagent findings
4. **Custom Subagent Definitions**: User-defined subagent configurations
5. **Subagent Collaboration**: Allow subagents to share findings
