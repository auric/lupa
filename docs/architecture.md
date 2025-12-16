---
stepsCompleted: [1, 2, 3, 4, 5, 6, 7, 8]
inputDocuments:
  - docs/prd.md
  - docs/ux-design-specification.md
  - docs/analysis/product-brief-chat-participant-2025-12-15.md
  - docs/research/vscode-chat-participant-api.md
  - docs/research/vscode-chat-response-streaming.md
  - docs/research/vscode-lm-tool-calling-api.md
  - docs/research/vscode-copilot-chat-research.md
  - docs/research/context-window-management.md
  - CLAUDE.md
workflowType: "architecture"
lastStep: 8
status: "complete-revised"
completedAt: "2025-12-16"
revisedAt: "2025-12-16"
revisionReason: "Incorporated UX Design Specification requirements; Added context window management and hybrid output approach decisions"
project_name: "Lupa"
feature_name: "@lupa Chat Participant"
user_name: "Igor"
date: "2025-12-16"
---

# Architecture Decision Document: @lupa Chat Participant

**Version:** 1.2
**Date:** December 16, 2025 (Revised)
**Original Date:** December 15, 2025
**Author:** Igor + Winston (Architect Agent)
**Status:** APPROVED FOR IMPLEMENTATION

---

_This document captures architectural decisions for implementing the `@lupa` chat participant feature in the Lupa VS Code extension. Decisions are structured to prevent AI agent implementation conflicts and ensure consistent development. **Revision 1.1** incorporates requirements from the UX Design Specification._

---

## Project Context Analysis

### Requirements Overview

**Functional Requirements (17 total):**

| Category                                         | Count | Coverage                              |
| ------------------------------------------------ | ----- | ------------------------------------- |
| Chat Participant Registration (FR-001 to FR-003) | 3     | Package.json + ChatParticipantService |
| Command Handling (FR-010 to FR-012)              | 3     | ChatParticipantService routing        |
| Streaming Response (FR-020 to FR-023)            | 4     | ChatResponseStream integration        |
| Follow-up Suggestions (FR-030 to FR-033)         | 4     | ChatFollowupProvider                  |
| Tool Registration (FR-050 to FR-052)             | 3     | LanguageModelToolProvider             |

**Non-Functional Requirements (11 total):**

| Category                           | Requirements                                               | Implementation                  |
| ---------------------------------- | ---------------------------------------------------------- | ------------------------------- |
| Performance (NFR-001 to NFR-003)   | First progress <500ms, debounced updates, <5min completion | Streaming architecture          |
| Reliability (NFR-010 to NFR-012)   | Clean cancellation, error handling, partial results        | CancellationToken propagation   |
| Usability (NFR-020 to NFR-022)     | Clear progress, clickable references, relevant follow-ups  | Rich ChatResponseStream methods |
| Compatibility (NFR-030 to NFR-031) | VS Code 1.95+, graceful Copilot fallback                   | Stable API only                 |

**UX Design Patterns (50+ from UX Specification):**

| Category            | Patterns                                       | Implementation         |
| ------------------- | ---------------------------------------------- | ---------------------- |
| Streaming Patterns  | Progress messages, debouncing, tool visibility | DebouncedStreamHandler |
| Response Structure  | Verdict-first, finding cards, summary bars     | ChatResponseBuilder    |
| Emoji Design System | Severity (🔴🟡✅), Activity (💭🔍📂)           | chatEmoji.ts constants |
| Follow-up Patterns  | Contextual chips, 3-4 max per response         | ChatFollowupProvider   |
| Accessibility       | Shape-based emoji, heading hierarchy           | Markdown conventions   |
| Emotional Design    | Supportive tone, non-judgmental language       | Message templates      |

**Scale & Complexity:**

- **Project Type:** Brownfield feature addition to existing VS Code extension
- **Complexity Level:** MEDIUM-HIGH (VS Code Chat API integration, streaming, tool-calling)
- **Primary Domain:** VS Code Extension (TypeScript, Node.js)
- **Estimated New Code:** ~300 lines (excluding tests)

### Technical Constraints & Dependencies

**From CLAUDE.md Project Context:**

| Constraint                              | Description                                 | Impact                                       |
| --------------------------------------- | ------------------------------------------- | -------------------------------------------- |
| Workers cannot use `vscode` module      | Isolated child_process execution            | N/A for this feature                         |
| Code chunking single-threaded           | web-tree-sitter memory leaks                | N/A for this feature                         |
| Circular deps use null+setter injection | ServiceManager pattern                      | May apply if ChatParticipantService has deps |
| Two model types                         | Embedding (local) vs Language (Copilot API) | ILLMClient abstracts this                    |

**External Dependencies:**

- VS Code ^1.95.0 (Chat Participant API) - ✅ Already have ^1.107.0
- GitHub Copilot extension (for chat UI)

**Internal Dependencies (Existing):**

- `ConversationRunner` - Modified to take ILLMClient
- `ToolExecutor` - Unchanged, shared
- `PromptGenerator` - Unchanged, shared
- `DiffUtils` - Unchanged, shared
- `GitOperations` - Unchanged, shared
- `GetSymbolsOverviewTool` - Wrapped for Agent Mode

### Cross-Cutting Concerns Identified

1. **Streaming/Progress** - Affects all command handlers, needs unified callback pattern
2. **Cancellation** - Propagates through entire call chain via CancellationToken
3. **Error Handling** - Must work for both chat (ChatResult.errorDetails) and command paths
4. **Model Abstraction** - ILLMClient pattern enables code reuse
5. **UX Response Formatting** - Consistent response structure, emoji system, finding cards (NEW)
6. **Emotional Design** - Supportive tone, non-judgmental language patterns (NEW)
7. **Streaming Rate Control** - Debounced updates (max 10/sec) to prevent UI flicker (NEW)

---

## Starter Template Evaluation

### Brownfield Project Assessment

**This is NOT a greenfield project.** Lupa exists with complete infrastructure:

| Component       | Technology                                           | Status      |
| --------------- | ---------------------------------------------------- | ----------- |
| Build System    | Vite (dual: Node.js extension + browser webview)     | ✅ Existing |
| Test Framework  | Vitest with VS Code mocks                            | ✅ Existing |
| UI Framework    | React 19, React Compiler, shadcn/ui, Tailwind CSS v4 | ✅ Existing |
| Language        | TypeScript (strict mode)                             | ✅ Existing |
| Package Manager | npm                                                  | ✅ Existing |

**Starter Template Decision:** N/A - Integrating into existing project structure.

### Build Configuration Integration

New feature integrates with existing build:

```bash
# Fast validation (~2s) - use for development
npm run check-types

# Full build (~30s) - use before commit
npm run build

# Run specific tests
npx vitest run src/__tests__/chatParticipant.test.ts
```

**package.json Changes Required:**

```json
{
  "contributes": {
    "chatParticipants": [
      /* new contribution */
    ],
    "languageModelTools": [
      /* new contribution */
    ]
  }
}
```

---

## Core Architectural Decisions

### Decision 1: LLM Client Abstraction (ILLMClient Interface)

**Decision:** Use Dependency Inversion with `ILLMClient` interface

**Rationale:**

- Enables 100% ConversationRunner reuse
- ChatLLMClient wraps `request.model` from chat participant
- CopilotModelManager implements same interface (trivial change)
- Follows SOLID principles (D - Dependency Inversion)

**Interface Definition:**

```typescript
// src/models/ILLMClient.ts
export interface ILLMClient {
  sendRequest(
    request: ToolCallRequest,
    token: vscode.CancellationToken
  ): Promise<ToolCallResponse>;

  getCurrentModel(): Promise<vscode.LanguageModelChat>;
}
```

**Impact Analysis:**

- `ConversationRunner` constructor changes from `CopilotModelManager` to `ILLMClient`
- Both `ChatLLMClient` and `CopilotModelManager` implement `ILLMClient`
- Zero behavior change, only type abstraction

---

### Decision 2: Message Conversion Extraction (ModelRequestHandler)

**Decision:** Extract shared message conversion logic to separate module

**Rationale:**

- DRY - both LLM clients need identical conversion
- Single point of maintenance
- Testable in isolation

**Implementation:**

```typescript
// src/models/modelRequestHandler.ts
export class ModelRequestHandler {
  static async sendRequest(
    model: vscode.LanguageModelChat,
    request: ToolCallRequest,
    token: vscode.CancellationToken,
    timeoutMs: number
  ): Promise<ToolCallResponse> {
    // Shared message conversion and request handling
  }
}
```

**Usage:**

- `CopilotModelManager.sendRequest()` delegates to `ModelRequestHandler.sendRequest()`
- `ChatLLMClient.sendRequest()` delegates to `ModelRequestHandler.sendRequest()`

---

### Decision 3: Streaming Progress Pattern

**Decision:** Use callback-based handler for ConversationRunner progress events

**Rationale:**

- Same ConversationRunner, different output targets
- Chat path: Calls `ChatResponseStream` methods
- Command path: Collects results for webview display

**Handler Interface:**

```typescript
export interface ToolCallHandler {
  onProgress(message: string): void;
  onToolStart(toolName: string, args: Record<string, unknown>): void;
  onToolComplete(toolName: string, success: boolean, summary: string): void;
  onFileReference(filePath: string, range?: vscode.Range): void;
  onThinking(thought: string): void;
  onMarkdown(content: string): void;
}
```

**Chat Implementation:**

```typescript
class ChatStreamHandler implements ToolCallHandler {
  constructor(private stream: vscode.ChatResponseStream) {}

  onProgress(message: string) {
    this.stream.progress(message);
  }

  onMarkdown(content: string) {
    this.stream.markdown(content);
  }

  onFileReference(filePath: string, range?: vscode.Range) {
    const uri = vscode.Uri.file(filePath);
    if (range) {
      this.stream.anchor(
        new vscode.Location(uri, range),
        path.basename(filePath)
      );
    } else {
      this.stream.reference(uri, vscode.ThemeIcon.File);
    }
  }
}
```

---

### Decision 4: Follow-up Provider Strategy

**Decision:** Context-based follow-up suggestions from ChatResult metadata

**Rationale:**

- Analysis results include metadata (issues found, severity, etc.)
- Follow-up provider reads metadata to suggest relevant actions
- Prompts crafted per Anthropic best practices

**Implementation:**

```typescript
// ChatResult metadata structure
export interface ChatAnalysisMetadata {
  command: "branch" | "changes" | "exploration";
  filesAnalyzed: number;
  issuesFound: boolean;
  hasCriticalIssues: boolean;
  cancelled: boolean;
}

// Follow-up provider
participant.followupProvider = {
  provideFollowups(result, context, token) {
    const meta = result.metadata as ChatAnalysisMetadata;
    const followups: vscode.ChatFollowup[] = [];

    if (meta?.hasCriticalIssues) {
      followups.push({
        prompt: "Focus on security issues only",
        label: "🔒 Security Focus",
      });
    }

    followups.push({
      prompt: "What tests should I add?",
      label: "🧪 Suggest Tests",
    });

    return followups;
  },
};
```

---

### Decision 5: Tool Registration for Agent Mode

**Decision:** Register ONLY `lupa_getSymbolsOverview` for Agent Mode

**Rationale:**

- Only tool providing unique value vs Copilot built-ins
- Other Lupa tools have Copilot equivalents
- Minimal surface area, maximum value

**Tools NOT Exposed (Copilot Has Equivalents):**

| Our Tool             | Copilot Equivalent               |
| -------------------- | -------------------------------- |
| `readFile`           | `copilot_readFile`               |
| `findSymbol`         | `copilot_searchWorkspaceSymbols` |
| `findUsages`         | `copilot_listCodeUsages`         |
| `listDir`            | `copilot_listDirectory`          |
| `searchForPattern`   | `copilot_findTextInFiles`        |
| `findFilesByPattern` | `copilot_findFiles`              |

**Tool Registration:**

```json
// package.json
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

---

### Decision 6: Error Handling Pattern

**Decision:** Use `ChatResult.errorDetails` for chat path errors

**Rationale:**

- Native VS Code chat error handling
- User sees proper error UI
- Consistent with other chat participants

**Implementation:**

```typescript
async function handleChatRequest(
  request: vscode.ChatRequest,
  context: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<vscode.ChatResult> {
  try {
    // ... analysis logic
    return { metadata: { command: "branch", issuesFound: true } };
  } catch (error) {
    return {
      errorDetails: {
        message: error instanceof Error ? error.message : "Analysis failed",
        responseIsIncomplete: true,
      },
    };
  }
}
```

---

### Decision 7: Cancellation Propagation

**Decision:** Pass CancellationToken through entire call chain

**Rationale:**

- Already supported by ConversationRunner
- ChatParticipantService passes token from request
- Clean abort at any point

**Implementation:**

- No new code needed - existing `ConversationRunner.run()` already accepts token
- `ChatParticipantService` passes `request.token` to runner

---

### Decision 8: Response Formatting Pattern (UX-Driven)

**Decision:** Use `ChatResponseBuilder` utility class for consistent response formatting

**Rationale:**

- UX specification defines strict response structure: Verdict → Stats → Findings → Positives → Follow-ups
- Ensures AI agents produce consistent, scannable output
- Supports emotional design goals (confidence, not shame)
- Enables unit testing of response formatting

**Implementation:**

```typescript
// src/utils/chatResponseBuilder.ts
export class ChatResponseBuilder {
  private sections: string[] = [];

  addVerdictLine(
    status: "success" | "issues" | "cancelled",
    summary: string
  ): this {
    const emoji =
      status === "success" ? "✅" : status === "issues" ? "🔍" : "💬";
    this.sections.push(`## ${emoji} ${summary}\n`);
    return this;
  }

  addSummaryStats(
    filesAnalyzed: number,
    critical: number,
    suggestions: number
  ): this {
    this.sections.push(
      `📊 **${filesAnalyzed} files** analyzed | **${critical}** critical | **${suggestions}** suggestions\n`
    );
    return this;
  }

  addFindingsSection(title: string, emoji: string, findings: Finding[]): this {
    if (findings.length === 0) return this;
    this.sections.push(`\n---\n\n### ${emoji} ${title}\n\n`);
    for (const finding of findings) {
      this.sections.push(
        `**${finding.title}** in [${finding.location}](${finding.anchor})\n${finding.description}\n\n`
      );
    }
    return this;
  }

  addPositiveNotes(notes: string[]): this {
    if (notes.length === 0) return this;
    this.sections.push(`\n---\n\n### ✅ What's Good\n\n`);
    for (const note of notes) {
      this.sections.push(`- ${note}\n`);
    }
    return this;
  }

  addFollowupPrompt(summary: string): this {
    this.sections.push(`\n---\n\n📊 ${summary}\n`);
    return this;
  }

  build(): string {
    return this.sections.join("");
  }
}
```

**Usage Pattern:**

```typescript
const response = new ChatResponseBuilder()
  .addVerdictLine("issues", "Analysis Complete")
  .addSummaryStats(15, 2, 3)
  .addFindingsSection("Critical Issues", "🔴", criticalFindings)
  .addFindingsSection("Suggestions", "🟡", suggestions)
  .addPositiveNotes(["Clean separation of concerns", "Good error messages"])
  .addFollowupPrompt("Ready for review after addressing critical issues.")
  .build();

stream.markdown(response);
```

---

### Decision 9: Emoji Design System Constants (UX-Driven)

**Decision:** Centralize all emoji constants in `chatEmoji.ts` for consistency

**Rationale:**

- UX specification defines specific emoji for severity (🔴🟡✅) and activity (💭🔍📂)
- Emoji must be distinguishable by shape for accessibility
- Single source of truth prevents inconsistency across handlers
- Enables easy updates if emoji choices change

**Implementation:**

```typescript
// src/config/chatEmoji.ts

/**
 * Severity indicators - distinguishable by shape (circle vs checkmark)
 */
export const SEVERITY = {
  critical: "🔴", // Red circle - stop and fix
  suggestion: "🟡", // Yellow circle - consider improving
  success: "✅", // Checkmark - positive confirmation
  warning: "⚠️", // Triangle - caution needed
} as const;

/**
 * Activity indicators - shown during analysis
 */
export const ACTIVITY = {
  thinking: "💭", // AI reasoning process
  searching: "🔍", // Finding symbols, definitions
  reading: "📂", // File operations
  analyzing: "🔎", // Deep code inspection
} as const;

/**
 * Section markers for consistent categorization
 */
export const SECTION = {
  security: "🔒", // Security findings
  testing: "🧪", // Testing suggestions
  summary: "📊", // Summary statistics
  files: "📁", // File listings
} as const;

export type SeverityType = keyof typeof SEVERITY;
export type ActivityType = keyof typeof ACTIVITY;
export type SectionType = keyof typeof SECTION;
```

**Design Rules:**

1. All emoji MUST be distinguishable by shape (not just color) for accessibility
2. Emoji MUST appear at START of lines for scannability
3. One emoji per concept (no mixing severity with activity)
4. Use Unicode emoji for cross-platform consistency

---

### Decision 10: Streaming Debounce Pattern (UX-Driven)

**Decision:** Implement `DebouncedStreamHandler` to limit updates to 10/second

**Rationale:**

- NFR-002 requires debounced updates to prevent UI flicker
- UX specification mandates max 10 updates/second
- Preserves important updates while reducing noise
- Decorator pattern wraps any ToolCallHandler implementation

**Implementation:**

```typescript
// src/handlers/debouncedStreamHandler.ts
import { ToolCallHandler } from "../models/toolCallHandler";

export class DebouncedStreamHandler implements ToolCallHandler {
  private lastUpdate = 0;
  private readonly minIntervalMs = 100; // 10 updates/sec max
  private pendingProgress: string | undefined;

  constructor(private readonly innerHandler: ToolCallHandler) {}

  onProgress(message: string): void {
    const now = Date.now();
    if (now - this.lastUpdate >= this.minIntervalMs) {
      this.innerHandler.onProgress(message);
      this.lastUpdate = now;
      this.pendingProgress = undefined;
    } else {
      // Store for potential flush
      this.pendingProgress = message;
    }
  }

  // Other methods pass through immediately - only progress is debounced
  onToolStart(toolName: string, args: Record<string, unknown>): void {
    this.flushPending();
    this.innerHandler.onToolStart(toolName, args);
  }

  onToolComplete(toolName: string, success: boolean, summary: string): void {
    this.flushPending();
    this.innerHandler.onToolComplete(toolName, success, summary);
  }

  onFileReference(filePath: string, range?: vscode.Range): void {
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

  private flushPending(): void {
    if (this.pendingProgress) {
      this.innerHandler.onProgress(this.pendingProgress);
      this.pendingProgress = undefined;
      this.lastUpdate = Date.now();
    }
  }

  /**
   * Call at end of analysis to ensure final message is sent
   */
  flush(): void {
    this.flushPending();
  }
}
```

**Usage:**

```typescript
// In ChatParticipantService
const baseHandler = new ChatStreamHandler(stream);
const debouncedHandler = new DebouncedStreamHandler(baseHandler);

await conversationRunner.run(
  config,
  conversationManager,
  token,
  debouncedHandler
);

debouncedHandler.flush(); // Ensure final message sent
```

---

### Decision 11: Hybrid Output Approach

**Decision:** Use ChatResponseBuilder for extension-generated messages only; stream LLM output as-is

**Rationale:**

- LLM output format cannot be guaranteed, especially with smaller models (GPT-4o-mini, Claude Haiku)
- Tool calling is unreliable across model sizes - some models skip tool calls entirely
- Parsing LLM output is fragile and breaks when models don't comply with format instructions
- We should control what we can and influence what we can't

**What We Control (ChatResponseBuilder):**

| Message Type         | Controller | Method                         |
| -------------------- | ---------- | ------------------------------ |
| Opening/intro        | Extension  | ChatResponseBuilder            |
| Progress updates     | Extension  | DebouncedStreamHandler + emoji |
| Error messages       | Extension  | ChatResponseBuilder            |
| Cancellation message | Extension  | ChatResponseBuilder            |
| Closing summary      | Extension  | ChatResponseBuilder            |
| Follow-up chips      | Extension  | ChatFollowupProvider           |

**What LLM Controls (streamed as-is):**

| Message Type       | Controller | Influence Method            |
| ------------------ | ---------- | --------------------------- |
| Analysis findings  | LLM        | System prompt (best effort) |
| Issue explanations | LLM        | System prompt (best effort) |
| Code suggestions   | LLM        | System prompt (best effort) |

**Implementation Pattern:**

```typescript
// In ChatParticipantService
async handleBranchCommand(request, stream, token) {
  // 1. OUR FORMATTED INTRO (ChatResponseBuilder)
  const intro = new ChatResponseBuilder()
    .addVerdictLine('issues', `Analyzing ${branchName}...`)
    .addSummaryStats(changedFiles.length, 0, 0)
    .build();
  stream.markdown(intro);

  // 2. Progress events (DebouncedStreamHandler + chatEmoji)
  handler.onProgress(`${ACTIVITY.reading} Reading changed files...`);

  // 3. LLM ANALYSIS (streamed as-is, no ChatResponseBuilder)
  for await (const chunk of llmResponse) {
    stream.markdown(chunk);
  }

  // 4. OUR FORMATTED CLOSING (ChatResponseBuilder)
  const closing = new ChatResponseBuilder()
    .addFollowupPrompt('Analysis complete.')
    .build();
  stream.markdown(closing);
}
```

**Alternatives Rejected:**

- **Report Tools approach:** LLM calls tools to report findings - unreliable with smaller models
- **Post-processing markers:** Parse LLM output for markers - fragile, markers visible on failure
- **Prompt engineering only:** Hope LLM follows format - inconsistent, especially with smaller models

---

### Decision 12: Context Window Management Strategy

**Decision:** Implement sliding-window token budget tracking with newest-first priority

**Rationale:**

- VS Code Chat Participant API provides full history without truncation
- Extensions are fully responsible for context window management
- Copilot Chat summarizes ALL turns (including participant turns) uniformly when context overflows
- When summarized, participant attribution is LOST - summaries don't preserve "who said what"
- We cannot rely on Copilot's summarization to preserve our analysis context

**Token Budget Strategy:**

```typescript
// In ChatContextManager
class ChatContextManager {
  private readonly OUTPUT_RESERVE = 4000;
  private readonly BUDGET_THRESHOLD = 0.8; // 80%

  async prepareHistory(
    history: ChatRequestTurn[],
    model: LanguageModelChat,
    systemPrompt: string,
    diffContext: string
  ): Promise<LanguageModelChatMessage[]> {
    const maxTokens = model.maxInputTokens - this.OUTPUT_RESERVE;
    const targetTokens = maxTokens * this.BUDGET_THRESHOLD;

    // Count fixed costs (always included)
    const systemTokens = await model.countTokens(systemPrompt);
    const diffTokens = await model.countTokens(diffContext);
    const availableForHistory = targetTokens - systemTokens - diffTokens;

    // Include history newest-first until budget exhausted
    const includedHistory: LanguageModelChatMessage[] = [];
    let usedTokens = 0;

    for (let i = history.length - 1; i >= 0; i--) {
      const turnTokens = await model.countTokens(history[i].prompt);
      if (usedTokens + turnTokens > availableForHistory) {
        Log.info("ChatContextManager", `Truncating history at turn ${i}`);
        break;
      }
      includedHistory.unshift(this.convertTurn(history[i]));
      usedTokens += turnTokens;
    }

    return includedHistory;
  }
}
```

**Priority Order (highest to lowest):**

1. System prompt (always included)
2. Current diff context (always included)
3. Current user request (always included)
4. Recent conversation history (newest first, until budget exhausted)
5. Older conversation history (dropped first)

**Copilot Summarization Behavior (Research Findings):**

| Behavior                                 | Implication for Lupa                         |
| ---------------------------------------- | -------------------------------------------- |
| Summarizes ALL turns uniformly           | Our participant responses get summarized too |
| Attribution lost in summaries            | Can't tell what we said vs what Copilot said |
| `isSticky: true` has no special handling | Same summarization regardless of sticky mode |
| Threshold-based triggering               | Happens when context exceeds model limits    |

**Alternatives Considered:**

- **LLM-based summarization:** Adds latency, unreliable with smaller models
- **Turn count limit:** Simpler but ignores actual token usage
- **Rely on Copilot summarization:** Attribution lost, can't control what's preserved

---

### Decision Impact Analysis

**Implementation Sequence:**

1. Create `ILLMClient` interface and `ModelRequestHandler`
2. Modify `CopilotModelManager` to implement `ILLMClient`
3. Create `ChatLLMClient`
4. Modify `ConversationRunner` to accept `ILLMClient`
5. Create `ChatParticipantService` with handlers
6. Create `LanguageModelToolProvider`
7. Update `ServiceManager` Phase 4
8. Update `package.json` contributions
9. Write tests

**Cross-Component Dependencies:**

```
ILLMClient ← ChatLLMClient
           ← CopilotModelManager

ConversationRunner ← ILLMClient (injected)

ChatParticipantService ← ChatLLMClient (creates)
                       ← ConversationRunner (creates)
                       ← ToolExecutor (injected)
                       ← PromptGenerator (uses)
```

---

## Implementation Patterns & Consistency Rules

### Naming Patterns

**File Naming:**

| Type      | Pattern                       | Example                     |
| --------- | ----------------------------- | --------------------------- |
| Service   | camelCase.ts                  | `chatParticipantService.ts` |
| Interface | PascalCase.ts with 'I' prefix | `ILLMClient.ts`             |
| Test      | \*.test.ts                    | `chatParticipant.test.ts`   |
| Type file | camelCase.ts                  | `chatTypes.ts`              |

**Class/Interface Naming:**

| Type      | Pattern                 | Example                  |
| --------- | ----------------------- | ------------------------ |
| Service   | PascalCase + Service    | `ChatParticipantService` |
| Interface | 'I' prefix + PascalCase | `ILLMClient`             |
| Type      | PascalCase              | `ChatAnalysisMetadata`   |
| Handler   | PascalCase + Handler    | `ChatStreamHandler`      |

**Method Naming:**

| Type           | Pattern           | Example             |
| -------------- | ----------------- | ------------------- |
| Public         | camelCase         | `sendRequest()`     |
| Async          | No special suffix | `getCurrentModel()` |
| Event handlers | on + Event        | `onProgress()`      |

### Structure Patterns

**Service Pattern:**

```typescript
export class ChatParticipantService implements vscode.Disposable {
  private static instance: ChatParticipantService | undefined;
  private disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly toolExecutor: ToolExecutor,
    private readonly promptGenerator: PromptGenerator
  ) {}

  static getInstance(/* deps */): ChatParticipantService {
    if (!ChatParticipantService.instance) {
      ChatParticipantService.instance = new ChatParticipantService(/* deps */);
    }
    return ChatParticipantService.instance;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    ChatParticipantService.instance = undefined;
  }
}
```

**Tool Pattern (for Agent Mode tool):**

```typescript
// Wrap existing tool for Agent Mode registration
export class LanguageModelToolProvider implements vscode.Disposable {
  private registration: vscode.Disposable | undefined;

  register(): void {
    this.registration = vscode.lm.registerTool("lupa_getSymbolsOverview", {
      invoke: async (options, token) => {
        const tool = new GetSymbolsOverviewTool();
        const result = await tool.execute(
          options.input as { filePath: string }
        );
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(JSON.stringify(result)),
        ]);
      },
    });
  }
}
```

### Format Patterns

**Tool Results:**

```typescript
import { toolSuccess, toolError } from '../types/toolResultTypes';

// Success
return toolSuccess({ symbols: [...] });

// Error
return toolError('File not found');
```

**Logging:**

```typescript
import { Log } from "../services/loggingService";

// Use Log, NOT console.log
Log.info("ChatParticipantService", "Processing /branch command");
Log.error("ChatParticipantService", "Analysis failed", error);
```

**Type Parameters:**

```typescript
// CORRECT: Explicit undefined
function analyze(diff: string | undefined): Promise<Result>;

// INCORRECT: Optional parameter
function analyze(diff?: string): Promise<Result>;
```

### Markdown Formatting Patterns (UX-Driven)

**Hierarchy Specification (from UX Design Spec):**

| Level       | Markdown          | Usage                    |
| ----------- | ----------------- | ------------------------ |
| Section     | `##`              | Major response sections  |
| Sub-section | `###`             | Individual findings      |
| Title       | `**bold**`        | Issue titles, emphasis   |
| Note        | `*italic*`        | Asides, clarifications   |
| Symbol      | `` `backticks` `` | Code symbols, file names |
| Code        | ` ``` `           | Multi-line code blocks   |

**Response Structure Pattern:**

```markdown
## [Emoji] Section Title (Count)

Brief context or summary paragraph.

### [Emoji] **Finding Title** in [file.ts](file.ts#L42)

Explanation of the issue with enough context to understand...

---

✅ Summary: X files analyzed, Y issues found

[Follow-up 1] [Follow-up 2] [Follow-up 3]
```

**Tone Guidelines (Emotional Design):**

| Scenario    | ❌ Don't Say                    | ✅ Do Say                                        |
| ----------- | ------------------------------- | ------------------------------------------------ |
| Issue found | "Error: Bad code detected"      | "Potential issue: Consider reviewing..."         |
| Severe bug  | "Critical mistake in your code" | "🔴 Important: This could cause..."              |
| No issues   | "No errors"                     | "✅ Looking good! No critical issues found."     |
| Cancelled   | "Aborted"                       | "Analysis paused. Here's what I found so far..." |

**Progress Message Voice Pattern:**

| State     | Format             | Example                                 |
| --------- | ------------------ | --------------------------------------- |
| Starting  | Verb + scope       | "Starting analysis of feature/oauth..." |
| Reading   | 📂 + path          | "📂 Reading src/auth/handler.ts..."     |
| Searching | 🔍 + target        | "🔍 Finding AuthHandler definitions..." |
| Analyzing | Count + target     | "Analyzing 3 usages..."                 |
| Thinking  | 💭 + consideration | "💭 Considering security..."            |

### Communication Patterns

**Progress Handler Interface:**

```typescript
export interface ToolCallHandler {
  onProgress(message: string): void;
  onToolStart(toolName: string, args: Record<string, unknown>): void;
  onToolComplete(toolName: string, success: boolean, summary: string): void;
  onFileReference(filePath: string, range?: vscode.Range): void;
  onThinking(thought: string): void;
  onMarkdown(content: string): void;
}
```

**Streaming Debounce (max 10 updates/sec):**

```typescript
class DebouncedStreamHandler implements ToolCallHandler {
  private lastUpdate = 0;
  private readonly minInterval = 100; // 10 updates/sec

  onProgress(message: string): void {
    const now = Date.now();
    if (now - this.lastUpdate >= this.minInterval) {
      this.stream.progress(message);
      this.lastUpdate = now;
    }
  }
}
```

### Process Patterns

**Service Initialization (ServiceManager Phase 4):**

```typescript
// In ServiceManager.initialize()
private async initializePhase4(): Promise<void> {
  // ... existing services

  // New services for chat participant
  this.chatParticipantService = ChatParticipantService.getInstance(
    this.toolExecutor,
    this.promptGenerator
  );

  this.languageModelToolProvider = new LanguageModelToolProvider();
  this.languageModelToolProvider.register();
}
```

**Testing Pattern:**

```typescript
// src/__tests__/chatParticipant.test.ts
import { describe, it, expect, vi } from "vitest";

// VS Code is mocked via __mocks__/vscode.js
describe("ChatParticipantService", () => {
  it("should route /branch command", async () => {
    // Test implementation
  });
});
```

### Enforcement Guidelines

**All AI Agents MUST:**

1. Use `ILLMClient` interface for LLM access, never concrete classes
2. Implement `ToolCallHandler` for progress streaming
3. Use `toolSuccess()`/`toolError()` for tool return values
4. Use `Log` from loggingService, not `console.log`
5. Follow 4-phase service initialization in ServiceManager
6. Add `vscode.Disposable` implementation to all services
7. Use emoji constants from `chatEmoji.ts`, never hardcode emoji (UX)
8. Use `ChatResponseBuilder` for all analysis response formatting (UX)
9. Wrap handlers with `DebouncedStreamHandler` to limit updates (UX)
10. Follow tone guidelines: supportive, not judgmental (UX)

---

## Project Structure & Boundaries

### Complete Project Directory Structure (New Files Only)

```
src/
├── config/
│   └── chatEmoji.ts                     # NEW: Emoji constants (UX-driven)
│
├── models/
│   ├── ILLMClient.ts                    # NEW: Interface definition
│   ├── chatLLMClient.ts                 # NEW: Wraps request.model
│   ├── modelRequestHandler.ts           # NEW: Extracted message conversion
│   ├── debouncedStreamHandler.ts        # NEW: Rate-limited handler (UX-driven)
│   ├── chatStreamHandler.ts             # NEW: Implements ToolCallHandler for chat
│   ├── conversationRunner.ts            # MODIFIED: Takes ILLMClient
│   └── copilotModelManager.ts           # MODIFIED: Implements ILLMClient
│
├── services/
│   ├── chatParticipantService.ts        # NEW: Chat participant registration
│   ├── languageModelToolProvider.ts     # NEW: Agent Mode tool registration
│   └── serviceManager.ts                # MODIFIED: Register new services
│
├── types/
│   └── chatTypes.ts                     # NEW: Chat-specific types
│
├── utils/
│   └── chatResponseBuilder.ts           # NEW: Response formatting (UX-driven)
│
├── __tests__/
│   ├── chatParticipant.test.ts          # NEW: Integration tests
│   ├── chatLLMClient.test.ts            # NEW: Unit tests
│   ├── chatResponseBuilder.test.ts      # NEW: Response formatting tests (UX)
│   ├── debouncedStreamHandler.test.ts   # NEW: Debouncing tests (UX)
│   └── chatEmoji.test.ts                # NEW: Emoji constant tests (UX)
│
└── package.json                         # MODIFIED: Add contributions
```

### Architectural Boundaries

```
┌──────────────────────────────────────────────────────────────────┐
│                      PRESENTATION LAYER                           │
│  ┌──────────────────────────┐    ┌─────────────────────────────┐ │
│  │ ChatParticipantService   │    │ Webview (React)             │ │
│  │ • /branch, /changes      │    │ • Existing command path     │ │
│  │ • Streaming to chat      │    │ • Result object display     │ │
│  │ • Creates ChatLLMClient  │    │                             │ │
│  └────────────┬─────────────┘    └──────────────┬──────────────┘ │
└───────────────┼──────────────────────────────────┼───────────────┘
                │                                   │
                ▼                                   ▼
┌───────────────────────────────────────────────────────────────────┐
│                       SERVICE LAYER                                │
│                                                                    │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │            ToolCallingAnalysisProvider                       │  │
│  │  • Diff processing     • Uses CopilotModelManager           │  │
│  │  • Webview output      • Returns result object              │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                    │
└───────────────────────────────────────────────────────────────────┘
                │
                ▼
┌───────────────────────────────────────────────────────────────────┐
│                       MODEL LAYER                                  │
│                                                                    │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │              ConversationRunner (SHARED 100%)                │  │
│  │              Constructor: (client: ILLMClient, ...)          │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  ┌─────────────────────┐         ┌────────────────────────────┐   │
│  │   ChatLLMClient     │         │   CopilotModelManager      │   │
│  │ implements ILLMClient│         │ implements ILLMClient      │   │
│  │ • Wraps request.model│         │ • Model selection/caching │   │
│  │ • Per-request       │         │ • Settings-based          │   │
│  └─────────────────────┘         └────────────────────────────┘   │
│                                                                    │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │              ModelRequestHandler (SHARED)                    │  │
│  │              • Message conversion • Request handling         │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                    │
└───────────────────────────────────────────────────────────────────┘
                │
                ▼
┌───────────────────────────────────────────────────────────────────┐
│                       TOOL LAYER (SHARED)                          │
│                                                                    │
│  ToolExecutor → All Tools (FindSymbol, ReadFile, ListDir, etc.)   │
│                                                                    │
│  LanguageModelToolProvider → Wraps GetSymbolsOverviewTool         │
│                              for Agent Mode                        │
└───────────────────────────────────────────────────────────────────┘
```

### Requirements to Structure Mapping

| Requirement Category            | Implementation Location                             |
| ------------------------------- | --------------------------------------------------- |
| FR-001 to FR-003 (Registration) | `package.json` + `ChatParticipantService`           |
| FR-010 to FR-012 (Commands)     | `ChatParticipantService.handleRequest()`            |
| FR-020 to FR-023 (Streaming)    | `ChatStreamHandler` + `DebouncedStreamHandler`      |
| FR-030 to FR-033 (Follow-ups)   | `ChatParticipantService.followupProvider`           |
| FR-050 to FR-052 (Agent Mode)   | `LanguageModelToolProvider`                         |
| NFR Performance                 | `DebouncedStreamHandler`, ConversationRunner limits |
| NFR Reliability                 | Error handling, CancellationToken                   |
| NFR Usability                   | Rich stream methods (anchor, reference, filetree)   |
| UX Streaming Patterns           | `DebouncedStreamHandler`, progress message voice    |
| UX Response Structure           | `ChatResponseBuilder`, finding card patterns        |
| UX Emoji System                 | `chatEmoji.ts` constants                            |
| UX Emotional Design             | Tone guidelines in format patterns                  |
| UX Accessibility                | Shape-based emoji, heading hierarchy rules          |

### Integration Points

**Internal Communication:**

```
ChatParticipantService
    ↓ creates
ChatLLMClient(request.model)
    ↓ implements
ILLMClient
    ↓ used by
ConversationRunner
    ↓ uses
ToolExecutor
    ↓ executes
All Tools (FindSymbol, ReadFile, etc.)
```

**External Integrations:**

| Integration   | API                                   | Direction           |
| ------------- | ------------------------------------- | ------------------- |
| VS Code Chat  | `vscode.chat.createChatParticipant()` | Extension → VS Code |
| Copilot Model | `request.model`                       | VS Code → Extension |
| Agent Mode    | `vscode.lm.registerTool()`            | Extension → VS Code |
| Git           | `GitOperations`                       | Extension → Git CLI |

---

## Architecture Validation Results

### Coherence Validation ✅

**Decision Compatibility:**

- All technology choices work together (TypeScript, Vite, Vitest)
- ILLMClient interface enables both CopilotModelManager and ChatLLMClient
- ConversationRunner is model-agnostic (works with any ILLMClient)
- No contradictory decisions identified

**Pattern Consistency:**

- Service pattern followed (vscode.Disposable, getInstance)
- Tool pattern unchanged (BaseTool, Zod schema)
- Naming conventions aligned (camelCase files, PascalCase classes)
- Communication patterns unified (ToolCallHandler callbacks)

**Structure Alignment:**

- New files fit existing directory structure
- Phase 4 service registration is appropriate
- No new circular dependencies introduced

### Requirements Coverage Validation ✅

**Functional Requirements:**
| Requirement | Coverage |
|-------------|----------|
| FR-001 to FR-003 (Registration) | ✅ ChatParticipantService handles |
| FR-010 to FR-012 (Commands) | ✅ Routing in handleRequest() |
| FR-020 to FR-023 (Streaming) | ✅ ChatResponseStream integration |
| FR-030 to FR-033 (Follow-ups) | ✅ ChatFollowupProvider implementation |
| FR-050 to FR-052 (Agent Mode) | ✅ LanguageModelToolProvider handles |

**Non-Functional Requirements:**
| Requirement | Coverage |
|-------------|----------|
| NFR Performance | ✅ Streaming ensures fast first response |
| NFR Reliability | ✅ Error handling via ChatResult.errorDetails |
| NFR Usability | ✅ Rich progress, clickable references |
| NFR Compatibility | ✅ No proposed APIs, stable VS Code API only |

**UX Design Specification Requirements (NEW):**
| UX Category | Coverage |
|-------------|----------|
| Streaming Patterns | ✅ `DebouncedStreamHandler` limits to 10 updates/sec |
| Response Structure | ✅ `ChatResponseBuilder` implements verdict-first pattern |
| Emoji Design System | ✅ `chatEmoji.ts` centralizes all emoji constants |
| Follow-up Patterns | ✅ Contextual chips via `ChatFollowupProvider` |
| Accessibility | ✅ Shape-based emoji selection documented |
| Emotional Design | ✅ Tone guidelines in format patterns section |
| Finding Card Pattern | ✅ Markdown structure pattern documented |
| Progress Message Voice | ✅ Voice pattern with examples provided |
| Error Message Pattern | ✅ Supportive tone guidelines included |
| User Journey Flows | ✅ All 6 flows supported by architecture |

### Implementation Readiness Validation ✅

**Decision Completeness:**

- ✅ All critical decisions documented with rationale
- ✅ Implementation patterns comprehensive and consistent
- ✅ Examples provided for all major patterns

**Structure Completeness:**

- ✅ Complete directory structure defined
- ✅ All new files specified with purpose
- ✅ Modified files identified with changes

**Pattern Completeness:**

- ✅ Naming conventions established
- ✅ Service pattern documented
- ✅ Communication patterns specified
- ✅ Error handling patterns defined

### Architecture Completeness Checklist

**✅ Requirements Analysis**

- [x] Project context thoroughly analyzed
- [x] Scale and complexity assessed (MEDIUM-HIGH)
- [x] Technical constraints identified (no proposed APIs)
- [x] Cross-cutting concerns mapped (streaming, cancellation, errors)

**✅ Architectural Decisions**

- [x] ILLMClient interface for Dependency Inversion
- [x] ModelRequestHandler extraction for DRY
- [x] ToolCallHandler pattern for streaming
- [x] Follow-up provider strategy documented
- [x] Agent Mode tool registration specified

**✅ Implementation Patterns**

- [x] Naming conventions established
- [x] Structure patterns defined
- [x] Communication patterns specified
- [x] Process patterns documented

**✅ Project Structure**

- [x] Complete directory structure defined
- [x] Component boundaries established
- [x] Integration points mapped
- [x] Requirements to structure mapping complete

### Architecture Readiness Assessment

**Overall Status:** READY FOR IMPLEMENTATION ✅

**Confidence Level:** HIGH

**Key Strengths:**

1. 100% ConversationRunner reuse via ILLMClient abstraction
2. Minimal new code (~300 lines excluding tests)
3. Leverages battle-tested existing components
4. Clear separation of concerns
5. SOLID principles applied (especially Dependency Inversion)
6. UX Design Specification fully integrated (NEW)
7. Emoji design system ensures accessibility (NEW)
8. Response formatting enforces emotional design goals (NEW)

**Areas for Future Enhancement:**

1. Exploration mode prompts could be optimized after user feedback
2. Follow-up suggestions could become more context-aware
3. Progress debouncing interval could be tuned based on UX testing
4. ChatResponseBuilder patterns could expand based on usage

---

## Architecture Completion Summary

### Workflow Completion

**Architecture Decision Workflow:** COMPLETED ✅ (Revised December 16, 2025)
**Total Steps Completed:** 8
**Original Completion:** December 15, 2025
**Revision Date:** December 16, 2025
**Revision Reason:** Incorporated UX Design Specification requirements
**Document Location:** `docs/architecture.md`

### Revision Summary (December 16, 2025)

**Added UX Design Specification as Input Document:**

- 14 completed workflow steps from UX spec analyzed
- 50+ UX patterns mapped to architectural components

**New Architectural Decisions Added:**
| Decision | Description | Implementation |
|----------|-------------|----------------|
| Decision 8 | Response Formatting Pattern | `ChatResponseBuilder` utility |
| Decision 9 | Emoji Design System | `chatEmoji.ts` constants |
| Decision 10 | Streaming Debounce | `DebouncedStreamHandler` |

**New Files Added to Structure:**

- `src/config/chatEmoji.ts` - Emoji constants
- `src/utils/chatResponseBuilder.ts` - Response formatting
- `src/models/debouncedStreamHandler.ts` - Rate limiting
- `src/models/chatStreamHandler.ts` - Chat handler implementation
- 3 new test files for UX components

**New Enforcement Guidelines:**

- Use emoji constants from `chatEmoji.ts`
- Use `ChatResponseBuilder` for response formatting
- Wrap handlers with `DebouncedStreamHandler`
- Follow tone guidelines (supportive, not judgmental)

### Final Architecture Deliverables

**📋 Complete Architecture Document**

- All architectural decisions documented with specific rationale
- Implementation patterns ensuring AI agent consistency
- Complete project structure with all files and directories
- Requirements to architecture mapping (including UX)
- Validation confirming coherence and completeness

**🏗️ Implementation Ready Foundation**

- 10 architectural decisions made (7 original + 3 UX-driven)
- 10 enforcement guidelines (6 original + 4 UX-driven)
- 12+ new/modified files specified
- 17 functional requirements fully supported
- 50+ UX patterns fully supported

### Implementation Handoff

**For AI Agents:**

This architecture document is your complete guide for implementing the `@lupa` chat participant feature. Follow all decisions, patterns, and structures exactly as documented.

**First Implementation Priority:**

```bash
# No starter template needed - brownfield project
# First implementation story: Create ILLMClient interface
```

**Development Sequence:**

1. Create `ILLMClient` interface and `ModelRequestHandler`
2. Modify `CopilotModelManager` to implement `ILLMClient`
3. Create `ChatLLMClient`
4. Modify `ConversationRunner` to accept `ILLMClient`
5. Create `chatEmoji.ts` constants (UX foundation)
6. Create `ChatResponseBuilder` utility (UX formatting)
7. Create `ChatStreamHandler` and `DebouncedStreamHandler` (UX streaming)
8. Create `ChatParticipantService` with handlers
9. Create `LanguageModelToolProvider`
10. Update `ServiceManager` Phase 4
11. Update `package.json` contributions
12. Write tests (including UX component tests)

### Quality Assurance Checklist

**✅ Architecture Coherence**

- [x] All decisions work together without conflicts
- [x] Technology choices are compatible
- [x] Patterns support the architectural decisions
- [x] Structure aligns with all choices

**✅ Requirements Coverage**

- [x] All functional requirements are supported
- [x] All non-functional requirements are addressed
- [x] Cross-cutting concerns are handled
- [x] Integration points are defined

**✅ UX Design Specification Coverage (NEW)**

- [x] Streaming patterns implemented via DebouncedStreamHandler
- [x] Response structure enforced via ChatResponseBuilder
- [x] Emoji design system centralized in chatEmoji.ts
- [x] Follow-up patterns supported by ChatFollowupProvider
- [x] Accessibility requirements documented (shape-based emoji)
- [x] Emotional design guidelines in format patterns
- [x] All 6 user journey flows architecturally supported

**✅ Implementation Readiness**

- [x] Decisions are specific and actionable
- [x] Patterns prevent agent conflicts
- [x] Structure is complete and unambiguous
- [x] Examples are provided for clarity

---

**Architecture Status:** READY FOR IMPLEMENTATION ✅

**Revision History:**
| Date | Version | Changes |
|------|---------|---------|
| 2025-12-15 | 1.0 | Initial architecture document |
| 2025-12-16 | 1.1 | Incorporated UX Design Specification (Decisions 8-10, format patterns, 6 new files) |
| 2025-12-16 | 1.2 | Added Decisions 11-12: Hybrid Output Approach, Context Window Management Strategy |

**Next Phase:** Begin implementation using the architectural decisions and patterns documented herein.

**Document Maintenance:** Update this architecture when major technical decisions are made during implementation.
