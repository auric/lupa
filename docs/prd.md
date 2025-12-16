---
stepsCompleted: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
inputDocuments:
  - docs/analysis/product-brief-chat-participant-2025-12-15.md
  - docs/research/vscode-chat-participant-api.md
  - docs/research/vscode-chat-response-streaming.md
  - docs/research/vscode-copilot-chat-research.md
  - docs/research/vscode-lm-tool-calling-api.md
  - docs/research/context-window-management.md
documentCounts:
  briefs: 1
  research: 5
  brainstorming: 0
  projectDocs: 0
workflowType: "prd"
workflowMode: "yolo"
lastStep: 11
status: "revised"
revisedAt: "2025-12-16"
revisionReason: "Added context window management and output formatting responsibility requirements"
project_name: "Lupa"
feature_name: "@lupa Chat Participant"
user_name: "Igor"
date: "2025-12-15"
---

# Product Requirements Document: @lupa Chat Participant

**Version:** 1.1
**Date:** December 16, 2025 (Revised)
**Original Date:** December 15, 2025
**Author:** Igor
**Status:** APPROVED FOR IMPLEMENTATION

---

## 1. Executive Summary

### 1.1 Product Vision

Transform Lupa from a standalone VS Code extension into a first-class GitHub Copilot ecosystem participant by implementing the `@lupa` chat participant. Users will invoke Lupa's PR analysis capabilities directly from Copilot Chat, receiving streaming analysis results with rich UI elements inline.

### 1.2 Problem Statement

**Current State:** Users must navigate a multi-step process to analyze code changes:

1. Open Command Palette
2. Run "Lupa: Analyze Pull Request"
3. Select analysis type (branch comparison vs uncommitted changes)
4. Wait for webview to open with results

**Desired State:** Users type `@lupa /branch` or `@lupa /changes` directly in Copilot Chat and receive streaming, interactive analysis results inline with follow-up capabilities.

### 1.3 Success Criteria

| Metric                       | Target                | Measurement                    |
| ---------------------------- | --------------------- | ------------------------------ |
| Chat participant invocations | Majority of new users | User feedback                  |
| Unhelpful feedback rate      | <10%                  | `onDidReceiveFeedback` handler |
| Analysis completion rate     | >90%                  | Error rate monitoring          |
| Follow-up question usage     | Common pattern        | User feedback                  |

---

## 2. Scope

### 2.1 In Scope

- `@lupa` chat participant registration with `/branch` and `/changes` commands
- Streaming progress visualization with rich UI elements
- Follow-up suggestions based on analysis findings
- `ILLMClient` interface abstraction for dependency inversion (SOLID)
- Full reuse of `ConversationRunner` for both chat and command paths (DRY)
- Exploration mode for codebase Q&A without diff context
- Registration of `lupa_getSymbolsOverview` tool for Copilot Agent Mode
- Maintaining existing webview-based analysis for command palette flow

### 2.2 Out of Scope

- Credit/quota tracking (no public API available)
- GitHub PR integration via API (Phase 4 in roadmap)
- CLI mode (Phase 5 in roadmap)
- Custom review templates (Phase 3 feature)
- Multi-repository support
- Proposed APIs (`chatParticipantPrivate`, `chatParticipantAdditions`)

### 2.3 Constraints

- **VS Code Version:** ^1.107.0 (already satisfied)
- **No Proposed APIs:** Must work with stable VS Code API only
- **Workers:** Cannot use `vscode` module in worker processes
- **Tree-sitter:** Single-threaded due to memory leaks in worker threads

---

## 3. Architecture

### 3.1 High-Level Design

The architecture uses **Dependency Inversion** via an `ILLMClient` interface, enabling full reuse of `ConversationRunner` for both chat and command paths. This follows SOLID principles while eliminating code duplication.

```
┌─────────────────────────────────────────────────────────────────┐
│                         ILLMClient                              │
│  sendRequest(request, token): Promise<ToolCallResponse>         │
│  getCurrentModel(): Promise<LanguageModelChat>                  │
└───────────────────────────┬─────────────────────────────────────┘
                            │
            ┌───────────────┴───────────────┐
            │                               │
            ▼                               ▼
┌───────────────────────┐       ┌───────────────────────┐
│  CopilotModelManager  │       │    ChatLLMClient      │
│  (implements ILLMClient)      │  (implements ILLMClient)
│                       │       │                       │
│  • Model selection    │       │  • Wraps request.model│
│  • Model caching      │       │  • Created per-request│
│  • Settings-based     │       │  • Lightweight        │
└───────────────────────┘       └───────────────────────┘
            │                               │
            └───────────────┬───────────────┘
                            │
                            ▼
               ┌────────────────────────┐
               │   ConversationRunner   │
               │   (takes ILLMClient)   │
               │                        │
               │   • THE conversation   │
               │     loop (100% reused) │
               │   • Token validation   │
               │   • Tool call handling │
               │   • Error recovery     │
               └────────────────────────┘
                            │
            ┌───────────────┴───────────────┐
            │                               │
            ▼                               ▼
┌───────────────────────────┐   ┌───────────────────────────┐
│ToolCallingAnalysisProvider│   │  ChatParticipantService   │
│                           │   │                           │
│ • Diff processing         │   │ • Command routing         │
│ • Returns result object   │   │ • Streams to chat         │
│ • Webview output          │   │ • Follow-up suggestions   │
│ • Uses CopilotModelManager│   │ • Uses ChatLLMClient      │
└───────────────────────────┘   └───────────────────────────┘
```

### 3.2 Why ILLMClient Interface (Dependency Inversion)

**Problem with separate loops:**

- `ConversationRunner` is the core loop handling iterations, token validation, tool calls
- Previously tied to `CopilotModelManager` concrete class
- Chat participants receive `request.model` directly from VS Code
- Duplicating the loop would violate DRY

**ILLMClient interface benefits:**

1. **100% ConversationRunner reuse** - Zero loop duplication
2. **Uses `request.model` correctly** - Via `ChatLLMClient` wrapper
3. **SOLID compliance** - Dependency Inversion, Open/Closed principles
4. **Easy testing** - Mock `ILLMClient` in tests
5. **Future-proof** - Easy to add new model sources

### 3.3 Code Reuse Summary

| Component           | Chat Path | Command Path | Shared?  |
| ------------------- | --------- | ------------ | -------- |
| ConversationRunner  | ✓         | ✓            | **100%** |
| ToolExecutor        | ✓         | ✓            | **100%** |
| PromptGenerator     | ✓         | ✓            | **100%** |
| All Tools           | ✓         | ✓            | **100%** |
| DiffUtils           | ✓         | ✓            | **100%** |
| GitOperations       | ✓         | ✓            | **100%** |
| ModelRequestHandler | ✓         | ✓            | **100%** |
| Message conversion  | ✓         | ✓            | **100%** |

**Unique code in ChatParticipantService: ~35 lines** (command routing, stream callbacks, follow-ups)

### 3.4 Data Flow (Chat Path)

1. User invokes `@lupa /branch` in Copilot Chat
2. `ChatParticipantService` receives `ChatRequest` with `request.model`
3. Creates `ChatLLMClient(request.model)` - lightweight wrapper
4. Creates `ConversationRunner(chatLLMClient, toolExecutor)`
5. Gets diff via `GitOperations.getDiffToDefaultBranch()`
6. Calls `conversationRunner.run(config, conversationManager, token, handler)`
7. Handler callbacks stream to `ChatResponseStream`
8. Follow-up suggestions offered based on findings

### 3.5 Data Flow (Command Path - Unchanged)

1. User runs "Lupa: Analyze Pull Request" from Command Palette
2. `ToolCallingAnalysisProvider.analyze()` called with diff
3. Uses `CopilotModelManager` (implements `ILLMClient`)
4. `ConversationRunner` executes the same loop
5. Returns `ToolCallingAnalysisResult` object
6. Results displayed in webview

### 3.6 Key Design Decisions

| Decision                                  | Rationale                                                  |
| ----------------------------------------- | ---------------------------------------------------------- |
| `ILLMClient` interface                    | Dependency Inversion enables full ConversationRunner reuse |
| `ChatLLMClient` wrapper                   | Adapts `request.model` to `ILLMClient` interface           |
| `ModelRequestHandler` extraction          | Message conversion logic shared between both LLM clients   |
| No proposed APIs                          | Ensures stability across VS Code versions                  |
| Single tool export (`getSymbolsOverview`) | Only tool providing unique value vs Copilot built-ins      |
| Exploration mode via no-command           | Natural conversational UX for codebase questions           |
| Keep webview for command path             | Proven UX for detailed analysis review                     |

---

## 4. Functional Requirements

### 4.1 Chat Participant Registration

**FR-001:** Extension MUST register a chat participant with id `lupa.chat-participant` and name `lupa`.

**FR-002:** Participant MUST declare two slash commands:

- `/branch` - Analyze current branch vs default branch
- `/changes` - Analyze uncommitted changes

**FR-003:** Participant MUST set `isSticky: true` to maintain context for follow-up questions.

**FR-004:** Participant MUST configure disambiguation for auto-routing code review questions:

```json
{
  "category": "code_review",
  "description": "The user wants to review code changes, analyze a pull request, find issues in their branch, or understand what changed",
  "examples": [
    "Review my changes before I commit",
    "What issues might be in my PR?",
    "Find bugs in my uncommitted changes"
  ]
}
```

### 4.2 Command Handling

**FR-010:** `/branch` command MUST:

- Create `ChatLLMClient` wrapping `request.model`
- Create `ConversationRunner` with the `ChatLLMClient`
- Call `GitOperations.getDiffToDefaultBranch()`
- Generate system prompt via `PromptGenerator`
- Execute `conversationRunner.run()` with handler callbacks
- Stream handler events to `ChatResponseStream`
- Support cancellation via `CancellationToken`

**FR-011:** `/changes` command MUST:

- Call `GitOperations.getUncommittedDiff()`
- Same conversation loop and streaming as `/branch`
- Clear indication of "uncommitted changes" scope

**FR-012:** No-command invocation (`@lupa <question>`) MUST:

- Enable exploration mode for codebase Q&A
- Use tools to gather context
- Not require a diff context

### 4.3 Streaming Response

**FR-020:** Analysis progress MUST use `stream.progress()` for status updates:

- "Reading changed files..."
- "Finding symbol definitions..."
- "Analyzing N usages of `SymbolName`..."

**FR-021:** File references MUST use `stream.reference()` with file icon.

**FR-022:** Inline code locations MUST use `stream.anchor()` for clickable links:

```typescript
stream.anchor(
  new vscode.Location(uri, new vscode.Position(42, 0)),
  "processRequest()"
);
```

**FR-023:** Analysis findings MUST be formatted as markdown with:

- Severity indicators (🔴 Critical, 🟡 Suggestion)
- Clickable file anchors
- Code snippets where relevant

### 4.4 Follow-up Suggestions

**FR-030:** Participant MUST implement `ChatFollowupProvider`.

**FR-031:** Follow-ups MUST be contextual based on analysis findings:

- If issues found: "Focus on security issues only", "Show me how to fix X"
- If analysis complete: "What tests should I add?", "Explain the changes"

**FR-032:** Follow-up suggestions MUST trigger continued conversation with Lupa.

**FR-033:** Follow-up prompts must be created with Anthropic's best practices for clarity and context. Here are some reference links for crafting effective prompts:

- https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/be-clear-and-direct.md
- https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/multishot-prompting.md
- https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/chain-of-thought.md
- https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/use-xml-tags.md
- https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/system-prompts.md
- https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/chain-prompts.md
- https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/long-context-tips.md

### 4.5 Tool Registration (Agent Mode)

**FR-050:** Extension MUST register `lupa_getSymbolsOverview` as a language model tool.

**FR-051:** Tool MUST be declared in `package.json` under `languageModelTools`:

```json
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
```

**FR-052:** Tool MUST wrap existing `GetSymbolsOverviewTool` implementation.

---

## 5. Non-Functional Requirements

### 5.1 Performance

**NFR-001:** First progress message MUST appear within 500ms of command invocation.

**NFR-002:** Streaming updates MUST be debounced to prevent UI flicker (max 10 updates/second).

**NFR-003:** Analysis MUST complete within 5 minutes for typical PRs (<100 files).

### 5.2 Reliability

**NFR-010:** Cancellation MUST cleanly stop analysis and display "Analysis cancelled" message.

**NFR-011:** Errors MUST be caught and displayed via `ChatResult.errorDetails`.

**NFR-012:** Partial results MUST be preserved if analysis fails mid-stream.

### 5.3 Usability

**NFR-020:** Progress messages MUST clearly indicate current operation.

**NFR-021:** File references MUST be clickable and open correct file/line.

**NFR-022:** Follow-up suggestions MUST be actionable and relevant.

### 5.4 Compatibility

**NFR-030:** Feature MUST work on VS Code 1.95+ (Chat Participant API availability).

**NFR-031:** Feature MUST gracefully degrade if Copilot is not installed (show error message).

### 5.5 Context Window Management

**NFR-040:** ChatParticipantService MUST track token usage via `model.countTokens()` for each conversation.

**NFR-041:** When cumulative context approaches 80% of `model.maxInputTokens`, older history MUST be truncated using a sliding window approach (newest turns first).

**NFR-042:** System prompt and current diff context MUST be prioritized over old conversation history during truncation.

**NFR-043:** A minimum of 4000 tokens MUST be reserved for model output.

### 5.6 Output Formatting Responsibility

**NFR-050:** `ChatResponseBuilder` MUST be used for extension-generated messages only (intro, summary, errors, cancellation), NOT for reformatting LLM analysis output.

**NFR-051:** LLM analysis output MUST be streamed via `stream.markdown()` as-is, with format influenced by system prompt (best effort, not guaranteed).

**NFR-052:** Progress messages, file anchors, and follow-up suggestions are controlled by our code and MUST use emoji constants from `chatEmoji.ts`.

---

## 6. Technical Specifications

### 6.1 Package.json Additions

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
          { "name": "changes", "description": "Analyze uncommitted changes" }
        ],
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
    ],
    "languageModelTools": [
      {
        "name": "lupa_getSymbolsOverview",
        "displayName": "Get Symbols Overview",
        "modelDescription": "Get an overview of all symbols (classes, functions, variables) defined in a file with their line numbers and hierarchy. Unlike workspace symbol search, this provides a complete structured view of a single file.",
        "canBeReferencedInPrompt": true,
        "toolReferenceName": "symbolsOverview",
        "inputSchema": {
          "type": "object",
          "properties": {
            "filePath": {
              "type": "string",
              "description": "Absolute path to the file to analyze"
            }
          },
          "required": ["filePath"]
        }
      }
    ]
  }
}
```

### 6.2 New Files

| File                                        | Purpose                                                             |
| ------------------------------------------- | ------------------------------------------------------------------- |
| `src/models/ILLMClient.ts`                  | Interface for LLM access (Dependency Inversion)                     |
| `src/models/chatLLMClient.ts`               | Wraps `request.model` for chat participant, implements `ILLMClient` |
| `src/models/modelRequestHandler.ts`         | Extracted message conversion logic, shared by both LLM clients      |
| `src/services/chatParticipantService.ts`    | Chat participant registration, command routing, stream handling     |
| `src/services/languageModelToolProvider.ts` | Registers tools for Agent Mode                                      |
| `src/__tests__/chatParticipant.test.ts`     | Integration tests                                                   |
| `src/__tests__/chatLLMClient.test.ts`       | Unit tests for ChatLLMClient                                        |

### 6.3 Modified Files

| File                                | Changes                                                         |
| ----------------------------------- | --------------------------------------------------------------- |
| `src/models/conversationRunner.ts`  | Constructor takes `ILLMClient` instead of `CopilotModelManager` |
| `src/models/copilotModelManager.ts` | Implements `ILLMClient` interface (trivial change)              |
| `src/services/serviceManager.ts`    | Register ChatParticipantService in Phase 4                      |
| `package.json`                      | Add chatParticipants, languageModelTools contributions          |

### 6.4 Interface Definitions

```typescript
// src/models/ILLMClient.ts

import * as vscode from "vscode";
import { ToolCallRequest, ToolCallResponse } from "../types/modelTypes";

/**
 * Abstraction for LLM access, enabling Dependency Inversion.
 * Allows ConversationRunner to work with different model sources.
 */
export interface ILLMClient {
  /**
   * Send a request to the language model with tool-calling support.
   */
  sendRequest(
    request: ToolCallRequest,
    token: vscode.CancellationToken
  ): Promise<ToolCallResponse>;

  /**
   * Get the underlying language model (for token counting, etc.)
   */
  getCurrentModel(): Promise<vscode.LanguageModelChat>;
}
```

```typescript
// src/models/chatLLMClient.ts

import * as vscode from "vscode";
import { ILLMClient } from "./ILLMClient";
import { ModelRequestHandler } from "./modelRequestHandler";
import { ToolCallRequest, ToolCallResponse } from "../types/modelTypes";

/**
 * LLM client that wraps a LanguageModelChat from chat participant request.
 * Lightweight, created per-request.
 */
export class ChatLLMClient implements ILLMClient {
  constructor(
    private readonly model: vscode.LanguageModelChat,
    private readonly timeoutMs: number = 30000
  ) {}

  async sendRequest(
    request: ToolCallRequest,
    token: vscode.CancellationToken
  ): Promise<ToolCallResponse> {
    return ModelRequestHandler.sendRequest(
      this.model,
      request,
      token,
      this.timeoutMs
    );
  }

  async getCurrentModel(): Promise<vscode.LanguageModelChat> {
    return this.model;
  }
}
```

```typescript
// src/services/chatParticipantService.ts

/**
 * Metadata stored in ChatResult for follow-up provider
 */
export interface ChatAnalysisMetadata {
  command: "branch" | "changes" | "exploration";
  filesAnalyzed: number;
  issuesFound: boolean;
  hasCriticalIssues: boolean;
  cancelled: boolean;
}
```

---

## 7. Epics and User Stories

### Epic 1: Core Chat Participant (Week 1-2)

**Goal:** Enable basic `@lupa /branch` and `@lupa /changes` commands with streaming responses.

#### US-1.1: Register Chat Participant

**As a** developer
**I want to** type `@lupa` in Copilot Chat
**So that** I can access Lupa's analysis capabilities

**Acceptance Criteria:**

- [ ] Chat participant registered with id `lupa.chat-participant`
- [ ] Participant appears in `@` mention list
- [ ] Icon displays correctly
- [ ] Description shown in participant list

**Tasks:**

- Add `chatParticipants` contribution to package.json
- Create `ChatParticipantService` with handler registration
- Add participant to ServiceManager initialization

---

#### US-1.2: Implement /branch Command

**As a** developer
**I want to** type `@lupa /branch` to analyze my current branch
**So that** I can review changes before creating a PR

**Acceptance Criteria:**

- [ ] Command triggers analysis against default branch
- [ ] Progress shown via `stream.progress()`
- [ ] Results displayed as markdown in chat
- [ ] File references are clickable

**Tasks:**

- Implement command routing in ChatParticipantService
- Create `ChatLLMClient` wrapper for `request.model`
- Use `ConversationRunner` with `ChatLLMClient` (100% reuse)
- Implement `ToolCallHandler` callbacks to stream to `ChatResponseStream`
- Add file reference streaming via `stream.reference()` and `stream.anchor()`

---

#### US-1.3: Implement /changes Command

**As a** developer
**I want to** type `@lupa /changes` to analyze uncommitted changes
**So that** I can review work before committing

**Acceptance Criteria:**

- [ ] Command triggers analysis of uncommitted diff
- [ ] Same streaming behavior as /branch
- [ ] Clear indication of "uncommitted changes" scope

**Tasks:**

- Route /changes to `GitOperations.getUncommittedDiff()`
- Reuse conversation loop from /branch handler

---

#### US-1.4: Support Cancellation

**As a** developer
**I want to** cancel analysis mid-stream
**So that** I can stop long-running analysis

**Acceptance Criteria:**

- [ ] CancellationToken properly propagated
- [ ] Partial results displayed with "Cancelled" indicator
- [ ] No orphaned processes after cancellation

**Tasks:**

- Pass `CancellationToken` to `ConversationRunner.run()` (already handled)
- Handle cancellation message in stream handler callback
- Stream "Analysis cancelled" message via `stream.markdown()`

---

### Epic 2: Rich UX & Agent Mode Integration (Week 2-3)

**Goal:** Enhanced progress visualization and expose tools to Agent Mode.

#### US-2.1: Rich Progress Visualization

**As a** developer
**I want to** see detailed progress during analysis
**So that** I understand what Lupa is doing

**Acceptance Criteria:**

- [ ] Tool calls shown with icons and file anchors
- [ ] Thinking steps shown as progress updates
- [ ] Turn counter displayed elegantly
- [ ] File tree of changed files displayed

**Tasks:**

- Add rich formatting helpers for tool call visualization
- Use `stream.filetree()` for changed files from parsed diff
- Use `stream.anchor()` for tool call file references
- Format turn counter in progress messages

---

#### US-2.2: Follow-up Suggestions

**As a** developer
**I want to** see suggested follow-up questions
**So that** I can dive deeper into findings

**Acceptance Criteria:**

- [ ] Follow-ups based on analysis findings
- [ ] "Focus on security issues" if security issues found
- [ ] "What tests should I add?" always available
- [ ] Follow-ups trigger continued conversation

**Tasks:**

- Implement ChatFollowupProvider
- Build follow-up logic based on ChatResult metadata
- Test follow-up conversation flow

---

#### US-2.3: Register Agent Mode Tool

**As a** developer using Copilot Agent Mode
**I want** access to Lupa's unique symbol overview tool
**So that** I can get structured file analysis

**Acceptance Criteria:**

- [ ] `lupa_getSymbolsOverview` appears in Agent Mode tool list
- [ ] Tool works when invoked by Copilot
- [ ] Input schema validated correctly

**Tasks:**

- Add `languageModelTools` to package.json
- Create LanguageModelToolProvider service
- Wrap GetSymbolsOverviewTool with vscode.lm.registerTool()

---

### Epic 3: Exploration Mode & Polish (Week 3)

**Goal:** Support `@lupa` without commands for codebase exploration.

#### US-3.1: Exploration Mode

**As a** developer
**I want to** ask questions about my codebase
**So that** I can understand code without analyzing a diff

**Acceptance Criteria:**

- [ ] `@lupa What is the purpose of AuthHandler?` works
- [ ] Tools are used to gather context
- [ ] Response is contextual and helpful
- [ ] No diff required

**Tasks:**

- Implement no-command handler
- Create exploration prompt template
- Enable tool access without diff context

---

#### US-3.2: Conversation History Integration

**As a** developer
**I want** conversation history to influence analysis
**So that** follow-ups have context

**Acceptance Criteria:**

- [ ] Previous questions provide context
- [ ] Follow-up questions reference prior answers
- [ ] History converted to internal message format

**Tasks:**

- Implement history extraction from ChatContext
- Convert ChatRequestTurn/ChatResponseTurn to internal format
- Pass history to ConversationManager

---

#### US-3.3: Disambiguation Auto-routing

**As a** developer
**I want** Copilot to auto-route code review questions to @lupa
**So that** I don't have to explicitly type @lupa

**Acceptance Criteria:**

- [ ] "Review my changes" routes to @lupa
- [ ] "Find bugs in my code" routes to @lupa
- [ ] Disambiguation works with isParticipantDetected check

**Tasks:**

- Configure disambiguation in package.json
- Test auto-routing scenarios
- Handle isParticipantDetected in handler

---

## 8. Risks and Mitigations

| Risk                              | Likelihood | Impact | Mitigation                                                                                                       |
| --------------------------------- | ---------- | ------ | ---------------------------------------------------------------------------------------------------------------- |
| VS Code API changes               | Low        | High   | Pin to stable API, avoid proposed APIs                                                                           |
| Performance issues with streaming | Medium     | Medium | Batch progress updates, debounce                                                                                 |
| Tool conflicts with Copilot       | Low        | Medium | Unique `lupa_` prefix, clear descriptions                                                                        |
| History format incompatibility    | Medium     | Low    | Abstract history conversion layer                                                                                |
| Copilot not installed             | Medium     | Low    | Graceful error message (or even better find out how to make it explicitly needed extension to use our extension) |

---

## 9. Dependencies

### External Dependencies

- VS Code ^1.95.0 (Chat Participant API)
- GitHub Copilot extension (for chat UI)

### Internal Dependencies

- `ILLMClient` - Interface for LLM access (NEW)
- `ChatLLMClient` - Wraps `request.model` (NEW)
- `ModelRequestHandler` - Message conversion logic (NEW, extracted)
- `ConversationRunner` - Conversation loop (MODIFIED to take `ILLMClient`)
- `CopilotModelManager` - Implements `ILLMClient` (MODIFIED, trivial)
- `ToolExecutor` - Tool invocation (shared)
- `PromptGenerator` - System and user prompts (shared)
- `DiffUtils` - Diff parsing (shared)
- `GitOperations` - Diff generation (shared)
- `GetSymbolsOverviewTool` - Agent Mode tool implementation
- `ServiceManager` - Dependency injection
- `ToolCallingAnalysisProvider` - Unchanged, used for command palette flow

---

## 10. Open Questions

| #   | Question                                      | Status   | Resolution                                             |
| --- | --------------------------------------------- | -------- | ------------------------------------------------------ |
| 1   | Should we use `@vscode/chat-extension-utils`? | DEFERRED | Evaluate after MVP                                     |
| 2   | Should we use `@vscode/prompt-tsx`?           | DEFERRED | Consider for optimization                              |
| 3   | How to handle very long analyses?             | RESOLVED | Stream full results in chat; chat UI handles scrolling |
| 4   | Should we expose more tools to Agent Mode?    | RESOLVED | Only `getSymbolsOverview` provides unique value        |

---

## 11. Glossary

| Term             | Definition                                                |
| ---------------- | --------------------------------------------------------- |
| Chat Participant | VS Code extension point for integrating with Copilot Chat |
| Agent Mode       | Copilot mode where LLM can autonomously invoke tools      |
| Slash Command    | `/command` shortcuts within chat participant              |
| Disambiguation   | Metadata for auto-routing questions to participants       |
| Sticky Mode      | Participant stays active for follow-up messages           |
| Tool Calling     | LLM capability to invoke extension-provided tools         |

---

## 12. Appendix

### A. Research Sources

1. VS Code Chat Participant API Documentation
2. microsoft/vscode-copilot-chat source analysis
3. microsoft/vscode-websearchforcopilot reference implementation
4. VS Code proposed API definitions

### B. Related Documents

- [Product Brief: @lupa Chat Participant](analysis/product-brief-chat-participant-2025-12-15.md)
- [VS Code Chat Participant API Research](research/vscode-chat-participant-api.md)
- [VS Code Chat Response Streaming Research](research/vscode-chat-response-streaming.md)
- [VS Code LM Tool Calling API Research](research/vscode-lm-tool-calling-api.md)

---

## Changelog

| Date       | Version | Author | Changes                                                                                                                                                     |
| ---------- | ------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2025-12-15 | 1.0     | Igor   | Initial PRD created from product brief                                                                                                                      |
| 2025-12-15 | 1.1     | Igor   | Revised architecture: component reuse over adapter pattern; removed telemetry (not implemented); clarified webview is for command path only                 |
| 2025-12-15 | 1.2     | Igor   | SOLID/DRY architecture: ILLMClient interface for Dependency Inversion; 100% ConversationRunner reuse; ChatLLMClient wrapper; ModelRequestHandler extraction |
