---
stepsCompleted: [1, 2, 3, 4, 5, 6]
inputDocuments:
  - docs/implementation-plans/feature-roadmap-2025.md
  - src/services/toolCallingAnalysisProvider.ts
  - src/tools/*
  - package.json
workflowType: "product-brief"
workflowMode: "yolo-research"
lastStep: 6
project_name: "Lupa"
feature_name: "Chat Participant"
user_name: "Igor"
date: "2025-12-15"
research_sources:
  - "microsoft/vscode (DeepWiki)"
  - "microsoft/vscode-copilot-chat (DeepWiki)"
  - "microsoft/vscode-websearchforcopilot (DeepWiki)"
  - "code.visualstudio.com/api/extension-guides/ai/chat"
---

# Product Brief: @lupa Chat Participant for VS Code

**Version:** 1.0
**Date:** December 15, 2025
**Author:** Lupa Development Team
**Status:** DRAFT - Pending Review

---

## Executive Summary

This product brief defines the implementation of the `@lupa` chat participant for VS Code, enabling users to invoke Lupa's PR analysis capabilities directly from GitHub Copilot Chat. This feature transforms Lupa from a standalone extension into a first-class Copilot ecosystem participant.

### Key Decision: Correct Previous Assumptions

> **⚠️ Critical Finding:** The previous roadmap contained incorrect assumptions that were made without proper research. This product brief corrects those assumptions based on comprehensive investigation of VS Code source code and official documentation.

**Previous Incorrect Assumptions:**

1. ❌ "Copilot's built-in tools are gated by `chatParticipantPrivate`" → **PARTIALLY CORRECT** - Third-party extensions CAN invoke tools via `vscode.lm.invokeTool()`, but internal tools require the proposed API
2. ❌ "Credits/quota tracking API is not available" → **CORRECT** - Only `github.copilot.chat.quotaExceeded` context key exists
3. ❌ "We should define `/analyze`, `/review`, `/explain` shortcuts first" → **INCORRECT** - We should start with `/branch` and `/changes` to leverage existing implementation

---

## Problem Statement

### Current State

Users must:

1. Open Command Palette
2. Run "Lupa: Analyze Pull Request"
3. Select analysis type (branch comparison vs uncommitted changes)
4. Wait for webview to open with results

### Desired State

Users can:

1. Type `@lupa /branch` or `@lupa /changes` directly in Copilot Chat
2. See streaming progress with rich UI (file references, progress indicators)
3. Get analysis results inline in chat with follow-up capabilities
4. Optionally use `@lupa` without commands for exploration/Q&A about code

---

## Research Findings Summary

### 1. Chat Participant API (VS Code 1.95+)

**Registration Pattern:**

```typescript
// package.json
"contributes": {
  "chatParticipants": [{
    "id": "lupa.chat-participant",
    "name": "lupa",
    "fullName": "Lupa Code Review",
    "description": "Analyze pull requests and code changes",
    "isSticky": true,
    "commands": [
      { "name": "branch", "description": "Analyze current branch vs default branch" },
      { "name": "changes", "description": "Analyze uncommitted changes" }
    ],
    "disambiguation": [{
      "category": "code_review",
      "description": "The user wants to review code changes, analyze pull requests, or understand diffs",
      "examples": [
        "Review my changes before I commit",
        "What issues might be in my PR?",
        "Analyze the security of my branch changes"
      ]
    }]
  }]
}
```

**Handler Implementation:**

```typescript
const handler: vscode.ChatRequestHandler = async (
  request: vscode.ChatRequest,
  context: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
) => { ... };
```

### 2. Built-in Tool Access

**Key Finding:** Third-party extensions CAN invoke Copilot tools via `vscode.lm.invokeTool()`:

```typescript
// This WORKS for publicly registered tools
const result = await vscode.lm.invokeTool(
  "copilot_searchCodebase",
  {
    input: { query: "authentication handler" },
    toolInvocationToken: request.toolInvocationToken,
  },
  token
);
```

**However:** Tools prefixed with `copilot_` or `vscode_` may require `chatParticipantPrivate` proposed API for certain operations. The exact list is:

- Internal edit tools (file creation, modification)
- Internal fetch tools (web page fetching)
- Extension-specific tools

**Recommendation:** Keep our custom tools for full control, but evaluate using `copilot_searchCodebase` for semantic search since it's publicly available.

### 3. Credit/Quota Tracking

**Finding:** No public API for credit usage tracking.

**Available:**

- `github.copilot.chat.quotaExceeded` - Context key (boolean)
- No per-request credit count

**Implication:** Cannot display credits used in webview reports. Remove this from requirements.

### 4. Rich Response Stream Capabilities

| Method               | Use Case for Lupa                                        |
| -------------------- | -------------------------------------------------------- |
| `stream.markdown()`  | Analysis results, explanations                           |
| `stream.progress()`  | "Analyzing 15 files...", "Reading symbol definitions..." |
| `stream.reference()` | Link to analyzed files                                   |
| `stream.anchor()`    | Inline file links in analysis                            |
| `stream.button()`    | "Open in Webview", "Show Full Diff"                      |
| `stream.filetree()`  | Show affected files structure                            |

### 5. Tool Registration for Agent Mode

Lupa can register tools that Copilot Agent Mode can invoke:

```typescript
// Register in package.json
"languageModelTools": [{
  "name": "lupa_analyzeSymbol",
  "displayName": "Analyze Symbol Context",
  "modelDescription": "Analyze how a symbol is used and affected by changes",
  "inputSchema": { ... },
  "canBeReferencedInPrompt": true,
  "toolReferenceName": "analyzeSymbol"
}]

// Register implementation
vscode.lm.registerTool('lupa_analyzeSymbol', new AnalyzeSymbolTool());
```

---

## Architecture Design

### Option A: Streaming Adapter (Recommended)

Modify `ToolCallingAnalysisProvider` to accept a streaming callback:

```
┌─────────────────────────────────────────────────────────────┐
│                    @lupa Chat Participant                    │
│  ┌─────────────────────────────────────────────────────┐    │
│  │             ChatParticipantHandler                   │    │
│  │  • Parses commands (/branch, /changes)              │    │
│  │  • Creates streaming adapter                         │    │
│  │  • Invokes ToolCallingAnalysisProvider              │    │
│  └──────────────────────┬──────────────────────────────┘    │
│                         │                                    │
│  ┌──────────────────────▼──────────────────────────────┐    │
│  │           StreamingProgressAdapter                   │    │
│  │  • Converts progress callbacks to stream methods    │    │
│  │  • progress() → stream.progress()                   │    │
│  │  • toolCall() → stream.markdown() + anchor()        │    │
│  └──────────────────────┬──────────────────────────────┘    │
│                         │                                    │
└─────────────────────────┼────────────────────────────────────┘
                          │
┌─────────────────────────▼────────────────────────────────────┐
│               EXISTING INFRASTRUCTURE                         │
│  ┌─────────────────────────────────────────────────────┐     │
│  │          ToolCallingAnalysisProvider                 │     │
│  │  • analyze(diff, token, progressCallback)           │     │
│  │  • Uses ConversationRunner                          │     │
│  │  • Tool execution via ToolExecutor                  │     │
│  └──────────────────────┬──────────────────────────────┘     │
│                         │                                     │
│  ┌──────────────────────▼──────────────────────────────┐     │
│  │              Tool Registry                           │     │
│  │  FindSymbolTool, ReadFileTool, ListDirTool, etc.   │     │
│  └──────────────────────────────────────────────────────┘     │
└───────────────────────────────────────────────────────────────┘
```

### Option B: Parallel Implementation (Not Recommended)

Create a completely separate `ChatAnalysisProvider` that duplicates tool-calling logic.

**Rejected because:** Violates DRY, doubles maintenance burden, divergent behavior risk.

### Chosen Approach: Option A with Enhanced Progress Callbacks

Extend the existing `AnalysisProgressCallback` type to support richer streaming:

```typescript
interface EnhancedProgressCallback {
  onProgress: (message: string) => void;
  onToolStart: (toolName: string, args: Record<string, unknown>) => void;
  onToolComplete: (toolName: string, success: boolean, summary: string) => void;
  onFileReference: (filePath: string, range?: vscode.Range) => void;
  onThinking: (thought: string) => void;
}
```

---

## Tool Strategy

### Tools to Keep Internal (Lupa-only)

These tools should NOT be exposed to Copilot Agent Mode because they are tightly coupled to our analysis workflow:

| Tool                      | Reason                                            |
| ------------------------- | ------------------------------------------------- |
| `thinkAboutContext`       | Internal reasoning, not useful for general agents |
| `thinkAboutTask`          | Internal planning, specific to our workflow       |
| `thinkAboutCompletion`    | Internal verification                             |
| `thinkAboutInvestigation` | Internal reasoning                                |
| `runSubagent`             | Complex orchestration, Lupa-specific              |

### Tools to Register for Agent Mode

These tools provide unique value that Copilot doesn't have natively:

| Tool                 | Agent Mode Name           | Value Proposition                                                       |
| -------------------- | ------------------------- | ----------------------------------------------------------------------- |
| `getSymbolsOverview` | `lupa_getSymbolsOverview` | Complete file structure with symbol hierarchy (not just search results) |

> **Note:** Only `getSymbolsOverview` provides genuinely unique functionality. Other tools have Copilot equivalents.

### Tools NOT to Expose (Copilot Has Equivalents)

| Our Tool             | Copilot Equivalent               | Notes                                   |
| -------------------- | -------------------------------- | --------------------------------------- |
| `readFile`           | `copilot_readFile`               | Identical functionality                 |
| `findSymbol`         | `copilot_searchWorkspaceSymbols` | Symbol search                           |
| `findUsages`         | `copilot_listCodeUsages`         | Usage finding                           |
| `listDir`            | `copilot_listDirectory`          | Directory listing                       |
| `searchForPattern`   | `copilot_findTextInFiles`        | **Supports regex via `isRegexp` param** |
| `findFilesByPattern` | `copilot_findFiles`              | Glob pattern support                    |

---

## UX Design

### Progress Visualization

**Current (boring):**

```
Turn 1/50: Analyzing...
Turn 2/50: Analyzing...
```

**Proposed (rich):**

```markdown
🔍 **Starting Analysis**

📂 Reading changed files...
└─ [src/auth/handler.ts](src/auth/handler.ts)
└─ [src/api/routes.ts](src/api/routes.ts)

🔎 Finding symbol definitions...
└─ `AuthHandler` → [src/auth/handler.ts#L45](src/auth/handler.ts#L45)
└─ `validateToken` → [src/auth/validator.ts#L12](src/auth/validator.ts#L12)

📊 Analyzing 3 usages of `AuthHandler`...

💭 Considering security implications...
```

### Response Structure

```markdown
## 🔍 Analysis: feature/add-oauth vs main

### Critical Issues (2)

🔴 **SQL Injection Risk** in [user-service.ts#L45](src/services/user-service.ts#L45)
The `userId` parameter is directly interpolated into the SQL query...

🔴 **Missing Error Handling** in [auth-handler.ts#L23](src/auth/auth-handler.ts#L23)
Promise rejection not caught, could crash the server...

### Suggestions (3)

🟡 Consider adding input validation for `email` parameter
🟡 The `timeout` value of 30000ms may be too long for user experience
🟡 Add JSDoc comments to exported `AuthConfig` interface

### Files Analyzed

📁 15 files changed, 234 additions, 89 deletions

[📊 Open Full Report](command:lupa.openWebview) | [🔄 Re-analyze](command:lupa.analyzePR)
```

### Follow-up Questions

```typescript
participant.followupProvider = {
  provideFollowups(result, context, token) {
    const issues = result.metadata?.issues || [];
    return [
      { prompt: "Focus on security issues only", label: "🔒 Security Focus" },
      {
        prompt: "Explain the SQL injection risk in detail",
        label: "❓ Explain Risk",
      },
      { prompt: "Show me how to fix the error handling", label: "🔧 Show Fix" },
      { prompt: "What tests should I add?", label: "🧪 Suggest Tests" },
    ];
  },
};
```

---

## Slash Commands Design

### Phase 1: Core Commands (MVP)

| Command    | Description                       | Implementation                                |
| ---------- | --------------------------------- | --------------------------------------------- |
| `/branch`  | Analyze current branch vs default | Uses `gitOperations.getDiffToDefaultBranch()` |
| `/changes` | Analyze uncommitted changes       | Uses `gitOperations.getUncommittedDiff()`     |

### Phase 2: Extended Commands (Future)

| Command     | Description                               | Status                        |
| ----------- | ----------------------------------------- | ----------------------------- |
| `/review`   | Focused review with custom focus areas    | Requires new prompts          |
| `/security` | Security-focused analysis                 | Requires SecurityAuditPrompt  |
| `/explain`  | Explain what changes do in plain language | Requires ExplainChangesPrompt |

### Handling `@lupa` Without Commands

**User types:** `@lupa What does the AuthHandler class do?`

**Behavior:**

1. No diff is loaded
2. Use tool-calling to answer the question about the codebase
3. Enable exploration mode with full tool access

This is essentially "ask mode" where Lupa acts as a codebase expert without PR context.

---

## Chat History Strategy

### Conversation Context

```typescript
handler: ChatRequestHandler = async (request, context, stream, token) => {
  // Access previous turns
  const previousTurns = context.history;

  // Convert to our internal message format
  const conversationHistory = previousTurns.map((turn) => {
    if (turn instanceof vscode.ChatRequestTurn) {
      return { role: "user", content: turn.prompt };
    } else {
      // ChatResponseTurn - extract markdown content
      return { role: "assistant", content: extractMarkdown(turn.response) };
    }
  });

  // Pass to our analysis provider
  conversationManager.setHistory(conversationHistory);
};
```

### History Preservation

- **Within Session:** Full history preserved via `context.history`
- **Across Sessions:** Not preserved (VS Code behavior)
- **Sticky Mode:** Enabled via `isSticky: true` - keeps @lupa active for follow-ups

---

## Epic Breakdown

### Epic 1: Core Chat Participant Integration (Week 1-2)

**Goal:** Enable basic `@lupa /branch` and `@lupa /changes` commands with streaming responses.

**User Stories:**

1. **As a developer, I want to type `@lupa /branch` to analyze my current branch**

   - AC: Analysis runs against default branch
   - AC: Progress shown via `stream.progress()`
   - AC: Results displayed as markdown in chat
   - AC: File references are clickable

2. **As a developer, I want to type `@lupa /changes` to analyze uncommitted changes**

   - AC: Analysis runs against working tree diff
   - AC: Same streaming/progress as /branch

3. **As a developer, I want to see which files are being analyzed**

   - AC: `stream.reference()` shows each analyzed file
   - AC: `stream.filetree()` shows changed files structure

4. **As a developer, I want to cancel analysis mid-stream**
   - AC: CancellationToken properly propagated
   - AC: Partial results displayed with "Cancelled" indicator

**Technical Tasks:**

- [ ] Add `chatParticipants` contribution to package.json
- [ ] Create `ChatParticipantService` with request handler
- [ ] Create `StreamingProgressAdapter` to bridge callbacks
- [ ] Modify `ToolCallingAnalysisProvider` to accept enhanced callbacks
- [ ] Add integration tests for chat participant
- [ ] Update VS Code engine requirement to ^1.95.0 (we have ^1.107.0, ✅)

### Epic 2: Rich UX & Tool Exposure (Week 2-3)

**Goal:** Enhanced progress visualization and expose unique tools to Agent Mode.

**User Stories:**

1. **As a developer, I want to see detailed progress during analysis**

   - AC: Tool calls shown with icons and file anchors
   - AC: Thinking steps shown in collapsible sections
   - AC: Turn counter displayed elegantly

2. **As a developer, I want follow-up question suggestions after analysis**

   - AC: Relevant follow-ups based on findings
   - AC: Follow-ups trigger continued conversation

3. **As a developer using Copilot Agent Mode, I want access to Lupa's unique search tools**

   - AC: `lupa_getSymbolsOverview` registered and working
   - AC: `lupa_searchForPattern` registered and working
   - AC: Tools appear in Agent Mode tool list

4. **As a developer, I want to open full results in webview from chat**
   - AC: "Open Full Report" button in chat response
   - AC: Webview shows complete tool call history

**Technical Tasks:**

- [ ] Implement `ChatFollowupProvider`
- [ ] Create rich progress formatting utilities
- [ ] Add `languageModelTools` contribution to package.json
- [ ] Implement `LanguageModelTool` wrapper for exposed tools
- [ ] Add button to open webview with full results

### Epic 3: Exploration Mode & Polish (Week 3)

**Goal:** Support `@lupa` without commands for codebase exploration.

**User Stories:**

1. **As a developer, I want to ask questions about my codebase without analyzing a diff**

   - AC: `@lupa What is the purpose of AuthHandler?` works
   - AC: Tools are used to gather context
   - AC: Response is contextual and helpful

2. **As a developer, I want conversation history to influence analysis**

   - AC: Previous questions provide context
   - AC: Follow-up questions reference prior answers

3. **As a developer, I want Copilot to auto-route code review questions to @lupa**
   - AC: Disambiguation configured correctly
   - AC: Questions like "review my changes" route to @lupa

**Technical Tasks:**

- [ ] Implement exploration mode (no-diff analysis)
- [ ] Add conversation history integration
- [ ] Configure disambiguation for auto-routing
- [ ] Add telemetry for success metrics
- [ ] Performance optimization and testing

---

## Technical Requirements

### Package.json Changes

```json
{
  "engines": {
    "vscode": "^1.107.0" // Already satisfied
  },
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

### New Files to Create

| File                                        | Purpose                                   |
| ------------------------------------------- | ----------------------------------------- |
| `src/services/chatParticipantService.ts`    | Chat participant registration and handler |
| `src/services/streamingProgressAdapter.ts`  | Converts callbacks to stream methods      |
| `src/services/languageModelToolProvider.ts` | Registers tools for Agent Mode            |
| `src/__tests__/chatParticipant.test.ts`     | Integration tests                         |

### Files to Modify

| File                                          | Changes                                                |
| --------------------------------------------- | ------------------------------------------------------ |
| `src/services/serviceManager.ts`              | Register ChatParticipantService                        |
| `src/services/toolCallingAnalysisProvider.ts` | Accept enhanced progress callback                      |
| `src/types/toolCallTypes.ts`                  | Add EnhancedProgressCallback interface                 |
| `package.json`                                | Add chatParticipants, languageModelTools contributions |

---

## Success Metrics

| Metric                           | Target                    | Measurement            |
| -------------------------------- | ------------------------- | ---------------------- |
| Chat participant invocations     | 50% of analyses via @lupa | Telemetry              |
| Unhelpful feedback rate          | <10%                      | `onDidReceiveFeedback` |
| Average analysis completion rate | >90%                      | Telemetry              |
| Follow-up question usage         | >20% of sessions          | Telemetry              |

---

## Risks and Mitigations

| Risk                              | Likelihood | Impact | Mitigation                             |
| --------------------------------- | ---------- | ------ | -------------------------------------- |
| VS Code API changes               | Low        | High   | Pin to stable API, avoid proposed APIs |
| Performance issues with streaming | Medium     | Medium | Batch progress updates, debounce       |
| Tool conflicts with Copilot       | Low        | Medium | Unique prefixes, clear descriptions    |
| History format incompatibility    | Medium     | Low    | Abstract history conversion layer      |

---

## Out of Scope

The following are explicitly NOT part of this feature:

1. **Credit/quota tracking** - No public API available
2. **GitHub PR integration** - Separate feature (Phase 4 in roadmap)
3. **CLI mode** - Separate feature (Phase 5 in roadmap)
4. **Custom review templates** - Phase 3 feature
5. **Multi-repository support** - Future consideration

---

## Open Questions

1. **Should we use `@vscode/chat-extension-utils` library?**

   - Pro: Simplifies tool calling
   - Con: Additional dependency, less control
   - **Recommendation:** Evaluate after MVP, potentially adopt in Epic 2

2. **Should we use `@vscode/prompt-tsx` for prompt construction?**

   - Pro: Type-safe prompts, priority-based token allocation
   - Con: Learning curve, React-like paradigm
   - **Recommendation:** Start without it, consider for follow-up optimization

3. **How to handle very long analyses in chat?**
   - Option A: Truncate in chat, full results in webview
   - Option B: Stream full results, rely on chat scrolling
   - **Recommendation:** Option A with "Open Full Report" button

---

## Appendix: Research Sources

1. **VS Code Chat Participant API Documentation**

   - https://code.visualstudio.com/api/extension-guides/ai/chat

2. **microsoft/vscode-websearchforcopilot**

   - Reference implementation of chat participant
   - Shows tool + participant dual registration pattern

3. **microsoft/vscode source (DeepWiki)**

   - ChatParticipant registration internals
   - Tool gating via `chatParticipantPrivate`

4. **microsoft/vscode-copilot-chat (DeepWiki)**
   - Built-in tool implementations
   - Agent Mode architecture

---

## Changelog

| Date       | Version | Changes                                       |
| ---------- | ------- | --------------------------------------------- |
| 2025-12-15 | 1.0     | Initial draft based on comprehensive research |

---

_Document created by Analyst Agent following BMAD workflow_
