---
stepsCompleted: [1, 2, 3, 4]
inputDocuments:
  - docs/prd.md
  - docs/architecture.md
  - docs/ux-design-specification.md
workflowType: "epics"
lastStep: 4
status: "revised"
completedAt: "2025-12-15"
revisedAt: "2025-12-16"
revisionReason: "Incorporated UX Design Specification requirements"
project_name: "Lupa"
feature_name: "@lupa Chat Participant"
user_name: "Igor"
date: "2025-12-16"
---

# Lupa - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for Lupa's `@lupa` Chat Participant feature, decomposing the requirements from the PRD, Architecture, and **UX Design Specification** into implementable stories.

**Revision Note (December 16, 2025):** Updated to incorporate UX Design Specification requirements including ChatResponseBuilder, Emoji Design System, DebouncedStreamHandler, and emotional design patterns.

---

## Requirements Inventory

### Functional Requirements

**Chat Participant Registration (FR-001 to FR-004):**

- FR-001: Extension MUST register a chat participant with id `lupa.chat-participant` and name `lupa`
- FR-002: Participant MUST declare two slash commands: `/branch` and `/changes`
- FR-003: Participant MUST set `isSticky: true` to maintain context for follow-up questions
- FR-004: Participant MUST configure disambiguation for auto-routing code review questions

**Command Handling (FR-010 to FR-012):**

- FR-010: `/branch` command MUST create `ChatLLMClient`, call `GitOperations.getDiffToDefaultBranch()`, execute `ConversationRunner`, stream to `ChatResponseStream`, support cancellation
- FR-011: `/changes` command MUST call `GitOperations.getUncommittedDiff()` with same streaming behavior as `/branch`
- FR-012: No-command invocation (`@lupa <question>`) MUST enable exploration mode for codebase Q&A

**Streaming Response (FR-020 to FR-023):**

- FR-020: Analysis progress MUST use `stream.progress()` for status updates
- FR-021: File references MUST use `stream.reference()` with file icon
- FR-022: Inline code locations MUST use `stream.anchor()` for clickable links
- FR-023: Analysis findings MUST be formatted as markdown with severity indicators and clickable file anchors

**Follow-up Suggestions (FR-030 to FR-033):**

- FR-030: Participant MUST implement `ChatFollowupProvider`
- FR-031: Follow-ups MUST be contextual based on analysis findings
- FR-032: Follow-up suggestions MUST trigger continued conversation with Lupa
- FR-033: Follow-up prompts must be created with Anthropic's best practices for clarity and context

**Tool Registration (FR-050 to FR-052):**

- FR-050: Extension MUST register `lupa_getSymbolsOverview` as a language model tool
- FR-051: Tool MUST be declared in `package.json` under `languageModelTools`
- FR-052: Tool MUST wrap existing `GetSymbolsOverviewTool` implementation

### Non-Functional Requirements

**Performance (NFR-001 to NFR-003):**

- NFR-001: First progress message MUST appear within 500ms of command invocation
- NFR-002: Streaming updates MUST be debounced to prevent UI flicker (max 10 updates/second)
- NFR-003: Analysis MUST complete within 5 minutes for typical PRs (<100 files)

**Reliability (NFR-010 to NFR-012):**

- NFR-010: Cancellation MUST cleanly stop analysis and display "Analysis cancelled" message
- NFR-011: Errors MUST be caught and displayed via `ChatResult.errorDetails`
- NFR-012: Partial results MUST be preserved if analysis fails mid-stream

**Usability (NFR-020 to NFR-022):**

- NFR-020: Progress messages MUST clearly indicate current operation
- NFR-021: File references MUST be clickable and open correct file/line
- NFR-022: Follow-up suggestions MUST be actionable and relevant

**Compatibility (NFR-030 to NFR-031):**

- NFR-030: Feature MUST work on VS Code 1.95+ (Chat Participant API availability)
- NFR-031: Feature MUST gracefully degrade if Copilot is not installed (show error message)

### Additional Requirements (from Architecture)

**Interface & Abstraction Requirements:**

- `ILLMClient` interface MUST be created for LLM access abstraction (Dependency Inversion)
- `ChatLLMClient` MUST wrap `request.model` from chat participant
- `CopilotModelManager` MUST implement `ILLMClient` interface (trivial change)
- `ModelRequestHandler` MUST extract shared message conversion logic

**Service Registration Requirements:**

- `ChatParticipantService` MUST be registered in ServiceManager Phase 4
- `LanguageModelToolProvider` MUST be registered in ServiceManager Phase 4
- Both services MUST implement `vscode.Disposable`

**Pattern Requirements:**

- All services MUST use singleton via `getInstance()` pattern
- Tool results MUST use `toolSuccess()`/`toolError()` helpers
- Logging MUST use `Log` from loggingService, not `console.log`
- Progress streaming MUST use `ToolCallHandler` callback interface

### UX Design Requirements (from UX Design Specification)

**Response Formatting Requirements (UX-FR):**

- UX-FR-001: `ChatResponseBuilder` MUST format responses as Verdict → Stats → Findings → Positives → Summary
- UX-FR-002: Emoji constants MUST be centralized in `chatEmoji.ts` (🔴🟡✅ for severity, 💭🔍📂 for activity)
- UX-FR-003: `DebouncedStreamHandler` MUST limit progress updates to max 10/second to prevent UI flicker
- UX-FR-004: Progress messages MUST follow voice pattern: "📂 Reading...", "🔍 Finding...", "💭 Considering..."
- UX-FR-005: Finding cards MUST use format: `### 🔴 **Title** in [file.ts](file.ts#L42)`
- UX-FR-006: All responses MUST include "What's Good" section for emotional balance
- UX-FR-007: Empty states MUST use positive framing: "✅ Looking good!" not "No errors"

**UX Accessibility Requirements (UX-NFR):**

- UX-NFR-001: Emoji MUST be distinguishable by shape (circle vs checkmark vs triangle), not just color
- UX-NFR-002: Link text MUST be descriptive, never use "click here"
- UX-NFR-003: Heading hierarchy MUST be logical (## for sections, ### for findings, never skip levels)
- UX-NFR-004: Tone MUST be supportive and non-judgmental per emotional design guidelines

**UX Tone Guidelines:**

| Scenario    | ❌ Don't Say                    | ✅ Do Say                                        |
| ----------- | ------------------------------- | ------------------------------------------------ |
| Issue found | "Error: Bad code detected"      | "Potential issue: Consider reviewing..."         |
| Severe bug  | "Critical mistake in your code" | "🔴 Important: This could cause..."              |
| No issues   | "No errors"                     | "✅ Looking good! No critical issues found."     |
| Cancelled   | "Aborted"                       | "Analysis paused. Here's what I found so far..." |

---

### FR Coverage Map

| Requirement | Epic   | Story | Status  |
| ----------- | ------ | ----- | ------- |
| FR-001      | Epic 1 | 1.1   | Pending |
| FR-002      | Epic 1 | 1.1   | Pending |
| FR-003      | Epic 1 | 1.1   | Pending |
| FR-004      | Epic 3 | 3.3   | Pending |
| FR-010      | Epic 1 | 1.2   | Pending |
| FR-011      | Epic 1 | 1.3   | Pending |
| FR-012      | Epic 3 | 3.1   | Pending |
| FR-020      | Epic 1 | 1.2   | Pending |
| FR-021      | Epic 2 | 2.1   | Pending |
| FR-022      | Epic 2 | 2.1   | Pending |
| FR-023      | Epic 1 | 1.2   | Pending |
| FR-030      | Epic 2 | 2.2   | Pending |
| FR-031      | Epic 2 | 2.2   | Pending |
| FR-032      | Epic 2 | 2.2   | Pending |
| FR-033      | Epic 2 | 2.2   | Pending |
| FR-050      | Epic 2 | 2.3   | Pending |
| FR-051      | Epic 2 | 2.3   | Pending |
| FR-052      | Epic 2 | 2.3   | Pending |
| NFR-001     | Epic 1 | 1.2   | Pending |
| NFR-002     | Epic 0 | 0.4   | Pending |
| NFR-003     | Epic 1 | 1.2   | Pending |
| NFR-010     | Epic 1 | 1.4   | Pending |
| NFR-011     | Epic 1 | 1.2   | Pending |
| NFR-012     | Epic 1 | 1.4   | Pending |
| NFR-020     | Epic 1 | 1.2   | Pending |
| NFR-021     | Epic 2 | 2.1   | Pending |
| NFR-022     | Epic 2 | 2.2   | Pending |
| NFR-030     | Epic 1 | 1.1   | Pending |
| NFR-031     | Epic 1 | 1.1   | Pending |
| UX-FR-001   | Epic 0 | 0.5   | Pending |
| UX-FR-002   | Epic 0 | 0.4   | Pending |
| UX-FR-003   | Epic 0 | 0.4   | Pending |
| UX-FR-004   | Epic 2 | 2.1   | Pending |
| UX-FR-005   | Epic 0 | 0.5   | Pending |
| UX-FR-006   | Epic 0 | 0.5   | Pending |
| UX-FR-007   | Epic 2 | 2.1   | Pending |
| UX-NFR-001  | Epic 0 | 0.4   | Pending |
| UX-NFR-002  | Epic 2 | 2.1   | Pending |
| UX-NFR-003  | Epic 0 | 0.5   | Pending |
| UX-NFR-004  | Epic 0 | 0.5   | Pending |

---

## Epic List

| Epic # | Title                              | Goal                                                       | Stories                 |
| ------ | ---------------------------------- | ---------------------------------------------------------- | ----------------------- |
| 0      | Foundation & Interface Abstraction | Create core abstractions enabling code reuse               | 0.1, 0.2, 0.3, 0.4, 0.5 |
| 1      | Core Chat Participant              | Enable basic `@lupa /branch` and `@lupa /changes` commands | 1.1, 1.2, 1.3, 1.4      |
| 2      | Rich UX & Agent Mode               | Enhanced progress and expose tools to Agent Mode           | 2.1, 2.2, 2.3           |
| 3      | Exploration Mode & Polish          | Support `@lupa` without commands for codebase exploration  | 3.1, 3.2, 3.3           |

---

## Epic 0: Foundation & Interface Abstraction

**Goal:** Create the foundational abstractions that enable 100% code reuse of ConversationRunner across both chat participant and command palette paths. This epic establishes the Dependency Inversion pattern that makes the rest of the implementation clean and maintainable.

**Business Value:** Eliminates code duplication, reduces maintenance burden, and ensures consistent behavior across all analysis paths.

**Technical Context:** Per the architecture document, we use `ILLMClient` interface to abstract LLM access, allowing `ConversationRunner` to work with either `CopilotModelManager` (command path) or `ChatLLMClient` (chat path).

---

### Story 0.1: Create ILLMClient Interface and ModelRequestHandler

**As a** developer maintaining Lupa,
**I want** a common interface for LLM access and shared message conversion logic,
**So that** ConversationRunner can work with any model source without duplication.

**Acceptance Criteria:**

**AC-0.1.1: ILLMClient Interface Definition**
**Given** the architecture decision for Dependency Inversion
**When** creating the ILLMClient interface
**Then** the interface MUST define:

- `sendRequest(request: ToolCallRequest, token: CancellationToken): Promise<ToolCallResponse>`
- `getCurrentModel(): Promise<LanguageModelChat>`
  **And** the interface MUST be in `src/models/ILLMClient.ts`
  **And** the interface MUST have JSDoc describing its purpose for abstraction

**AC-0.1.2: ModelRequestHandler Extraction**
**Given** message conversion logic exists in CopilotModelManager
**When** extracting to ModelRequestHandler
**Then** `ModelRequestHandler.sendRequest()` MUST:

- Accept `model`, `request`, `token`, and `timeoutMs` parameters
- Convert `ToolCallRequest` messages to VS Code `LanguageModelChatMessage` format
- Handle timeout with `Promise.race` pattern
- Parse response stream into `ToolCallResponse`
- Support tool calls in the response
  **And** the class MUST be in `src/models/modelRequestHandler.ts`

**AC-0.1.3: Unit Tests**
**Given** the new abstractions
**When** running tests
**Then** `ModelRequestHandler.sendRequest()` MUST have unit tests covering:

- Successful request/response cycle
- Timeout handling
- Tool call parsing
- Error propagation

**Tasks:**

- [ ] Create `src/models/ILLMClient.ts` with interface definition
- [ ] Create `src/models/modelRequestHandler.ts` with extracted logic
- [ ] Extract message conversion from `CopilotModelManager`
- [ ] Create `src/__tests__/modelRequestHandler.test.ts`
- [ ] Verify with `npm run check-types`

**Dependencies:** None (this is the foundation)

**Files to Create:**

- `src/models/ILLMClient.ts`
- `src/models/modelRequestHandler.ts`
- `src/__tests__/modelRequestHandler.test.ts`

---

### Story 0.2: Modify CopilotModelManager to Implement ILLMClient

**As a** developer maintaining Lupa,
**I want** CopilotModelManager to implement the ILLMClient interface,
**So that** existing command palette functionality continues working with the new abstraction.

**Acceptance Criteria:**

**AC-0.2.1: Interface Implementation**
**Given** the existing CopilotModelManager class
**When** modifying it to implement ILLMClient
**Then** the class MUST:

- Add `implements ILLMClient` to class declaration
- Delegate `sendRequest()` to `ModelRequestHandler.sendRequest()`
- Keep existing `getCurrentModel()` implementation
  **And** all existing functionality MUST remain unchanged

**AC-0.2.2: Backward Compatibility**
**Given** existing code using CopilotModelManager
**When** running all tests
**Then** all existing tests MUST pass without modification
**And** ToolCallingAnalysisProvider MUST continue working unchanged

**Tasks:**

- [ ] Add `implements ILLMClient` to CopilotModelManager
- [ ] Refactor `sendRequest()` to delegate to ModelRequestHandler
- [ ] Run existing tests to verify backward compatibility
- [ ] Verify with `npm run check-types`

**Dependencies:** Story 0.1

**Files to Modify:**

- `src/models/copilotModelManager.ts`

---

### Story 0.3: Modify ConversationRunner to Accept ILLMClient

**As a** developer maintaining Lupa,
**I want** ConversationRunner to accept ILLMClient instead of concrete CopilotModelManager,
**So that** the same conversation loop can be used with different model sources.

**Acceptance Criteria:**

**AC-0.3.1: Constructor Modification**
**Given** the existing ConversationRunner constructor
**When** modifying to accept ILLMClient
**Then** the constructor MUST:

- Accept `client: ILLMClient` parameter instead of `CopilotModelManager`
- Store the client for use in the conversation loop
- Update all internal references from `modelManager` to `client`

**AC-0.3.2: Full Backward Compatibility**
**Given** existing callers passing CopilotModelManager
**When** running all tests
**Then** all existing tests MUST pass
**And** ToolCallingAnalysisProvider MUST continue working
**And** no behavior changes in the conversation loop

**AC-0.3.3: Type Safety**
**Given** the interface abstraction
**When** compiling with `npm run check-types`
**Then** compilation MUST succeed with no type errors
**And** all usages of ILLMClient methods MUST be type-safe

**Tasks:**

- [ ] Modify ConversationRunner constructor to accept `ILLMClient`
- [ ] Update all internal references to use interface methods
- [ ] Update ToolCallingAnalysisProvider to pass CopilotModelManager (already implements ILLMClient)
- [ ] Run all existing tests
- [ ] Verify with `npm run check-types`

**Dependencies:** Story 0.2

**Files to Modify:**

- `src/models/conversationRunner.ts`
- `src/services/toolCallingAnalysisProvider.ts` (if needed for type annotation)

---

### Story 0.4: Create Emoji Design System and Debounced Stream Handler (UX Foundation)

**As a** developer maintaining Lupa,
**I want** centralized emoji constants and rate-limited progress streaming,
**So that** all chat responses are consistent, accessible, and don't cause UI flicker.

**Acceptance Criteria:**

**AC-0.4.1: Emoji Design System Constants**
**Given** the UX specification defines specific emoji for severity and activity
**When** creating `chatEmoji.ts`
**Then** the file MUST define:

- `SEVERITY` object with `critical: '🔴'`, `suggestion: '🟡'`, `success: '✅'`, `warning: '⚠️'`
- `ACTIVITY` object with `thinking: '💭'`, `searching: '🔍'`, `reading: '📂'`, `analyzing: '🔎'`
- `SECTION` object with `security: '🔒'`, `testing: '🧪'`, `summary: '📊'`, `files: '📁'`
  **And** all emoji MUST be distinguishable by shape (not just color) per UX-NFR-001
  **And** types `SeverityType`, `ActivityType`, `SectionType` MUST be exported

**AC-0.4.2: DebouncedStreamHandler Implementation**
**Given** NFR-002 requires max 10 updates/second to prevent UI flicker
**When** creating `DebouncedStreamHandler`
**Then** the handler MUST:

- Implement `ToolCallHandler` interface
- Limit `onProgress()` calls to max 10/second (100ms minimum interval)
- Immediately pass through `onToolStart`, `onToolComplete`, `onThinking`, `onMarkdown`
- Store pending progress messages and flush before other events
- Provide `flush()` method to send final pending message
  **And** the class MUST wrap any `ToolCallHandler` implementation (decorator pattern)

**AC-0.4.3: Unit Tests**
**Given** the UX foundation components
**When** running tests
**Then** tests MUST verify:

- All emoji constants are defined correctly
- Debouncing limits progress updates to 10/sec
- Pending messages are flushed before tool events
- `flush()` sends any remaining pending message

**Tasks:**

- [ ] Create `src/config/chatEmoji.ts` with severity, activity, and section emoji
- [ ] Create `src/models/debouncedStreamHandler.ts`
- [ ] Create `src/__tests__/chatEmoji.test.ts`
- [ ] Create `src/__tests__/debouncedStreamHandler.test.ts`
- [ ] Verify with `npm run check-types`

**Dependencies:** Story 0.1 (ToolCallHandler interface)

**Files to Create:**

- `src/config/chatEmoji.ts`
- `src/models/debouncedStreamHandler.ts`
- `src/__tests__/chatEmoji.test.ts`
- `src/__tests__/debouncedStreamHandler.test.ts`

---

### Story 0.5: Create ChatResponseBuilder Utility (UX Formatting)

**As a** developer maintaining Lupa,
**I want** a builder utility for constructing consistent chat responses,
**So that** all analysis responses follow the UX design specification's structure and emotional design patterns.

**Acceptance Criteria:**

**AC-0.5.1: ChatResponseBuilder Class**
**Given** the UX specification defines response structure as Verdict → Stats → Findings → Positives → Summary
**When** creating `ChatResponseBuilder`
**Then** the class MUST provide methods:

- `addVerdictLine(status: 'success' | 'issues' | 'cancelled', summary: string)`
- `addSummaryStats(filesAnalyzed: number, critical: number, suggestions: number)`
- `addFindingsSection(title: string, emoji: string, findings: Finding[])`
- `addPositiveNotes(notes: string[])`
- `addFollowupPrompt(summary: string)`
- `build(): string`
  **And** the builder MUST use emoji from `chatEmoji.ts` constants
  **And** finding cards MUST use format: `**Title** in [location](anchor)\nDescription`

**AC-0.5.2: Finding Card Format**
**Given** UX-FR-005 requires specific finding card format
**When** adding findings via `addFindingsSection()`
**Then** each finding MUST render as:

```markdown
**{title}** in [{location}]({anchor})
{description}
```

**And** sections MUST be separated by `---` horizontal rules
**And** emoji MUST appear at the start of section titles

**AC-0.5.3: Emotional Design Compliance**
**Given** UX-NFR-004 requires supportive, non-judgmental tone
**When** building responses
**Then** success status MUST use "✅" emoji
**And** the builder MUST support positive notes section per UX-FR-006
**And** heading hierarchy MUST be logical (## for sections, ### implied by structure)

**AC-0.5.4: Unit Tests**
**Given** the ChatResponseBuilder utility
**When** running tests
**Then** tests MUST verify:

- Verdict line renders correctly for all three statuses
- Summary stats format is correct
- Finding sections use proper markdown structure
- Positive notes appear after findings
- Built output matches expected markdown structure
- Emoji from chatEmoji.ts are used correctly

**Tasks:**

- [ ] Create `src/utils/chatResponseBuilder.ts`
- [ ] Create `Finding` type in `src/types/chatTypes.ts`
- [ ] Import and use emoji from `chatEmoji.ts`
- [ ] Create `src/__tests__/chatResponseBuilder.test.ts`
- [ ] Verify with `npm run check-types`

**Dependencies:** Story 0.4 (emoji constants)

**Files to Create:**

- `src/utils/chatResponseBuilder.ts`
- `src/__tests__/chatResponseBuilder.test.ts`

**Files to Modify:**

- `src/types/chatTypes.ts` (add Finding type)

---

## Epic 1: Core Chat Participant

**Goal:** Enable basic `@lupa /branch` and `@lupa /changes` commands with streaming responses in Copilot Chat.

**Business Value:** Users can invoke Lupa's PR analysis capabilities directly from Copilot Chat, receiving streaming results without leaving the chat context.

**Technical Context:** Uses the foundation from Epic 0 to create `ChatLLMClient` wrapper and `ChatParticipantService` for command routing.

---

### Story 1.1: Register Chat Participant

**As a** developer,
**I want to** type `@lupa` in Copilot Chat,
**So that** I can access Lupa's analysis capabilities.

**Acceptance Criteria:**

**AC-1.1.1: Package.json Contribution**
**Given** the VS Code extension manifest
**When** configuring chatParticipants
**Then** package.json MUST include:

```json
{
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
        { "name": "changes", "description": "Analyze uncommitted changes" }
      ]
    }
  ]
}
```

**AC-1.1.2: ChatParticipantService Creation**
**Given** the package.json contribution
**When** the extension activates
**Then** `ChatParticipantService` MUST:

- Call `vscode.chat.createChatParticipant('lupa.chat-participant', handler)`
- Store the participant for disposal
- Implement `vscode.Disposable`
- Use singleton pattern with `getInstance()`

**AC-1.1.3: Graceful Degradation**
**Given** Copilot is not installed
**When** the extension activates
**Then** chat participant registration MUST:

- Catch any errors during registration
- Log warning via `Log.warn()`
- NOT crash the extension
- NOT prevent other features from working

**AC-1.1.4: ServiceManager Integration**
**Given** the service lifecycle
**When** ServiceManager Phase 4 runs
**Then** `ChatParticipantService.getInstance()` MUST be called
**And** the service MUST be added to disposables

**Tasks:**

- [ ] Add `chatParticipants` contribution to package.json
- [ ] Create `src/services/chatParticipantService.ts` with handler registration
- [ ] Implement basic handler that returns empty result (placeholder)
- [ ] Add to ServiceManager Phase 4 initialization
- [ ] Create `src/__tests__/chatParticipantService.test.ts`
- [ ] Verify with `npm run check-types`

**Dependencies:** Epic 0 complete

**Files to Create:**

- `src/services/chatParticipantService.ts`
- `src/types/chatTypes.ts`
- `src/__tests__/chatParticipantService.test.ts`

**Files to Modify:**

- `package.json`
- `src/services/serviceManager.ts`

---

### Story 1.2: Implement /branch Command

**As a** developer,
**I want to** type `@lupa /branch` to analyze my current branch,
**So that** I can review changes before creating a PR.

**Acceptance Criteria:**

**AC-1.2.1: ChatLLMClient Creation**
**Given** a chat request with `request.model`
**When** handling the /branch command
**Then** `ChatLLMClient` MUST be created:

- Constructor accepts `vscode.LanguageModelChat` and optional timeout
- Implements `ILLMClient` interface
- Delegates to `ModelRequestHandler.sendRequest()`
- `getCurrentModel()` returns the wrapped model

**AC-1.2.2: Command Routing**
**Given** a chat request with command.name === 'branch'
**When** handling the request
**Then** the handler MUST:

- Create `ChatLLMClient` from `request.model`
- Create `ConversationRunner` with the `ChatLLMClient`
- Call `GitOperations.getDiffToDefaultBranch()`
- Generate system prompt via `PromptGenerator`
- Execute `conversationRunner.run()` with handler callbacks

**AC-1.2.3: Streaming to Chat**
**Given** the ConversationRunner is executing
**When** progress events occur
**Then** `stream.progress()` MUST be called with status messages
**And** `stream.markdown()` MUST be called with analysis results
**And** first progress MUST appear within 500ms (NFR-001)

**AC-1.2.4: Error Handling**
**Given** an error occurs during analysis
**When** the error is caught
**Then** `ChatResult.errorDetails` MUST contain the error message
**And** `responseIsIncomplete` MUST be true

**AC-1.2.5: Unit Tests**
**Given** the ChatLLMClient and command handling
**When** running tests
**Then** tests MUST cover:

- ChatLLMClient implements ILLMClient correctly
- /branch command routes correctly
- Streaming callbacks work
- Error handling works

**Tasks:**

- [ ] Create `src/models/chatLLMClient.ts`
- [ ] Implement /branch command handler in ChatParticipantService
- [ ] Create streaming handler that calls `ChatResponseStream` methods
- [ ] Connect to GitOperations and ConversationRunner
- [ ] Create `src/__tests__/chatLLMClient.test.ts`
- [ ] Verify with `npm run check-types` and run tests

**Dependencies:** Story 1.1

**Files to Create:**

- `src/models/chatLLMClient.ts`
- `src/__tests__/chatLLMClient.test.ts`

**Files to Modify:**

- `src/services/chatParticipantService.ts`

---

### Story 1.3: Implement /changes Command

**As a** developer,
**I want to** type `@lupa /changes` to analyze uncommitted changes,
**So that** I can review work before committing.

**Acceptance Criteria:**

**AC-1.3.1: Command Routing**
**Given** a chat request with command.name === 'changes'
**When** handling the request
**Then** the handler MUST:

- Route to `/changes` specific logic
- Call `GitOperations.getUncommittedDiff()` instead of `getDiffToDefaultBranch()`
- Use identical conversation loop and streaming as /branch

**AC-1.3.2: Scope Indication**
**Given** the /changes analysis is running
**When** streaming progress
**Then** progress messages MUST clearly indicate "uncommitted changes" scope
**And** the analysis context MUST be clear to the user

**AC-1.3.3: Empty Diff Handling**
**Given** there are no uncommitted changes
**When** the /changes command is invoked
**Then** the handler MUST:

- Detect empty diff
- Stream a helpful message: "No uncommitted changes found to analyze"
- Return success (not error)

**Tasks:**

- [ ] Add /changes command routing to ChatParticipantService
- [ ] Use `GitOperations.getUncommittedDiff()` for diff retrieval
- [ ] Handle empty diff case gracefully
- [ ] Add tests for /changes command
- [ ] Verify with `npm run check-types`

**Dependencies:** Story 1.2

**Files to Modify:**

- `src/services/chatParticipantService.ts`
- `src/__tests__/chatParticipantService.test.ts`

---

### Story 1.4: Support Cancellation

**As a** developer,
**I want to** cancel analysis mid-stream,
**So that** I can stop long-running analysis.

**Acceptance Criteria:**

**AC-1.4.1: Token Propagation**
**Given** the chat request includes a CancellationToken
**When** the token is cancelled
**Then** the token MUST be propagated to:

- `ConversationRunner.run()`
- All tool calls via `ToolExecutor`
- Any long-running operations

**AC-1.4.2: Clean Cancellation**
**Given** analysis is in progress
**When** the user cancels
**Then** the handler MUST:

- Stop analysis cleanly
- Stream "Analysis cancelled" via `stream.markdown()`
- Return `ChatResult` with `metadata.cancelled = true`
- NOT have orphaned processes

**AC-1.4.3: Partial Results Preservation**
**Given** analysis has produced partial results
**When** cancellation occurs
**Then** results streamed so far MUST be visible in chat
**And** user MUST understand analysis was incomplete

**Tasks:**

- [ ] Pass `request.token` through to ConversationRunner
- [ ] Handle cancellation in stream handler
- [ ] Stream cancellation message on cancel
- [ ] Add cancellation tests
- [ ] Verify with `npm run check-types`

**Dependencies:** Story 1.2

**Files to Modify:**

- `src/services/chatParticipantService.ts`
- `src/__tests__/chatParticipantService.test.ts`

---

## Epic 2: Rich UX & Agent Mode Integration

**Goal:** Enhanced progress visualization and expose tools to Agent Mode.

**Business Value:** Users get richer feedback during analysis and can leverage Lupa's unique capabilities in Copilot Agent Mode.

---

### Story 2.1: Rich Progress Visualization

**As a** developer,
**I want to** see detailed progress during analysis,
**So that** I understand what Lupa is doing.

**Acceptance Criteria:**

**AC-2.1.1: ToolCallHandler Interface**
**Given** the need for streaming callbacks
**When** implementing the handler interface
**Then** `ToolCallHandler` MUST define:

- `onProgress(message: string): void`
- `onToolStart(toolName: string, args: Record<string, unknown>): void`
- `onToolComplete(toolName: string, success: boolean, summary: string): void`
- `onFileReference(filePath: string, range?: vscode.Range): void`
- `onThinking(thought: string): void`
- `onMarkdown(content: string): void`

**AC-2.1.2: File References with Anchors**
**Given** tool calls reference files
**When** streaming progress
**Then** `stream.anchor()` MUST be used for clickable file:line references
**And** `stream.reference()` MUST be used for file-only references with icons

**AC-2.1.3: Debounced Updates with DebouncedStreamHandler**
**Given** rapid progress updates and NFR-002
**When** streaming to chat
**Then** `ChatStreamHandler` MUST be wrapped with `DebouncedStreamHandler` from Story 0.4
**And** updates MUST be debounced to max 10/second
**And** UI MUST NOT flicker

**AC-2.1.4: Changed Files Tree**
**Given** the diff has been parsed
**When** starting analysis
**Then** `stream.filetree()` SHOULD display changed files
**And** file tree SHOULD be collapsible

**AC-2.1.5: Progress Message Voice Pattern (UX-FR-004)**
**Given** the UX specification defines progress message voice
**When** streaming progress
**Then** messages MUST follow patterns:

- Starting: "Starting analysis of {branch}..."
- Reading: "📂 Reading {filepath}..."
- Searching: "🔍 Finding {symbol} definitions..."
- Analyzing: "Analyzing {count} usages..."
- Thinking: "💭 Considering {aspect}..."
  **And** emoji from `chatEmoji.ts` MUST be used (ACTIVITY.reading, ACTIVITY.searching, ACTIVITY.thinking)

**AC-2.1.6: ChatStreamHandler Implementation**
**Given** the need to stream analysis output to chat
**When** creating `ChatStreamHandler`
**Then** the class MUST implement `ToolCallHandler` interface
**And** MUST use `ChatResponseBuilder` from Story 0.5 for **extension-generated messages only** (intro, summary, errors, cancellation)
**And** MUST stream LLM analysis output via `stream.markdown()` **as-is** (not reformatted)
**And** MUST use emoji constants from Story 0.4
**And** MUST follow UX tone guidelines (supportive, not judgmental)

**CLARIFICATION (December 16, 2025):**
`ChatResponseBuilder` is used for messages generated BY OUR CODE:

- Opening verdict line ("Analyzing branch...")
- Summary statistics (calculated by our code: files analyzed, etc.)
- Error messages
- Cancellation messages
- Closing prompts

LLM analysis output is streamed via `stream.markdown()` as-is.
The system prompt influences but does NOT guarantee LLM format.
Smaller models (GPT-4o-mini, Claude Haiku) may not follow format instructions reliably.
Tool calling for structured output is unreliable across model sizes.

**AC-2.1.7: Empty State Handling (UX-FR-007)**
**Given** no issues are found during analysis
**When** streaming results
**Then** output MUST use positive framing: "✅ Looking good! No critical issues found."
**And** MUST NOT use negative framing like "No errors" or "Nothing found"

**AC-2.1.8: ChatResponseBuilder Migration (Epic 1 Technical Debt)**
**Given** Epic 1 implemented inline string formatting instead of ChatResponseBuilder
**When** refactoring ChatParticipantService
**Then** the following inline patterns MUST be replaced with ChatResponseBuilder:

- `## ${SEVERITY.success} No Changes Found` → `ChatResponseBuilder.addVerdictLine('success', ...)`
- `## ${SEVERITY.warning} Configuration Error` → Error handling via builder
- `## ${SEVERITY.warning} Git Not Initialized` → Error handling via builder
- `## ${SEVERITY.warning} Analysis Error` → Error handling via builder
- `## 💬 Analysis Cancelled` → `ChatResponseBuilder.addVerdictLine('cancelled', ...)`
  **And** add `addErrorSection(title: string, message: string, details?: string)` method to ChatResponseBuilder
  **And** ensure consistent UX formatting across all extension-generated messages

**Technical Debt Context (from Epic 1 Retrospective):**
Story 0.5 created ChatResponseBuilder but Epic 1 used inline formatting for simplicity during rapid development. This story consolidates all extension-generated messages through the builder for UX consistency.

**Tasks:**

- [ ] Create `ToolCallHandler` interface in `src/types/chatTypes.ts`
- [ ] Create `ChatStreamHandler` class implementing the interface
- [ ] Wrap with `DebouncedStreamHandler` in ChatParticipantService
- [ ] Use `stream.anchor()` for file:line references
- [ ] Use `stream.filetree()` for changed files display
- [ ] Import and use emoji from `chatEmoji.ts` for progress messages
- [ ] Use `ChatResponseBuilder` for formatted output
- [ ] **Migrate Epic 1 inline formatting to ChatResponseBuilder** (AC-2.1.8):
  - Replace inline error messages with builder pattern
  - Replace inline cancellation message with builder pattern
  - Add `addErrorSection()` method to ChatResponseBuilder if needed
  - Update tests to verify builder usage
- [ ] Modify ConversationRunner to accept optional `ToolCallHandler`
- [ ] **Update `toolAwareSystemPromptGenerator.ts` with UX guidelines** (from Epic 0 Retro):
  - Add emoji severity guidance (🔴 CRITICAL, 🟠 HIGH, 🟡 MEDIUM, 🟢 LOW)
  - Add finding format template matching `ChatResponseBuilder` output
  - Add supportive tone guidelines (positive framing, actionable feedback)
  - Use Anthropic best practices for prompt clarity:
    - https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/be-clear-and-direct.md
    - https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/multishot-prompting.md
    - https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/chain-of-thought.md
    - https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/use-xml-tags.md
    - https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/system-prompts.md
    - https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/chain-prompts.md
    - https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/long-context-tips.md
- [ ] Add tests for visualization, debouncing, and UX patterns
- [ ] Verify with `npm run check-types`

**Dependencies:** Story 1.2, Story 0.4, Story 0.5

**Files to Create/Modify:**

- `src/types/chatTypes.ts` (add ToolCallHandler)
- `src/models/chatStreamHandler.ts` (NEW)
- `src/services/chatParticipantService.ts` (integrate handlers)
- `src/models/conversationRunner.ts` (add handler callback support)
- `src/__tests__/chatStreamHandler.test.ts` (NEW)

---

### Story 2.2: Follow-up Suggestions

**As a** developer,
**I want to** see suggested follow-up questions,
**So that** I can dive deeper into findings.

**Acceptance Criteria:**

**AC-2.2.1: ChatFollowupProvider Implementation**
**Given** analysis completes with a ChatResult
**When** the follow-up provider is invoked
**Then** it MUST read `result.metadata` to determine context
**And** suggest relevant follow-up actions

**AC-2.2.2: Context-Based Suggestions**
**Given** the analysis metadata
**When** generating follow-ups
**Then** suggestions MUST include:

- If `hasCriticalIssues`: "Focus on security issues only" (🔒)
- If `issuesFound`: "Show me how to fix the most critical issue"
- Always: "What tests should I add?" (🧪)
- Always: "Explain the changes in detail"

**AC-2.2.3: Follow-up Continuation**
**Given** a user clicks a follow-up suggestion
**When** the follow-up triggers
**Then** it MUST continue the conversation with Lupa
**And** the follow-up context MUST be clear

**AC-2.2.4: Prompt Quality**
**Given** follow-up prompts
**When** crafting them
**Then** they MUST follow Anthropic best practices:

- Be clear and direct
- Provide context
- Use proper formatting

**Tasks:**

- [ ] Define `ChatAnalysisMetadata` type in `src/types/chatTypes.ts`
- [ ] Implement `ChatFollowupProvider` in `ChatParticipantService`
- [ ] Generate follow-ups based on metadata
- [ ] Test follow-up suggestions for various scenarios
- [ ] Verify with `npm run check-types`

**Dependencies:** Story 1.2

**Files to Modify:**

- `src/types/chatTypes.ts`
- `src/services/chatParticipantService.ts`
- `src/__tests__/chatParticipantService.test.ts`

---

### Story 2.3: Register Agent Mode Tool

**As a** developer using Copilot Agent Mode,
**I want** access to Lupa's unique symbol overview tool,
**So that** I can get structured file analysis.

**Acceptance Criteria:**

**AC-2.3.1: Package.json Contribution**
**Given** the VS Code extension manifest
**When** configuring languageModelTools
**Then** package.json MUST include:

```json
{
  "languageModelTools": [
    {
      "name": "lupa_getSymbolsOverview",
      "displayName": "Get Symbols Overview",
      "modelDescription": "Get an overview of all symbols defined in a file with their line numbers and hierarchy.",
      "canBeReferencedInPrompt": true,
      "toolReferenceName": "symbolsOverview",
      "inputSchema": {
        "type": "object",
        "properties": {
          "filePath": {
            "type": "string",
            "description": "Absolute path to the file"
          }
        },
        "required": ["filePath"]
      }
    }
  ]
}
```

**AC-2.3.2: LanguageModelToolProvider Creation**
**Given** the package.json contribution
**When** the extension activates
**Then** `LanguageModelToolProvider` MUST:

- Call `vscode.lm.registerTool('lupa_getSymbolsOverview', handler)`
- Wrap existing `GetSymbolsOverviewTool` implementation
- Convert tool output to `LanguageModelToolResult`
- Implement `vscode.Disposable`

**AC-2.3.3: Tool Invocation**
**Given** Copilot Agent Mode invokes the tool
**When** the tool handler is called
**Then** it MUST:

- Parse input schema for `filePath`
- Call `GetSymbolsOverviewTool.execute()`
- Return result as JSON in `LanguageModelTextPart`

**AC-2.3.4: ServiceManager Integration**
**Given** the service lifecycle
**When** ServiceManager Phase 4 runs
**Then** `LanguageModelToolProvider` MUST be registered
**And** added to disposables

**Tasks:**

- [ ] Add `languageModelTools` contribution to package.json
- [ ] Create `src/services/languageModelToolProvider.ts`
- [ ] Wrap GetSymbolsOverviewTool with vscode.lm.registerTool()
- [ ] Add to ServiceManager Phase 4
- [ ] Create `src/__tests__/languageModelToolProvider.test.ts`
- [ ] Verify with `npm run check-types`

**Dependencies:** Story 1.1

**Files to Create:**

- `src/services/languageModelToolProvider.ts`
- `src/__tests__/languageModelToolProvider.test.ts`

**Files to Modify:**

- `package.json`
- `src/services/serviceManager.ts`

---

## Epic 3: Exploration Mode & Polish

**Goal:** Support `@lupa` without commands for codebase exploration and polish the user experience.

**Business Value:** Users can ask questions about their codebase naturally without needing a diff context.

---

### Story 3.1: Exploration Mode

**As a** developer,
**I want to** ask questions about my codebase,
**So that** I can understand code without analyzing a diff.

**Acceptance Criteria:**

**AC-3.1.1: No-Command Handler**
**Given** a chat request with no slash command
**When** the user types `@lupa What is the purpose of AuthHandler?`
**Then** the handler MUST:

- Detect absence of command (request.command is undefined)
- Route to exploration mode
- NOT require a diff context

**AC-3.1.2: Tool-Based Exploration**
**Given** exploration mode is active
**When** answering the user's question
**Then** the handler MUST:

- Use tools (FindSymbol, ReadFile, etc.) to gather context
- Use ConversationRunner in "exploration" mode
- Generate appropriate exploration prompt

**AC-3.1.3: Contextual Responses**
**Given** the user asks about specific code
**When** generating responses
**Then** responses MUST:

- Reference actual code from the workspace
- Use `stream.anchor()` for code locations
- Be helpful and contextual

**AC-3.1.4: Exploration Prompt Template**
**Given** exploration mode
**When** generating the system prompt
**Then** `PromptGenerator` MUST support exploration mode:

- No diff context required
- Focus on understanding and explaining
- Tool usage encouraged for context gathering

**Tasks:**

- [ ] Add no-command handler in ChatParticipantService
- [ ] Create exploration prompt template in PromptGenerator
- [ ] Enable tool access without diff context
- [ ] Add exploration mode tests
- [ ] Verify with `npm run check-types`

**Dependencies:** Story 1.2

**Files to Modify:**

- `src/services/chatParticipantService.ts`
- `src/prompts/promptGenerator.ts` (if needed)
- `src/__tests__/chatParticipantService.test.ts`

---

### Story 3.2: Conversation History Integration

**As a** developer,
**I want** conversation history to influence follow-up questions,
**So that** I can ask contextual questions about previous analysis.

**SCOPE CLARIFICATION (Epic 1 Retrospective):**

| Mode                  | Include History? | Rationale                                    |
| --------------------- | ---------------- | -------------------------------------------- |
| `/branch` command     | ❌ NO            | Fresh diff analysis, token budget protection |
| `/changes` command    | ❌ NO            | Fresh diff analysis, token budget protection |
| `@lupa` (exploration) | ✅ YES           | Follow-ups need context                      |
| Follow-up chips       | ✅ YES           | Continuation of conversation                 |

**Design Decision:** Commands (`/branch`, `/changes`) intentionally start fresh to:

1. Avoid context window overflow (diff can be 5-20K tokens)
2. Prevent stale analysis context from influencing new diff
3. Give users predictable, repeatable behavior

**UX Mitigation:** Progress messages indicate "fresh analysis" and follow-up suggestions guide users to exploration mode for contextual questions.

**Acceptance Criteria:**

**AC-3.2.0: Command vs Exploration Mode History**
**Given** the need to balance context relevance with token budget
**When** handling requests
**Then**:

- `/branch` and `/changes` commands MUST NOT include conversation history
- `@lupa` without a command (exploration mode) MUST include history
- Follow-up suggestions MUST trigger exploration mode with history
- Progress message for commands MUST indicate "fresh analysis" (e.g., "🔄 Starting fresh analysis...")

**AC-3.2.1: History Extraction (Exploration Mode Only) (Exploration Mode Only)**
**Given** a chat request with context.history AND no command specified
**When** processing the request in exploration mode
**Then** the handler MUST:

- Extract previous turns from `ChatContext.history`
- Convert `ChatRequestTurn` to internal message format
- Convert `ChatResponseTurn` to internal message format

**AC-3.2.2: History Conversion**
**Given** chat history items
**When** converting to internal format
**Then** conversion MUST:

- Map user turns to user messages
- Map assistant turns to assistant messages
- Preserve tool call references if present
- Handle multi-part responses

**AC-3.2.3: History Passing**
**Given** converted history
**When** running ConversationRunner
**Then** history MUST be passed to `ConversationManager`
**And** follow-up questions MUST have previous context

**AC-3.2.4: Token Budget Tracking (Context Window Management)**
**Given** VS Code provides full history without automatic truncation
**When** preparing conversation context
**Then** `ChatContextManager` MUST:

- Use `model.maxInputTokens` to determine context limit
- Reserve minimum 4000 tokens for model output
- Count tokens via `model.countTokens()` for each message
- Track cumulative token usage across system prompt, diff, and history

**AC-3.2.5: Sliding Window Truncation**
**Given** cumulative context approaches 80% of `model.maxInputTokens`
**When** truncating history
**Then** the handler MUST:

- Prioritize: system prompt > diff context > current request > recent history
- Include history newest-first until budget exhausted
- Drop older history turns first
- Log warning when truncation occurs

**AC-3.2.6: Copilot Summarization Awareness**
**Given** Copilot Chat may summarize conversation history (including our responses)
**When** history contains summarized content
**Then** the handler MUST:

- Accept that participant attribution is lost in summaries
- Not rely on knowing "what we said" vs "what Copilot said"
- Treat summarized history as context, not authoritative source

**Tasks:**

- [ ] Implement history extraction from ChatContext
- [ ] Create history conversion utilities in chatTypes.ts
- [ ] Create `ChatContextManager` class for token budget tracking
- [ ] Implement sliding window truncation (newest-first)
- [ ] Pass history to ConversationManager
- [ ] Add history integration tests
- [ ] Add token budget tests
- [ ] Verify with `npm run check-types`

**Dependencies:** Story 1.2

**Files to Create/Modify:**

- `src/services/chatParticipantService.ts`
- `src/models/chatContextManager.ts` (NEW)
- `src/types/chatTypes.ts`
- `src/__tests__/chatParticipantService.test.ts`
- `src/__tests__/chatContextManager.test.ts` (NEW)

---

### Story 3.3: Disambiguation Auto-routing

**As a** developer,
**I want** Copilot to auto-route code review questions to @lupa,
**So that** I don't have to explicitly type @lupa.

**Acceptance Criteria:**

**AC-3.3.1: Disambiguation Configuration**
**Given** the package.json chatParticipant contribution
**When** configuring disambiguation
**Then** the configuration MUST include:

```json
{
  "disambiguation": [
    {
      "category": "code_review",
      "description": "The user wants to review code changes, analyze a pull request, find issues in their branch, or understand what changed",
      "examples": [
        "Review my changes before I commit",
        "What issues might be in my PR?",
        "Analyze the security of my branch",
        "What did I change in this branch?",
        "Find bugs in my uncommitted changes"
      ]
    }
  ]
}
```

**AC-3.3.2: Auto-Routing Detection**
**Given** a user types "Review my changes" without @lupa
**When** Copilot evaluates disambiguation
**Then** the question SHOULD be routed to @lupa
**And** the handler MUST work correctly

**AC-3.3.3: isParticipantDetected Handling**
**Given** a request was auto-routed
**When** checking `context.isParticipantDetected`
**Then** the handler MUST:

- Check if the participant was explicitly mentioned
- Handle auto-routed requests appropriately
- Provide appropriate context in responses

**Tasks:**

- [ ] Add disambiguation configuration to package.json
- [ ] Test auto-routing scenarios manually
- [ ] Handle isParticipantDetected in request handler
- [ ] Document disambiguation behavior
- [ ] Verify with `npm run check-types`

**Dependencies:** Story 1.1

**Files to Modify:**

- `package.json`
- `src/services/chatParticipantService.ts`

---

## Implementation Roadmap

### Phase 1: Foundation (Days 1-3)

- **Epic 0:** All stories (0.1, 0.2, 0.3, 0.4, 0.5)
- Establishes ILLMClient abstraction and enables code reuse
- **NEW:** Creates UX foundation (emoji constants, DebouncedStreamHandler, ChatResponseBuilder)

### Phase 2: Core Chat (Days 4-6)

- **Epic 1:** Stories 1.1, 1.2, 1.3, 1.4
- Basic `@lupa /branch` and `/changes` working

### Phase 3: Polish (Days 7-9)

- **Epic 2:** Stories 2.1, 2.2, 2.3
- Rich progress with UX patterns, follow-ups, Agent Mode tool

### Phase 4: Exploration (Days 10-11)

- **Epic 3:** Stories 3.1, 3.2, 3.3
- Exploration mode and conversation history

---

## Appendix: Story Dependencies Graph

```
Epic 0:
  0.1 ──► 0.2 ──► 0.3
   │
   └──► 0.4 ──► 0.5
                 │
                 ▼
Epic 1:         1.1
                 │
       ┌────────┼────────┐
       │        │        │
       ▼        ▼        ▼
      1.2 ──► 1.3       1.4
       │
       ├──────────────────┐
       ▼                  ▼
Epic 2: 2.1 ◄── 0.4, 0.5
       │
       │      2.2      2.3 (parallel to 2.1/2.2)
       │       │
       └───┬───┘
           │
           ▼
Epic 3:  3.1 ──► 3.2 ──► 3.3
```

**Note:** Stories 0.4 and 0.5 (UX Foundation) are prerequisites for Story 2.1 (Rich Progress Visualization).

---

**Document Status:** REVISED ✅ | Ready for Development
**Original Completion Date:** December 15, 2025
**Revision Date:** December 16, 2025
**Revision Reason:** Incorporated UX Design Specification requirements

---

## Validation Summary

| Check                     | Result   |
| ------------------------- | -------- |
| FR Coverage               | 17/17 ✅ |
| NFR Coverage              | 11/11 ✅ |
| **UX-FR Coverage (NEW)**  | 7/7 ✅   |
| **UX-NFR Coverage (NEW)** | 4/4 ✅   |
| Architecture Alignment    | ✅       |
| Story Quality             | 15/15 ✅ |
| Epic Structure            | ✅       |
| Dependencies              | ✅       |

**Total Stories:** 15 across 4 Epics (was 13, added 2 UX stories)
**Estimated Timeline:** 11 days (was 10, added 1 day for UX foundation)
**Ready for Implementation:** YES

### New Stories Added in Revision:

| Story | Title                                        | Purpose                                                              |
| ----- | -------------------------------------------- | -------------------------------------------------------------------- |
| 0.4   | Emoji Design System & DebouncedStreamHandler | UX foundation: accessibility-compliant emoji, rate-limited streaming |
| 0.5   | ChatResponseBuilder Utility                  | UX formatting: consistent response structure, emotional design       |

### Updated Stories in Revision:

| Story | Changes                                                                                             |
| ----- | --------------------------------------------------------------------------------------------------- |
| 2.1   | Added ACs for UX progress voice, emoji usage, ChatResponseBuilder integration, empty state handling |
