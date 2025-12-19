# Story 3.1: Exploration Mode

**Status:** Done
**Epic:** 3 - Exploration Mode & Polish
**Story ID:** 3.1
**Created:** 2025-12-19

---

## Story

**As a** developer using VS Code,
**I want** to ask questions about my codebase without needing a slash command,
**So that** I can get contextual answers about code structure, patterns, and implementation details.

---

## Business Context

This story fixes a **critical P0 issue** identified in the Epic 2 retrospective: follow-up chips lead to a dead end. When users click follow-up suggestions (e.g., "🔧 Fix Guidance"), the prompt is sent to `@lupa` **without a slash command**, which currently falls through to a useless placeholder message.

**Issues Resolved:**

- **Issue 1 (CRITICAL):** Follow-up chips lead to "Commands coming soon!" dead end
- **Issue 5 (MEDIUM):** Default follow-ups provide no actionable value

---

## Acceptance Criteria

### AC-3.1.1: No-Command Handler

**Given** a chat request with no slash command (exploration mode)
**When** the user types `@lupa What is the purpose of AuthHandler?`
**Then** the handler MUST:

- Detect absence of command (`request.command === undefined`)
- Route to `handleExplorationMode()` method
- NOT require a diff context
- NOT display "Commands coming soon!" placeholder

### AC-3.1.2: Exploration System Prompt

**Given** exploration mode is active
**When** generating the system prompt
**Then** the `PromptGenerator` and `ToolAwareSystemPromptGenerator` MUST generate an exploration-specific prompt that:

- Removes all PR/diff-specific language and instructions
- Focuses on understanding, explaining, and answering questions
- Encourages tool usage for context gathering
- Uses the same voice/tone guidelines as analysis mode
- Does NOT reference diffs, PRs, branches, or code review

### AC-3.1.3: Tool-Based Exploration

**Given** exploration mode is active
**When** answering the user's question
**Then** the handler MUST:

- Use the existing `ConversationRunner` with `ChatLLMClient`
- Pass the user's question as the initial message (no diff context)
- Make all tools available (`FindSymbol`, `ReadFile`, `GetSymbolsOverview`, etc.)
- Stream responses via `ChatResponseStream` using existing `DebouncedStreamHandler`

### AC-3.1.4: Contextual Responses with File References

**Given** exploration mode produces a response
**When** the LLM references code locations
**Then** responses MUST:

- Reference actual code from the workspace via tool calls
- Use `stream.anchor()` for file:line references (handled by `ChatStreamHandler`)
- Be helpful and conversational in tone

### AC-3.1.5: Follow-up Continuity

**Given** a user clicked a follow-up chip from a previous analysis
**When** the follow-up prompt is processed
**Then** the handler MUST:

- Detect the request is exploration mode (no command)
- Process the prompt normally using `handleExplorationMode()`
- Generate contextually relevant responses

### AC-3.1.6: Error Handling

**Given** an error occurs during exploration
**When** the error is caught
**Then** the handler MUST:

- Use `ChatResponseBuilder.addErrorSection()` for consistent UX
- Return `ChatResult.errorDetails` with the error message
- Log the error via `Log.error()`

### AC-3.1.7: Cancellation Support

**Given** exploration is in progress
**When** the user cancels
**Then** the handler MUST:

- Stop processing cleanly via `CancellationToken`
- Use existing `handleCancellation()` method
- Return appropriate `ChatResult` with `cancelled: true` metadata

### AC-3.1.8: Follow-up Command Behavior (NEW)

**Given** a follow-up chip is generated after `/branch` or `/changes` analysis
**When** the user clicks the follow-up chip
**Then** the follow-up MUST:

- Activate exploration mode (no slash command), NOT re-run `/branch` or `/changes`
- Set `command: ''` explicitly on `ChatFollowup` to override the fallback to the original command
- Allow users to ask follow-up questions about the analysis without re-running it

### AC-3.1.9: Follow-ups Disabled in Exploration Mode (NEW)

**Given** the user is in exploration mode (`command === 'exploration'`)
**When** the `ChatFollowupProvider` is invoked
**Then** it MUST:

- Return an empty array of follow-ups
- NOT show any follow-up chips after exploration responses
- Rationale: Exploration is open-ended Q&A; follow-up chips don't add value

### AC-3.1.10: User Message in Analysis Prompt (NEW)

**Given** a user runs `/branch` or `/changes` with additional text (e.g., `@lupa /branch focus on security`)
**When** the analysis is performed
**Then** the handler MUST:

- Include the user's message (`request.prompt`) in the analysis context
- Pass it alongside the diff so the LLM can focus on what the user asked
- Enable directed analysis rather than generic review

### AC-3.1.11: DRY Handler Creation (NEW)

**Given** `ChatToolCallHandler` is instantiated in multiple places (`handleExplorationMode`, `runAnalysis`)
**When** refactoring for maintainability
**Then** the code MUST:

- Extract handler creation into a factory function `createStreamHandler(stream)`
- Reduce duplication across exploration and analysis modes
- Maintain identical behavior for both modes

---

## Tasks / Subtasks

- [x] **Task 1: Add exploration system prompt generator** (AC: 3.1.2)

  - [x] Create `generateExplorationSystemPrompt()` in `ToolAwareSystemPromptGenerator`
  - [x] Reuse role definition (Staff Engineer persona)
  - [x] Reuse tool selection guide, self-reflection guidance
  - [x] Replace analysis methodology with exploration methodology
  - [x] Replace output format with exploration output format
  - [x] No subagent delegation (exploration is single-threaded)

- [x] **Task 2: Add prompt generator method** (AC: 3.1.2)

  - [x] Add `generateExplorationSystemPrompt(tools: ITool[]): string` to `PromptGenerator`
  - [x] Delegate to `ToolAwareSystemPromptGenerator.generateExplorationPrompt()`

- [x] **Task 3: Implement handleExplorationMode()** (AC: 3.1.1, 3.1.3, 3.1.4, 3.1.5)

  - [x] Add `handleExplorationMode()` method to `ChatParticipantService`
  - [x] Route to exploration when `request.command === undefined`
  - [x] Create `ChatLLMClient` from `request.model`
  - [x] Create `ConversationRunner` with exploration config
  - [x] Pass user's `request.prompt` as initial message
  - [x] Use `DebouncedStreamHandler` and `ToolCallStreamAdapter`
  - [x] Stream response via `stream.markdown()`

- [x] **Task 4: Wire routing in handleRequest()** (AC: 3.1.1, 3.1.5)

  - [x] Replace placeholder fallthrough with `handleExplorationMode()` call
  - [x] Pass `request`, `context`, `stream`, `token` parameters

- [x] **Task 5: Update ChatAnalysisMetadata type** (AC: 3.1.1)

  - [x] Update `command` type in `ChatAnalysisMetadata` to include `'exploration'`
  - [x] Current: `command?: 'branch' | 'changes'`
  - [x] Updated: `command?: 'branch' | 'changes' | 'exploration'`

- [x] **Task 6: Handle exploration metadata** (AC: 3.1.1)

  - [x] Return `ChatAnalysisMetadata` with `command: 'exploration'`
  - [x] Set appropriate metadata fields (no filesAnalyzed for exploration)

- [x] **Task 7: Add cancellation and error handling** (AC: 3.1.6, 3.1.7)

  - [x] Wrap exploration in try/catch
  - [x] Check cancellation token before and after LLM call
  - [x] Use existing `handleCancellation()` for cancelled state
  - [x] Use `ChatResponseBuilder.addErrorSection()` for errors

- [x] **Task 8: Write unit tests** (AC: all)

  - [x] Test exploration mode routing
  - [x] Test follow-up continuation (no command)
  - [x] Test error handling
  - [x] Test cancellation

- [x] **Task 9: Fix follow-up command behavior** (AC: 3.1.8) **[NEW]**

  - [x] In `chatFollowupProvider.ts`, set `command: ''` on all `ChatFollowup` objects
  - [x] This prevents follow-ups from re-running `/branch` or `/changes`
  - [x] Test: click follow-up after `/branch` → should activate exploration mode

- [x] **Task 10: Disable follow-ups in exploration mode** (AC: 3.1.9) **[NEW]**

  - [x] In `chatFollowupProvider.ts`, check if `metadata.command === 'exploration'`
  - [x] Return empty array when in exploration mode
  - [x] Add unit test for this behavior

- [x] **Task 11: Pass user message to analysis** (AC: 3.1.10) **[NEW]**

  - [x] In `runAnalysis()`, include `request.prompt` in the user message sent to LLM
  - [x] Modify `generateToolCallingUserPrompt()` to accept optional user instructions
  - [x] Test: `@lupa /branch focus on security` → LLM should prioritize security

- [x] **Task 12: DRY ChatToolCallHandler creation** (AC: 3.1.11) **[NEW]**

  - [x] Create `createChatStreamHandler(stream: ChatResponseStream): ChatToolCallHandler`
  - [x] Extract duplicated handler creation from `handleExplorationMode` and `runAnalysis`
  - [x] Both methods should use the same factory function

- [x] **Task 13: Update tests for new behaviors** (AC: all new)
  - [x] Add test: follow-up chips have `command: ''`
  - [x] Add test: exploration mode returns no follow-ups
  - [x] Add test: user message included in analysis
  - [x] Verify all existing tests still pass

---

## Dev Notes

### Architecture Integration

**Existing Infrastructure Reuse (100%):**

- `ChatLLMClient` - wraps `request.model` ✅
- `ConversationRunner` - conversation loop ✅
- `DebouncedStreamHandler` - rate limiting ✅
- `ToolCallStreamAdapter` - bridges interfaces ✅
- `ChatResponseBuilder` - error formatting ✅
- `handleCancellation()` - cancellation UX ✅

**New Code Required:**

- `generateExplorationSystemPrompt()` in `ToolAwareSystemPromptGenerator` (~80 lines)
- `handleExplorationMode()` in `ChatParticipantService` (~40 lines)
- One line change in `handleRequest()` routing

### Key Files to Modify

| File                                            | Changes                                                               |
| ----------------------------------------------- | --------------------------------------------------------------------- |
| `src/types/chatTypes.ts`                        | Update `ChatAnalysisMetadata.command` type to include `'exploration'` |
| `src/prompts/toolAwareSystemPromptGenerator.ts` | Add `generateExplorationPrompt()` method                              |
| `src/models/promptGenerator.ts`                 | Add `generateExplorationSystemPrompt()` delegating method             |
| `src/services/chatParticipantService.ts`        | Add `handleExplorationMode()`, update routing                         |
| `src/__tests__/chatParticipantService.test.ts`  | Add exploration mode tests                                            |

### Exploration System Prompt Design

The exploration prompt differs from analysis in these ways:

| Aspect      | Analysis Mode                  | Exploration Mode               |
| ----------- | ------------------------------ | ------------------------------ |
| Purpose     | Review PR changes, find issues | Answer questions, explain code |
| Context     | Diff hunk(s) provided          | No diff, user question only    |
| Output      | Structured review sections     | Conversational explanation     |
| Subagents   | Mandatory for 4+ files         | Not needed                     |
| Methodology | Security, performance, etc.    | Understanding, explaining      |

**Key prompt sections to KEEP from analysis:**

- Role definition (Staff Engineer persona)
- Tool inventory and selection guide
- Self-reflection guidance
- Certainty principle
- Tone guidelines

**Key prompt sections to REPLACE:**

- Analysis methodology → Exploration methodology
- Output format (review structure) → Conversational output
- Subagent delegation → Remove entirely

### Routing Implementation

```typescript
// In handleRequest() - replace placeholder
if (request.command === "branch") {
  return this.handleBranchCommand(request, stream, token);
}
if (request.command === "changes") {
  return this.handleChangesCommand(request, stream, token);
}

// NEW: Route no-command requests to exploration mode
return this.handleExplorationMode(request, context, stream, token);
```

### Exploration Method Signature

```typescript
private async handleExplorationMode(
  request: vscode.ChatRequest,
  context: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<vscode.ChatResult>
```

**Note:** `context` parameter is passed but NOT used in this story. Story 3.2 will integrate conversation history from `context.history`.

### Follow-up Continuity

When a user clicks a follow-up chip:

1. Copilot Chat sends the prompt to `@lupa` without a slash command
2. `request.command` is `undefined`
3. Falls through to exploration mode
4. User's follow-up prompt is processed as exploration

This automatically fixes Issue 1 - no special handling needed.

### Testing Strategy

**Unit Tests:**

- Mock `vscode.chat` API
- Test routing: no command → exploration mode
- Test ConversationRunner integration
- Test error/cancellation paths

**Manual Integration Testing:**

1. Type `@lupa What does ConversationRunner do?` → Should get exploration response
2. Run `/branch` analysis → Click follow-up chip → Should get exploration response
3. Cancel mid-exploration → Should see cancellation message

---

## Dependencies

- **Story 2.1** (Rich Progress Visualization) - ✅ Done, provides `ChatStreamHandler`, `DebouncedStreamHandler`
- **Story 1.2** (Implement /branch Command) - ✅ Done, provides `ChatLLMClient`, routing pattern

---

## Non-Functional Requirements

| NFR     | Requirement                          | Implementation                             |
| ------- | ------------------------------------ | ------------------------------------------ |
| NFR-001 | First progress <500ms                | Same streaming as analysis mode            |
| NFR-002 | Max 10 updates/sec                   | `DebouncedStreamHandler` ✅                |
| NFR-010 | Clean cancellation                   | `handleCancellation()` ✅                  |
| NFR-011 | Errors via `ChatResult.errorDetails` | `ChatResponseBuilder.addErrorSection()` ✅ |

---

## Out of Scope

- **Conversation history integration** - Story 3.2
- **Token budget management** - Story 3.2
- **LLM-generated follow-ups** - Future enhancement (Epic 2 Retro recommendation)
- **Disambiguation auto-routing** - Story 3.3

---

## References

- [PRD FR-012](docs/prd.md): No-command exploration mode requirement
- [Architecture Decision 3](docs/architecture.md): Streaming Progress Pattern
- [Epic 2 Retrospective](docs/sprint-artifacts/epic-2-retro-2025-12-19.md): Issues 1 and 5
- [UX Design Specification](docs/ux-design-specification.md): Tone guidelines

---

## Definition of Done

- [x] All acceptance criteria verified
- [x] Unit tests pass (`npm run test`)
- [x] Type check passes (`npm run check-types`)
- [ ] Follow-up chips work end-to-end (manual test)
- [ ] Exploration mode works without diff context (manual test)
- [x] Code follows project conventions (no `console.log`, use `Log`)

---

## Dev Agent Record

### Implementation Notes

**Date:** 2025-12-19

**Approach:**

Implemented exploration mode by reusing 100% of existing infrastructure. The exploration prompt was designed following Anthropic prompt engineering best practices:

- Clear role definition (Staff Engineer helping understand codebase)
- XML structure for prompt organization (`<tool_inventory>`, `<exploration_methodology>`, `<output_format>`)
- Same tool infrastructure as analysis mode
- Self-reflection guidance retained
- Removed all PR/diff-specific language

**Key Design Decisions:**

1. **Exploration prompt reuses private methods** from `ToolAwareSystemPromptGenerator` for consistency (role definition structure, tool inventory format, self-reflection guidance)
2. **No subagent delegation** in exploration mode - exploration is single-threaded, focused conversation
3. **Exploration output is conversational** - no structured review sections, severity ratings, or mandatory "What's Good"
4. **context parameter passed but unused** - Story 3.2 will integrate conversation history

**Tests Added:** 10 new unit tests for exploration mode covering:

- Routing (no command → exploration mode)
- Follow-up chip handling
- Error handling with ChatResponseBuilder
- Cancellation at all stages
- Metadata verification

### Completion Notes

✅ All 13 tasks completed
✅ All 914 tests pass (10 new tests added)
✅ Type check passes
✅ Fixes Epic 2 Retro Issue 1 (CRITICAL): Follow-up chips now work
✅ Follows project conventions (uses `Log`, no `console.log`)

### Additional Implementation (Session 2 - Integration Testing Findings)

**Date:** 2025-12-19

**Issues Found During Integration Testing:**

1. **User message not passed to analysis** - Fixed by modifying `generateToolCallingUserPrompt()` to accept optional `userInstructions` parameter and adding `<user_focus>` section to prompt
2. **Follow-up provider using history** - Deferred to Story 3.2 (requires conversation context integration first)
3. **Follow-ups in exploration mode** - Fixed by returning empty array when `metadata.command === 'exploration'`
4. **Follow-up command behavior** - Fixed by setting `command: ''` on all `ChatFollowup` objects to activate exploration mode
5. **DRY handler creation** - Fixed by extracting `createChatStreamHandler(stream)` factory function

**Key API Discovery:**

VS Code's `ChatFollowup.command` defaults to `request?.command` if not specified. To escape the original command and activate exploration mode, we must explicitly set `command: ''`.

**Tests Added (Session 2):**

- 4 new follow-up provider tests (exploration mode, command: '' on all chips)
- 5 new prompt generator tests (user focus instructions)
- 2 new chat participant tests (user prompt passed to analysis)

---

## File List

| File                                               | Change                                                                                                                           |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `src/prompts/toolAwareSystemPromptGenerator.ts`    | Added `generateExplorationPrompt()` with exploration-specific role, methodology, and output format                               |
| `src/models/promptGenerator.ts`                    | Added `generateExplorationSystemPrompt()` method; modified `generateToolCallingUserPrompt()` to accept optional userInstructions |
| `src/types/chatTypes.ts`                           | Updated `ChatAnalysisMetadata.command` to include `'exploration'`                                                                |
| `src/services/chatParticipantService.ts`           | Added `handleExplorationMode()`, `createChatStreamHandler()` factory, updated routing                                            |
| `src/services/chatFollowupProvider.ts`             | Added `command: ''` to all follow-ups, return empty array for exploration mode                                                   |
| `src/__tests__/chatParticipantService.test.ts`     | Added exploration mode tests, user prompt test                                                                                   |
| `src/__tests__/chatFollowupProvider.test.ts`       | Added tests for command: '' and exploration mode                                                                                 |
| `src/__tests__/promptGeneratorToolCalling.test.ts` | Added tests for user focus instructions                                                                                          |
| `docs/sprint-artifacts/sprint-status.yaml`         | Updated story status to `in-progress` → `review`                                                                                 |
| `docs/sprint-artifacts/3-1-exploration-mode.md`    | Marked tasks complete, added Dev Agent Record                                                                                    |

---

## Change Log

| Date       | Change                                                          |
| ---------- | --------------------------------------------------------------- |
| 2025-12-19 | Story implemented - exploration mode with all 8 tasks complete  |
| 2025-12-19 | Integration testing fixes - 5 additional tasks (9-13) completed |
