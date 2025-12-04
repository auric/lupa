# Subagent Tool Implementation Plan for Lupa

## Overview

This document outlines the design and implementation plan for adding a **subagent tool** to the Lupa VS Code extension, similar to Claude Code's Task tool and GitHub Copilot's runSubagent feature. The subagent tool enables the LLM to spawn isolated agent instances for focused investigation tasks during PR analysis.

## Research Summary

### Claude Code Task Tool
- Spawns lightweight agent instances with isolated context windows
- Supports up to 10 concurrent tasks with intelligent queuing
- Subagents have access to the same tools as the parent (except spawning other subagents)
- Only the final result is returned to the main conversation context
- Uses subagent-specific prompts stored in `.claude/agents/` directory

### GitHub Copilot runSubagent
- Context-isolated sub-agents for delegating focused tasks
- Each subagent knows nothing about the main chat context
- Returns only the final result to the main conversation
- Currently runs sequentially (parallel execution is a feature request)
- Uses the same model and tools as the main chat session

### Key Benefits
1. **Context Management**: Keeps main conversation lean while enabling deep dives
2. **Token Optimization**: Subagent context is discarded after task completion
3. **Focused Tasks**: Subagents can be specialized for specific investigation types
4. **Parallel Processing**: Multiple investigations can run concurrently

## Design Philosophy: Trust the LLM

### Why No Rigid Categories?

Early designs included a `SubagentFocusArea` enum (Security, Performance, Impact, etc.), but this was rejected because:

1. **The parent LLM knows what it needs** - It identified the complex investigation; let it describe the task naturally
2. **Artificial constraints limit flexibility** - "Find deprecated API usages and suggest migrations" doesn't fit predefined boxes
3. **Categories don't improve results** - A "security" label doesn't make investigation better; a well-written task does
4. **Matches Claude Code's approach** - Task tool just takes a prompt, guidance is in the system prompt

### Handling Smaller/Weaker LLMs

Instead of rigid parameters, we use:
1. **Few-shot examples** in system prompt showing good vs bad task descriptions
2. **Minimum length validation** with helpful error messages
3. **Smart subagent system prompt** that can handle vague tasks by asking clarifying "questions" through tool usage

## Architecture Design

### 1. Subagent Tool Interface (Simplified)

```typescript
// src/types/subagentTypes.ts
interface SubagentTaskDefinition {
  task: string;           // Detailed investigation task (the only required field)
  context?: string;       // Relevant context from parent analysis
  maxToolCalls?: number;  // Limit subagent tool calls (default: 8)
}

interface SubagentResult {
  success: boolean;
  findings: string;       // Detailed findings with evidence
  summary: string;        // 2-3 sentence executive summary
  answer?: string;        // Direct answer if applicable
  toolCallsMade: number;
  error?: string;
}
```

**No SubagentFocusArea** - The LLM describes what it needs in natural language.

### 2. SubagentExecutor Service

New service that manages subagent lifecycle:

```typescript
// src/services/subagentExecutor.ts
class SubagentExecutor {
  constructor(
    private copilotModelManager: CopilotModelManager,
    private toolRegistry: ToolRegistry
  ) {}

  async executeSubagent(
    task: SubagentTaskDefinition,
    token: vscode.CancellationToken
  ): Promise<SubagentResult>
}
```

### 3. Subagent System Prompt Structure

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

### 4. Tool Schema (Simplified)

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

### Phase 1: Core Subagent Infrastructure

1. **Create Subagent Types** (`src/types/subagentTypes.ts`)
   - `SubagentTaskDefinition`: task, context, maxToolCalls
   - `SubagentResult`: success, findings, summary, answer, toolCallsMade, error

2. **Create SubagentConstants** (`src/models/subagentConstants.ts`)
   - Execution limits (max subagents, max tool calls, timeouts)
   - Disallowed tools list (`['run_subagent']`)
   - Error message templates

3. **Create SubagentPromptGenerator** (`src/prompts/subagentPromptGenerator.ts`)
   - Generate intelligent system prompt from task definition
   - Inject context if provided
   - Dynamically list available tools (excluding run_subagent)
   - Define response format with XML tags

4. **Create SubagentExecutor service** (`src/services/subagentExecutor.ts`)
   - Create isolated ConversationManager per subagent
   - Filter tool registry to exclude run_subagent
   - Execute conversation loop with tool call handling
   - Parse response for `<findings>`, `<summary>`, `<answer>` tags
   - Return structured SubagentResult

### Phase 2: Subagent Tool Implementation

5. **Create RunSubagentTool** (`src/tools/runSubagentTool.ts`)
   - Extend BaseTool with simplified 3-parameter schema
   - **Validate task quality** - reject tasks < 30 chars with helpful guidance
   - Track subagent count per session
   - Execute via SubagentExecutor
   - Format results for parent LLM

6. **Update ServiceManager** (`src/services/serviceManager.ts`)
   - Add SubagentExecutor to IServiceRegistry
   - Create and register RunSubagentTool in initializeTools()

### Phase 3: System Prompt Engineering (Critical for Weak LLMs)

7. **Update ToolAwareSystemPromptGenerator** with:

   **Strategic guidance:**
   ```markdown
   ### run_subagent: Delegate Complex Investigations

   Spawn an isolated agent to investigate questions requiring multiple tool calls.
   The subagent works independently and returns focused findings.

   **When to use:**
   - Deep analysis spanning multiple files
   - Impact assessment of changes
   - Pattern discovery across codebase
   - Complex dependency tracing

   **When NOT to use (use direct tools instead):**
   - Simple symbol lookups → find_symbol
   - Reading single files → read_file
   - Quick pattern searches → search_for_pattern
   ```

   **Few-shot examples showing good vs bad task descriptions:**
   ```markdown
   ✅ GOOD task (specific, actionable):
   "Investigate security of JWT handling in src/auth/:
   1. How does validateToken() verify signatures?
   2. Is there timing-attack protection?
   3. How are expired tokens handled?
   Return: Security concerns with severity and line numbers."

   ✅ GOOD task (clear scope and deliverables):
   "Find all consumers of UserService.updateProfile(). For each:
   note file path, error handling approach, and input validation.
   Return: Impact assessment for changing the method signature."

   ❌ BAD: "Check the auth code" (too vague)
   ❌ BAD: "Look for bugs" (no direction)
   ❌ BAD: "Read the user service" (use read_file instead)
   ```

### Phase 4: Safety & Token Management

8. **Add safety limits:**
   - Maximum 5 subagents per analysis session
   - Prevent recursive subagent spawning (filter tool registry)
   - Timeout per subagent (60 seconds default)

9. **Task validation with helpful feedback:**
   ```typescript
   if (task.length < 30) {
     return `Task too brief for effective investigation.

     Good tasks include:
     - WHAT to investigate (specific question)
     - WHERE to look (files, directories, symbols)
     - WHAT to return (expected deliverables)

     Example: "Analyze error handling in src/api/handlers/.
     Check if endpoints have proper try-catch and return appropriate
     HTTP status codes. Return: List of handlers with weak error handling."`;
   }
   ```

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
├── tools/
│   └── runSubagentTool.ts          # New subagent tool
├── services/
│   └── subagentExecutor.ts         # New subagent execution service
├── prompts/
│   └── subagentPromptGenerator.ts  # New subagent prompt generator
├── types/
│   └── subagentTypes.ts            # New subagent types
└── models/
    └── subagentConstants.ts        # New subagent configuration constants
```

## Configuration Constants

```typescript
// src/models/subagentConstants.ts
export const SubagentConstants = {
  // Execution limits
  MAX_SUBAGENTS_PER_SESSION: 5,
  MAX_TOOL_CALLS_PER_SUBAGENT: 15,
  DEFAULT_TOOL_CALLS: 8,
  MIN_TASK_LENGTH: 30,  // Minimum characters for task description

  // Token management
  MAX_SUBAGENT_CONTEXT_CHARS: 32000,
  RESERVED_CHARS_FOR_RESULT: 4000,

  // Tool access - prevent recursive spawning
  DISALLOWED_TOOLS: ['run_subagent'],

  // Timeouts
  SUBAGENT_TIMEOUT_MS: 60000, // 1 minute per subagent

  // Error messages with helpful guidance
  ERROR_MESSAGES: {
    MAX_SUBAGENTS_EXCEEDED: (max: number) =>
      `Maximum subagents (${max}) reached for this session. ` +
      `Use direct tools (find_symbol, read_file, search_for_pattern) for remaining investigations.`,

    TASK_TOO_BRIEF: (minLength: number) =>
      `Task description too brief (minimum ${minLength} characters).\n\n` +
      `Good tasks include:\n` +
      `- WHAT to investigate (specific question)\n` +
      `- WHERE to look (files, directories, symbols)\n` +
      `- WHAT to return (expected deliverables)\n\n` +
      `Example: "Investigate error handling in src/api/handlers/. ` +
      `Check if endpoints have try-catch blocks and return appropriate HTTP status codes. ` +
      `Return: List of handlers with weak error handling and suggested fixes."`,

    SUBAGENT_TIMEOUT: (timeoutMs: number) =>
      `Subagent timed out after ${timeoutMs / 1000} seconds. ` +
      `Consider breaking the task into smaller, more focused investigations.`,

    SUBAGENT_FAILED: (error: string) =>
      `Subagent investigation failed: ${error}`,
  }
};
```

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
