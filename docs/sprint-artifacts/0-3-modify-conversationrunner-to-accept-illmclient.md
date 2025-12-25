# Story 0.3: Modify ConversationRunner to Accept ILLMClient

**Status:** Ready for Review
**Story ID:** 0.3
**Epic:** 0 - Foundation & Interface Abstraction
**Created:** 2025-12-16
**Created By:** Bob (SM) with Party Mode (Winston, Amelia, Murat)

---

## Story

**As a** developer maintaining Lupa,
**I want** ConversationRunner to accept ILLMClient instead of concrete CopilotModelManager,
**So that** the same conversation loop can be used with different model sources.

---

## Business Context

This story completes the Dependency Inversion pattern by enabling `ConversationRunner` to work with any `ILLMClient` implementation. After this story:

- **Command palette path:** `CopilotModelManager` (which implements `ILLMClient`) continues working
- **Chat participant path:** `ChatLLMClient` (Story 1.2) can be passed to `ConversationRunner`

This achieves **100% code reuse** of the conversation loop across both analysis paths.

**Business Value:** Enables the chat participant feature without duplicating the complex conversation loop logic.

---

## Acceptance Criteria

### AC-0.3.1: Constructor Modification

**Given** the existing ConversationRunner constructor
**When** modifying to accept ILLMClient
**Then** the constructor MUST:

- Accept `client: ILLMClient` parameter instead of `CopilotModelManager`
- Store the client for use in the conversation loop
- Update all internal references from `modelManager` to `client`

---

### AC-0.3.2: Full Backward Compatibility

**Given** existing callers passing CopilotModelManager
**When** running all tests
**Then** all existing tests MUST pass
**And** ToolCallingAnalysisProvider MUST continue working
**And** SubagentExecutor MUST continue working
**And** no behavior changes in the conversation loop

---

### AC-0.3.3: Type Safety

**Given** the interface abstraction
**When** compiling with `npm run check-types`
**Then** compilation MUST succeed with no type errors
**And** all usages of ILLMClient methods MUST be type-safe

---

## Developer Context (Party Mode Analysis)

### 🏗️ Architecture Context (Winston)

**Design Pattern:**
This is textbook Dependency Inversion. We change the constructor dependency from concrete class to interface, enabling polymorphism without breaking existing callers.

**Interface Segregation Verification:**
`ILLMClient` exposes exactly what `ConversationRunner` needs:

- `sendRequest()` - for LLM communication
- `getCurrentModel()` - for token counting in `TokenValidator`

No additional methods are exposed - no leaky abstractions.

**CopilotApiError Consideration:**
The `isFatalModelError()` method checks for `CopilotApiError` with code `model_not_supported`. This is a **Copilot-specific error** that:

- Is thrown by `CopilotModelManager` when model is not supported
- Will NOT be thrown by `ChatLLMClient` (different error surface)
- The check remains as-is - for ChatLLMClient path, errors propagate normally

**Architecture Guardrails:**

1. Keep `CopilotApiError` import for backward compatibility
2. Use semantic naming: `client` instead of `modelManager`
3. No changes to callers - TypeScript structural typing handles this

**Architecture References:**

- [Architecture Decision 1](docs/architecture.md#decision-1-llm-client-abstraction-illmclient-interface) - ILLMClient Interface
- [PRD Section 3.1](docs/prd.md#31-high-level-design) - Architecture overview

---

### 💻 Implementation Context (Amelia)

**Source Code to Modify:**

- [conversationRunner.ts](src/models/conversationRunner.ts) - The ONLY file requiring changes

**Current State (conversationRunner.ts):**

```typescript
// Line 5: Current import
import { CopilotModelManager, CopilotApiError } from './copilotModelManager';

// Lines 60-63: Current constructor
constructor(
    private readonly modelManager: CopilotModelManager,
    private readonly toolExecutor: ToolExecutor
) { }
```

**Required Changes:**

**1. Import Change (Line 5):**

```typescript
// FROM:
import { CopilotModelManager, CopilotApiError } from "./copilotModelManager";

// TO:
import { ILLMClient } from "./ILLMClient";
import { CopilotApiError } from "./copilotModelManager";
```

**2. Constructor Change (Lines 60-63):**

```typescript
// FROM:
constructor(
    private readonly modelManager: CopilotModelManager,
    private readonly toolExecutor: ToolExecutor
) { }

// TO:
constructor(
    private readonly client: ILLMClient,
    private readonly toolExecutor: ToolExecutor
) { }
```

**3. Internal Usage Updates:**

| Line | Current                               | Updated                         |
| ---- | ------------------------------------- | ------------------------------- |
| 91   | `this.modelManager.getCurrentModel()` | `this.client.getCurrentModel()` |
| 129  | `this.modelManager.sendRequest(...)`  | `this.client.sendRequest(...)`  |

**Estimated Changes:**

- 2 import lines modified
- 1 constructor parameter renamed
- 2 internal usages renamed
- **Total: 5-6 lines modified**
- **Net lines added/removed: 0**

---

### 🧪 Testing Context (Murat)

**Risk Assessment: VERY LOW**

This is pure interface abstraction with no behavioral changes.

**Backward Compatibility Matrix:**

| Consumer                         | Current Usage                                               | After Change | Impact                                                  |
| -------------------------------- | ----------------------------------------------------------- | ------------ | ------------------------------------------------------- |
| `toolCallingAnalysisProvider.ts` | `new ConversationRunner(copilotModelManager, toolExecutor)` | Unchanged    | ✅ None - `CopilotModelManager` implements `ILLMClient` |
| `subagentExecutor.ts`            | `new ConversationRunner(this.modelManager, toolExecutor)`   | Unchanged    | ✅ None - `CopilotModelManager` implements `ILLMClient` |
| `conversationRunner.test.ts`     | Mocks typed as `CopilotModelManager`                        | Unchanged    | ✅ None - mocks satisfy `ILLMClient` interface          |

**Existing Tests (11 tests in conversationRunner.test.ts):**

1. Basic Conversation Flow (2 tests)
2. Tool Call Handling (3 tests)
3. Iteration Limits (1 test)
4. Cancellation (1 test)
5. Error Handling (3 tests) - includes `CopilotApiError` test
6. Reset (1 test)

**No New Tests Required:**

- This is pure refactoring
- All behavior is unchanged
- Interface compliance verified by TypeScript compiler

**Verification Commands:**

```bash
npm run check-types    # Must pass with no errors
npm run test           # All 714+ tests must pass
```

---

## Technical Requirements

### Import Structure

```typescript
// Required imports after change
import { ILLMClient } from "./ILLMClient";
import { CopilotApiError } from "./copilotModelManager";
```

**Why keep CopilotApiError?**
The `isFatalModelError()` method on line 168-170 checks:

```typescript
private isFatalModelError(error: unknown): boolean {
    return error instanceof CopilotApiError && error.code === 'model_not_supported';
}
```

This detection must remain for the command palette path.

### Method Signature Preservation

| Method        | Current Signature                                                 | After Change                                       |
| ------------- | ----------------------------------------------------------------- | -------------------------------------------------- |
| `constructor` | `(modelManager: CopilotModelManager, toolExecutor: ToolExecutor)` | `(client: ILLMClient, toolExecutor: ToolExecutor)` |
| `run()`       | Unchanged                                                         | Unchanged                                          |
| `reset()`     | Unchanged                                                         | Unchanged                                          |

### Internal References to Update

| Location | From                                  | To                              |
| -------- | ------------------------------------- | ------------------------------- |
| Line 60  | `modelManager: CopilotModelManager`   | `client: ILLMClient`            |
| Line 91  | `this.modelManager.getCurrentModel()` | `this.client.getCurrentModel()` |
| Line 129 | `this.modelManager.sendRequest(...)`  | `this.client.sendRequest(...)`  |

---

## Tasks / Subtasks

### Task 1: Update Imports (AC: 0.3.1)

- [x] Add import for `ILLMClient` from `./ILLMClient`
- [x] Keep import for `CopilotApiError` from `./copilotModelManager`
- [x] Remove `CopilotModelManager` from imports

### Task 2: Modify Constructor (AC: 0.3.1)

- [x] Change parameter type from `CopilotModelManager` to `ILLMClient`
- [x] Rename parameter from `modelManager` to `client`
- [x] Update all internal references: `this.modelManager` → `this.client`

### Task 3: Verify Backward Compatibility (AC: 0.3.2, 0.3.3)

- [x] Run `npm run check-types` - must pass with no errors
- [x] Run `npm run test` - all existing tests must pass unchanged
- [x] Verify ToolCallingAnalysisProvider works (passes CopilotModelManager)
- [x] Verify SubagentExecutor works (passes CopilotModelManager)

---

## Dev Notes

### Critical Implementation Details

1. **Semantic Rename:** Use `client` instead of `modelManager` to reflect the interface abstraction. The variable is no longer specifically a "model manager" - it's a generic LLM client.

2. **CopilotApiError Must Stay:** The fatal error detection is essential for the command palette path. When the Copilot model is not supported, we show a user-friendly error and stop the conversation.

3. **No Caller Changes:** Both `ToolCallingAnalysisProvider` and `SubagentExecutor` pass `CopilotModelManager` which now implements `ILLMClient`. TypeScript structural typing handles this seamlessly.

4. **Future Path:** Story 1.2 will create `ChatLLMClient` that also implements `ILLMClient`. After that story, `ConversationRunner` can be instantiated with either client.

### Previous Story Intelligence

**From Story 0.1:**

- Created `ILLMClient` interface with `sendRequest()` and `getCurrentModel()` methods
- Created `ModelRequestHandler` for message conversion (22 tests)
- Verified timeout handling and tool call parsing

**From Story 0.2:**

- `CopilotModelManager` now implements `ILLMClient`
- Delegates `sendRequest()` to `ModelRequestHandler`
- All 714 tests pass

**Git Commit Pattern:**

```
feat(models): CopilotModelManager implements ILLMClient (Story 0.2)
```

**Suggested Commit for 0.3:**

```
feat(models): ConversationRunner accepts ILLMClient (Story 0.3)

- Change constructor param from CopilotModelManager to ILLMClient
- Rename internal field: modelManager → client
- Keep CopilotApiError import for fatal error detection
- Zero impact on callers (TypeScript structural typing)

All existing tests pass unchanged.
```

### Files to Modify

| File                               | Changes                                                               |
| ---------------------------------- | --------------------------------------------------------------------- |
| `src/models/conversationRunner.ts` | Update imports, change constructor param type, rename internal usages |

### Files NOT Modified in This Story

| File                                          | Reason                                                     |
| --------------------------------------------- | ---------------------------------------------------------- |
| `src/services/toolCallingAnalysisProvider.ts` | Passes `CopilotModelManager` which implements `ILLMClient` |
| `src/services/subagentExecutor.ts`            | Passes `CopilotModelManager` which implements `ILLMClient` |
| `src/__tests__/conversationRunner.test.ts`    | Mocks satisfy `ILLMClient` interface                       |
| `src/models/copilotModelManager.ts`           | Already implements `ILLMClient` from Story 0.2             |

### Project Structure Notes

No new files created. This is pure refactoring of existing code with interface abstraction.

### Consumers of ConversationRunner

| Consumer                    | Location      | Usage                                                       |
| --------------------------- | ------------- | ----------------------------------------------------------- |
| ToolCallingAnalysisProvider | Line 41       | `new ConversationRunner(copilotModelManager, toolExecutor)` |
| SubagentExecutor            | Line 89       | `new ConversationRunner(this.modelManager, toolExecutor)`   |
| Tests                       | Mock creation | Typed as `CopilotModelManager`                              |

### References

- [ILLMClient Interface](src/models/ILLMClient.ts) - From Story 0.1
- [ModelRequestHandler](src/models/modelRequestHandler.ts) - From Story 0.1
- [CopilotModelManager](src/models/copilotModelManager.ts) - Implements ILLMClient from Story 0.2
- [ConversationRunner](src/models/conversationRunner.ts) - Target file
- [Story 0.1](docs/sprint-artifacts/0-1-create-illmclient-interface-and-modelrequesthandler.md) - Interface creation
- [Story 0.2](docs/sprint-artifacts/0-2-modify-copilotmodelmanager-to-implement-illmclient.md) - Interface implementation
- [Epic 0 in epics.md](docs/epics.md#story-03-modify-conversationrunner-to-accept-illmclient) - Story definition

---

## Dev Agent Record

### Context Reference

Story created via BMAD create-story workflow with Party Mode analysis from:

- 🏗️ Winston (Architect) - Dependency Inversion pattern and interface design
- 💻 Amelia (Developer) - Code changes and implementation specifics
- 🧪 Murat (Test Architect) - Backward compatibility verification

### Agent Model Used

Claude Opus 4.5 (Preview)

### Debug Log References

- `npm run check-types` passed with no errors
- All 714 tests passed (including 11 conversationRunner tests)

### Completion Notes List

1. Changed import from `CopilotModelManager` to `ILLMClient`, kept `CopilotApiError` for fatal error detection
2. Renamed constructor parameter from `modelManager: CopilotModelManager` to `client: ILLMClient`
3. Updated 2 internal usages: `this.modelManager.getCurrentModel()` and `this.modelManager.sendRequest()` → `this.client.*`
4. TypeScript structural typing ensures existing callers (ToolCallingAnalysisProvider, SubagentExecutor) continue working without modification
5. Total: 5 lines changed, net 0 lines added/removed

### Change Log

| Date       | Author   | Changes                                           |
| ---------- | -------- | ------------------------------------------------- |
| 2025-12-16 | Bob (SM) | Initial story creation with party mode analysis   |
| 2025-12-16 | Amelia   | Implemented interface abstraction, all tests pass |

### File List

| File                               | Status   | Description                                                                |
| ---------------------------------- | -------- | -------------------------------------------------------------------------- |
| `src/models/conversationRunner.ts` | Modified | Updated constructor to accept ILLMClient, renamed internal field to client |
