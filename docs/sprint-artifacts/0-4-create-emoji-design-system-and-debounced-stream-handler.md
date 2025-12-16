# Story 0.4: Create Emoji Design System and Debounced Stream Handler

**Status:** Ready for Review
**Story ID:** 0.4
**Epic:** 0 - Foundation & Interface Abstraction
**Created:** 2025-12-16
**Created By:** Bob (SM) with Party Mode (Winston, Sally, Murat)

---

## Story

**As a** developer maintaining Lupa,
**I want** centralized emoji constants and rate-limited progress streaming,
**So that** all chat responses are consistent, accessible, and don't cause UI flicker.

---

## Business Context

This story establishes the **UX Foundation** for the chat participant feature. It creates:

1. **Emoji Design System** - Centralized constants ensuring consistent, accessible severity and activity indicators across all chat responses
2. **DebouncedStreamHandler** - Rate-limited progress streaming to prevent UI flicker (max 10 updates/second per NFR-002)

**Business Value:** Ensures professional, accessible UX from day one. Prevents each developer from making independent emoji choices that could create inconsistency.

**Emotional Design Impact:** The emoji system directly supports the "Supportive, Not Judgmental" principle from the UX specification. Using 🔴 (attention needed) instead of ❌ (error/wrong) maintains a helpful tone.

---

## Acceptance Criteria

### AC-0.4.1: Emoji Design System Constants

**Given** the UX specification defines specific emoji for severity and activity
**When** creating `chatEmoji.ts`
**Then** the file MUST define:

| Object     | Key          | Emoji | Purpose                     |
| ---------- | ------------ | ----- | --------------------------- |
| `SEVERITY` | `critical`   | 🔴    | Stop-and-fix problems       |
| `SEVERITY` | `suggestion` | 🟡    | Consider improving          |
| `SEVERITY` | `success`    | ✅    | Positive confirmation       |
| `SEVERITY` | `warning`    | ⚠️    | Caution needed              |
| `ACTIVITY` | `thinking`   | 💭    | AI reasoning process        |
| `ACTIVITY` | `searching`  | 🔍    | Finding symbols/definitions |
| `ACTIVITY` | `reading`    | 📂    | File operations             |
| `ACTIVITY` | `analyzing`  | 🔎    | Deep code inspection        |
| `SECTION`  | `security`   | 🔒    | Security findings           |
| `SECTION`  | `testing`    | 🧪    | Testing suggestions         |
| `SECTION`  | `summary`    | 📊    | Summary statistics          |
| `SECTION`  | `files`      | 📁    | File listings               |

**And** all emoji MUST be distinguishable by shape (not just color) per UX-NFR-001
**And** types `SeverityType`, `ActivityType`, `SectionType` MUST be exported
**And** the file MUST be located at `src/config/chatEmoji.ts`

---

### AC-0.4.2: ChatToolCallHandler Interface Definition

**Given** the need for a streaming progress handler interface
**When** creating `chatTypes.ts`
**Then** the file MUST define `ChatToolCallHandler` interface with:

```typescript
export interface ChatToolCallHandler {
  onProgress(message: string): void;
  onToolStart(toolName: string, args: Record<string, unknown>): void;
  onToolComplete(toolName: string, success: boolean, summary: string): void;
  onFileReference(filePath: string, range?: vscode.Range): void;
  onThinking(thought: string): void;
  onMarkdown(content: string): void;
}
```

**And** the interface MUST be in `src/types/chatTypes.ts`
**And** the interface name MUST be `ChatToolCallHandler` to avoid collision with existing `ToolCallHandler` in `conversationRunner.ts`

---

### AC-0.4.3: DebouncedStreamHandler Implementation

**Given** NFR-002 requires max 10 updates/second to prevent UI flicker
**When** creating `DebouncedStreamHandler`
**Then** the handler MUST:

- Implement `ChatToolCallHandler` interface
- Accept an inner `ChatToolCallHandler` in constructor (decorator pattern)
- Limit `onProgress()` calls to max 10/second (100ms minimum interval)
- Immediately pass through `onToolStart`, `onToolComplete`, `onThinking`, `onMarkdown`
- Store pending progress messages when rate-limited
- Flush pending progress message BEFORE other events
- Provide `flush()` method to send final pending message

**And** the class MUST be in `src/models/debouncedStreamHandler.ts`

---

### AC-0.4.4: Unit Tests

**Given** the UX foundation components
**When** running tests
**Then** tests MUST verify:

**chatEmoji.test.ts:**

- All SEVERITY emoji are defined correctly (4 entries)
- All ACTIVITY emoji are defined correctly (4 entries)
- All SECTION emoji are defined correctly (4 entries)
- Types are properly exported and usable

**debouncedStreamHandler.test.ts:**

- Debouncing limits progress updates to max 10/sec (100ms interval)
- Rapid `onProgress` calls within 100ms only emit first
- `onToolStart` flushes pending and passes through
- `onToolComplete` flushes pending and passes through
- `onThinking` flushes pending and passes through
- `onMarkdown` flushes pending and passes through
- `onFileReference` passes through (no flush needed)
- `flush()` sends any remaining pending message
- `flush()` when no pending does nothing

---

## Developer Context (Party Mode Analysis)

### 🏗️ Architecture Context (Winston)

**Design Patterns:**

1. **Centralized Constants Pattern** - `chatEmoji.ts` provides a single source of truth for all emoji. This prevents inconsistency and enables easy updates.

2. **Decorator Pattern** - `DebouncedStreamHandler` wraps any `ChatToolCallHandler`, adding debouncing behavior without modifying the inner handler. Classic Gang of Four pattern.

**Interface Segregation:**
We're creating a NEW interface `ChatToolCallHandler` rather than modifying the existing `ToolCallHandler` in `conversationRunner.ts`. Reasons:

1. **Different purposes:** Existing interface is for conversation recording; new interface is for chat streaming
2. **Different consumers:** ConversationRunner vs ChatParticipantService
3. **Avoid breaking changes:** Existing code continues working unchanged

**Type Design:**

```typescript
// Read-only const objects for type safety
export const SEVERITY = {
  critical: "🔴",
  suggestion: "🟡",
  success: "✅",
  warning: "⚠️",
} as const;

export type SeverityType = keyof typeof SEVERITY;
```

Using `as const` ensures the object is deeply readonly and enables type inference from keys.

**Architecture References:**

- [Architecture Decision 9](docs/architecture.md#decision-9-emoji-design-system-constants-ux-driven) - Emoji Design System
- [Architecture Decision 10](docs/architecture.md#decision-10-streaming-debounce-pattern-ux-driven) - Debounce Pattern
- [UX Specification: Emoji Design System](docs/ux-design-specification.md#emoji-design-system) - Emoji selection rationale

---

### 🎨 UX Context (Sally)

**Accessibility Requirements (UX-NFR-001):**

The emoji must be distinguishable by **shape**, not just color. This is critical for color-blind users:

| Emoji | Shape            | Distinguishable? |
| ----- | ---------------- | ---------------- |
| 🔴    | Circle           | ✅ Yes           |
| 🟡    | Circle           | ✅ Yes (vs 🔴)   |
| ✅    | Checkmark        | ✅ Yes           |
| ⚠️    | Triangle         | ✅ Yes           |
| 💭    | Speech bubble    | ✅ Yes           |
| 🔍    | Magnifying glass | ✅ Yes           |
| 📂    | Folder           | ✅ Yes           |

**Why These Specific Emoji:**

- 🔴 **Critical:** Red circle universally understood as "attention needed" - less aggressive than ❌
- 🟡 **Suggestion:** Yellow for "consider this" - not alarming, just informative
- ✅ **Success:** Positive checkmark reinforces accomplishment
- 💭 **Thinking:** Shows AI is reasoning, builds trust through transparency

**Emotional Design:**

| Scenario       | ❌ Don't Use | ✅ Do Use | Reason                      |
| -------------- | ------------ | --------- | --------------------------- |
| Critical issue | ❌           | 🔴        | Less judgmental             |
| Suggestion     | ⚠️           | 🟡        | Warning feels too severe    |
| Analysis done  | 🏁           | ✅        | Checkmark = accomplishment  |
| Processing     | ⏳           | 💭        | Shows thinking, not waiting |

**UX References:**

- [UX Spec: Emoji Design System](docs/ux-design-specification.md#emoji-design-system)
- [UX Spec: Emotional Design Principles](docs/ux-design-specification.md#emotional-design-principles)
- [UX Spec: Accessibility Considerations](docs/ux-design-specification.md#accessibility-considerations)

---

### 💻 Implementation Context (Amelia)

**Source Files to Create:**

| File                                           | Purpose              | Lines (est.) |
| ---------------------------------------------- | -------------------- | ------------ |
| `src/config/chatEmoji.ts`                      | Emoji constants      | ~40          |
| `src/types/chatTypes.ts`                       | Interface definition | ~25          |
| `src/models/debouncedStreamHandler.ts`         | Debounce decorator   | ~80          |
| `src/__tests__/chatEmoji.test.ts`              | Emoji tests          | ~40          |
| `src/__tests__/debouncedStreamHandler.test.ts` | Debounce tests       | ~120         |

**Implementation: chatEmoji.ts**

```typescript
/**
 * Centralized emoji constants for chat responses.
 * All emoji are chosen to be distinguishable by shape (accessibility requirement).
 * @see docs/ux-design-specification.md#emoji-design-system
 */

/**
 * Severity indicators - used for finding cards and status messages.
 * Circle shapes with different fills, plus checkmark for success.
 */
export const SEVERITY = {
  /** 🔴 Critical issue - must fix before shipping */
  critical: "🔴",
  /** 🟡 Suggestion - consider improving */
  suggestion: "🟡",
  /** ✅ Success - positive confirmation */
  success: "✅",
  /** ⚠️ Warning - caution needed */
  warning: "⚠️",
} as const;

/**
 * Activity indicators - shown during analysis progress.
 */
export const ACTIVITY = {
  /** 💭 AI is reasoning/thinking */
  thinking: "💭",
  /** 🔍 Finding symbols, searching definitions */
  searching: "🔍",
  /** 📂 Reading files */
  reading: "📂",
  /** 🔎 Deep code inspection */
  analyzing: "🔎",
} as const;

/**
 * Section markers - used for response structure headers.
 */
export const SECTION = {
  /** 🔒 Security-related findings */
  security: "🔒",
  /** 🧪 Testing suggestions */
  testing: "🧪",
  /** 📊 Summary statistics */
  summary: "📊",
  /** 📁 File listings */
  files: "📁",
} as const;

export type SeverityType = keyof typeof SEVERITY;
export type ActivityType = keyof typeof ACTIVITY;
export type SectionType = keyof typeof SECTION;
```

**Implementation: chatTypes.ts**

```typescript
import * as vscode from "vscode";

/**
 * Callback interface for streaming chat responses.
 * Different from ToolCallHandler in conversationRunner.ts which is for conversation recording.
 * This interface is for the chat participant to stream progress and findings.
 */
export interface ChatToolCallHandler {
  /** Called to stream progress updates during analysis */
  onProgress(message: string): void;

  /** Called when a tool starts executing */
  onToolStart(toolName: string, args: Record<string, unknown>): void;

  /** Called when a tool completes */
  onToolComplete(toolName: string, success: boolean, summary: string): void;

  /** Called to reference a file location (creates clickable anchor) */
  onFileReference(filePath: string, range?: vscode.Range): void;

  /** Called to show AI thinking/reasoning */
  onThinking(thought: string): void;

  /** Called to stream markdown content */
  onMarkdown(content: string): void;
}
```

**Implementation: debouncedStreamHandler.ts**

```typescript
import { ChatToolCallHandler } from "../types/chatTypes";
import * as vscode from "vscode";

/**
 * Decorator that rate-limits progress updates to prevent UI flicker.
 * Implements NFR-002: max 10 updates/second (100ms minimum interval).
 *
 * Only `onProgress` is debounced. Other events pass through immediately
 * after flushing any pending progress message.
 */
export class DebouncedStreamHandler implements ChatToolCallHandler {
  private lastProgressTime = 0;
  private pendingProgress: string | undefined;
  private readonly minIntervalMs = 100; // 10 updates/sec max

  constructor(private readonly innerHandler: ChatToolCallHandler) {}

  onProgress(message: string): void {
    const now = Date.now();
    if (now - this.lastProgressTime >= this.minIntervalMs) {
      this.innerHandler.onProgress(message);
      this.lastProgressTime = now;
      this.pendingProgress = undefined;
    } else {
      // Store for potential flush - latest message wins
      this.pendingProgress = message;
    }
  }

  onToolStart(toolName: string, args: Record<string, unknown>): void {
    this.flushPending();
    this.innerHandler.onToolStart(toolName, args);
  }

  onToolComplete(toolName: string, success: boolean, summary: string): void {
    this.flushPending();
    this.innerHandler.onToolComplete(toolName, success, summary);
  }

  onFileReference(filePath: string, range?: vscode.Range): void {
    // File references pass through without flush - they don't interrupt flow
    this.innerHandler.onFileReference(filePath, range);
  }

  onThinking(thought: string): void {
    this.flushPending();
    this.innerHandler.onThinking(thought);
  }

  onMarkdown(content: string): void {
    this.flushPending();
    this.innerHandler.onMarkdown(content);
  }

  /**
   * Flush any pending progress message.
   * Call this at the end of analysis to ensure the final message is sent.
   */
  flush(): void {
    this.flushPending();
  }

  private flushPending(): void {
    if (this.pendingProgress) {
      this.innerHandler.onProgress(this.pendingProgress);
      this.pendingProgress = undefined;
      this.lastProgressTime = Date.now();
    }
  }
}
```

**Estimated Changes:**

- 5 new files created
- ~300 lines of code total
- Net new: ~300 lines

---

### 🧪 Testing Context (Murat)

**Risk Assessment: LOW**

These are pure utility classes with no external dependencies beyond vscode types.

**Test Coverage Requirements:**

| Component              | Test Cases | Coverage Target |
| ---------------------- | ---------- | --------------- |
| chatEmoji.ts           | 4          | 100%            |
| DebouncedStreamHandler | 10         | 100%            |

**chatEmoji.test.ts Test Cases:**

```typescript
describe("chatEmoji", () => {
  describe("SEVERITY", () => {
    it("should define critical as red circle", () => {
      expect(SEVERITY.critical).toBe("🔴");
    });
    it("should define suggestion as yellow circle", () => {
      expect(SEVERITY.suggestion).toBe("🟡");
    });
    it("should define success as checkmark", () => {
      expect(SEVERITY.success).toBe("✅");
    });
    it("should define warning as triangle", () => {
      expect(SEVERITY.warning).toBe("⚠️");
    });
  });

  describe("ACTIVITY", () => {
    it("should define all activity emoji", () => {
      expect(ACTIVITY.thinking).toBe("💭");
      expect(ACTIVITY.searching).toBe("🔍");
      expect(ACTIVITY.reading).toBe("📂");
      expect(ACTIVITY.analyzing).toBe("🔎");
    });
  });

  describe("SECTION", () => {
    it("should define all section emoji", () => {
      expect(SECTION.security).toBe("🔒");
      expect(SECTION.testing).toBe("🧪");
      expect(SECTION.summary).toBe("📊");
      expect(SECTION.files).toBe("📁");
    });
  });

  describe("Types", () => {
    it("should export SeverityType", () => {
      const severity: SeverityType = "critical";
      expect(severity).toBe("critical");
    });
  });
});
```

**debouncedStreamHandler.test.ts Test Cases:**

```typescript
describe("DebouncedStreamHandler", () => {
  let mockInner: ChatToolCallHandler;
  let handler: DebouncedStreamHandler;

  beforeEach(() => {
    mockInner = {
      onProgress: vi.fn(),
      onToolStart: vi.fn(),
      onToolComplete: vi.fn(),
      onFileReference: vi.fn(),
      onThinking: vi.fn(),
      onMarkdown: vi.fn(),
    };
    handler = new DebouncedStreamHandler(mockInner);
  });

  describe("onProgress debouncing", () => {
    it("should pass through first call immediately", () => {
      handler.onProgress("message 1");
      expect(mockInner.onProgress).toHaveBeenCalledWith("message 1");
    });

    it("should debounce rapid calls within 100ms", () => {
      handler.onProgress("message 1");
      handler.onProgress("message 2");
      handler.onProgress("message 3");
      expect(mockInner.onProgress).toHaveBeenCalledTimes(1);
      expect(mockInner.onProgress).toHaveBeenCalledWith("message 1");
    });

    it("should emit after 100ms interval", async () => {
      handler.onProgress("message 1");
      await sleep(110);
      handler.onProgress("message 2");
      expect(mockInner.onProgress).toHaveBeenCalledTimes(2);
    });
  });

  describe("flush before events", () => {
    it("should flush pending before onToolStart", () => {
      handler.onProgress("pending");
      handler.onProgress("latest"); // This becomes pending
      handler.onToolStart("readFile", { path: "/test" });

      expect(mockInner.onProgress).toHaveBeenNthCalledWith(1, "pending");
      expect(mockInner.onProgress).toHaveBeenNthCalledWith(2, "latest");
      expect(mockInner.onToolStart).toHaveBeenCalled();
    });

    it("should flush pending before onToolComplete", () => {
      handler.onProgress("first");
      handler.onProgress("pending");
      handler.onToolComplete("readFile", true, "done");

      expect(mockInner.onProgress).toHaveBeenCalledWith("pending");
    });

    it("should flush pending before onThinking", () => {
      handler.onProgress("first");
      handler.onProgress("pending");
      handler.onThinking("considering...");

      expect(mockInner.onProgress).toHaveBeenCalledWith("pending");
    });

    it("should flush pending before onMarkdown", () => {
      handler.onProgress("first");
      handler.onProgress("pending");
      handler.onMarkdown("## Results");

      expect(mockInner.onProgress).toHaveBeenCalledWith("pending");
    });
  });

  describe("pass-through methods", () => {
    it("should pass through onFileReference without flush", () => {
      handler.onFileReference("/path/file.ts");
      expect(mockInner.onFileReference).toHaveBeenCalledWith("/path/file.ts");
    });
  });

  describe("flush()", () => {
    it("should send pending message", () => {
      handler.onProgress("first");
      handler.onProgress("pending");
      handler.flush();

      expect(mockInner.onProgress).toHaveBeenCalledWith("pending");
    });

    it("should do nothing when no pending", () => {
      handler.onProgress("message");
      mockInner.onProgress.mockClear();
      handler.flush();

      expect(mockInner.onProgress).not.toHaveBeenCalled();
    });
  });
});
```

**Mock Setup:**

- Use Vitest's `vi.fn()` for mock functions
- Use `vi.useFakeTimers()` for time-sensitive tests
- No external dependencies to mock

**Verification Commands:**

```bash
npm run check-types                # Must pass with no errors
npx vitest run src/__tests__/chatEmoji.test.ts
npx vitest run src/__tests__/debouncedStreamHandler.test.ts
npm run test                       # All tests must pass
```

---

## Technical Requirements

### File Locations

| File                      | Location         | Purpose                                         |
| ------------------------- | ---------------- | ----------------------------------------------- |
| chatEmoji.ts              | `src/config/`    | Follows existing pattern (treeSitterQueries.ts) |
| chatTypes.ts              | `src/types/`     | Follows existing types pattern                  |
| debouncedStreamHandler.ts | `src/models/`    | Contains behavior, not just types               |
| Tests                     | `src/__tests__/` | Standard test location                          |

### Import Structure

```typescript
// In debouncedStreamHandler.ts
import * as vscode from "vscode";
import { ChatToolCallHandler } from "../types/chatTypes";

// In chatEmoji.ts
// No imports needed - pure constants

// In chatTypes.ts
import * as vscode from "vscode";
```

### Type Exports

From `chatEmoji.ts`:

- `SEVERITY` (const object)
- `ACTIVITY` (const object)
- `SECTION` (const object)
- `SeverityType` (type)
- `ActivityType` (type)
- `SectionType` (type)

From `chatTypes.ts`:

- `ChatToolCallHandler` (interface)

From `debouncedStreamHandler.ts`:

- `DebouncedStreamHandler` (class)

---

## Tasks / Subtasks

### Task 1: Create Emoji Design System (AC: 0.4.1)

- [x] Create `src/config/chatEmoji.ts`
- [x] Define SEVERITY object with 4 emoji
- [x] Define ACTIVITY object with 4 emoji
- [x] Define SECTION object with 4 emoji
- [x] Export SeverityType, ActivityType, SectionType
- [x] Add JSDoc comments explaining each emoji choice

### Task 2: Create ChatToolCallHandler Interface (AC: 0.4.2)

- [x] Create `src/types/chatTypes.ts`
- [x] Define ChatToolCallHandler interface
- [x] Include all 6 methods from architecture
- [x] Add JSDoc explaining difference from ToolCallHandler

### Task 3: Create DebouncedStreamHandler (AC: 0.4.3)

- [x] Create `src/models/debouncedStreamHandler.ts`
- [x] Implement ChatToolCallHandler interface
- [x] Implement 100ms debounce for onProgress
- [x] Implement flush before tool events
- [x] Implement public flush() method
- [x] Add JSDoc explaining decorator pattern

### Task 4: Create Unit Tests (AC: 0.4.4)

- [x] Create `src/__tests__/chatEmoji.test.ts`
- [x] Test all SEVERITY emoji values
- [x] Test all ACTIVITY emoji values
- [x] Test all SECTION emoji values
- [x] Test type exports work correctly
- [x] Create `src/__tests__/debouncedStreamHandler.test.ts`
- [x] Test debounce limits to 10/sec
- [x] Test pending flush before events
- [x] Test flush() method
- [x] Test pass-through for onFileReference

### Task 5: Verification (AC: All)

- [x] Run `npm run check-types` - must pass with no errors
- [x] Run tests for new files - all must pass
- [x] Run `npm run test` - all 714+ tests must pass (751 total now)
- [x] Verify no circular dependencies introduced

---

## Dev Notes

### Integration Clarification (Added 2025-12-15)

**How These Components Will Be Used:**

The utilities created in this story are part of the **Hybrid Output Approach** (Architecture Decision 11):

| Component                | Integration Point                                                                       | Used By        |
| ------------------------ | --------------------------------------------------------------------------------------- | -------------- |
| `SEVERITY`, `SECTION`    | `ChatResponseBuilder` methods for extension-controlled messages (intro, summary, error) | Extension only |
| `ACTIVITY`               | `DebouncedStreamHandler.onProgress()` for progress updates during analysis              | Extension only |
| `DebouncedStreamHandler` | Wraps `ChatStreamHandler` to rate-limit `stream.progress()` calls to 10/sec             | Extension only |
| `ChatToolCallHandler`    | Interface for `ChatStreamHandler` implementation (Story 2.1)                            | Extension only |

**Key Insight:** These utilities are NOT used to format LLM output. The LLM analysis content streams as-is via `stream.markdown()`. We control only:

- Progress updates during analysis (uses `ACTIVITY` emoji via `DebouncedStreamHandler`)
- Intro/greeting messages (uses `ChatResponseBuilder` with `SEVERITY`/`SECTION` emoji)
- Summary messages after analysis (uses `ChatResponseBuilder`)
- Error messages (uses `ChatResponseBuilder.error()`)
- Follow-up chips (uses `stream.button()`)

The emoji system provides consistency for OUR messages, not LLM messages. We ask the LLM to use these emoji via system prompt, but cannot enforce it.

### Critical Implementation Details

1. **Interface Naming:** Use `ChatToolCallHandler` NOT `ToolCallHandler` to avoid confusion with the existing interface in `conversationRunner.ts`. They serve different purposes:

   - `ToolCallHandler` (existing): Records tool calls for conversation history
   - `ChatToolCallHandler` (new): Streams progress to chat UI

2. **Debounce Behavior:** Only `onProgress` is debounced. Other methods pass through immediately because:

   - `onToolStart/Complete`: Users should see tool activity immediately
   - `onThinking`: Builds trust, should appear when AI is thinking
   - `onMarkdown`: Final content, never debounce

3. **Pending Message:** When debounced, the LATEST message is stored. Earlier messages are discarded. This ensures the user sees the most recent status.

4. **Flush Timing:** Flush happens BEFORE the event that triggers it. Order is:

   ```
   pending progress → new event
   ```

   This ensures context is preserved.

5. **vscode.Range:** The `onFileReference` method accepts optional `vscode.Range`. This is imported from vscode module. Tests should use undefined or mock Range.

### Previous Story Intelligence

**From Story 0.3:**

- ConversationRunner now accepts ILLMClient
- Existing ToolCallHandler unchanged
- Pattern established: interfaces in models folder

**Git Commit Pattern:**

```
feat(config): add chatEmoji constants (Story 0.4)
feat(types): add ChatToolCallHandler interface (Story 0.4)
feat(models): add DebouncedStreamHandler (Story 0.4)
```

**Suggested Single Commit:**

```
feat(ux): add emoji design system and debounced streaming (Story 0.4)

- Create chatEmoji.ts with severity, activity, section constants
- Create ChatToolCallHandler interface for chat streaming
- Create DebouncedStreamHandler with 100ms debounce (10 updates/sec max)
- Add comprehensive unit tests for all components

Implements NFR-002 and UX-FR-002, UX-FR-003, UX-NFR-001.
```

### Files to Create

| File                                           | Description                            |
| ---------------------------------------------- | -------------------------------------- |
| `src/config/chatEmoji.ts`                      | Centralized emoji constants with types |
| `src/types/chatTypes.ts`                       | ChatToolCallHandler interface          |
| `src/models/debouncedStreamHandler.ts`         | Rate-limited streaming handler         |
| `src/__tests__/chatEmoji.test.ts`              | Emoji constant tests                   |
| `src/__tests__/debouncedStreamHandler.test.ts` | Debounce behavior tests                |

### Files NOT Modified

| File                                          | Reason                             |
| --------------------------------------------- | ---------------------------------- |
| `src/models/conversationRunner.ts`            | Existing ToolCallHandler unchanged |
| `src/services/toolCallingAnalysisProvider.ts` | Uses existing ToolCallHandler      |
| Any existing files                            | Pure additions, no modifications   |

### Project Structure Notes

**Alignment with Existing Patterns:**

- `src/config/` contains `treeSitterQueries.ts` - chatEmoji.ts follows same pattern
- `src/types/` contains domain-specific types - chatTypes.ts follows same pattern
- `src/models/` contains behavioral classes - debouncedStreamHandler.ts follows same pattern

**No Circular Dependencies:**

- chatEmoji.ts has no imports
- chatTypes.ts only imports vscode
- debouncedStreamHandler.ts imports chatTypes (no cycles)

### Dependency Clarification

**Epics file states:** "Dependencies: Story 0.1 (ToolCallHandler interface)"

**Clarification:** This was an error in the epics. Story 0.1 created ILLMClient, not ToolCallHandler. Story 0.4 creates its own interface (ChatToolCallHandler) to avoid this dependency issue.

**Actual Dependencies:** None. Story 0.4 is self-contained.

### Future Integration

Story 2.1 (Rich Progress Visualization) will:

- Import ChatToolCallHandler from chatTypes.ts
- Import emoji from chatEmoji.ts
- Create ChatStreamHandler implementing ChatToolCallHandler
- Wrap ChatStreamHandler with DebouncedStreamHandler

Story 0.5 (ChatResponseBuilder) will:

- Import emoji from chatEmoji.ts
- Use SEVERITY and SECTION emoji in response formatting

### References

- [Architecture Decision 9](docs/architecture.md#decision-9-emoji-design-system-constants-ux-driven) - Emoji constants design
- [Architecture Decision 10](docs/architecture.md#decision-10-streaming-debounce-pattern-ux-driven) - Debounce pattern
- [UX Specification: Emoji Design System](docs/ux-design-specification.md#emoji-design-system) - Emoji selection rationale
- [UX Specification: Accessibility](docs/ux-design-specification.md#accessibility-considerations) - Shape-based emoji requirement
- [Epic 0 Story 0.4](docs/epics.md#story-04-create-emoji-design-system-and-debounced-stream-handler-ux-foundation) - Story definition
- [NFR-002](docs/epics.md#non-functional-requirements) - Debounce requirement
- [UX-FR-002, UX-FR-003, UX-NFR-001](docs/epics.md#ux-design-requirements-from-ux-design-specification) - UX requirements

---

## Dev Agent Record

### Context Reference

Story created via BMAD create-story workflow with Party Mode analysis from:

- 🏗️ Winston (Architect) - Interface design and decorator pattern
- 🎨 Sally (UX Designer) - Emoji selection and accessibility requirements
- 🧪 Murat (Test Architect) - Test coverage requirements

### Agent Model Used

Claude Opus 4.5 (Preview)

### Debug Log References

N/A - Story creation phase

### Completion Notes List

✅ **Story 0.4 Implementation Complete** (2025-12-16)

**Implementation Summary:**

- Created centralized emoji design system with 12 emoji across 3 categories (SEVERITY, ACTIVITY, SECTION)
- Created ChatToolCallHandler interface with 6 methods for chat streaming
- Implemented DebouncedStreamHandler decorator with 100ms debounce (10 updates/sec max per NFR-002)
- All 37 new tests pass, full test suite passes (751 tests total)
- Type checking passes with no errors
- No circular dependencies introduced

**Key Decisions:**

- Used `as const` pattern for type-safe readonly objects
- Decorator pattern for DebouncedStreamHandler (Gang of Four)
- onFileReference passes through without flush (doesn't interrupt flow)
- Latest pending message wins when debounced

### Change Log

| Date       | Author       | Changes                                             |
| ---------- | ------------ | --------------------------------------------------- |
| 2025-12-16 | Bob (SM)     | Initial story creation with party mode analysis     |
| 2025-12-16 | Amelia (Dev) | Implemented all tasks, tests pass, ready for review |

### File List

| File                                           | Status  | Description                   |
| ---------------------------------------------- | ------- | ----------------------------- |
| `src/config/chatEmoji.ts`                      | Created | Emoji constants               |
| `src/types/chatTypes.ts`                       | Created | ChatToolCallHandler interface |
| `src/models/debouncedStreamHandler.ts`         | Created | Debounce decorator            |
| `src/__tests__/chatEmoji.test.ts`              | Created | Emoji tests (17 tests)        |
| `src/__tests__/debouncedStreamHandler.test.ts` | Created | Debounce tests (20 tests)     |
