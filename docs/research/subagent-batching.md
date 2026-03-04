# Subagent Batching — Lessons Learned & Future Implementation Guide

> **Status**: Removed in March 2026. Experimental feature that was disabled by default.
> This document captures what we learned for any future re-implementation.

## Problem Statement

Some LLMs (notably GPT-5-mini in VS Code Copilot) emit only **one `run_subagent` tool call per conversation iteration**, even when asked to delegate multiple investigations in parallel. This causes sequential execution:

```
IT1: run_subagent("auth") → 30s → IT2: run_subagent("api") → 30s → IT3: run_subagent("tests") → 30s
Total: 90s sequential
```

The goal was to accumulate these calls and flush them all at once for parallel execution:

```
IT1: queue("auth") → IT2: queue("api") → IT3: queue("tests") → IT4: flush all 3 → ~30s parallel
Total: 30s + overhead
```

## What Worked

1. **Basic queue-and-flush pattern**: `SubagentBatchManager` (simple queue with `enqueue`/`drain`/`hasPending`) worked well. The queue accumulated subagent tasks correctly.

2. **Cooldown window**: A gap of 2 consecutive non-`run_subagent` iterations before flushing was effective. Models that interleave `run_subagent` → `update_plan` → `run_subagent` would trigger premature flushes without this. With the cooldown, a batch of 6 subagents was correctly accumulated and flushed together.

3. **Text-only bypass**: When the model stops calling tools entirely (text-only response), flushing immediately was correct — the model has finished delegating.

4. **Pre-submit_review safety net**: Flushing before accepting `submit_review` prevented the model from completing before pending subagent results were available.

## What Didn't Work

1. **Model still wastes iterations**: Even with batching, GPT-5-mini spent 12 iterations to produce 6 subagent calls (alternating `run_subagent` → `update_plan`). Batching saved wall-clock time but not token/iteration budget. The model doesn't know it can stop between subagent calls.

2. **Retroactive metadata patching**: When `RunSubagentTool` enqueued instead of executing, it returned a simple string (`"Subagent #N queued"`). After the batch executed, we had to find those `ToolCallRecord` entries by matching the string and backfill `nestedCalls`, `executionTimeMs`, etc. This was fragile and confusing.

3. **Complexity spread across 6 files**: The implementation touched `SubagentBatchManager`, `subagentBatchExecutor`, `ConversationRunner`, `ToolCallingAnalysisProvider`, `ChatParticipantService`, and `RunSubagentTool`. Each had partial knowledge of the batching lifecycle.

4. **Three duplicate flush sites in ConversationRunner**: Pre-submit_review, post-tool-call, and text-only-response each repeated the same flush → check cancellation → inject message → call callback pattern.

5. **Stateful closure factory**: `createFlushBatchCallback()` returned a closure capturing mutable `gapIterations` state instead of being a method on an object, making the state flow hard to follow.

## Architecture of the Removed Implementation

```
RunSubagentTool
  └─ context.subagentBatchManager.enqueue(task)
       │
ConversationRunner (3 flush sites)
  └─ config.flushBatchedSubagents(toolNames)
       │
subagentBatchExecutor.createFlushBatchCallback (closure with cooldown state)
  └─ batchManager.drain() → Promise.allSettled(executeBatchedSubagent(...))
       │
  └─ Returns BatchFlushResult { message, subagentResults[] }
       │
ConversationRunner
  └─ conversation.addUserMessage(result.message)
  └─ config.onBatchFlushComplete(result)
       │
ToolCallingAnalysisProvider
  └─ Retroactively patches ToolCallRecord.nestedCalls
```

## Recommendations for Future Implementation

### Simplification #1: Single batch orchestrator class

Instead of splitting across `SubagentBatchManager` + `subagentBatchExecutor` + closure factory + callback, create a single `SubagentBatchOrchestrator` class that owns:

- Queue state (enqueue/drain)
- Cooldown state (gap iteration counter)
- Flush logic (execute batch, format results)
- A `tryFlush(toolNames): Promise<string | undefined>` method

This makes ConversationRunner's flush code just:

```typescript
const injectedMessage = await batchOrchestrator?.tryFlush(toolNames);
if (injectedMessage) conversation.addUserMessage(injectedMessage);
```

### Simplification #2: Avoid retroactive record patching

Instead of `RunSubagentTool` returning a "queued" string and later patching records, have `RunSubagentTool` return a placeholder `ToolCallRecord` with a `pendingBatchId`. When the batch executes, the orchestrator resolves those pending records directly. Or, let the batch orchestrator own the `ToolCallRecord` creation for batched subagents entirely — it's the one with the actual execution results.

### Simplification #3: Single flush helper in ConversationRunner

Extract a private method `flushBatchIfNeeded(toolNames)` that encapsulates:

1. Call the flush callback
2. Check cancellation
3. Inject message
4. Return whether a flush occurred

Call it from the 2-3 flush sites with one line each.

### Simplification #4: Consider prompt-based approach instead

Instead of engineering batching infrastructure, instruct the model more explicitly:

```
When delegating work to subagents, call run_subagent multiple times in the SAME response.
Do NOT interleave run_subagent calls with update_plan calls.
```

This may be sufficient for newer models and avoids the entire batching system.

### Simplification #5: Consider post-hoc parallel execution

Instead of intercepting at the tool level, analyze the completed iteration's tool calls. If multiple `run_subagent` calls were made sequentially across recent iterations, offer to re-run them in parallel. This separates "detection" from "execution" cleanly.

## Key Constants (for reference)

```typescript
FLUSH_COOLDOWN_ITERATIONS = 2; // Gap iterations before flush
RecursionConstants.MIN_SUBAGENT_TIMEOUT_MS = 120_000; // 2min floor
RecursionConstants.TIMEOUT_PER_ITERATION_MS = 30_000; // Per-budget-unit timeout
```

## Settings (removed)

```typescript
// Was in WorkspaceSettingsSchema:
enableSubagentBatching: z.boolean().default(false);
```

Default was `false` — feature was disabled for most users since it provided marginal benefit with significant complexity cost.
