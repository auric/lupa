# Claude Code Implementation Prompt: Subagent Tool

Copy the prompt below to have Claude Code implement the subagent tool feature.

---

## Prompt

```
Implement a subagent tool for the Lupa VS Code extension that allows the main LLM to spawn isolated investigation agents during PR analysis. This is similar to Claude Code's Task tool and GitHub Copilot's runSubagent feature.

Read `docs/SUBAGENT_TOOL_IMPLEMENTATION_PLAN.md` for full architectural context.

## Code Quality Requirements (CRITICAL)

Write high-quality TypeScript code that:

**SOLID Principles:**
- **Single Responsibility**: Each class/function does ONE thing
- **Dependency Inversion**: Depend on abstractions, inject dependencies

**DRY:**
- Extract shared logic into reusable components
- ConversationRunner must be extracted from ToolCallingAnalysisProvider for reuse
- No duplicating the conversation loop between main analysis and subagent

**Comments:**
- NO obvious comments like `// Get user` before `getUser()`
- YES to explaining WHY: `// Filter run_subagent to prevent infinite recursion`
- JSDoc for public APIs only

**Code Style:**
- Small functions (typically <20 lines)
- Names reveal intent (no `temp`, `data`, single-letter vars except loops)
- Leverage TypeScript types, avoid `any`
- Follow existing codebase patterns

## Background

The `feature/tool-calls` branch has:
- ToolRegistry, ToolExecutor, ConversationManager
- ToolCallingAnalysisProvider with the conversation loop (needs extraction)
- Multiple tools (find_symbol, find_usages, etc.)

## Implementation Tasks

### Phase 0: DRY Refactoring (DO THIS FIRST)

**Before adding subagents, extract the reusable conversation loop:**

#### Task 0.1: Create ConversationRunner (`src/models/conversationRunner.ts`)

Extract the conversation loop from ToolCallingAnalysisProvider:

```typescript
export interface ConversationRunnerConfig {
  systemPrompt: string;
  maxIterations: number;
}

/**
 * Runs a tool-calling conversation loop.
 * Extracted for reuse by both main analysis and subagents.
 */
export class ConversationRunner {
  constructor(
    private modelManager: CopilotModelManager,
    private toolExecutor: ToolExecutor
  ) {}

  async run(
    config: ConversationRunnerConfig,
    conversation: ConversationManager,
    token: CancellationToken
  ): Promise<string> {
    // Move conversationLoop() logic here
    // Accept conversation as parameter (not internal state)
    // Return final response content
  }
}
```

#### Task 0.2: Refactor ToolCallingAnalysisProvider

Make it a thin wrapper that uses ConversationRunner:

```typescript
// Before: has its own conversationLoop() method
// After: delegates to conversationRunner.run()

async analyze(diff: string, token: CancellationToken): Promise<string> {
  this.conversationManager.clearHistory();
  // ... setup code ...

  return this.conversationRunner.run(
    { systemPrompt, maxIterations: 10 },
    this.conversationManager,
    token
  );
}
```

**Verify all existing tests still pass before continuing.**

### Phase 1: Subagent Types & Constants

#### Task 1.1: Add types to existing `src/types/modelTypes.ts`

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

**No new file** - add to existing types file.

#### Task 1.2: Add constants to existing `src/models/toolConstants.ts`

```typescript
export const SubagentLimits = {
  MAX_PER_SESSION: 5,
  MAX_TOOL_CALLS: 15,
  DEFAULT_TOOL_CALLS: 8,
  MIN_TASK_LENGTH: 30,
  TIMEOUT_MS: 60_000,
  DISALLOWED_TOOLS: ['run_subagent'] as const,
} as const;

export const SubagentErrors = {
  maxExceeded: (max: number) =>
    `Maximum subagents (${max}) reached. Use direct tools instead.`,
  taskTooShort: (min: number) =>
    `Task too brief (${min}+ chars). Include: WHAT, WHERE, WHAT TO RETURN.`,
  timeout: (ms: number) =>
    `Subagent timed out after ${ms / 1000}s. Break into smaller tasks.`,
  failed: (err: string) => `Subagent failed: ${err}`,
} as const;
```

### Phase 2: Subagent Components

#### Task 2.1: Create SubagentPromptGenerator (`src/prompts/subagentPromptGenerator.ts`)

Single responsibility: generate subagent system prompts.

```typescript
export class SubagentPromptGenerator {
  generateSystemPrompt(task: SubagentTask, tools: ITool[]): string {
    // Dynamic tool list (filter run_subagent)
    // Include task and context
    // Define <findings>, <summary>, <answer> response format
  }
}
```

#### Task 2.2: Create SubagentExecutor (`src/services/subagentExecutor.ts`)

**Thin wrapper** - uses ConversationRunner, does NOT duplicate loop logic:

```typescript
export class SubagentExecutor {
  constructor(
    private conversationRunner: ConversationRunner,
    private toolRegistry: ToolRegistry,
    private promptGenerator: SubagentPromptGenerator
  ) {}

  async execute(task: SubagentTask, token: CancellationToken): Promise<SubagentResult> {
    // 1. Create fresh ConversationManager (isolation!)
    // 2. Filter tools (remove run_subagent)
    // 3. Generate prompt
    // 4. Delegate to conversationRunner.run() - NO LOOP DUPLICATION
    // 5. Parse <findings>, <summary>, <answer> from response
  }

  private filterTools(): ITool[] {
    // Remove run_subagent to prevent recursion
  }

  private parseResponse(response: string): { findings: string; summary: string; answer?: string } {
    // Extract XML tags from response
  }
}
```

#### Task 2.3: Create SubagentSessionManager (`src/services/subagentSessionManager.ts`)

Tracks subagent usage per analysis session:

```typescript
export class SubagentSessionManager {
  private count = 0;

  canSpawn(): boolean {
    return this.count < SubagentLimits.MAX_PER_SESSION;
  }

  recordSpawn(): void {
    this.count++;
  }

  reset(): void {
    this.count = 0;
  }
}
```

### Phase 3: Tool Implementation

#### Task 3.1: Create RunSubagentTool (`src/tools/runSubagentTool.ts`)

```typescript
export class RunSubagentTool extends BaseTool {
  name = 'run_subagent';
  description = `Spawn isolated agent for complex investigations.

Use when: deep multi-file analysis, impact assessment, pattern discovery.
Don't use for: simple lookups (find_symbol), single file reads (read_file).`;

  schema = z.object({
    task: z.string()
      .min(SubagentLimits.MIN_TASK_LENGTH, SubagentErrors.taskTooShort(SubagentLimits.MIN_TASK_LENGTH))
      .describe('Investigation task: WHAT to investigate, WHERE to look, WHAT to return'),
    context: z.string().optional()
      .describe('Relevant context: code snippets, file paths, findings'),
    max_tool_calls: z.number().min(1).max(SubagentLimits.MAX_TOOL_CALLS)
      .default(SubagentLimits.DEFAULT_TOOL_CALLS).optional()
      .describe('Max tool calls (default: 8)')
  });

  constructor(
    private executor: SubagentExecutor,
    private sessionManager: SubagentSessionManager
  ) { super(); }

  async execute(args: z.infer<typeof this.schema>): Promise<string> {
    if (!this.sessionManager.canSpawn()) {
      return SubagentErrors.maxExceeded(SubagentLimits.MAX_PER_SESSION);
    }

    this.sessionManager.recordSpawn();
    const result = await this.executor.execute({
      task: args.task,
      context: args.context,
      maxToolCalls: args.max_tool_calls
    }, /* token */);

    return this.formatResult(result);
  }

  private formatResult(result: SubagentResult): string {
    // Format for parent LLM consumption
  }
}
```

### Phase 4: Registration & Wiring

#### Task 4.1: Update ServiceManager

Add to `src/services/serviceManager.ts`:

```typescript
// In IServiceRegistry:
conversationRunner: ConversationRunner;
subagentExecutor: SubagentExecutor;
subagentSessionManager: SubagentSessionManager;

// In initializeHighLevelServices():
this.services.conversationRunner = new ConversationRunner(
  this.services.copilotModelManager,
  this.services.toolExecutor
);

this.services.subagentSessionManager = new SubagentSessionManager();

this.services.subagentExecutor = new SubagentExecutor(
  this.services.conversationRunner,
  this.services.toolRegistry,
  new SubagentPromptGenerator()
);

// In initializeTools():
const runSubagentTool = new RunSubagentTool(
  this.services.subagentExecutor,
  this.services.subagentSessionManager
);
this.services.toolRegistry.registerTool(runSubagentTool);
```

### Phase 5: System Prompt Updates

#### Task 5.1: Update ToolAwareSystemPromptGenerator

Add guidance to `generateToolUsageStrategies()`:

```markdown
### run_subagent: Delegate Complex Investigations

Spawn isolated agent for multi-file investigations.

**When to use:** Deep analysis, impact assessment, pattern discovery
**Don't use for:** Simple lookups (find_symbol), single reads (read_file)

**Write good tasks:** Include WHAT to investigate, WHERE to look, WHAT to return

✅ "Investigate JWT handling in src/auth/. Check validation, timing protection.
   Return: Security issues with severity."
❌ "Check the auth code" (too vague)
```

### Phase 6: Testing

#### Task 6.1: Write tests

1. `conversationRunner.test.ts` - Loop behavior, iteration limits
2. `subagentExecutor.test.ts` - Isolation, filtering, parsing
3. `runSubagentTool.test.ts` - Validation, session limits
4. `subagentSessionManager.test.ts` - Count tracking

## Code Quality Checklist

Before submitting, verify:

- [ ] **DRY**: ConversationRunner extracted, no loop duplication
- [ ] **SOLID**: Each class has single responsibility
- [ ] **No obvious comments**: Comments explain WHY, not WHAT
- [ ] **Small functions**: Most under 20 lines
- [ ] **Type safety**: No `any`, proper interfaces
- [ ] **Tests pass**: `npm run test`
- [ ] **Types check**: `npm run check-types`

## Expected Architecture After Implementation

```
┌──────────────────────────────────────────────────────────────┐
│              ToolCallingAnalysisProvider                      │
│  (thin wrapper - orchestrates PR analysis)                    │
└────────────────────────┬─────────────────────────────────────┘
                         │ uses
                         ▼
┌──────────────────────────────────────────────────────────────┐
│                   ConversationRunner                          │
│  (EXTRACTED - reusable loop, no duplication)                  │
└────────────────────────┬─────────────────────────────────────┘
                         │ also used by
                         ▼
┌──────────────────────────────────────────────────────────────┐
│                   SubagentExecutor                            │
│  (thin wrapper - isolation + parsing)                         │
└────────────────────────┬─────────────────────────────────────┘
                         │ called by
                         ▼
┌──────────────────────────────────────────────────────────────┐
│                   RunSubagentTool                             │
│  (the tool - delegates everything)                            │
└──────────────────────────────────────────────────────────────┘
```

The LLM writes task descriptions naturally - no categories or rigid parameters.
```

---

## Usage Notes

1. Copy the prompt above (everything between the triple backticks after "## Prompt")
2. Paste it to Claude Code on the `feature/tool-calls` branch
3. Claude Code will read the implementation plan and existing code
4. The implementation should follow the existing code patterns and style

## Alternative: Phase-by-Phase Implementation

If you prefer more control, split into smaller prompts. Each phase includes code quality requirements.

### Phase 0 Prompt (CRITICAL - Do First)
```
Read docs/SUBAGENT_TOOL_IMPLEMENTATION_PLAN.md.

**DRY REFACTORING**: Extract ConversationRunner from ToolCallingAnalysisProvider.

Code Quality:
- NO code duplication - this extraction enables reuse
- Small functions (<20 lines)
- No obvious comments

Tasks:
1. Create src/models/conversationRunner.ts
   - Move conversationLoop() logic from ToolCallingAnalysisProvider
   - Accept ConversationManager as parameter (not internal state)
   - Configurable via ConversationRunnerConfig

2. Refactor ToolCallingAnalysisProvider to use ConversationRunner
   - Make it a thin wrapper that delegates to conversationRunner.run()

Run npm run test - ALL existing tests must still pass before continuing.
```

### Phase 1 Prompt
```
Add subagent types and constants to EXISTING files (no new files):

Code Quality:
- Use const assertions for type safety
- Concise error messages that guide the LLM

Tasks:
1. Add to src/types/modelTypes.ts:
   - SubagentTask interface (task, context, maxToolCalls)
   - SubagentResult interface (success, findings, summary, answer, toolCallsMade, error)

2. Add to src/models/toolConstants.ts:
   - SubagentLimits object with MAX_PER_SESSION, MAX_TOOL_CALLS, etc.
   - SubagentErrors object with error message functions

Run check-types after.
```

### Phase 2 Prompt
```
Create SubagentPromptGenerator and SubagentSessionManager.

Code Quality:
- Single responsibility per class
- No business logic in prompt generator - just prompt construction
- Comments explain WHY, not WHAT

Tasks:
1. Create src/prompts/subagentPromptGenerator.ts
   - generateSystemPrompt(task, tools) returns prompt string
   - Filter run_subagent from tool list
   - Define <findings>, <summary>, <answer> response format

2. Create src/services/subagentSessionManager.ts
   - Track count per session
   - canSpawn(), recordSpawn(), reset() methods

Run check-types after.
```

### Phase 3 Prompt
```
Create SubagentExecutor as a THIN WRAPPER.

Code Quality:
- MUST use ConversationRunner (no loop duplication!)
- Single responsibility: isolation and response parsing
- Inject dependencies, don't create them

Tasks:
Create src/services/subagentExecutor.ts that:
1. Creates fresh ConversationManager per execution (isolation)
2. Filters run_subagent from tools
3. Delegates to conversationRunner.run() - NO LOOP CODE
4. Parses <findings>, <summary>, <answer> from response

Dependencies: ConversationRunner, ToolRegistry, SubagentPromptGenerator

Run check-types after.
```

### Phase 4 Prompt
```
Create RunSubagentTool and register in ServiceManager.

Code Quality:
- Tool delegates everything to SubagentExecutor
- Use constants from SubagentLimits, not magic numbers
- Dependency injection for executor and session manager

Tasks:
1. Create src/tools/runSubagentTool.ts
   - 3-parameter schema (task, context, max_tool_calls)
   - Inject SubagentExecutor and SubagentSessionManager
   - Return helpful error if session limit reached

2. Update src/services/serviceManager.ts
   - Add ConversationRunner, SubagentExecutor, SubagentSessionManager to registry
   - Register RunSubagentTool

Run check-types and npm run build after.
```

### Phase 5 Prompt
```
Update system prompt to guide LLM on subagent usage.

This is CRITICAL for smaller/weaker LLMs - teach by example.

Update src/prompts/toolAwareSystemPromptGenerator.ts:
1. Add run_subagent to generateToolUsageStrategies()
2. Include when-to-use and when-not-to-use guidance
3. Show good vs bad task examples
4. Teach WHAT/WHERE/RETURN pattern

Run check-types after.
```

### Phase 6 Prompt
```
Write tests for the subagent system.

Tests to create:
1. conversationRunner.test.ts - Loop behavior, iteration limits
2. subagentPromptGenerator.test.ts - Prompt generation, tool filtering
3. subagentExecutor.test.ts - Isolation, response parsing, error handling
4. subagentSessionManager.test.ts - Count tracking, reset
5. runSubagentTool.test.ts - Validation, session limits

Follow existing test patterns. Mock CopilotModelManager for unit tests.

Run npm run test after.
```
