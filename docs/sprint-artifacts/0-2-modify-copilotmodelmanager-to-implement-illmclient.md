# Story 0.2: Modify CopilotModelManager to Implement ILLMClient

**Status:** Ready for Review
**Story ID:** 0.2
**Epic:** 0 - Foundation & Interface Abstraction
**Created:** 2025-12-16
**Created By:** Bob (SM) with Party Mode (Winston, Amelia, Murat)

---

## Story

**As a** developer maintaining Lupa,
**I want** CopilotModelManager to implement the ILLMClient interface,
**So that** existing command palette functionality continues working with the new abstraction.

---

## Business Context

This story completes the Dependency Inversion pattern by making `CopilotModelManager` implement the `ILLMClient` interface. This is a **trivial change** per the architecture document - the methods already exist with compatible signatures. After this story, both `CopilotModelManager` (command palette path) and `ChatLLMClient` (chat participant path, Story 1.2) will implement the same interface, enabling 100% `ConversationRunner` reuse.

**Business Value:** Enables code reuse across analysis paths without any behavior changes to existing functionality.

---

## Acceptance Criteria

### AC-0.2.1: Interface Implementation

**Given** the existing CopilotModelManager class
**When** modifying it to implement ILLMClient
**Then** the class MUST:

- Add `implements ILLMClient` to class declaration
- Delegate `sendRequest()` to `ModelRequestHandler.sendRequest()`
- Keep existing `getCurrentModel()` implementation unchanged

**And** all existing functionality MUST remain unchanged

---

### AC-0.2.2: Backward Compatibility

**Given** existing code using CopilotModelManager (28 usages across codebase)
**When** running all tests
**Then** all existing tests MUST pass without modification
**And** ToolCallingAnalysisProvider MUST continue working unchanged
**And** ConversationRunner MUST continue working unchanged

---

## Developer Context (Party Mode Analysis)

### 🏗️ Architecture Context (Winston)

**Interface Contract:**
The `ILLMClient` interface from Story 0.1 defines:

```typescript
interface ILLMClient {
  sendRequest(
    request: ToolCallRequest,
    token: CancellationToken
  ): Promise<ToolCallResponse>;
  getCurrentModel(): Promise<LanguageModelChat>;
}
```

**Design Decision:**
`CopilotModelManager.sendRequest()` currently contains duplicated message conversion logic that now exists in `ModelRequestHandler`. For DRY compliance, refactor to delegate to `ModelRequestHandler.sendRequest()` while keeping error handling.

**Architecture Guardrails:**

1. `CopilotModelManager` keeps responsibility for model selection and caching
2. `ModelRequestHandler` handles message conversion and request execution
3. Error handling for `CopilotApiError` (model_not_supported) MUST stay in `CopilotModelManager`
4. Logging MUST stay in `CopilotModelManager` (ModelRequestHandler has no logging)

**Architecture References:**

- [Architecture Decision 1](docs/architecture.md#decision-1-llm-client-abstraction-illmclient-interface) - ILLMClient Interface
- [Architecture Decision 2](docs/architecture.md#decision-2-message-conversion-extraction-modelrequesthandler) - ModelRequestHandler Extraction

---

### 💻 Implementation Context (Amelia)

**Current State (copilotModelManager.ts):**

- Line 42: Class declaration - needs `implements ILLMClient`
- Lines 139-153: `getCurrentModel()` - already matches interface signature
- Lines 220-295: `sendRequest()` - duplicates ModelRequestHandler logic, needs refactoring

**Required Changes (Minimal):**

1. **Add import for ILLMClient:**

```typescript
import { ILLMClient } from "./ILLMClient";
import { ModelRequestHandler } from "./modelRequestHandler";
```

2. **Add implements clause:**

```typescript
export class CopilotModelManager implements vscode.Disposable, ILLMClient {
```

3. **Refactor sendRequest() to delegate:**

```typescript
async sendRequest(request: ToolCallRequest, token: vscode.CancellationToken): Promise<ToolCallResponse> {
    try {
        const model = await this.getCurrentModel();
        return await ModelRequestHandler.sendRequest(
            model,
            request,
            token,
            this.requestTimeoutMs
        );
    } catch (error) {
        // Keep existing CopilotApiError detection
        const msg = error instanceof Error ? error.message : String(error);
        const codeMatch = msg.match(/"code"\s*:\s*"([^"]+)"/);
        if (codeMatch) {
            const code = codeMatch[1];
            if (code === 'model_not_supported') {
                const modelName = this.currentModel?.name || this.currentModel?.id || 'selected model';
                const friendlyMessage = `The selected Copilot model ${modelName} is not supported. Please choose another Copilot model in Lupa settings.`;
                Log.error(`Copilot model not supported: ${modelName}. API response: ${msg.replace(/\\"/g, '"').replace(/\n/g, '')}`);
                throw new CopilotApiError(friendlyMessage, code);
            }
        }
        Log.error('Error in sendRequest:', error);
        throw error;
    }
}
```

**Code to Remove (now in ModelRequestHandler):**

- Lines 191-218: `withTimeout()` method - now in `ModelRequestHandler.withTimeout()`
- Lines 225-264: Message conversion loop - now in `ModelRequestHandler.convertMessages()`
- Lines 266-283: Response stream parsing - now in `ModelRequestHandler.sendRequest()`

**Estimated Changes:**

- ~5 lines added (import, implements)
- ~80 lines removed (duplicated logic)
- Net reduction: ~75 lines

---

### 🧪 Testing Context (Murat)

**Backward Compatibility is CRITICAL:**

28 usages of `CopilotModelManager` across the codebase:

- `conversationRunner.ts` - constructor injection
- `toolCallingAnalysisProvider.ts` - creates runner
- `serviceManager.ts` - instantiates
- `analysisProvider.ts` - uses
- `contextProvider.ts` - uses
- Multiple test files

**Test Strategy:**

1. **NO new tests required** - this is a pure refactoring
2. All existing tests MUST pass unchanged:
   - `copilotModelManagerTimeout.test.ts` (17 tests)
   - `copilotModelManagerModelNotSupported.test.ts`
   - `conversationRunner.test.ts`
   - Any integration tests using CopilotModelManager

**Verification Commands:**

```bash
npm run check-types    # Must pass
npm run test           # All tests must pass
```

**Risk Assessment:**

- **VERY LOW RISK**: Interface adds type constraint without behavior change
- Delegation to ModelRequestHandler tested in Story 0.1 (22 tests)

---

## Technical Requirements

### Import Changes

| Import                                                        | Purpose           |
| ------------------------------------------------------------- | ----------------- |
| `import { ILLMClient } from './ILLMClient'`                   | Interface type    |
| `import { ModelRequestHandler } from './modelRequestHandler'` | Delegation target |

### Method Signature Verification

| Method            | ILLMClient Signature                                                              | Current CopilotModelManager | Match |
| ----------------- | --------------------------------------------------------------------------------- | --------------------------- | ----- |
| `sendRequest`     | `(request: ToolCallRequest, token: CancellationToken): Promise<ToolCallResponse>` | Same                        | ✅    |
| `getCurrentModel` | `(): Promise<LanguageModelChat>`                                                  | Same                        | ✅    |

### Error Handling Preservation

The `CopilotApiError` detection for `model_not_supported` MUST be preserved:

```typescript
if (code === "model_not_supported") {
  throw new CopilotApiError(friendlyMessage, code);
}
```

This error triggers a user-friendly message in VS Code and is handled specially by `ConversationRunner.isFatalModelError()`.

---

## Tasks / Subtasks

### Task 1: Add Interface Implementation (AC: 0.2.1)

- [x] Add import for `ILLMClient` from `./ILLMClient`
- [x] Add import for `ModelRequestHandler` from `./modelRequestHandler`
- [x] Add `implements ILLMClient` to class declaration

### Task 2: Refactor sendRequest to Delegate (AC: 0.2.1)

- [x] Replace message conversion code with `ModelRequestHandler.sendRequest()` call
- [x] Preserve `CopilotApiError` detection and handling in try/catch
- [x] Preserve error logging
- [x] Remove `withTimeout()` method (now unused)

### Task 3: Verify Backward Compatibility (AC: 0.2.2)

- [x] Run `npm run check-types` - must pass with no errors
- [x] Run all existing CopilotModelManager tests - must pass unchanged
- [x] Run ConversationRunner tests - must pass unchanged
- [x] Verify ToolCallingAnalysisProvider continues to work

---

## Dev Notes

### Critical Implementation Details

1. **Error Handling MUST Stay:** The `CopilotApiError` detection is essential. It provides user-friendly error messages and is detected by `ConversationRunner.isFatalModelError()` to stop the conversation loop on fatal errors.

2. **Logging MUST Stay:** Unlike `ModelRequestHandler`, `CopilotModelManager` logs errors. Keep the `Log.error()` calls.

3. **Model Selection Unchanged:** `getCurrentModel()` is already correct - it handles model selection, caching, and fallback logic. No changes needed.

4. **Remove Dead Code:** After delegation, `withTimeout()` becomes dead code. Remove it.

### Previous Story Intelligence

**From Story 0.1:**

- `ModelRequestHandler.sendRequest()` is tested with 22 unit tests
- Message conversion handles all role types (system, user, assistant, tool)
- Timeout handling with proper cleanup verified
- Tool call parsing verified

**Git Commit Pattern from 0.1:**

```
feat(models): implement ILLMClient interface and ModelRequestHandler (Story 0.1)
```

**Suggested Commit for 0.2:**

```
feat(models): CopilotModelManager implements ILLMClient (Story 0.2)
```

### Files to Modify

| File                                | Changes                                                  |
| ----------------------------------- | -------------------------------------------------------- |
| `src/models/copilotModelManager.ts` | Add implements, delegate sendRequest, remove withTimeout |

### Files NOT Modified in This Story

- `src/models/conversationRunner.ts` - Modified in Story 0.3
- `src/models/ILLMClient.ts` - Already complete from Story 0.1
- `src/models/modelRequestHandler.ts` - Already complete from Story 0.1

### Project Structure Notes

No new files created. This is pure refactoring of existing code.

### References

- [Architecture Document - Decision 1](docs/architecture.md#decision-1-llm-client-abstraction-illmclient-interface)
- [PRD Section 3.1](docs/prd.md#31-high-level-design) - Architecture overview
- [Source: ILLMClient.ts](src/models/ILLMClient.ts) - Interface from Story 0.1
- [Source: modelRequestHandler.ts](src/models/modelRequestHandler.ts) - Handler from Story 0.1
- [Source: copilotModelManager.ts](src/models/copilotModelManager.ts) - Target file
- [Story 0.1](docs/sprint-artifacts/0-1-create-illmclient-interface-and-modelrequesthandler.md) - Dependency

---

## Dev Agent Record

### Context Reference

Story created via BMAD create-story workflow with Party Mode analysis from:

- 🏗️ Winston (Architect) - Interface design and DRY compliance
- 💻 Amelia (Developer) - Code changes and delegation pattern
- 🧪 Murat (Test Architect) - Backward compatibility verification

### Agent Model Used

Claude Opus 4.5 (Preview)

### Debug Log References

- Type checking: `npm run check-types` - passed
- CopilotModelManager tests (6): passed
- ConversationRunner tests (11): passed
- Full test suite (714 tests): all passed

### Completion Notes List

- ✅ Added `implements ILLMClient` to CopilotModelManager class declaration
- ✅ Refactored `sendRequest()` to delegate to `ModelRequestHandler.sendRequest()`
- ✅ Preserved `CopilotApiError` detection for `model_not_supported` error code
- ✅ Preserved error logging with `Log.error()`
- ✅ Removed `withTimeout()` method (now unused, exists in ModelRequestHandler)
- ✅ Net reduction: ~75 lines of code
- ✅ All 714 tests pass - no regressions

### Change Log

| Date       | Author             | Changes                                                                        |
| ---------- | ------------------ | ------------------------------------------------------------------------------ |
| 2025-12-16 | Dev Agent (Amelia) | Implemented ILLMClient interface, delegated sendRequest to ModelRequestHandler |
| 2025-12-16 | Bob (SM)           | Initial story creation with party mode analysis                                |

### File List

| File                                | Status   | Description                                                                              |
| ----------------------------------- | -------- | ---------------------------------------------------------------------------------------- |
| `src/models/copilotModelManager.ts` | Modified | Added ILLMClient implementation, delegated to ModelRequestHandler, removed withTimeout() |
