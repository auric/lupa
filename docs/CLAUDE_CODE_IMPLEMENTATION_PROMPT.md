# Claude Code Implementation Prompt: Subagent Tool

Copy the prompt below to have Claude Code implement the subagent tool feature.

---

## Prompt

```
Implement a subagent tool for the Lupa VS Code extension that allows the main LLM to spawn isolated investigation agents during PR analysis. This is similar to Claude Code's Task tool and GitHub Copilot's runSubagent feature.

## Design Philosophy

**Trust the LLM to describe its own tasks.** We do NOT use rigid categories like "security" or "performance" - the LLM knows what it needs to investigate and should describe it in natural language. Guidance for smaller/weaker LLMs comes from the system prompt (with examples), not from restrictive parameters.

## Background

The codebase already has a robust tool-calling system on the `feature/tool-calls` branch with:
- ToolRegistry for registering tools
- ToolExecutor for executing tools with rate limiting
- ToolCallingAnalysisProvider for the main conversation loop
- ConversationManager for managing message history
- Multiple tools (find_symbol, find_usages, search_for_pattern, etc.)

Read the implementation plan at `docs/SUBAGENT_TOOL_IMPLEMENTATION_PLAN.md` for full context.

## Implementation Tasks

### Task 1: Create Subagent Types (`src/types/subagentTypes.ts`)

Create a new types file with a **simplified interface** - no enum for focus areas:

```typescript
/**
 * Task definition for spawning a subagent
 * Intentionally simple - the LLM describes tasks in natural language
 */
export interface SubagentTaskDefinition {
  task: string;            // Detailed investigation task (required)
  context?: string;        // Relevant context from parent analysis
  maxToolCalls?: number;   // Limit subagent tool calls (default: 8)
}

/**
 * Result returned by a subagent
 */
export interface SubagentResult {
  success: boolean;
  findings: string;        // Detailed findings with evidence
  summary: string;         // 2-3 sentence executive summary
  answer?: string;         // Direct answer if task posed a question
  toolCallsMade: number;
  error?: string;
}
```

### Task 2: Create Subagent Constants (`src/models/subagentConstants.ts`)

Create configuration constants with **helpful error messages** that guide the LLM:

```typescript
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
  SUBAGENT_TIMEOUT_MS: 60000,

  // Error messages that help the LLM improve
  ERROR_MESSAGES: {
    MAX_SUBAGENTS_EXCEEDED: (max: number) =>
      `Maximum subagents (${max}) reached. Use direct tools for remaining investigations.`,

    TASK_TOO_BRIEF: (minLength: number) =>
      `Task description too brief (minimum ${minLength} characters).\n\n` +
      `Good tasks include:\n` +
      `- WHAT to investigate (specific question)\n` +
      `- WHERE to look (files, directories, symbols)\n` +
      `- WHAT to return (expected deliverables)\n\n` +
      `Example: "Investigate error handling in src/api/handlers/. ` +
      `Check if endpoints have try-catch and return appropriate HTTP status codes. ` +
      `Return: List of handlers with weak error handling."`,

    SUBAGENT_TIMEOUT: (timeoutMs: number) =>
      `Subagent timed out after ${timeoutMs / 1000}s. Break into smaller tasks.`,

    SUBAGENT_FAILED: (error: string) => `Subagent failed: ${error}`,
  }
};
```

### Task 3: Create SubagentPromptGenerator (`src/prompts/subagentPromptGenerator.ts`)

Create a prompt generator that creates **intelligent, task-agnostic prompts**:

```typescript
export class SubagentPromptGenerator {
  /**
   * Generate system prompt for a subagent
   * The prompt is intelligent enough to handle any task type
   */
  generateSystemPrompt(
    task: SubagentTaskDefinition,
    availableTools: ITool[]
  ): string {
    // Build dynamic tool list (excluding run_subagent)
    // Include task and context
    // Define response format with <findings>, <summary>, <answer> tags
    // Give proactive tool usage guidance
  }
}
```

The subagent prompt should be smart enough to:
1. Parse the task to identify what's needed
2. Use tools proactively to investigate
3. Handle vague tasks by gathering clarifying context
4. Return structured results

### Task 4: Create SubagentExecutor Service (`src/services/subagentExecutor.ts`)

Create the core execution service:

1. Accept SubagentTaskDefinition and cancellation token
2. Create **isolated ConversationManager** instance (key for context isolation!)
3. Generate subagent-specific system prompt
4. **Filter tool registry** to exclude run_subagent (prevent recursion)
5. Execute conversation loop similar to ToolCallingAnalysisProvider:
   - Maximum tool calls from task definition
   - Handle tool calls within subagent
   - Track tool calls made count
6. **Parse response** for <findings>, <summary>, <answer> XML tags
7. Return SubagentResult with findings and metadata
8. Handle timeouts and errors gracefully

Key methods:
- `executeSubagent(task, token): Promise<SubagentResult>`
- `createFilteredToolRegistry(): ToolRegistry` (without run_subagent)
- `parseSubagentResponse(response): {findings, summary, answer}`

### Task 5: Create RunSubagentTool (`src/tools/runSubagentTool.ts`)

Implement with **simplified 3-parameter schema**:

```typescript
export class RunSubagentTool extends BaseTool {
  name = 'run_subagent';
  description = `Spawn an isolated agent to investigate a complex question.

Use when you need deep investigation that would require many tool calls
or would clutter your main context. The subagent works independently
and returns focused findings.

**When to use:**
- Deep analysis spanning multiple files
- Impact assessment across codebase
- Complex pattern discovery

**When NOT to use (use direct tools instead):**
- Simple symbol lookups → find_symbol
- Reading single files → read_file
- Quick pattern searches → search_for_pattern`;

  schema = z.object({
    task: z.string()
      .min(30, 'Task too brief. Include: what to investigate, where to look, what to return.')
      .describe(
        'Detailed investigation task. Good tasks include: ' +
        '1) What to investigate, 2) Where to look, 3) What to return.'
      ),
    context: z.string().optional().describe(
      'Relevant context: code snippets, file paths, findings so far'
    ),
    max_tool_calls: z.number().min(1).max(15).default(8).optional().describe(
      'Maximum tool calls (default: 8). Increase for complex investigations.'
    )
  });

  private subagentCount = 0;

  async execute(args): Promise<string> {
    // Validate task length with helpful error if too brief
    // Check subagent count limit
    // Build SubagentTaskDefinition
    // Call subagentExecutor.executeSubagent()
    // Format and return results
  }
}
```

**No focus_area parameter** - the LLM describes what it needs in the task string.

### Task 6: Register Tool in ServiceManager

Update `src/services/serviceManager.ts`:

1. Import SubagentExecutor, SubagentPromptGenerator, and RunSubagentTool
2. Add SubagentExecutor to IServiceRegistry interface
3. Create SubagentPromptGenerator in Phase 4
4. Create SubagentExecutor in Phase 4 (after tool registry, needs CopilotModelManager)
5. Create and register RunSubagentTool in initializeTools()

### Task 7: Update System Prompt (Critical for Weak LLMs)

Update `src/prompts/toolAwareSystemPromptGenerator.ts`:

This is **critical** - the system prompt teaches the LLM HOW to use subagents well.

Add to `generateToolUsageStrategies()`:

```typescript
**run_subagent**: Delegate complex investigations to an isolated agent.

**When to use:**
- Deep analysis spanning multiple files
- Impact assessment requiring extensive usage tracing
- Complex investigation that would clutter your context

**When NOT to use (use direct tools):**
- Simple symbol lookups → find_symbol
- Reading single files → read_file
- Quick pattern searches → search_for_pattern

**Writing Effective Tasks:**
Good tasks have three parts:
1. WHAT to investigate (specific question)
2. WHERE to look (files, directories, symbols)
3. WHAT to return (deliverables you need)

**Examples:**
✅ run_subagent(task: "Investigate JWT handling in src/auth/middleware.ts:
   1. How does validateToken() verify signatures?
   2. Is there timing-attack protection?
   Return: Security issues with severity and line numbers.")

❌ run_subagent(task: "Check the auth code")  // Too vague
❌ run_subagent(task: "Read src/utils.ts")    // Use read_file instead
```

### Task 8: Write Tests

Create test files:

1. `src/__tests__/subagentPromptGenerator.test.ts`
   - Test prompt generation with various tasks
   - Test context injection
   - Test tool list filtering (run_subagent excluded)

2. `src/__tests__/subagentExecutor.test.ts`
   - Test execution flow with mocked LLM
   - Test tool call handling within subagent
   - Test XML response parsing (<findings>, <summary>, <answer>)
   - Test timeout handling
   - Test max tool calls enforcement

3. `src/__tests__/runSubagentTool.test.ts`
   - Test schema validation
   - Test min task length validation with helpful error
   - Test subagent count limit
   - Test result formatting

## Important Implementation Notes

1. **No Recursive Subagents**: Filter run_subagent from tool registry passed to SubagentExecutor
2. **Isolated Context**: Each subagent gets a NEW ConversationManager instance
3. **Helpful Errors**: When validation fails, return guidance on how to fix it
4. **Task Validation**: Reject tasks < 30 chars with examples of good tasks
5. **Logging**: Use Log service for debugging subagent execution flow
6. **Proper Cleanup**: Clear subagent conversation after execution

## Testing the Implementation

After implementation:
1. Run `npm run check-types` to verify TypeScript
2. Run `npm run test` to run all tests
3. Build extension with `npm run build`
4. Test in VS Code extension host with a real PR analysis

## Expected Behavior

When the LLM encounters a complex investigation task during PR analysis, it should:
1. Recognize the investigation would require many tool calls
2. Decide to delegate to a subagent with a **detailed task description**
3. Receive back focused findings, summary, and optional answer
4. Incorporate subagent findings into its main analysis
5. Continue with the PR review using the gathered context

The LLM writes task descriptions naturally - no categories or rigid parameters.
```

---

## Usage Notes

1. Copy the prompt above (everything between the triple backticks after "## Prompt")
2. Paste it to Claude Code on the `feature/tool-calls` branch
3. Claude Code will read the implementation plan and existing code
4. The implementation should follow the existing code patterns and style

## Alternative: Phase-by-Phase Implementation

If you prefer more control, you can split this into smaller prompts:

### Phase 1 Prompt
```
Read docs/SUBAGENT_TOOL_IMPLEMENTATION_PLAN.md and implement Tasks 1-2:
- Create src/types/subagentTypes.ts with SubagentTaskDefinition (task, context, maxToolCalls)
  and SubagentResult (success, findings, summary, answer, toolCallsMade, error)
- Create src/models/subagentConstants.ts with execution limits and helpful error messages

Note: No SubagentFocusArea enum - we trust the LLM to describe tasks naturally.

Run check-types after implementation.
```

### Phase 2 Prompt
```
Implement Task 3: Create src/prompts/subagentPromptGenerator.ts

Follow the pattern in src/prompts/toolAwareSystemPromptGenerator.ts. The subagent prompt generator should:
1. Generate an intelligent system prompt from the task description
2. Include context when provided
3. List available tools (filter out run_subagent to prevent recursion)
4. Define response format with <findings>, <summary>, and <answer> XML tags
5. Give proactive tool usage guidance

The prompt should be smart enough to handle ANY type of investigation task.

Run check-types after implementation.
```

### Phase 3 Prompt
```
Implement Task 4: Create src/services/subagentExecutor.ts

Follow the pattern in src/services/toolCallingAnalysisProvider.ts. The SubagentExecutor should:
1. Create isolated ConversationManager per subagent (key for context isolation!)
2. Filter ToolRegistry to exclude run_subagent
3. Execute a conversation loop with max tool calls limit
4. Handle tool calls within subagent
5. Parse response for <findings>, <summary>, <answer> XML tags
6. Return SubagentResult

Dependencies:
- CopilotModelManager (for LLM calls)
- ToolRegistry (filtered)
- SubagentPromptGenerator

Run check-types after implementation.
```

### Phase 4 Prompt
```
Implement Task 5: Create src/tools/runSubagentTool.ts

Follow the pattern in src/tools/findSymbolTool.ts. The RunSubagentTool should:
1. Extend BaseTool
2. Define simplified 3-parameter Zod schema: task (min 30 chars), context, max_tool_calls
3. Validate task length and return helpful error if too brief
4. Track subagent count per session
5. Call SubagentExecutor
6. Format results for the main LLM

NO focus_area parameter - the LLM describes what it needs in the task string.

Run check-types after implementation.
```

### Phase 5 Prompt
```
Implement Task 6: Register the subagent tool in ServiceManager

Update src/services/serviceManager.ts:
1. Add SubagentExecutor to IServiceRegistry
2. Create SubagentPromptGenerator in initializeHighLevelServices()
3. Create SubagentExecutor in initializeHighLevelServices()
4. Register RunSubagentTool in initializeTools()

Ensure no circular dependencies.
Run check-types and npm run build after implementation.
```

### Phase 6 Prompt
```
Implement Task 7: Update the system prompt in src/prompts/toolAwareSystemPromptGenerator.ts

This is CRITICAL for making subagents work with smaller/weaker LLMs.

Add guidance for run_subagent tool:
1. Add to generateToolUsageStrategies() with when-to-use and when-not-to-use guidance
2. Add examples showing good vs bad task descriptions
3. Teach the "WHAT/WHERE/RETURN" pattern for writing effective tasks
4. Make clear that subagents are for complex investigations, not simple lookups

Run check-types after implementation.
```

### Phase 7 Prompt
```
Implement Task 8: Write tests for the subagent system

Create:
1. src/__tests__/subagentPromptGenerator.test.ts - Test prompt generation, context injection
2. src/__tests__/subagentExecutor.test.ts - Test execution flow, XML parsing, timeouts
3. src/__tests__/runSubagentTool.test.ts - Test validation, helpful errors, count limits

Follow the testing patterns in existing test files.
Mock the CopilotModelManager for unit tests.
Run npm run test after implementation.
```
