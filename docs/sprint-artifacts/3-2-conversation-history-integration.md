# Story 3.2: Conversation History Integration

**Status:** done
**Epic:** 3 - Exploration Mode & Polish
**Story ID:** 3.2
**Created:** 2025-12-19
**Priority:** 🟠 HIGH (Fixes Epic 2 Retro Issues 3 & 4)

---

## Story

**As a** developer using `@lupa` exploration mode,
**I want** follow-up questions to have context from my previous conversation,
**So that** I can ask contextual questions about prior analysis without repeating myself.

---

## Business Context

This story addresses two **HIGH priority issues** from the Epic 2 retrospective:

| Issue   | Severity | Description                                    |
| ------- | -------- | ---------------------------------------------- |
| Issue 3 | 🟠 HIGH  | History not integrated—follow-ups lack context |
| Issue 4 | 🟠 HIGH  | `ChatContextManager` does not exist            |

**User Impact:** Without conversation history, follow-up questions after analysis feel disconnected. Users must repeat context, and the assistant cannot reference prior findings.

**Technical Context:** VS Code Chat Participant API provides full conversation history via `ChatContext.history`, but extensions are **fully responsible** for token budget management. VS Code does not truncate or summarize history automatically.

---

## Acceptance Criteria

### AC-3.2.1: Mode-Specific History Behavior

**Given** the design decision from Epic 1 retrospective
**When** handling chat requests
**Then** history behavior MUST follow:

| Mode                  | Include History? | Rationale                                           |
| --------------------- | ---------------- | --------------------------------------------------- |
| `/branch` command     | ❌ NO            | Fresh diff analysis, token budget protection        |
| `/changes` command    | ❌ NO            | Fresh diff analysis, token budget protection        |
| `@lupa` (exploration) | ✅ YES           | Follow-ups need context                             |
| Follow-up chips       | ✅ YES           | Continuation of conversation (triggers exploration) |

**And** progress message for exploration mode SHOULD indicate when history is included (e.g., "💭 Continuing conversation...")

### AC-3.2.2: ChatContextManager Class

**Given** the architecture.md Decision 12 specification
**When** creating the `ChatContextManager` class
**Then** the class MUST:

- Be located at `src/models/chatContextManager.ts`
- Export a class named `ChatContextManager`
- Provide `prepareConversationHistory()` method that:
  - Accepts `ChatContext.history` array
  - Accepts `LanguageModelChat` for token counting
  - Accepts system prompt string for budget calculation
  - Returns `Message[]` compatible with `ConversationManager`
- Manage token budget using `model.maxInputTokens`
- Reserve at least 4000 tokens for model output (`OUTPUT_RESERVE`)
- Target 80% of available budget for input (`BUDGET_THRESHOLD`)

### AC-3.2.3: History Extraction

**Given** a chat request in exploration mode
**When** extracting history from `ChatContext.history`
**Then** the extraction MUST:

- Iterate over `ChatRequestTurn` and `ChatResponseTurn` objects
- Convert `ChatRequestTurn.prompt` to user messages
- Convert `ChatResponseTurn.response` parts to assistant messages
  - Extract text from `ChatResponseMarkdownPart.value.value`
  - Concatenate multiple parts into single content string
  - Skip non-text parts (fileTree, anchor, commandButton)
- Preserve chronological order of turns

### AC-3.2.4: Token Budget Tracking

**Given** the need to prevent context overflow
**When** preparing conversation history
**Then** `ChatContextManager` MUST:

- Count tokens via `model.countTokens()` for EACH message individually
  - **Note:** `countTokens()` only accepts single messages, not arrays
- Calculate available budget: `(maxInputTokens - OUTPUT_RESERVE) * BUDGET_THRESHOLD`
- Subtract system prompt token cost from budget
- Track cumulative token usage as history is processed

### AC-3.2.5: Sliding Window Truncation

**Given** cumulative context approaches 80% of `model.maxInputTokens`
**When** truncating history
**Then** the handler MUST:

- Process history **newest-first** until budget exhausted
- Prioritize: system prompt > current request > recent history > older history
- Drop older history turns first
- Log warning when truncation occurs: `[ChatContextManager]: Truncating history at turn X`
- Return only the turns that fit within budget

### AC-3.2.6: ConversationManager History Injection

**Given** prepared history messages
**When** setting up the conversation for exploration mode
**Then** `ConversationManager` MUST:

- Support injecting history messages before the current user message
- Provide `prependHistoryMessages(messages: Message[]): void` method
- Maintain message order: [history...] → [current user message]

### AC-3.2.7: Exploration Mode Integration

**Given** the `handleExplorationMode()` method from Story 3.1
**When** a user asks a follow-up question
**Then** the handler MUST:

- Create `ChatContextManager` instance
- Prepare history via `prepareConversationHistory()`
- Inject history into `ConversationManager` before adding current message
- Pass the prepared conversation to `ConversationRunner`

### AC-3.2.8: Copilot Summarization Awareness

**Given** Copilot Chat may summarize conversation history
**When** history contains summarized content
**Then** the handler MUST:

- Accept that participant attribution is lost in summaries
- NOT rely on detecting "what we said" vs "what Copilot said"
- Treat ALL history as context, not authoritative source
- Process summarized text the same as regular responses

### AC-3.2.9: Error Handling

**Given** token counting or history processing may fail
**When** an error occurs
**Then** the handler MUST:

- Catch errors gracefully
- Fall back to no history (exploration without context)
- Log warning: `[ChatContextManager]: History processing failed, continuing without history`
- NOT block the exploration request

### AC-3.2.10: Performance

**Given** history may be large
**When** processing tokens
**Then** the implementation MUST:

- Process token counting asynchronously
- NOT block UI during token counting
- Complete history preparation in under 500ms for typical conversations (10-20 turns)

---

## Tasks / Subtasks

- [x] **Task 1: Create ChatContextManager class** (AC: 3.2.2, 3.2.4, 3.2.5)

  - [x] Create `src/models/chatContextManager.ts`
  - [x] Define constants: `OUTPUT_RESERVE = 4000`, `BUDGET_THRESHOLD = 0.8`
  - [x] Implement `prepareConversationHistory()` method
  - [x] Implement token budget tracking with `model.countTokens()`
  - [x] Implement newest-first sliding window truncation
  - [x] Add logging for truncation events

- [x] **Task 2: Implement history extraction** (AC: 3.2.3)

  - [x] Create `extractTextFromTurn()` helper for ChatRequestTurn
  - [x] Create `extractTextFromResponse()` helper for ChatResponseTurn
  - [x] Handle ChatResponseMarkdownPart extraction
  - [x] Skip non-text parts (fileTree, anchor, etc.)
  - [x] Handle edge cases: empty responses, tool-only responses

- [x] **Task 3: Add ConversationManager history support** (AC: 3.2.6)

  - [x] Add `prependHistoryMessages(messages: Message[]): void` method
  - [x] Ensure history is inserted at the beginning of the conversation
  - [x] Maintain immutability with deep cloning

- [x] **Task 4: Integrate in handleExplorationMode()** (AC: 3.2.1, 3.2.7)

  - [x] Remove underscore from `_context` parameter (now used)
  - [x] Create `ChatContextManager` instance
  - [x] Call `prepareConversationHistory()` with context.history
  - [x] Call `conversation.prependHistoryMessages()` with result
  - [x] Update progress message: "💭 Continuing conversation..."
  - [x] Add fallback for empty history case

- [x] **Task 5: Add error handling and logging** (AC: 3.2.8, 3.2.9)

  - [x] Wrap history processing in try/catch
  - [x] Log truncation with turn count
  - [x] Fall back gracefully on errors
  - [x] Log warning when history is summarized

- [x] **Task 6: Create unit tests for ChatContextManager** (AC: all)

  - [x] Test token budget calculation
  - [x] Test sliding window truncation (newest-first)
  - [x] Test history extraction from ChatRequestTurn
  - [x] Test history extraction from ChatResponseTurn
  - [x] Test handling of non-text response parts
  - [x] Test error fallback behavior
  - [x] Test empty history handling

- [x] **Task 7: Create integration tests** (AC: 3.2.7)

  - [x] Test exploration mode with history
  - [x] Test follow-up continuity with context
  - [x] Test truncation logging
  - [x] Verify commands still don't include history

- [x] **Task 8: Update sprint-status.yaml** (AC: N/A)
  - [x] Mark story as `in-progress` when starting
  - [x] Mark story as `review` when complete

---

## Dev Notes

### Architecture Integration

**New Class Location:**

```
src/
├── models/
│   └── chatContextManager.ts  # NEW - Token budget and history management
```

**Key Integration Points:**

```typescript
// In handleExplorationMode() - after Story 3.2
private async handleExplorationMode(
  request: vscode.ChatRequest,
  context: vscode.ChatContext,  // Now used (remove underscore)
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<vscode.ChatResult> {
  // ... existing setup ...

  // NEW: Prepare conversation history
  const contextManager = new ChatContextManager();
  const historyMessages = await contextManager.prepareConversationHistory(
    context.history,
    request.model,
    systemPrompt
  );

  if (historyMessages.length > 0) {
    stream.progress(`${ACTIVITY.thinking} Continuing conversation...`);
    conversation.prependHistoryMessages(historyMessages);
  }

  conversation.addUserMessage(request.prompt);
  // ... rest of exploration logic ...
}
```

### Token Counting API Constraints

From the research document, critical constraint:

> `countTokens()` accepts a string or single `LanguageModelChatMessage`, **NOT an array**

**Implementation Pattern:**

```typescript
async countConversationTokens(
  model: vscode.LanguageModelChat,
  messages: Message[],
  token: vscode.CancellationToken
): Promise<number> {
  let total = 0;
  for (const message of messages) {
    // Convert Message to string for counting
    const count = await model.countTokens(message.content ?? '', token);
    total += count;
  }
  return total;
}
```

### History Conversion Logic

```typescript
// ChatRequestTurn → Message
function convertRequestTurn(turn: vscode.ChatRequestTurn): Message {
  return {
    role: "user",
    content: turn.prompt,
  };
}

// ChatResponseTurn → Message
function convertResponseTurn(turn: vscode.ChatResponseTurn): Message {
  // Extract text from markdown parts
  const textParts = turn.response
    .filter(
      (part): part is vscode.ChatResponseMarkdownPart =>
        part instanceof vscode.ChatResponseMarkdownPart
    )
    .map((part) => part.value.value);

  return {
    role: "assistant",
    content: textParts.join("\n") || "[No text content]",
  };
}
```

**Note:** VS Code response parts are class instances. Need to check part types carefully:

- `ChatResponseMarkdownPart` - text content
- `ChatResponseFileTreePart` - file tree (skip)
- `ChatResponseAnchorPart` - clickable anchor (skip)
- `ChatResponseCommandButtonPart` - button (skip)

### Sliding Window Algorithm

```typescript
async prepareConversationHistory(
  history: ReadonlyArray<vscode.ChatRequestTurn | vscode.ChatResponseTurn>,
  model: vscode.LanguageModelChat,
  systemPrompt: string
): Promise<Message[]> {
  const maxTokens = model.maxInputTokens - this.OUTPUT_RESERVE;
  const targetTokens = maxTokens * this.BUDGET_THRESHOLD;

  // Reserve tokens for system prompt
  const systemTokens = await model.countTokens(systemPrompt);
  let availableTokens = targetTokens - systemTokens;

  // Process newest-first
  const prepared: Message[] = [];
  for (let i = history.length - 1; i >= 0 && availableTokens > 0; i--) {
    const turn = history[i];
    const message = this.convertTurn(turn);
    const tokenCount = await model.countTokens(message.content ?? '');

    if (tokenCount > availableTokens) {
      Log.info(`[ChatContextManager]: Truncating history at turn ${i}`);
      break;
    }

    prepared.unshift(message);  // Add to front to maintain order
    availableTokens -= tokenCount;
  }

  return prepared;
}
```

### Testing Strategy

**Unit Tests (ChatContextManager):**

- Mock `model.countTokens()` to return predictable values
- Test truncation triggers at budget threshold
- Test empty history returns empty array
- Test error handling returns empty array

**Integration Tests (ChatParticipantService):**

- Mock `ChatContext.history` with test turns
- Verify history is passed to ConversationManager
- Verify commands don't include history (regression)

### Error Handling Pattern

```typescript
try {
  const historyMessages = await contextManager.prepareConversationHistory(...);
  conversation.prependHistoryMessages(historyMessages);
} catch (error) {
  Log.warn('[ChatParticipantService]: History processing failed, continuing without', error);
  // Continue without history - exploration still works
}
```

---

## Dependencies

- **Story 3.1** (Exploration Mode) - ✅ Done, provides `handleExplorationMode()` structure
- **Story 1.2** (Implement /branch Command) - ✅ Done, provides routing pattern

---

## Non-Functional Requirements

| NFR         | Requirement           | Implementation                                       |
| ----------- | --------------------- | ---------------------------------------------------- |
| NFR-001     | First progress <500ms | History processing async, progress shown immediately |
| NFR-002     | Max 10 updates/sec    | Uses existing `DebouncedStreamHandler`               |
| NFR-010     | Clean cancellation    | Token passed to `countTokens()`                      |
| Performance | <500ms for 20 turns   | Async iteration, no blocking                         |

---

## Out of Scope

Per Epic 2 retrospective recommendations:

- **LLM-generated follow-ups** - Separate enhancement (see Epic 2 Retro recommendation)
- **LLM-based summarization** - Too complex, simple truncation sufficient for MVP
- **History for `/branch` and `/changes`** - Intentionally excluded (fresh analysis each time)
- **ChatSummarizer proposed API** - Not stable, avoid proposed APIs per project constraints

---

## Technical Debt Addressed

This story resolves technical debt from Epic 1:

> "The `context` parameter is passed but NOT used in this story. Story 3.2 will integrate conversation history from `context.history`."
> — Story 3.1 Dev Notes

---

## References

- [Architecture Decision 12](docs/architecture.md#decision-12-context-window-management-strategy): Context Window Management Strategy
- [Research: Context Window Management](docs/research/context-window-management.md): API constraints and patterns
- [Epic 2 Retrospective](docs/sprint-artifacts/epic-2-retro-2025-12-19.md): Issues 3 and 4
- [PRD FR-012](docs/prd.md): Exploration mode requirement

---

## Definition of Done

- [x] All acceptance criteria verified
- [x] Unit tests pass (`npm run test`) - 941 tests passing
- [x] Type check passes (`npm run check-types`)
- [x] History included in exploration follow-ups (verified via tests)
- [x] Commands still don't include history (regression test)
- [x] Token truncation logs warning (verified via tests)
- [x] Code follows project conventions (no `console.log`, use `Log`)

---

## Dev Agent Record

### Context Reference

- Story file: `docs/sprint-artifacts/3-2-conversation-history-integration.md`
- Architecture: `CLAUDE.md`, `.github/copilot-instructions.md`

### Agent Model Used

Claude Opus 4.5 (via GitHub Copilot)

### Implementation Notes

**Implementation completed 2025-12-19:**

1. **ChatContextManager** created at `src/models/chatContextManager.ts`:

   - Implements sliding window truncation (newest-first processing)
   - Token budget: `(maxInputTokens - 4000) * 0.8` after system prompt
   - Extracts text from `ChatResponseMarkdownPart.value.value`
   - Skips non-text parts (fileTree, anchor, commandButton)
   - Graceful error handling with fallback to empty history

2. **ConversationManager** enhanced with `prependHistoryMessages()`:

   - Deep clones messages for immutability
   - Prepends at beginning to maintain [history...] → [current] order

3. **ChatParticipantService** integration:

   - Mode-specific history behavior per AC-3.2.1
   - Progress message "Continuing conversation..." when history present
   - Try/catch wrapper for graceful degradation

4. **Test coverage**: 18 unit tests for ChatContextManager, 6 new integration tests, all 941 tests passing

---

## File List

| File                                           | Change                                                  |
| ---------------------------------------------- | ------------------------------------------------------- |
| `src/models/chatContextManager.ts`             | **NEW** - Token budget tracking and history preparation |
| `src/models/conversationManager.ts`            | Add `prependHistoryMessages()` method                   |
| `src/services/chatParticipantService.ts`       | Integrate ChatContextManager in exploration mode        |
| `src/__tests__/chatContextManager.test.ts`     | **NEW** - Unit tests for ChatContextManager (18 tests)  |
| `src/__tests__/conversationManager.test.ts`    | Add prependHistoryMessages tests (6 tests)              |
| `src/__tests__/chatParticipantService.test.ts` | Add history integration tests (4 tests)                 |
| `__mocks__/vscode.js`                          | Add chat response part mocks                            |
| `docs/sprint-artifacts/sprint-status.yaml`     | Update story status                                     |

---

## Change Log

| Date       | Change                                                                      |
| ---------- | --------------------------------------------------------------------------- |
| 2025-12-19 | Story created via SM agent `*create-story` workflow with Party Mode         |
| 2025-12-19 | Implementation completed - All ACs met, 941 tests passing, ready for review |
| 2025-12-20 | Code Review completed - Fixed logging severity and markdown joining         |
