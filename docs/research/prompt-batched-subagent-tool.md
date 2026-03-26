# Research Prompt: Batched Subagent Tool for Parallel Execution

> **Instructions**: Paste this entire prompt into a NEW chat session. Select Claude Opus 4.6 as the model. The agent should use sequential thinking and subagent delegation for research.

---

## Context

**Lupa** is a VS Code extension that performs PR code review using GitHub Copilot models via the `vscode.lm` API. It uses a recursive agent architecture where a root agent decomposes a PR, spawns investigation subagents, and aggregates findings.

### The Problem

Some models (Raptor Mini, GPT-5 mini, GPT-4.1 mini) call the `run_subagent` tool **sequentially** even though:

1. The VS Code API supports parallel tool execution (since v1.109)
2. The `run_subagent` tool description explicitly says "⚡ PARALLEL: You can make MULTIPLE run_subagent calls in the same response"
3. The tool executor already handles parallel tool calls natively

Research shows this is a **model behavior issue**, not an API limitation:

- Laurent Kubaski's testing (Jul 2025): "Out of 4 models, only GPT-4.1 (full) uses tools in the way you would expect. GPT-4.1 mini calls tools sequentially."
- The "plan-then-execute" pattern (tool_choice=none for planning, then execute) helps but doesn't fully solve it via our API (VS Code LM API doesn't support tool_choice parameter)

**Impact**: When a model calls `run_subagent` 6 times sequentially, analysis takes ~6x longer than parallel execution. This makes some models unusable despite being better at finding bugs.

### Current Architecture

**Key files**:

- `src/tools/runSubagentTool.ts` — The `run_subagent` tool (extends BaseTool, Zod schema)
- `src/services/subagentExecutor.ts` — Creates isolated conversation contexts per subagent
- `src/sessions/subagentSessionManager.ts` — Tracks spawn count, enforces limits
- `src/models/conversationRunner.ts` — The main conversation loop (handles tool calls)
- `src/models/toolExecutor.ts` — Executes tool calls (already handles parallel execution)
- `src/services/toolCallingAnalysisProvider.ts` — Main analysis orchestration
- `src/sessions/recursiveStateManager.ts` — Agent tree, budget tracking for RLM approach

**Current `run_subagent` schema**:

```typescript
schema = z.object({
    task: z
        .string()
        .min(20)
        .max(8000)
        .describe('Detailed investigation task...'),
    context: z
        .string()
        .optional()
        .describe('Relevant context from analysis...'),
});
```

**Tool execution flow**:

1. LLM returns response with `toolCalls` array
2. `ConversationRunner` passes tool calls to `handleToolCalls()`
3. `ToolExecutor.executeBatch()` runs all tool calls — **already parallelizes** if multiple calls in same response
4. Results are added to conversation as tool messages
5. Problem: Sequential-calling models only put ONE `run_subagent` in each response

### Constraints

- **VS Code LM API**: No `tool_choice` parameter, no `parallel_tool_calls` parameter. We control tools available and messages, nothing else.
- **BaseTool pattern**: All tools extend `BaseTool` with Zod schema and `execute()` method
- **ExecutionContext**: Tools receive per-analysis context (cancellation token, finding store, recursive state, etc.)
- **Existing parallel infrastructure**: `ToolExecutor.executeBatch()` already runs tools concurrently when the model returns multiple tool calls in one response

## Research Task

### Phase 1: Research (use subagents + sequential thinking)

1. **Research the VS Code Language Model API** (DeepWiki: `microsoft/vscode`):
    - How does `sendRequest` handle tool calls?
    - Is there any way to hint/force parallel tool calling?
    - How do chat participants handle parallel subagent execution?

2. **Research existing patterns** for forcing parallel execution:
    - Tavily search: "LLM parallel tool calling force batched execution 2025"
    - Tavily search: "OpenAI function calling parallel_tool_calls parameter workaround"
    - Look for patterns used by LangChain deepagents, smolagents, Claude Code SDK

3. **Research plan-then-execute patterns** specifically for VS Code extensions:
    - How Claude Code implements planning phase
    - How to implement a mandatory planning step before tool execution

### Phase 2: Design (use sequential thinking)

Design a `run_subagent_batch` tool that:

1. Accepts an array of tasks (not just one)
2. Spawns all subagents in parallel internally (bypassing model's sequential tendency)
3. Returns combined results
4. Respects existing limits (SubagentSessionManager, RecursiveStateManager)
5. Handles partial failures (some subagents succeed, some fail)
6. Supports cancellation (parent cancel → all children cancel)
7. Reports progress for each subagent

**Schema proposal** (refine this):

```typescript
schema = z.object({
    tasks: z
        .array(
            z.object({
                task: z.string().min(20).max(8000),
                context: z.string().optional(),
            })
        )
        .min(1)
        .max(10)
        .describe('Array of investigation tasks to run in parallel'),
});
```

**Consider**:

- Should we REPLACE `run_subagent` with `run_subagent_batch` or keep both?
- How to handle the model still calling it with 1 task? (Should work fine, just less efficient)
- How to update prompts to instruct models to use the batch version?
- How does this interact with RecursiveStateManager agent tree registration?
- Timeout: should all subagents share a timeout or have individual timeouts?

### Phase 3: Also consider prompt-based approach

Even without a new tool, can we improve parallel execution via prompts?

Ideas:

- Add explicit "PHASE 1: Create investigation plan. PHASE 2: Spawn ALL subagents in ONE response" to system prompt
- Add a `create_plan` tool that forces the model to plan before executing
- Restructure the conversation flow: first turn = orientation + planning (no subagent tool), second turn = execution (subagent tool available)

### Phase 4: Implement

Implement the chosen solution:

1. Create `RunSubagentBatchTool` in `src/tools/`
2. Register in `ServiceManager.initializeTools()`
3. Update relevant prompts (system prompt generator, subagent prompt generator)
4. Add tests in `src/__tests__/runSubagentBatchTool.test.ts`
5. Update model calibration if needed (per-model tool selection)

**Follow all conventions in CLAUDE.md and ARCHITECTURE.md**:

- Extend `BaseTool`, use Zod schema
- Use `toolSuccess()`/`toolError()` for results
- Use `Log` from `loggingService.ts`
- Access `SubagentExecutor` and `SubagentSessionManager` from `ExecutionContext`
- Run `npm run check-types` after changes
- Commit with descriptive message

## Expected Output

1. A design document explaining the chosen approach and rationale
2. Implementation of the batched subagent tool
3. Updated prompts for models that call tools sequentially
4. Tests covering: parallel execution, partial failure, cancellation, limit enforcement
5. A recommendation for whether to also implement the prompt-based approach as complementary
