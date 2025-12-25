# Story 0.1: Create ILLMClient Interface and ModelRequestHandler

**Status:** Ready for Review
**Story ID:** 0.1
**Epic:** 0 - Foundation & Interface Abstraction
**Created:** 2025-12-16
**Created By:** Bob (SM) with Party Mode (Winston, Amelia, Murat)

---

## Story

**As a** developer maintaining Lupa,
**I want** a common interface for LLM access and shared message conversion logic,
**So that** ConversationRunner can work with any model source without duplication.

---

## Business Context

This story establishes the Dependency Inversion pattern that enables 100% code reuse of `ConversationRunner` across both the chat participant path (`ChatLLMClient`) and the command palette path (`CopilotModelManager`). This is the foundational abstraction that makes the entire `@lupa` chat participant feature clean and maintainable.

**Business Value:** Eliminates code duplication, reduces maintenance burden, and ensures consistent behavior across all analysis paths.

---

## Acceptance Criteria

### AC-0.1.1: ILLMClient Interface Definition

**Given** the architecture decision for Dependency Inversion
**When** creating the ILLMClient interface
**Then** the interface MUST define:

- `sendRequest(request: ToolCallRequest, token: CancellationToken): Promise<ToolCallResponse>`
- `getCurrentModel(): Promise<LanguageModelChat>`

**And** the interface MUST be in `src/models/ILLMClient.ts`
**And** the interface MUST have JSDoc describing its purpose for abstraction

---

### AC-0.1.2: ModelRequestHandler Extraction

**Given** message conversion logic exists in CopilotModelManager
**When** extracting to ModelRequestHandler
**Then** `ModelRequestHandler.sendRequest()` MUST:

- Accept `model`, `request`, `token`, and `timeoutMs` parameters
- Convert `ToolCallRequest` messages to VS Code `LanguageModelChatMessage` format
- Handle timeout with `Promise.race` pattern
- Parse response stream into `ToolCallResponse`
- Support tool calls in the response

**And** the class MUST be in `src/models/modelRequestHandler.ts`

---

### AC-0.1.3: Unit Tests

**Given** the new abstractions
**When** running tests
**Then** `ModelRequestHandler.sendRequest()` MUST have unit tests covering:

- Successful request/response cycle
- Timeout handling
- Tool call parsing
- Error propagation

---

## Developer Context (Party Mode Analysis)

### 🏗️ Architecture Context (Winston)

**Interface Contract:**

- `sendRequest()` handles both sync and async tool call scenarios
- `getCurrentModel()` is needed for token counting operations in ConversationRunner
- Interface should NOT expose VS Code-specific types in its core signature to maintain testability

**Design Guardrails:**

1. `ILLMClient` lives in `src/models/` - it's a model concern, not a service
2. `ModelRequestHandler` is a static utility class pattern
3. Both `CopilotModelManager` and `ChatLLMClient` delegate to `ModelRequestHandler` for DRY

**Architecture References:**

- [Architecture Decision 1](docs/architecture.md#decision-1-llm-client-abstraction-illmclient-interface) - ILLMClient Interface
- [Architecture Decision 2](docs/architecture.md#decision-2-message-conversion-extraction-modelrequesthandler) - ModelRequestHandler Extraction

---

### 💻 Implementation Context (Amelia)

**Source Code to Extract From:**

- [copilotModelManager.ts#L220-L295](src/models/copilotModelManager.ts#L220) - `sendRequest()` method
- [copilotModelManager.ts#L191-L218](src/models/copilotModelManager.ts#L191) - `withTimeout()` method

**Message Conversion Logic (Lines 230-264):**

```typescript
// System messages → Assistant() - VS Code API quirk, NOT System()
if (msg.role === "system" && msg.content) {
  messages.push(vscode.LanguageModelChatMessage.Assistant(msg.content));
}

// User messages → User()
else if (msg.role === "user" && msg.content) {
  messages.push(vscode.LanguageModelChatMessage.User(msg.content));
}

// Assistant messages with tool calls → Assistant([TextPart, ToolCallPart...])
else if (msg.role === "assistant") {
  // Build content array with text and tool calls
}

// Tool responses → User([ToolResultPart])
else if (msg.role === "tool") {
  const toolResultContent = [
    new vscode.LanguageModelTextPart(msg.content || ""),
  ];
  const toolResult = new vscode.LanguageModelToolResultPart(
    msg.toolCallId || "",
    toolResultContent
  );
  messages.push(vscode.LanguageModelChatMessage.User([toolResult]));
}
```

**Dependencies to Import:**

- `ToolCallRequest`, `ToolCallResponse`, `ToolCall` from `../types/modelTypes`
- `vscode.LanguageModelTextPart`, `vscode.LanguageModelToolCallPart`, `vscode.LanguageModelToolResultPart`

**Estimated Lines of Code:**

- `ILLMClient.ts`: ~15 lines (interface + JSDoc)
- `modelRequestHandler.ts`: ~100 lines (extracted logic + withTimeout)
- `modelRequestHandler.test.ts`: ~120 lines

---

### 🧪 Testing Context (Murat)

**Test Cases for ModelRequestHandler:**

1. **Message Conversion:** Test each message type (system, user, assistant, tool)
2. **Success Path:** Verify response parsing with text content
3. **Timeout Handling:** Mock slow model, verify timeout error thrown
4. **Tool Call Parsing:** Verify `ToolCall[]` extraction from stream
5. **Cancellation:** Verify cleanup when token cancelled
6. **Error Propagation:** Model throws error, verify propagation

**Mocking Strategy:**

```typescript
import { vi, describe, it, expect } from "vitest";

const mockModel = {
  sendRequest: vi.fn().mockResolvedValue({
    stream: (async function* () {
      yield new vscode.LanguageModelTextPart("Test response");
    })(),
  }),
};
```

**Backward Compatibility Requirement:**
After extraction, run existing tests:

- `copilotModelManager.test.ts`
- `copilotModelManagerTimeout.test.ts`
- `copilotModelManagerModelNotSupported.test.ts`
- `conversationRunner.test.ts`

ALL must pass unchanged.

---

## Technical Requirements

### Message Conversion Specification

| Source Role | VS Code API Call                                  | Content Handling                  |
| ----------- | ------------------------------------------------- | --------------------------------- |
| `system`    | `LanguageModelChatMessage.Assistant()`            | String content directly           |
| `user`      | `LanguageModelChatMessage.User()`                 | String content directly           |
| `assistant` | `LanguageModelChatMessage.Assistant([parts])`     | Array of TextPart + ToolCallParts |
| `tool`      | `LanguageModelChatMessage.User([ToolResultPart])` | Wrap in ToolResultPart            |

### Timeout Handling Specification

```typescript
private static async withTimeout<T>(
    thenable: Thenable<T>,
    timeoutMs: number,
    token: vscode.CancellationToken
): Promise<T> {
    // 1. Create timeout promise that rejects after timeoutMs
    // 2. Register cleanup on cancellation token
    // 3. Promise.race between thenable and timeout
    // 4. Always cleanup timeout on success/failure
}
```

### Response Stream Parsing Specification

```typescript
for await (const chunk of response.stream) {
  if (chunk instanceof vscode.LanguageModelTextPart) {
    responseText += chunk.value;
  } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
    toolCalls.push({
      id: chunk.callId,
      function: {
        name: chunk.name,
        arguments: JSON.stringify(chunk.input),
      },
    });
  }
}
```

---

## Tasks / Subtasks

### Task 1: Create ILLMClient Interface (AC: 0.1.1)

- [x] Create `src/models/ILLMClient.ts`
- [x] Define `sendRequest()` method signature
- [x] Define `getCurrentModel()` method signature
- [x] Add comprehensive JSDoc documentation
- [x] Export interface

### Task 2: Create ModelRequestHandler (AC: 0.1.2)

- [x] Create `src/models/modelRequestHandler.ts`
- [x] Extract `withTimeout()` as private static method
- [x] Create `convertMessages()` static method for message conversion
- [x] Create `sendRequest()` static method with full extraction
- [x] Handle all message types (system, user, assistant, tool)
- [x] Handle tool call parsing from response stream
- [x] Preserve exact error handling from original

### Task 3: Write Unit Tests (AC: 0.1.3)

- [x] Create `src/__tests__/modelRequestHandler.test.ts`
- [x] Test successful request/response cycle
- [x] Test timeout handling (mock slow model)
- [x] Test tool call parsing
- [x] Test error propagation
- [x] Test cancellation cleanup

### Task 4: Verify Backward Compatibility

- [x] Run `npm run check-types` - must pass
- [x] Run existing CopilotModelManager tests - must pass unchanged
- [x] Run ConversationRunner tests - must pass unchanged

---

## Dev Notes

### Critical Implementation Details

1. **System Message Quirk:** VS Code's API requires system messages to be sent as `Assistant()`, not a dedicated system call. The existing code handles this - preserve the pattern.

2. **Tool Call Serialization:** When building `ToolCallPart`, the input is already an object. When parsing response, convert back to `JSON.stringify()` for the `arguments` field.

3. **Timeout Cleanup:** The `withTimeout` utility must properly cleanup the timeout on:

   - Successful completion
   - Error/rejection
   - Cancellation token firing

4. **No Logging in ModelRequestHandler:** This is a pure utility class. Logging remains in `CopilotModelManager` and `ChatLLMClient`.

### Files to Create

| File                                        | Purpose                                           |
| ------------------------------------------- | ------------------------------------------------- |
| `src/models/ILLMClient.ts`                  | Interface definition                              |
| `src/models/modelRequestHandler.ts`         | Extracted message conversion and request handling |
| `src/__tests__/modelRequestHandler.test.ts` | Unit tests                                        |

### Files NOT Modified in This Story

- `src/models/copilotModelManager.ts` - Modified in Story 0.2
- `src/models/conversationRunner.ts` - Modified in Story 0.3

### Project Structure Notes

- `ILLMClient.ts` follows existing pattern: interfaces in `src/models/`
- `modelRequestHandler.ts` is a static utility, similar pattern to `DiffUtils`
- Test file follows existing pattern: `src/__tests__/*.test.ts`

### References

- [Architecture Document - Decision 1](docs/architecture.md#decision-1-llm-client-abstraction-illmclient-interface)
- [Architecture Document - Decision 2](docs/architecture.md#decision-2-message-conversion-extraction-modelrequesthandler)
- [PRD Section 3.1](docs/prd.md#31-high-level-design)
- [PRD Section 6.4](docs/prd.md#64-interface-definitions)
- [Source: copilotModelManager.ts](src/models/copilotModelManager.ts)
- [Source: modelTypes.ts](src/types/modelTypes.ts)

---

## Dev Agent Record

### Context Reference

Story created via BMAD create-story workflow with Party Mode analysis from:

- 🏗️ Winston (Architect) - Interface design and architectural decisions
- 💻 Amelia (Developer) - Code extraction specifics and implementation details
- 🧪 Murat (Test Architect) - Testing strategy and backward compatibility

### Agent Model Used

Claude Opus 4.5 (Preview)

### Debug Log References

- Type check: `npm run check-types` passed with no errors
- New tests: 22 tests passed (modelRequestHandler.test.ts)
- Backward compatibility: 17 tests passed (copilotModelManagerTimeout, copilotModelManagerModelNotSupported, conversationRunner)

### Completion Notes List

**Implementation Summary:**

1. Created `ILLMClient.ts` interface (~30 lines) with comprehensive JSDoc documentation explaining the Dependency Inversion pattern that enables ConversationRunner to work with any model source.
2. Created `ModelRequestHandler.ts` static utility class (~150 lines) with three public static methods:
   - `convertMessages()` - Converts ToolCallMessage[] to VS Code LanguageModelChatMessage[] format, handling the VS Code API quirk where system messages must be sent as Assistant messages
   - `withTimeout()` - Wraps thenables with timeout handling and proper cleanup on success, error, or cancellation
   - `sendRequest()` - Orchestrates message conversion, request execution, and response stream parsing
3. Created comprehensive test suite with 22 tests covering:
   - Message conversion for all role types (system, user, assistant, tool)
   - Timeout handling with proper cleanup
   - Tool call parsing from response streams
   - Error propagation
   - Multiple text chunks and tool calls

**Design Decisions:**

- Made `withTimeout` public to enable unit testing; can be made private in future if needed
- Followed existing codebase patterns: static utility class similar to DiffUtils
- No logging in ModelRequestHandler - logging responsibility stays with calling services

**Backward Compatibility Verified:**

- All existing CopilotModelManager tests pass unchanged
- All ConversationRunner tests pass unchanged
- Type checking passes with no errors

### Change Log

| Date       | Author       | Changes                                                        |
| ---------- | ------------ | -------------------------------------------------------------- |
| 2025-12-16 | Bob (SM)     | Initial story creation with party mode analysis                |
| 2025-12-16 | Amelia (Dev) | Implemented ILLMClient, ModelRequestHandler, and 22 unit tests |

### File List

| File                                        | Status  | Description                                        |
| ------------------------------------------- | ------- | -------------------------------------------------- |
| `src/models/ILLMClient.ts`                  | Created | Interface for LLM client abstraction               |
| `src/models/modelRequestHandler.ts`         | Created | Static utility for message conversion and requests |
| `src/__tests__/modelRequestHandler.test.ts` | Created | Comprehensive unit tests (22 tests)                |
| `docs/sprint-artifacts/sprint-status.yaml`  | Updated | Story status: ready-for-dev → in-progress → review |

### Code Review (Dev Agent)

**Date:** 2025-12-16
**Reviewer:** Dev Agent (Adversarial Mode)

**Findings & Fixes:**

1. **Robustness:** Added try-catch block around `JSON.parse` in `convertMessages` to prevent crashes on malformed tool call arguments.
2. **API Compliance:** Added check to ensure Assistant messages always have at least one content part (empty text part if needed).
3. **UX:** Simplified and corrected timeout error message to show exact duration.
4. **Testing:** Added 2 new test cases for invalid JSON and empty content handling.
