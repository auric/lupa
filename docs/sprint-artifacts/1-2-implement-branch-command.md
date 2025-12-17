# Story 1.2: Implement /branch Command

**Status:** Ready for Review
**Epic:** 1 - Core Chat Participant
**Story ID:** 1.2
**Estimated Effort:** M (1-2 days)
**Created:** 2025-12-17

---

## Story

**As a** developer,
**I want to** type `@lupa /branch` to analyze my current branch,
**So that** I can review changes before creating a PR.

---

## Acceptance Criteria

### AC-1.2.1: ChatLLMClient Creation

**Given** the ILLMClient interface from Epic 0
**When** implementing `ChatLLMClient`
**Then** the class MUST:

- Accept `vscode.LanguageModelChat` and `timeoutMs` in constructor
- Implement `ILLMClient` interface with `sendRequest()` and `getCurrentModel()` methods
- Delegate `sendRequest()` to `ModelRequestHandler.sendRequest()`
- Timeout MUST come from `WorkspaceSettingsService.getRequestTimeoutSeconds()` (converted to ms)
- Be located at `src/models/chatLLMClient.ts`

```typescript
export class ChatLLMClient implements ILLMClient {
  constructor(
    private readonly model: vscode.LanguageModelChat,
    private readonly timeoutMs: number // from WorkspaceSettingsService
  ) {}

  async sendRequest(
    request: ToolCallRequest,
    token: CancellationToken
  ): Promise<ToolCallResponse>;
  async getCurrentModel(): Promise<LanguageModelChat>;
}
```

### AC-1.2.2: Command Routing

**Given** a chat request with `request.command?.name === 'branch'`
**When** handling the request in `ChatParticipantService`
**Then** the handler MUST:

1. Create `ChatLLMClient` from `request.model` with timeout from `WorkspaceSettingsService`
2. Get `ToolExecutor` from injected dependencies
3. Create `ConversationRunner` with the `ChatLLMClient` and `ToolExecutor`
4. Call `GitService.getInstance().compareBranches({})` to get diff
5. Handle empty/error diff gracefully with helpful message
6. Create a new `ConversationManager` for the conversation
7. Generate system prompt via `ToolAwareSystemPromptGenerator`
8. Execute `conversationRunner.run()` with config and handler

### AC-1.2.3: Streaming to Chat with Debouncing

**Given** the ConversationRunner is executing
**When** progress events occur
**Then** progress updates MUST be rate-limited via `DebouncedStreamHandler` (NFR-002: max 10 updates/sec)
**And** progress messages MUST use emoji from `chatEmoji.ts` (ACTIVITY.reading, ACTIVITY.searching, etc.)
**And** first progress message MUST appear within 500ms of command invocation (NFR-001)
**And** LLM response text MUST be streamed via `stream.markdown()`
**And** `debouncedHandler.flush()` MUST be called at end of analysis

### AC-1.2.4: ToolCallStreamAdapter Class (DRY Compliance)

**Given** ConversationRunner uses `ToolCallHandler` (from conversationRunner.ts)
**And** chat streaming uses `ChatToolCallHandler` (from chatTypes.ts)
**When** integrating these systems
**Then** the implementation MUST create a **reusable `ToolCallStreamAdapter` class**:

**Requirements:**

- Create `src/models/toolCallStreamAdapter.ts`
- Class MUST implement `ToolCallHandler` interface
- Constructor MUST accept `ChatToolCallHandler`
- Forward `onIterationStart` → `chatHandler.onProgress()` with turn count and ACTIVITY.thinking
- Forward `onToolCallStart` → `chatHandler.onToolStart()`
- Forward `onToolCallComplete` → `chatHandler.onToolComplete()` with success/failure summary
- Add JSDoc explaining the adapter's purpose and referencing Architecture Decision 10
- Unit tests MUST verify all forwarding behavior

**Implementation:**

```typescript
// src/models/toolCallStreamAdapter.ts
import { ToolCallHandler } from "./conversationRunner";
import { ChatToolCallHandler } from "../types/chatTypes";
import { ACTIVITY } from "../config/chatEmoji";

/**
 * Adapts ConversationRunner's ToolCallHandler to ChatToolCallHandler for UI streaming.
 * Bridges the gap between internal conversation events and external UI updates.
 * @see Architecture Decision 10 in docs/architecture.md
 */
export class ToolCallStreamAdapter implements ToolCallHandler {
  constructor(private readonly chatHandler: ChatToolCallHandler) {}

  onIterationStart(current: number, max: number): void {
    this.chatHandler.onProgress(
      `Turn ${current}/${max}: ${ACTIVITY.thinking} Analyzing...`
    );
  }

  onToolCallStart(
    toolName: string,
    _toolIndex: number,
    _totalTools: number
  ): void {
    this.chatHandler.onToolStart(toolName, {});
  }

  onToolCallComplete(
    _toolCallId: string,
    toolName: string,
    _args: Record<string, unknown>,
    _result: string,
    success: boolean,
    error?: string
  ): void {
    const summary = success ? "completed" : error || "failed";
    this.chatHandler.onToolComplete(toolName, success, summary);
  }
}
```

### AC-1.2.5: Three-Layer Streaming Architecture

**Given** the ToolCallStreamAdapter from AC-1.2.4
**When** handling the /branch command
**Then** the implementation MUST use a three-layer pattern:

**Layer 1 - UI Streaming (ChatToolCallHandler):**

- Create simple handler implementing `ChatToolCallHandler` that calls `stream.*` methods

**Layer 2 - Rate Limiting (DebouncedStreamHandler):**

- Wrap Layer 1 with `DebouncedStreamHandler` for NFR-002 compliance

**Layer 3 - Adapter (ToolCallStreamAdapter):**

- Wrap Layer 2 with `ToolCallStreamAdapter`
- Pass Layer 3 to `conversationRunner.run()`

```typescript
// Layer 1: UI streaming (ChatToolCallHandler)
const uiHandler: ChatToolCallHandler = {
  onProgress: (msg) => stream.progress(msg),
  onToolStart: () => {},
  onToolComplete: () => {},
  onFileReference: () => {},
  onThinking: (thought) => stream.progress(`${ACTIVITY.thinking} ${thought}`),
  onMarkdown: (content) => stream.markdown(content),
};

// Layer 2: Rate limiting (decorator)
const debouncedHandler = new DebouncedStreamHandler(uiHandler);

// Layer 3: Adapter (bridges interfaces)
const adapter = new ToolCallStreamAdapter(debouncedHandler);

// Execute with adapter
const analysisResult = await runner.run(config, conversation, token, adapter);
debouncedHandler.flush(); // Ensure final message sent
stream.markdown(analysisResult);
```

### AC-1.2.6: Empty/Error Diff Handling

**Given** no changes exist between current branch and default branch
**When** the /branch command is invoked
**Then** the handler MUST:

- Detect `diffResult.error` or empty `diffResult.diffText`
- Stream a helpful message using `ChatResponseBuilder`
- Use supportive tone per UX guidelines
- Return success (not error) for empty diffs

```markdown
## ✅ No Changes Found

Your branch appears to be up-to-date with the default branch. Nothing to analyze!
```

### AC-1.2.7: Error Handling

**Given** an error occurs during analysis
**When** the error is caught
**Then** `ChatResult.errorDetails` MUST contain the error message
**And** `responseIsIncomplete` MUST be `true`
**And** error messages MUST use supportive tone from UX guidelines

### AC-1.2.8: Unit Tests

**Given** the ChatLLMClient, ToolCallStreamAdapter, and /branch command handling
**When** running tests
**Then** tests MUST cover:

- ChatLLMClient implements ILLMClient correctly
- `sendRequest()` delegates to ModelRequestHandler
- `getCurrentModel()` returns the wrapped model
- /branch command routes correctly and calls GitService
- Empty diff handling returns helpful message
- Error handling returns ChatResult with errorDetails

---

## Technical Implementation

### Architecture Integration

This story connects Epic 0 foundations with the chat participant:

```
┌─────────────────────────────────────────────────────────────────┐
│                    ChatParticipantService                        │
│  handleRequest() → /branch routing                               │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                ▼
┌───────────────────────────────────────────────────────────────────┐
│  1. ChatLLMClient(request.model)    ← NEW: wraps chat model       │
│  2. ConversationRunner(client, toolExecutor)                      │
│  3. GitService.compareBranches({})                                │
│  4. conversationRunner.run(config, convo, token, handler)         │
└───────────────────────────────────────────────────────────────────┘
```

### ConversationRunner Integration

The `ConversationRunner` already accepts `ILLMClient` (Story 0.3). The key insight is that we create `ChatLLMClient` wrapping `request.model` and pass it in:

```typescript
// In handleBranchCommand
const client = new ChatLLMClient(request.model);
const runner = new ConversationRunner(client, this.toolExecutor);
```

### Handler Bridging (Three-Layer Architecture)

Two handler interfaces exist with **different purposes and signatures**:

1. `ToolCallHandler` (conversationRunner.ts) - ConversationRunner callbacks

   - `onIterationStart(current, max)`
   - `onToolCallComplete(id, name, args, result, success, error?, durationMs?, metadata?)`

2. `ChatToolCallHandler` (chatTypes.ts) - UI streaming abstraction
   - `onProgress(message)`
   - `onToolStart/Complete(name, args/success, summary)`
   - `onFileReference`, `onThinking`, `onMarkdown`

**Three-Layer Architecture:**

```
ConversationRunner
       │
       ▼ (ToolCallHandler callbacks)
ToolCallStreamAdapter  ← NEW: reusable adapter class
       │
       ▼ (ChatToolCallHandler methods)
DebouncedStreamHandler  ← rate limiting (NFR-002)
       │
       ▼ (ChatToolCallHandler methods)
   UI Handler
       │
       ▼ (stream.* calls)
ChatResponseStream
```

The `ToolCallStreamAdapter` class (created in AC-1.2.4) provides a DRY, SOLID-compliant bridge between the interfaces.

### GitService Usage

The `GitService` provides:

```typescript
// Get diff to default branch
const diffResult = await GitService.getInstance().compareBranches({});
// Returns: { diffText: string, refName: string, error?: string }

// Check for errors/empty
if (diffResult.error || !diffResult.diffText) {
  // Handle gracefully
}
```

### System Prompt Generation

Use `ToolAwareSystemPromptGenerator` from existing codebase:

```typescript
const promptGenerator = new ToolAwareSystemPromptGenerator();
const systemPrompt = promptGenerator.generateSystemPrompt(availableTools);
```

---

## Tasks / Subtasks

- [x] **Task 1: Create ChatLLMClient** (AC: 1.2.1)

  - [x] Create `src/models/chatLLMClient.ts`
  - [x] Implement `ILLMClient` interface
  - [x] Delegate `sendRequest()` to `ModelRequestHandler.sendRequest()`
  - [x] Return wrapped model from `getCurrentModel()`
  - [x] Add JSDoc documentation

- [x] **Task 2: Create ChatLLMClient Unit Tests** (AC: 1.2.7)

  - [x] Create `src/__tests__/chatLLMClient.test.ts`
  - [x] Test constructor stores model and timeout
  - [x] Test `sendRequest()` delegates to `ModelRequestHandler`
  - [x] Test `getCurrentModel()` returns wrapped model
  - [x] Mock `ModelRequestHandler.sendRequest` for isolation

- [x] **Task 3: Implement /branch Command Handler** (AC: 1.2.2, 1.2.3)

  - [x] Add `/branch` routing in `ChatParticipantService.handleRequest()`
  - [x] Create `ChatLLMClient` from `request.model`
  - [x] Get `ToolExecutor` via dependency injection from ServiceManager
  - [x] Create `ConversationRunner` with client and executor
  - [x] Call `GitService.getInstance().compareBranches({})`
  - [x] Create `ConversationManager` for history tracking
  - [x] Generate system prompt with `ToolAwareSystemPromptGenerator`
  - [x] Execute `conversationRunner.run()` with handler adapter

- [x] **Task 4: Create ToolCallStreamAdapter Class** (AC: 1.2.4)

  - [x] Create `src/models/toolCallStreamAdapter.ts`
  - [x] Implement `ToolCallHandler` interface
  - [x] Constructor accepts `ChatToolCallHandler`
  - [x] Forward `onIterationStart` → `chatHandler.onProgress()` with turn count
  - [x] Forward `onToolCallStart` → `chatHandler.onToolStart()`
  - [x] Forward `onToolCallComplete` → `chatHandler.onToolComplete()`
  - [x] Add JSDoc referencing Architecture Decision 10

- [x] **Task 5: Create ToolCallStreamAdapter Tests** (AC: 1.2.8)

  - [x] Create `src/__tests__/toolCallStreamAdapter.test.ts`
  - [x] Test `onIterationStart` forwards to `onProgress`
  - [x] Test `onToolCallStart` forwards to `onToolStart`
  - [x] Test `onToolCallComplete` forwards to `onToolComplete`
  - [x] Test success and failure summary formatting

- [x] **Task 6: Implement Three-Layer Handler Architecture** (AC: 1.2.3, 1.2.5)

  - [x] Create UI handler implementing `ChatToolCallHandler` for stream calls
  - [x] Wrap UI handler with `DebouncedStreamHandler` (NFR-002 compliance)
  - [x] Wrap with `ToolCallStreamAdapter` (bridges interfaces)
  - [x] Pass adapter to `conversationRunner.run()`
  - [x] Use `ACTIVITY` emoji constants for progress formatting
  - [x] Call `debouncedHandler.flush()` after `run()` completes
  - [x] Stream LLM final response via `stream.markdown()`

- [x] **Task 7: Handle Empty/Error Diffs** (AC: 1.2.6)

  - [x] Check `diffResult.error` and empty `diffResult.diffText`
  - [x] Use SEVERITY emoji for consistent formatting
  - [x] Return success result (not error) for empty diffs
  - [x] Use supportive tone per UX specification

- [x] **Task 8: Error Handling** (AC: 1.2.7)

  - [x] Wrap analysis in try/catch
  - [x] Return `ChatResult` with `errorDetails` on failure
  - [x] Set `responseIsIncomplete: true` on error
  - [x] Log errors via `Log.error()` with service prefix

- [x] **Task 9: Integration Tests** (AC: 1.2.8)

  - [x] Add tests to `chatParticipantService.test.ts`
  - [x] Test /branch routing invokes GitService
  - [x] Test empty diff returns helpful message
  - [x] Test error handling returns ChatResult.errorDetails
  - [x] Mock GitService, ConversationRunner, and stream

- [x] **Task 10: Verification**
  - [x] Run `npm run check-types` - no errors
  - [x] Run `npm run test` - all 814 tests pass
  - [ ] Manual test: `@lupa /branch` analyzes current branch

---

## Dev Notes

### File Structure

**Create:**

- `src/models/chatLLMClient.ts` - New ILLMClient implementation
- `src/models/toolCallStreamAdapter.ts` - Adapter bridging ToolCallHandler to ChatToolCallHandler
- `src/__tests__/chatLLMClient.test.ts` - ChatLLMClient unit tests
- `src/__tests__/toolCallStreamAdapter.test.ts` - Adapter unit tests

**Modify:**

- `src/services/chatParticipantService.ts` - Add /branch handler

### Dependencies from Epic 0

This story relies on these Epic 0 deliverables:

- `ILLMClient` interface (Story 0.1)
- `ModelRequestHandler.sendRequest()` (Story 0.1)
- `ConversationRunner` accepting `ILLMClient` (Story 0.3)
- `ACTIVITY` emoji from `chatEmoji.ts` (Story 0.4)
- `ChatToolCallHandler` interface (Story 0.4)
- `DebouncedStreamHandler` for rate limiting (Story 0.4)
- `ChatResponseBuilder` for formatted output (Story 0.5)

### Architecture Decision 10 Reference

This story implements the Three-Layer Streaming Architecture documented in Architecture Decision 10:

1. **UI Handler**: ChatToolCallHandler → stream.\* calls
2. **DebouncedStreamHandler**: Rate limits to 10 updates/sec (NFR-002)
3. **ToolCallStreamAdapter**: Bridges ToolCallHandler → ChatToolCallHandler

### ServiceManager Access Pattern

Get services via ServiceManager singleton:

```typescript
const serviceManager = ServiceManager.getInstance();
const toolExecutor = serviceManager.getToolExecutor();
const gitService = GitService.getInstance();
```

### Mock Strategy for Tests

```typescript
// Mock ModelRequestHandler static method
vi.spyOn(ModelRequestHandler, "sendRequest").mockResolvedValue({
  content: "Mock response",
  toolCalls: undefined,
});

// Mock GitService
vi.spyOn(GitService, "getInstance").mockReturnValue({
  compareBranches: vi.fn().mockResolvedValue({
    diffText: "mock diff",
    refName: "feature/test",
    error: undefined,
  }),
} as unknown as GitService);
```

### ConversationRunner Config

```typescript
const config: ConversationRunnerConfig = {
  systemPrompt,
  maxIterations: 10, // reasonable default
  tools: availableTools,
  label: "Chat /branch",
};
```

### Progress Message Formatting

Use ACTIVITY emoji for progress:

```typescript
import { ACTIVITY } from "../config/chatEmoji";

// Progress examples
stream.progress(`${ACTIVITY.reading} Reading changed files...`);
stream.progress(`${ACTIVITY.searching} Finding symbol definitions...`);
stream.progress(`${ACTIVITY.analyzing} Analyzing changes...`);
stream.progress(`Turn ${current}/${max}: ${ACTIVITY.thinking} Thinking...`);
```

### Hybrid Output Pattern with Debouncing

Per Architecture Decision 11:

- Extension controls: intro, progress, errors, follow-ups
- LLM controls: analysis findings (streamed as-is)

Per NFR-002: Progress updates must be rate-limited (max 10/sec).

```typescript
import { ACTIVITY } from "../config/chatEmoji";
import { DebouncedStreamHandler } from "../models/debouncedStreamHandler";
import type { ChatToolCallHandler } from "../types/chatTypes";
import type { ToolCallHandler } from "../models/conversationRunner";

// Layer 1: UI streaming handler
const uiHandler: ChatToolCallHandler = {
  onProgress: (msg) => stream.progress(msg),
  onToolStart: () => {},
  onToolComplete: () => {},
  onFileReference: () => {},
  onThinking: (thought) => stream.progress(`${ACTIVITY.thinking} ${thought}`),
  onMarkdown: (content) => stream.markdown(content),
};
const debouncedHandler = new DebouncedStreamHandler(uiHandler);

// Layer 2: ConversationRunner adapter
const runnerHandler: ToolCallHandler = {
  onIterationStart: (current, max) => {
    debouncedHandler.onProgress(
      `Turn ${current}/${max}: ${ACTIVITY.thinking} Analyzing...`
    );
  },
  onToolCallComplete: (_id, name, _args, _result, success) => {
    const status = success ? "completed" : "failed";
    debouncedHandler.onProgress(`${ACTIVITY.analyzing} ${name} ${status}`);
  },
};

// Execute with adapter
const analysisText = await runner.run(
  config,
  conversation,
  token,
  runnerHandler
);
debouncedHandler.flush(); // NFR-002: ensure final message sent
stream.markdown(analysisText);
```

### Logging Convention

```typescript
import { Log } from "./loggingService";

Log.info("[ChatParticipantService]: /branch command received");
Log.info(`[ChatParticipantService]: Analyzing branch "${diffResult.refName}"`);
Log.error("[ChatParticipantService]: Analysis failed", error);
```

---

## References

- [Source: docs/epics.md#Story-1.2]
- [Source: docs/architecture.md#Decision-1-LLM-Client-Abstraction]
- [Source: docs/architecture.md#Decision-2-Message-Conversion-Extraction]
- [Source: docs/architecture.md#Decision-10-Streaming-Debounce-Pattern] - Three-Layer Architecture
- [Source: docs/architecture.md#Decision-11-Hybrid-Output-Approach]
- [Source: docs/prd.md#FR-010-Branch-Command]
- [Source: docs/ux-design-specification.md#Progress-Message-Voice-Pattern]

---

## Dev Agent Record

### Context Reference

Story context created by SM agent (Bob) with Party Mode collaboration.

### Agent Model Used

Claude Opus 4.5 (Preview)

### Debug Log References

N/A - Story creation phase

### Completion Notes List

**Implementation Summary (2025-12-17):**

1. **ChatLLMClient** - Created lightweight ILLMClient wrapper around VS Code's LanguageModelChat. Delegates to `ModelRequestHandler.sendRequest()` for DRY compliance. 7 unit tests.

2. **ToolCallStreamAdapter** - Created adapter bridging `ToolCallHandler` (ConversationRunner callbacks) to `ChatToolCallHandler` (UI streaming). Implements three-layer streaming architecture per Decision 10. 8 unit tests.

3. **/branch Command Handler** - Implemented full /branch routing in `ChatParticipantService`:

   - Dependency injection via `setDependencies()` called from ServiceManager
   - Three-layer handler architecture: UI → DebouncedStreamHandler → ToolCallStreamAdapter
   - GitService integration for branch diff retrieval
   - ConversationRunner execution with tool-calling support

4. **Empty/Error Handling** - Graceful UX for no changes (returns success, not error)

5. **Error Handling** - Try/catch with ChatResult.errorDetails and responseIsIncomplete flag

6. **Tests** - Added 6 integration tests for /branch command. All 814 tests pass.

**Design Decision:** Used dependency injection pattern (setDependencies) instead of ServiceManager.getInstance() since ServiceManager is not a singleton. ChatParticipantService receives dependencies from ServiceManager.initializeHighLevelServices().

**Review Fix (2025-12-17):** Removed hardcoded 30s timeout from ChatLLMClient. Timeout now comes from `WorkspaceSettingsService.getRequestTimeoutSeconds()` (default 300s) for consistency with the rest of the application. Added `workspaceSettings` to `ChatParticipantDependencies` interface.

### File List

**Created:**

- `src/models/chatLLMClient.ts` - ILLMClient wrapper for chat models (49 lines)
- `src/models/toolCallStreamAdapter.ts` - Adapter: ToolCallHandler → ChatToolCallHandler (52 lines)
- `src/__tests__/chatLLMClient.test.ts` - ChatLLMClient unit tests (7 tests)
- `src/__tests__/toolCallStreamAdapter.test.ts` - Adapter unit tests (8 tests)

**Modified:**

- `src/services/chatParticipantService.ts` - Added /branch command handler, dependency injection
- `src/services/serviceManager.ts` - Inject dependencies into ChatParticipantService
- `src/__tests__/chatParticipantService.test.ts` - Added 6 integration tests for /branch- `docs/architecture.md` - Updated with Decision 10 details
- `__mocks__/vscode.js` - Added LanguageModel\* mocks
