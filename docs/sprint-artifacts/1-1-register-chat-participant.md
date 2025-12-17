# Story 1.1: Register Chat Participant

**Status:** Done
**Epic:** 1 - Core Chat Participant
**Story ID:** 1.1
**Estimated Effort:** XS (< 0.5 day)
**Created:** 2025-12-17

---

## Story

**As a** developer,
**I want to** type `@lupa` in Copilot Chat,
**So that** I can access Lupa's analysis capabilities.

---

## Acceptance Criteria

### AC-1.1.1: Package.json Contribution

**Given** the VS Code extension manifest
**When** configuring chatParticipants
**Then** package.json MUST include:

```json
{
  "contributes": {
    "chatParticipants": [
      {
        "id": "lupa.chat-participant",
        "name": "lupa",
        "fullName": "Lupa Code Review",
        "description": "Analyze pull requests and code changes",
        "isSticky": true,
        "commands": [
          {
            "name": "branch",
            "description": "Analyze current branch vs default branch"
          },
          {
            "name": "changes",
            "description": "Analyze uncommitted changes"
          }
        ]
      }
    ]
  }
}
```

**And** the contribution MUST be added inside the existing `contributes` section (after `commands`)

### AC-1.1.2: ChatParticipantService Creation

**Given** the package.json contribution
**When** the extension activates
**Then** `ChatParticipantService` MUST:

- Call `vscode.chat.createChatParticipant('lupa.chat-participant', handler)`
- Store the participant for disposal
- Implement `vscode.Disposable`
- Use singleton pattern with `getInstance()`

**Handler Stub:**

```typescript
async function handler(
  request: vscode.ChatRequest,
  context: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<vscode.ChatResult> {
  // Placeholder - full implementation in Story 1.2
  stream.markdown("Lupa chat participant registered. Commands coming soon!");
  return {};
}
```

### AC-1.1.3: Graceful Degradation

**Given** Copilot is not installed (or Chat API unavailable)
**When** the extension activates
**Then** chat participant registration MUST:

- Catch any errors during registration
- Log warning via `Log.warn()` from loggingService
- NOT crash the extension
- NOT prevent other features from working

**Error Handling Pattern:**

```typescript
try {
  this.participant = vscode.chat.createChatParticipant(/* ... */);
} catch (error) {
  Log.warn(
    "[ChatParticipantService]: Chat participant registration failed - Copilot may not be installed",
    error
  );
  // Service remains usable, just without chat participant functionality
}
```

### AC-1.1.4: ServiceManager Integration

**Given** the service lifecycle
**When** ServiceManager Phase 4 runs
**Then** `ChatParticipantService.getInstance()` MUST be called
**And** the service MUST be added to disposables in `IServiceRegistry`

---

## Tasks / Subtasks

- [x] **Task 1: Package.json Contribution** (AC: 1.1.1)

  - [x] Add `chatParticipants` array inside existing `contributes` section
  - [x] Include both `/branch` and `/changes` commands
  - [x] Set `isSticky: true` for conversation context

- [x] **Task 2: Create ChatParticipantService** (AC: 1.1.2, 1.1.3)

  - [x] Create `src/services/chatParticipantService.ts`
  - [x] Implement singleton pattern (`private static instance`, `static getInstance()`)
  - [x] Implement `vscode.Disposable` interface
  - [x] Register chat participant in constructor
  - [x] Store participant reference for disposal
  - [x] Implement placeholder handler returning empty ChatResult
  - [x] Wrap registration in try/catch for graceful degradation

- [x] **Task 3: Create chatTypes.ts** (AC: 1.1.2)

  - [x] Create `src/types/chatTypes.ts`
  - [x] Define `ChatAnalysisMetadata` interface (for follow-ups in Story 2.2)

- [x] **Task 4: ServiceManager Integration** (AC: 1.1.4)

  - [x] Add `chatParticipantService` to `IServiceRegistry` interface
  - [x] Create service instance in `initializeHighLevelServices()` (Phase 4)
  - [x] Add to disposal list in `dispose()` method

- [x] **Task 5: Unit Tests** (AC: all)

  - [x] Create `src/__tests__/chatParticipantService.test.ts`
  - [x] Test service initialization (singleton pattern)
  - [x] Test chat participant registration
  - [x] Test disposal unregisters participant
  - [x] Test graceful degradation when `vscode.chat` is undefined
  - [x] Test handler returns valid ChatResult

- [x] **Task 6: Verification**
  - [x] Run `npm run check-types` - no errors
  - [x] Run `npm run test` - all tests pass
  - [x] Manual test: `@lupa` appears in Copilot Chat

---

## Dev Notes

### Service Pattern Reference

Follow the pattern from `statusBarService.ts` and `gitService.ts`:

```typescript
export class ChatParticipantService implements vscode.Disposable {
  private static instance: ChatParticipantService | undefined;
  private participant: vscode.ChatParticipant | undefined;
  private disposables: vscode.Disposable[] = [];

  private constructor() {
    this.registerParticipant();
  }

  public static getInstance(): ChatParticipantService {
    if (!ChatParticipantService.instance) {
      ChatParticipantService.instance = new ChatParticipantService();
    }
    return ChatParticipantService.instance;
  }

  public dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.participant?.dispose();
    ChatParticipantService.instance = undefined;
  }
}
```

### Logging Convention

Use `Log` from loggingService, NOT `console.log`:

```typescript
import { Log } from "./loggingService";

// Correct
Log.info("[ChatParticipantService]: Chat participant registered successfully");
Log.warn("[ChatParticipantService]: Registration failed", error);

// NEVER use console.log in services
```

### VS Code Mock Extension Required

The `__mocks__/vscode.js` needs extension for `vscode.chat`:

```javascript
// Add to existing mock
const chat = {
  createChatParticipant: jest.fn().mockReturnValue({
    dispose: jest.fn(),
    iconPath: undefined,
    followupProvider: undefined,
  }),
};
```

### Project Structure Notes

**New files align with existing structure:**

| File                             | Location         | Pattern Source             |
| -------------------------------- | ---------------- | -------------------------- |
| `chatParticipantService.ts`      | `src/services/`  | `statusBarService.ts`      |
| `chatTypes.ts`                   | `src/types/`     | `modelTypes.ts`            |
| `chatParticipantService.test.ts` | `src/__tests__/` | `analysisProvider.test.ts` |

### Architecture Decisions Applied

From [architecture.md](../architecture.md):

- **Decision 6:** Error handling via `ChatResult.errorDetails` (not used in Story 1.1, but handler returns `ChatResult`)
- **Decision 7:** Cancellation propagation (handler accepts token, not used in stub)

### Epic 0 Learnings Applied

From [epic-0-retro](epic-0-retro-2025-12-17.md):

- **Domain-specific naming:** `ChatParticipantService` not `ParticipantService`
- **Prototype early:** Test with VS Code chat API as documentation has gaps

---

## References

- [Source: docs/epics.md#Story-1.1]
- [Source: docs/architecture.md#Decision-6-Error-Handling-Pattern]
- [Source: docs/architecture.md#Decision-7-Cancellation-Propagation]
- [Source: docs/prd.md#4.1-Chat-Participant-Registration]
- [Source: epic-0-retro-2025-12-17.md#Challenge-2-Naming-Collision]

---

## Dev Agent Record

### Context Reference

Story context created by SM agent (Bob) with Party Mode collaboration.

### Agent Model Used

Claude Opus 4.5 (Preview)

### Debug Log References

N/A - Story creation phase

### Completion Notes List

- ✅ Story 1.1 implementation complete - all ACs satisfied
- Registered chat participant with id `lupa.chat-participant`
- Implemented graceful degradation for missing Copilot
- Added 7 comprehensive unit tests - all passing
- Extended VS Code mock with `chat.createChatParticipant`
- Full test suite: 793 tests passing (60 files), zero regressions
- Type checking: Clean compilation, no errors

### File List

**Create:**

- `src/services/chatParticipantService.ts`
- `src/__tests__/chatParticipantService.test.ts`

**Modify:**

- `package.json` (added chatParticipants contribution)
- `src/services/serviceManager.ts` (Phase 4 registration, disposal)
- `src/types/chatTypes.ts` (added ChatAnalysisMetadata)
- `__mocks__/vscode.js` (extended chat mock)

### Change Log

- 2025-12-17: Story 1.1 implementation complete - Chat participant registered with stub handler, comprehensive tests, ServiceManager integration
- 2025-12-17: Code review completed - Fixed 7 issues:
  - Fixed test assertion to use correct Log.warn format (2 args with bracket prefix)
  - Added JSDoc documentation to ChatParticipantService class and public methods
  - Added @internal tag to reset() test-only method
  - Removed double disposal of participant (was in both disposables array and direct call)
  - Prefixed unused handler parameters with underscore
  - Added JSDoc documentation to ChatAnalysisMetadata interface
  - Added trailing newline to package.json
