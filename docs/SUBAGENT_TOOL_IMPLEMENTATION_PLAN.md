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

## Architecture Design

### 1. Subagent Tool Interface

```typescript
// src/tools/subagentTool.ts
interface SubagentTaskDefinition {
  taskDescription: string;       // Clear description of what to investigate
  focusArea?: SubagentFocusArea; // Optional specialization
  maxIterations?: number;        // Limit subagent iterations (default: 5)
  tools?: string[];              // Subset of tools to make available
}

enum SubagentFocusArea {
  SecurityAnalysis = 'security',
  PerformanceAnalysis = 'performance',
  ImpactAssessment = 'impact',
  ContextGathering = 'context',
  PatternSearch = 'patterns'
}
```

### 2. SubagentExecutor Service

New service that manages subagent lifecycle:

```typescript
// src/services/subagentExecutor.ts
class SubagentExecutor {
  constructor(
    private copilotModelManager: CopilotModelManager,
    private toolRegistry: ToolRegistry,
    private promptGenerator: PromptGenerator
  ) {}

  async executeSubagent(
    task: SubagentTaskDefinition,
    parentContext?: string,  // Optional context from parent
    token: vscode.CancellationToken
  ): Promise<SubagentResult>
}
```

### 3. Subagent System Prompt Structure

Each subagent receives a focused system prompt:

```
You are a specialized code analysis subagent focused on [FOCUS_AREA].

Your task: [TASK_DESCRIPTION]

Context from parent analysis (if provided):
[PARENT_CONTEXT]

Available tools: [TOOL_LIST]

Instructions:
1. Investigate the specific task assigned to you
2. Use tools proactively to gather necessary information
3. Provide a comprehensive, focused analysis
4. Return findings in structured format
5. Do NOT spawn additional subagents

Response Format:
<findings>
[Your detailed findings here]
</findings>

<summary>
[Concise summary of key discoveries]
</summary>
```

### 4. Tool Schema

```typescript
const subagentToolSchema = z.object({
  task_description: z.string().min(10).describe(
    'Clear description of the investigation task. Be specific about what you want to discover.'
  ),
  focus_area: z.enum([
    'security', 'performance', 'impact', 'context', 'patterns'
  ]).optional().describe(
    'Optional specialization area for the subagent'
  ),
  parent_context: z.string().optional().describe(
    'Relevant context to pass to the subagent (e.g., file path, symbol name, code snippet)'
  ),
  max_iterations: z.number().min(1).max(8).default(5).describe(
    'Maximum iterations for subagent tool calls (default: 5)'
  )
});
```

## Implementation Steps

### Phase 1: Core Subagent Infrastructure

1. **Create SubagentResult type** (`src/types/subagentTypes.ts`)
   - Result interface with findings, summary, tool calls made, tokens used

2. **Create SubagentPromptGenerator** (`src/prompts/subagentPromptGenerator.ts`)
   - Generate focused system prompts for each subagent type
   - Handle parent context injection

3. **Create SubagentExecutor service** (`src/services/subagentExecutor.ts`)
   - Manage isolated conversation context
   - Execute subagent conversation loop
   - Handle tool calls within subagent
   - Return structured results

### Phase 2: Subagent Tool Implementation

4. **Create RunSubagentTool** (`src/tools/runSubagentTool.ts`)
   - Implement ITool interface
   - Define Zod schema for parameters
   - Execute via SubagentExecutor
   - Format and return results

5. **Update ToolRegistry initialization** (`src/services/serviceManager.ts`)
   - Register RunSubagentTool
   - Inject required dependencies

### Phase 3: Token Management & Safety

6. **Add subagent token budget**
   - Reserve tokens for subagent responses in main context
   - Limit subagent context window usage
   - Track cumulative token usage across subagents

7. **Add safety limits**
   - Maximum subagents per analysis session
   - Prevent subagents from spawning subagents
   - Rate limiting for subagent calls

### Phase 4: System Prompt Updates

8. **Update ToolAwareSystemPromptGenerator**
   - Add strategic guidance for when to use subagents
   - Document subagent capabilities and limitations
   - Add few-shot examples showing proper subagent usage

## System Prompt Updates

### Addition to Strategic Tool Usage

```markdown
### Subagent Delegation Tool

**run_subagent**: Spawn an isolated investigation subagent for complex analysis tasks.

**When to use subagents:**
- Deep security analysis of a specific code pattern or vulnerability
- Impact assessment across multiple files/modules
- Performance analysis requiring extensive codebase exploration
- Gathering context about unfamiliar code areas
- Pattern searching across the codebase

**When NOT to use subagents:**
- Simple symbol lookups (use find_symbol directly)
- Single file reads (use read_file directly)
- Quick pattern searches (use search_for_pattern directly)

**Subagent Usage Strategy:**
1. **Be Specific**: Provide clear, focused task descriptions
2. **Pass Context**: Include relevant information from your current analysis
3. **Choose Focus Area**: Select appropriate specialization when helpful
4. **Combine Results**: Synthesize subagent findings with your own analysis

**Example Usage:**
- "Investigate security implications of the new authentication flow in src/auth/"
- "Assess impact of changing the UserService interface across all consumers"
- "Find all usages of deprecated API patterns and suggest migration paths"
- "Analyze performance characteristics of the new caching implementation"
```

### Few-Shot Example for Subagent Usage

```xml
<example>
<scenario>Complex security analysis spanning multiple files</scenario>
<analysis_approach>
I see a new authentication middleware being added. This requires deep investigation across multiple auth-related files.

Instead of making many sequential tool calls, I'll spawn a security-focused subagent:

run_subagent(
  task_description: "Analyze the security implications of the new authentication middleware in src/middleware/auth.ts. Investigate: 1) How it handles token validation, 2) What sensitive data it exposes, 3) How it integrates with existing auth flow, 4) Potential bypass vectors",
  focus_area: "security",
  parent_context: "New middleware added at line 45: authenticateRequest()"
)

The subagent will use tools to deeply investigate while I continue analyzing other aspects of the PR.
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
  MAX_ITERATIONS_PER_SUBAGENT: 8,
  DEFAULT_ITERATIONS: 5,

  // Token management
  MAX_SUBAGENT_INPUT_TOKENS: 8000,
  MAX_SUBAGENT_OUTPUT_TOKENS: 4000,
  RESERVED_TOKENS_FOR_RESPONSE: 1000,

  // Tool access
  DISALLOWED_TOOLS: ['run_subagent'], // Prevent recursive spawning

  // Timeouts
  SUBAGENT_TIMEOUT_MS: 60000, // 1 minute per subagent
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
