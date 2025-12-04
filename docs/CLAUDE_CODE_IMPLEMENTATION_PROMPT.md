# Claude Code Implementation Prompt: Subagent Tool

Copy the prompt below to have Claude Code implement the subagent tool feature.

---

## Prompt

```
Implement a subagent tool for the Lupa VS Code extension that allows the main LLM to spawn isolated investigation agents during PR analysis. This is similar to Claude Code's Task tool and GitHub Copilot's runSubagent feature.

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

Create a new types file with:

```typescript
/**
 * Focus areas for subagent specialization
 */
export enum SubagentFocusArea {
  Security = 'security',
  Performance = 'performance',
  Impact = 'impact',
  Context = 'context',
  Patterns = 'patterns'
}

/**
 * Task definition for spawning a subagent
 */
export interface SubagentTaskDefinition {
  taskDescription: string;
  focusArea?: SubagentFocusArea;
  parentContext?: string;
  maxIterations?: number;
}

/**
 * Result returned by a subagent
 */
export interface SubagentResult {
  success: boolean;
  findings: string;
  summary: string;
  toolCallsMade: number;
  tokensUsed?: number;
  error?: string;
}
```

### Task 2: Create Subagent Constants (`src/models/subagentConstants.ts`)

Create configuration constants:

```typescript
export const SubagentConstants = {
  // Execution limits
  MAX_SUBAGENTS_PER_SESSION: 5,
  MAX_ITERATIONS_PER_SUBAGENT: 8,
  DEFAULT_ITERATIONS: 5,

  // Token management
  MAX_SUBAGENT_CONTEXT_CHARS: 32000,
  RESERVED_CHARS_FOR_RESPONSE: 4000,

  // Tool access
  DISALLOWED_TOOLS: ['run_subagent'],

  // Timeouts
  SUBAGENT_TIMEOUT_MS: 60000,

  // Error messages
  ERROR_MESSAGES: {
    MAX_SUBAGENTS_EXCEEDED: (max: number) =>
      `Maximum number of subagents (${max}) exceeded for this session`,
    SUBAGENT_TIMEOUT: 'Subagent execution timed out',
    SUBAGENT_FAILED: (error: string) => `Subagent failed: ${error}`,
  }
};
```

### Task 3: Create SubagentPromptGenerator (`src/prompts/subagentPromptGenerator.ts`)

Create a prompt generator that creates focused prompts for subagents:

1. Generate a focused system prompt based on the focus area
2. Include parent context if provided
3. List available tools (excluding run_subagent)
4. Define clear response format with <findings> and <summary> tags
5. Include specific instructions based on focus area:
   - Security: Look for vulnerabilities, auth issues, data exposure
   - Performance: Look for algorithmic issues, memory leaks, concurrency
   - Impact: Find all usages and assess change effects
   - Context: Gather comprehensive understanding of code area
   - Patterns: Find similar patterns, anti-patterns, code smells

### Task 4: Create SubagentExecutor Service (`src/services/subagentExecutor.ts`)

Create the core execution service:

1. Accept SubagentTaskDefinition and cancellation token
2. Create isolated ConversationManager instance
3. Generate subagent-specific system prompt
4. Filter tool registry to exclude disallowed tools
5. Execute conversation loop similar to ToolCallingAnalysisProvider:
   - Maximum iterations based on task definition
   - Handle tool calls from subagent
   - Track tool calls made count
6. Parse subagent response for <findings> and <summary> tags
7. Return SubagentResult with findings, summary, and metadata
8. Handle timeouts and errors gracefully

Key methods:
- `executeSubagent(task, token): Promise<SubagentResult>`
- `createSubagentToolExecutor(): ToolExecutor` (filtered tools)
- `parseSubagentResponse(response): {findings, summary}`

### Task 5: Create RunSubagentTool (`src/tools/runSubagentTool.ts`)

Implement the tool following the BaseTool pattern:

```typescript
export class RunSubagentTool extends BaseTool {
  name = 'run_subagent';
  description = `Spawn an isolated investigation subagent for complex analysis tasks.

Use this tool when you need to:
- Perform deep security analysis of specific code areas
- Assess impact of changes across multiple files
- Gather extensive context about unfamiliar code
- Search for patterns across the codebase

The subagent runs with its own context and returns focused findings.

Do NOT use for simple tasks - prefer direct tool calls for:
- Single symbol lookups
- Single file reads
- Quick pattern searches`;

  schema = z.object({
    task_description: z.string().min(10).describe(
      'Clear, specific description of what to investigate'
    ),
    focus_area: z.enum(['security', 'performance', 'impact', 'context', 'patterns'])
      .optional()
      .describe('Optional specialization for the subagent'),
    parent_context: z.string().optional().describe(
      'Relevant context from your analysis to pass to subagent'
    ),
    max_iterations: z.number().min(1).max(8).default(5).describe(
      'Maximum tool-calling iterations (default: 5)'
    )
  });

  async execute(args): Promise<string> {
    // Validate arguments
    // Check subagent count limit
    // Call subagentExecutor.executeSubagent()
    // Format and return results
  }
}
```

### Task 6: Register Tool in ServiceManager

Update `src/services/serviceManager.ts`:

1. Import SubagentExecutor and RunSubagentTool
2. Add SubagentExecutor to IServiceRegistry interface
3. Create SubagentExecutor in Phase 4 (after tool registry)
4. Create and register RunSubagentTool

### Task 7: Update System Prompt

Update `src/prompts/toolAwareSystemPromptGenerator.ts`:

1. Add run_subagent to the tool strategies section
2. Add guidance on when to use vs when not to use subagents
3. Add few-shot example showing proper subagent delegation

Add this to `generateToolUsageStrategies()`:

```typescript
- **run_subagent**: For complex investigations requiring multiple tool calls. Delegate deep analysis tasks that would consume too much context if done directly.
  - Use for: Security audits, impact assessments, pattern analysis, extensive context gathering
  - Don't use for: Simple lookups, single file reads, quick searches
```

### Task 8: Write Tests

Create test files:

1. `src/__tests__/subagentPromptGenerator.test.ts`
   - Test prompt generation for each focus area
   - Test parent context inclusion
   - Test tool list filtering

2. `src/__tests__/subagentExecutor.test.ts`
   - Test basic execution flow with mocked LLM
   - Test tool call handling
   - Test response parsing
   - Test timeout handling
   - Test max iterations enforcement

3. `src/__tests__/runSubagentTool.test.ts`
   - Test schema validation
   - Test execution with mocked executor
   - Test result formatting

## Important Implementation Notes

1. **No Recursive Subagents**: Subagents MUST NOT have access to run_subagent tool
2. **Isolated Context**: Each subagent gets fresh ConversationManager
3. **Token Safety**: Track and limit subagent context consumption
4. **Proper Cleanup**: Dispose of subagent resources after execution
5. **Error Handling**: Graceful failures with meaningful error messages
6. **Logging**: Use Log service for debugging subagent execution

## Testing the Implementation

After implementation:
1. Run `npm run check-types` to verify TypeScript
2. Run `npm run test` to run all tests
3. Build extension with `npm run build`
4. Test in VS Code extension host with a real PR analysis

## Expected Behavior

When the LLM encounters a complex investigation task during PR analysis, it should:
1. Recognize the task requires multiple tool calls
2. Decide to delegate to a subagent with appropriate focus area
3. Receive back focused findings and summary
4. Incorporate subagent findings into its main analysis
5. Continue with the PR review using the gathered context
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
- Create src/types/subagentTypes.ts with SubagentFocusArea, SubagentTaskDefinition, SubagentResult
- Create src/models/subagentConstants.ts with execution limits and error messages

Run check-types after implementation.
```

### Phase 2 Prompt
```
Implement Task 3: Create src/prompts/subagentPromptGenerator.ts

Follow the pattern in src/prompts/toolAwareSystemPromptGenerator.ts. The subagent prompt generator should:
1. Generate focused system prompts based on SubagentFocusArea
2. Include parent context when provided
3. List available tools (filter out run_subagent)
4. Define response format with <findings> and <summary> tags

Run check-types after implementation.
```

### Phase 3 Prompt
```
Implement Task 4: Create src/services/subagentExecutor.ts

Follow the pattern in src/services/toolCallingAnalysisProvider.ts. The SubagentExecutor should:
1. Create isolated conversation context per subagent
2. Execute a conversation loop with limited iterations
3. Handle tool calls (with filtered tool registry)
4. Parse response for findings and summary
5. Return SubagentResult

Dependencies:
- CopilotModelManager (for LLM calls)
- ToolRegistry (filtered to exclude run_subagent)
- SubagentPromptGenerator (from previous phase)

Run check-types after implementation.
```

### Phase 4 Prompt
```
Implement Task 5: Create src/tools/runSubagentTool.ts

Follow the pattern in src/tools/findSymbolTool.ts. The RunSubagentTool should:
1. Extend BaseTool
2. Define Zod schema for task_description, focus_area, parent_context, max_iterations
3. Track subagent count per session
4. Call SubagentExecutor
5. Format results for the main LLM

Run check-types after implementation.
```

### Phase 5 Prompt
```
Implement Task 6: Register the subagent tool in ServiceManager

Update src/services/serviceManager.ts:
1. Add SubagentExecutor to IServiceRegistry
2. Create SubagentExecutor in initializeHighLevelServices()
3. Register RunSubagentTool in initializeTools()

Ensure no circular dependencies.
Run check-types and npm run build after implementation.
```

### Phase 6 Prompt
```
Implement Task 7: Update the system prompt in src/prompts/toolAwareSystemPromptGenerator.ts

Add guidance for run_subagent tool:
1. Add to generateToolUsageStrategies() with when-to-use and when-not-to-use guidance
2. Add a few-shot example showing proper subagent delegation
3. Make clear that subagents are for complex multi-tool investigations

Run check-types after implementation.
```

### Phase 7 Prompt
```
Implement Task 8: Write tests for the subagent system

Create:
1. src/__tests__/subagentPromptGenerator.test.ts
2. src/__tests__/subagentExecutor.test.ts
3. src/__tests__/runSubagentTool.test.ts

Follow the testing patterns in existing test files.
Mock the CopilotModelManager for unit tests.
Run npm run test after implementation.
```
