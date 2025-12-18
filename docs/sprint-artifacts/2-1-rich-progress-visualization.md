# Story 2.1: Rich Progress Visualization

**Status:** Done
**Epic:** 2 - Rich UX & Agent Mode Integration
**Story ID:** 2.1
**Estimated Effort:** M (1-2 days)
**Created:** 2025-12-17

---

## Story

**As a** developer using `@lupa`,
**I want to** see detailed, consistent progress and error messages during analysis,
**So that** I understand what Lupa is doing and receive professional, emotionally supportive feedback.

---

## Acceptance Criteria

### AC-2.1.1: ChatToolCallHandler Interface (CLARIFICATION)

**Given** the architecture defines two separate handler interfaces
**When** implementing rich progress
**Then** understand the dual-interface architecture:

| Interface             | Location                | Purpose                                          |
| --------------------- | ----------------------- | ------------------------------------------------ |
| `ToolCallHandler`     | `conversationRunner.ts` | Internal conversation state (recording, metrics) |
| `ChatToolCallHandler` | `chatTypes.ts`          | UI streaming abstraction (progress, markdown)    |

**Note:** AC-2.1.1 in epics.md incorrectly names the interface as "ToolCallHandler" but describes `ChatToolCallHandler`. The `ChatToolCallHandler` interface is **already implemented** with these methods:

- `onProgress(message: string): void`
- `onToolStart(toolName: string, args: Record<string, unknown>): void`
- `onToolComplete(toolName: string, success: boolean, summary: string): void`
- `onFileReference(filePath: string, range?: vscode.Range): void`
- `onThinking(thought: string): void`
- `onMarkdown(content: string): void`

**No changes to ChatToolCallHandler interface required.**

### AC-2.1.2: File References with Anchors (Existing Infrastructure)

**Given** tool calls reference files in their results
**When** ConversationRunner processes tool outputs
**Then**:

- `stream.anchor()` is available via `onFileReference()` callback
- `stream.reference()` is available for file-only references with icons

**Note:** The infrastructure exists via `ChatToolCallHandler.onFileReference()`. Currently not actively called by the adapter—enhancement opportunity if time permits but NOT required for MVP.

### AC-2.1.3: Debounced Updates with DebouncedStreamHandler (DONE)

**Given** rapid progress updates and NFR-002 (max 10 updates/second)
**When** streaming to chat
**Then** `ChatStreamHandler` MUST be wrapped with `DebouncedStreamHandler`

**Note:** **Already implemented in Story 1.2.** The three-layer architecture is in place:

```
UI Handler (ChatToolCallHandler) → DebouncedStreamHandler → ToolCallStreamAdapter → ConversationRunner
```

**No changes required for this AC.**

### AC-2.1.4: Changed Files Tree

**Given** the diff has been parsed
**When** starting analysis
**Then** `stream.filetree()` MUST display changed files

**Implementation:** Task 10 - Add `stream.filetree()` call after `parsedDiff` is created. Transform `DiffHunk[]` to `ChatResponseFileTree[]` structure.

### AC-2.1.5: Progress Message Voice Pattern (UX-FR-004)

**Given** the UX specification defines progress message voice
**When** streaming progress via `ToolCallStreamAdapter`
**Then** messages MUST follow these patterns:

| State             | Format                               | Emoji                |
| ----------------- | ------------------------------------ | -------------------- |
| Iteration start   | (Removed per UX decision)            | N/A                  |
| Reading file      | `📂 Reading {filepath}...`           | `ACTIVITY.reading`   |
| Searching symbols | `🔍 Finding {symbol} definitions...` | `ACTIVITY.searching` |
| Analyzing usages  | `🔎 Analyzing {count} usages...`     | `ACTIVITY.analyzing` |
| Thinking          | `💭 Considering {aspect}...`         | `ACTIVITY.thinking`  |

**Implementation:** Task 11 - Update `ToolCallHandler.onToolCallStart` signature to pass args, then format tool-specific messages in `ToolCallStreamAdapter`.

### AC-2.1.6: ChatStreamHandler Implementation (CLARIFICATION)

**Given** the need to stream analysis output to chat
**When** implementing `ChatStreamHandler`
**Then**:

**CLARIFICATION:** A dedicated `ChatStreamHandler` class is **NOT required**. The existing inline handler in `chatParticipantService.ts` serves this purpose:

```typescript
const uiHandler: ChatToolCallHandler = {
  onProgress: (msg) => stream.progress(msg),
  onToolStart: () => {},
  onToolComplete: () => {},
  onFileReference: () => {},
  onThinking: (thought) => stream.progress(`${ACTIVITY.thinking} ${thought}`),
  onMarkdown: (content) => stream.markdown(content),
};
```

**Focus instead on AC-2.1.8 (ChatResponseBuilder migration) for extension-generated messages.**

### AC-2.1.7: Empty State Handling (UX-FR-007)

**Given** no issues are found during analysis
**When** streaming results
**Then** output MUST use positive framing

**Current Implementation (chatParticipantService.ts line 157):**

```typescript
stream.markdown(`## ${SEVERITY.success} No Changes Found\n\n${message}`);
```

**Migration Target:**

```typescript
const response = new ChatResponseBuilder()
  .addVerdictLine("success", "No Changes Found")
  .addFollowupPrompt(message)
  .build();
stream.markdown(response);
```

### AC-2.1.8: ChatResponseBuilder Migration (CRITICAL - Technical Debt)

**Given** Epic 1 implemented inline string formatting instead of `ChatResponseBuilder`
**When** refactoring `ChatParticipantService`
**Then** the following inline patterns MUST be replaced with `ChatResponseBuilder`:

| Line    | Current Pattern                                     | Migration Target                                       |
| ------- | --------------------------------------------------- | ------------------------------------------------------ |
| 140     | `## ${SEVERITY.warning} Configuration Error...`     | `addErrorSection('Configuration Error', ...)`          |
| 150     | `## ${SEVERITY.warning} Git Not Initialized...`     | `addErrorSection('Git Not Initialized', ...)`          |
| 157     | `## ${SEVERITY.success} No Changes Found...`        | `addVerdictLine('success', ...)`                       |
| 172-173 | `## ${SEVERITY.warning} Analysis Error...\`\`\`...` | `addErrorSection('Analysis Error', ..., errorDetails)` |
| 208-212 | `## 💬 Analysis Cancelled...`                       | `addVerdictLine('cancelled', ...)`                     |

**AND** add new method to `ChatResponseBuilder`:

```typescript
addErrorSection(title: string, message: string, details?: string): this
```

### AC-2.1.9: System Prompt UX Guidelines Update

**Given** the system prompt influences LLM output format
**When** updating `toolAwareSystemPromptGenerator.ts`
**Then** extend the existing `generateOutputFormat()` with:

1. **Tone guidelines** - Supportive, non-judgmental language guidance
2. **Certainty principle** - Exception-based uncertainty flagging
3. **"What's Good" requirement** - Make positive observations mandatory

**CRITICAL: Do NOT Duplicate**

The existing `generateOutputFormat()` already defines:

- Severity levels (🔴 CRITICAL, 🟠 HIGH, 🟡 MEDIUM, 🟢 LOW)
- Finding format with **backtick file references**: `` `src/path/file.ts:42` ``
- Section structure (Summary, Critical Issues, Suggestions, Test Considerations, Positive Observations)

**File Path Format (CRITICAL for webview path detection):**

```
**Location**: `src/path/file.ts:42`
```

NOT markdown links like `[file.ts](file.ts#L42)` - the backtick format is required for path detection.

**Anthropic Prompt Engineering Best Practices Applied:**

| Technique                  | Already Implemented In                                          |
| -------------------------- | --------------------------------------------------------------- |
| **Role Prompting**         | `generateRoleDefinition()` - Staff Engineer role                |
| **XML Tags for Structure** | Throughout prompt - `<output_format>`, `<tool_inventory>`, etc. |
| **Multishot Examples**     | `generateAnalysisGuidance()` - workflow examples                |
| **Chain of Thought**       | `generateSelfReflectionGuidance()` - think*about*\* tools       |

**NEW Content to Add (extend, don't duplicate):**

```xml
<tone_guidelines>
- Be supportive, not judgmental - you're a helpful colleague, not a critic
- Frame issues as "catches" not "failures" - you're helping prevent problems
- Use "Consider..." and "Potential issue:" not "Error" or "Bad code"
- Explain WHY something matters, not just WHAT is wrong
- Provide specific, actionable recommendations
</tone_guidelines>

<certainty_principle>
For VERIFIED findings (tool-confirmed): Report normally.
For UNCERTAIN findings: Add verification callout:

> 🔍 **Verify:** {what context is missing}

Only flag uncertainty when genuinely uncertain.
</certainty_principle>
```

### AC-2.1.10: Exception-Based Certainty Flagging (NEW - Brainstormed)

**Given** the LLM may have varying levels of confidence in its findings
**When** outputting analysis findings
**Then** implement exception-based certainty flagging:

**Design Decision (from Party Mode Brainstorm - December 2025):**

After ultrathink analysis and multi-agent brainstorming (Architect, UX Designer, Developer perspectives), the following approach was selected:

**Core Principle: Flag Uncertainty, Not Confidence**

| Finding Type              | Display                        | Rationale                          |
| ------------------------- | ------------------------------ | ---------------------------------- |
| VERIFIED (tool-confirmed) | Show normally, no extra markup | Silence = confidence; avoids noise |
| UNCERTAIN                 | Prefix with verification note  | Transparent about limitations      |

**Why NOT show confidence on every finding:**

1. LLM self-reported confidence is not calibrated (often overconfident when wrong)
2. Percentages are "confidence theater" - no meaningful probability estimate
3. UI clutter - another field on every finding adds cognitive load
4. Exception-based reporting reduces noise while maintaining transparency

**Implementation Pattern:**

```xml
<certainty_principle>
Before finalizing each finding, ask yourself:
- Did I verify this with tools (find_symbol, find_usages)?
- Could there be context that would change this assessment?

For VERIFIED findings (tool-confirmed), report normally.
For UNCERTAIN findings, use this format:

### 🟡 **Potential Issue Title** in `src/path/file.ts:88`
> 🔍 **Verify:** {what context is missing}

{Description...}
</certainty_principle>
```

**Visual Format (from UX review):**

- Use blockquote callout for verification notes (visually distinct, easy to scan/skip)
- Use 🔍 emoji (different class from severity indicators)
- Action-oriented: "Verify:" not passive "Needs verification"
- Remove redundant ⚠️ from header - severity emoji is sufficient

**Example Uncertain Finding:**

```markdown
### 🟡 **Potential Race Condition** in `src/services/service.ts:88`

> 🔍 **Verify:** Could not determine threading model

This pattern may cause issues under concurrent access. The `processQueue()` method is called from multiple places but lock acquisition was not traced.

**Recommendation:** Check if calling code uses synchronization primitives.
```

**Integration with Existing Tools:**
This principle extends the existing `think_about_context` self-reflection tool. When the LLM calls `think_about_context`, it should identify which findings are tool-verified vs uncertain.

---

## Technical Implementation

### Architecture Context

**Three-Layer Streaming Architecture (from Story 1.2):**

```
┌─────────────────────────────────────────────────────────────────┐
│ ChatParticipantService                                          │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ Layer 1: UI Handler (ChatToolCallHandler)                 │  │
│  │   • inline object in runAnalysis()                        │  │
│  │   • Maps: onProgress→stream.progress()                    │  │
│  │           onMarkdown→stream.markdown()                    │  │
│  └──────────────────────┬────────────────────────────────────┘  │
│                         │                                        │
│  ┌──────────────────────▼────────────────────────────────────┐  │
│  │ Layer 2: DebouncedStreamHandler (decorator)               │  │
│  │   • Rate limits onProgress to 10/sec (NFR-002) ✅ DONE    │  │
│  └──────────────────────┬────────────────────────────────────┘  │
│                         │                                        │
│  ┌──────────────────────▼────────────────────────────────────┐  │
│  │ Layer 3: ToolCallStreamAdapter (adapter)                  │  │
│  │   • Bridges ToolCallHandler → ChatToolCallHandler ✅ DONE │  │
│  └──────────────────────┬────────────────────────────────────┘  │
└─────────────────────────┼────────────────────────────────────────┘
                          ▼
              ConversationRunner.run()
```

### Implementation Priority Order

1. **Add `addErrorSection()` to ChatResponseBuilder** (unblocks migration)
2. **Migrate inline formatting in ChatParticipantService** (5 locations)
3. **Update system prompt with UX guidelines** (influences LLM output)
4. **Add tests for new functionality**

### ChatResponseBuilder Enhancement

**File:** `src/utils/chatResponseBuilder.ts`

**Add method:**

```typescript
/**
 * Adds a styled error section with optional technical details.
 * Uses warning emoji and supportive tone per UX guidelines.
 */
addErrorSection(title: string, message: string, details?: string): this {
    this.sections.push(`## ${SEVERITY.warning} ${title}\n\n${message}`);
    if (details) {
        this.sections.push(`\n\n\`\`\`\n${details}\n\`\`\``);
    }
    this.sections.push('\n');
    return this;
}
```

**Import required:** Add `SEVERITY` import from `../config/chatEmoji`.

### ChatParticipantService Migration

**File:** `src/services/chatParticipantService.ts`

**Add import:**

```typescript
import { ChatResponseBuilder } from "../utils/chatResponseBuilder";
```

**Migration patterns:**

**Configuration Error (line ~140):**

```typescript
// Before:
stream.markdown(
  `## ${SEVERITY.warning} Configuration Error\n\nLupa is still initializing...`
);

// After:
const response = new ChatResponseBuilder()
  .addErrorSection(
    "Configuration Error",
    "Lupa is still initializing. Please try again in a moment."
  )
  .build();
stream.markdown(response);
```

**Git Not Initialized (line ~150):**

```typescript
// Before:
stream.markdown(
  `## ${SEVERITY.warning} Git Not Initialized\n\nCould not find a Git repository...`
);

// After:
const response = new ChatResponseBuilder()
  .addErrorSection(
    "Git Not Initialized",
    "Could not find a Git repository. Please ensure you have a Git repository open."
  )
  .build();
stream.markdown(response);
```

**No Changes Found (line ~157):**

```typescript
// Before:
stream.markdown(`## ${SEVERITY.success} No Changes Found\n\n${message}`);

// After:
const response = new ChatResponseBuilder()
  .addVerdictLine("success", "No Changes Found")
  .addFollowupPrompt(message)
  .build();
stream.markdown(response);
```

**Analysis Error (lines ~172-173):**

```typescript
// Before:
stream.markdown(
  `## ${SEVERITY.warning} Analysis Error\n\nSomething went wrong...\n\n\`\`\`\n${errorMessage}\n\`\`\``
);

// After:
const response = new ChatResponseBuilder()
  .addErrorSection(
    "Analysis Error",
    "Something went wrong during analysis. Please try again.",
    errorMessage
  )
  .build();
stream.markdown(response);
```

**Cancellation (lines ~208-212):**

```typescript
// Before:
stream.markdown(`## 💬 Analysis Cancelled\n\nAnalysis was stopped...`);

// After:
const response = new ChatResponseBuilder()
  .addVerdictLine("cancelled", "Analysis Cancelled")
  .addFollowupPrompt(
    "Analysis was stopped before findings could be generated.\n\n*Run the command again when you're ready.*"
  )
  .build();
stream.markdown(response);
```

### System Prompt UX Guidelines

**File:** `src/prompts/toolAwareSystemPromptGenerator.ts`

**Analysis of Existing Code:**

The file already has `generateOutputFormat()` which defines:

- Severity levels (🔴 CRITICAL, 🟠 HIGH, 🟡 MEDIUM, 🟢 LOW)
- Detailed finding format with `\`src/path/file.ts:42\`` backtick format (CRITICAL for webview path detection)
- Section structure (Summary, Critical Issues, Suggestions by Category, Test Considerations, Positive Observations, Questions)
- Formatting rules

**CRITICAL: File Path Format**

The existing `generateOutputFormat()` uses backtick code format for file references:

```
**Location**: \`src/path/file.ts:42\`
```

This format is **essential** for webview path detection functionality. Any new UX guidelines MUST use the same format, NOT markdown link format like `[file.ts](file.ts#L42)`.

**Implementation Approach: COMPLEMENT, Don't Duplicate**

Instead of creating a separate `generateUXGuidelines()` method that duplicates severity levels and finding formats, the developer should:

1. **Extend `generateOutputFormat()`** with the following NEW content:

   - Tone guidelines (supportive, not judgmental)
   - Certainty principle (exception-based uncertainty flagging)
   - Explicit "What's Good" section requirement

2. **Add to existing output format** (not a separate method):

```xml
<tone_guidelines>
- Be supportive, not judgmental - you're a helpful colleague, not a critic
- Frame issues as "catches" not "failures" - you're helping prevent problems
- Use "Consider..." and "Potential issue:" not "Error" or "Bad code"
- Explain WHY something matters, not just WHAT is wrong
- Provide specific, actionable recommendations
</tone_guidelines>

<certainty_principle>
Before finalizing each finding, verify your certainty:
- Did you confirm this with tools (find_symbol, find_usages)?
- Could there be context that would change this assessment?

For VERIFIED findings (tool-confirmed): Report normally with full confidence.
For UNCERTAIN findings: Add a verification callout:

> 🔍 **Verify:** {what context is missing, e.g., "Could not determine threading model"}

Only flag uncertainty when genuinely uncertain - do NOT add confidence levels to every finding.
</certainty_principle>
```

3. **Modify "Positive Observations" section** to make it mandatory:
   - Change from "What was done well:" to "### 5. What's Good (REQUIRED - never skip)"
   - Add instruction: "Always find at least one positive observation, even in problematic PRs"

**Why NOT a Separate Method:**

| Approach                          | Problem                                                                 |
| --------------------------------- | ----------------------------------------------------------------------- |
| Separate `generateUXGuidelines()` | Duplicates severity levels, finding format; creates conflicting formats |
| Extend `generateOutputFormat()`   | Single source of truth; no format conflicts                             |

**Rationale:** The existing prompt is ~8K tokens. Adding duplicate sections wastes tokens and risks LLM confusion when formats conflict.

````

---

## Tasks / Subtasks

- [x] **Task 1: Add addErrorSection to ChatResponseBuilder** (AC: 2.1.8)

  - [x] Add `SEVERITY` import from `../config/chatEmoji`
  - [x] Implement `addErrorSection(title, message, details?)` method
  - [x] Add JSDoc documentation
  - [x] Run `npm run check-types`

- [x] **Task 2: Migrate Configuration Error** (AC: 2.1.8)

  - [x] Import `ChatResponseBuilder` in chatParticipantService.ts
  - [x] Replace inline formatting at line ~140
  - [x] Verify error display matches expected format

- [x] **Task 3: Migrate Git Not Initialized Error** (AC: 2.1.8)

  - [x] Replace inline formatting at line ~150
  - [x] Verify error display matches expected format

- [x] **Task 4: Migrate No Changes Found** (AC: 2.1.7, 2.1.8)

  - [x] Replace inline formatting at line ~157
  - [x] Use `addVerdictLine('success', ...)` + `addFollowupPrompt()`

- [x] **Task 5: Migrate Analysis Error** (AC: 2.1.8)

  - [x] Replace inline formatting at lines ~172-173
  - [x] Include error details in code block via `addErrorSection()`

- [x] **Task 6: Migrate Cancellation Message** (AC: 2.1.8)

  - [x] Replace inline formatting at lines ~208-212
  - [x] Use `addVerdictLine('cancelled', ...)`

- [x] **Task 7: Extend System Prompt with UX Enhancements** (AC: 2.1.9, 2.1.10)

  - [x] **Analyze existing `generateOutputFormat()`** - understand current structure, severity levels, file path format
  - [x] **CRITICAL: Use backtick file format** - `` `src/path/file.ts:42` `` NOT markdown links (required for webview path detection)
  - [x] **Placement:** Insert `<tone_guidelines>` BEFORE the `### 1. Summary` section (tone should influence entire output)
  - [x] **Placement:** Insert `<certainty_principle>` after `<tone_guidelines>`, also before `### 1. Summary`
  - [x] Add `<tone_guidelines>` section with supportive, non-judgmental language guidance
  - [x] Add `<certainty_principle>` section with exception-based uncertainty flagging
  - [x] Modify "Positive Observations" header to: `### 5. What's Good (REQUIRED - never skip this section)`
  - [x] Add instruction after header: `"Always find at least one positive observation, even in problematic PRs."`
  - [x] **Do NOT duplicate** severity levels, finding format, or section structure already in `generateOutputFormat()`
  - [x] Run `npm run check-types`
  - **Note:** Extend `generateOutputFormat()`, do NOT create separate `generateUXGuidelines()` method
  - **Future:** Backtick format will eventually migrate to markdown links - but that is a SEPARATE story, not this one

- [x] **Task 8: Unit Tests** (All ACs)

  - [x] Test `ChatResponseBuilder.addErrorSection()` output format
  - [x] Test `addErrorSection()` with and without details parameter
  - [x] Verify emoji constants are used correctly
  - [x] Test UX guidelines appear in system prompt output

- [x] **Task 9: Verification**
  - [x] Run `npm run check-types` - no errors
  - [x] Run `npm run test` - all tests pass (878 tests across 64 files)
  - [x] Manual test: Error messages display with proper formatting
  - [x] Manual test: Cancellation shows builder-formatted message

- [x] **Task 10: Implement Changed Files Tree** (AC: 2.1.4)

  **Research Summary:** Parsed diff is already available at line ~247 in `chatParticipantService.ts`. The `stream.filetree()` API expects `ChatResponseFileTree[]` structure.

  - [x] Create helper function `buildFileTree(parsedDiff: DiffHunk[]): vscode.ChatResponseFileTree[]`
    - Transform `hunk.filePath` strings into tree structure
    - Support hierarchical display (folders containing files)
  - [x] Add `stream.filetree()` call in `runAnalysis()` after `parsedDiff` is created (line ~248)
    ```typescript
    const parsedDiff = DiffUtils.parseDiff(diffResult.diffText);

    // NEW: Display changed files tree
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder && parsedDiff.length > 0) {
        const fileTree = this.buildFileTree(parsedDiff);
        stream.filetree(fileTree, workspaceFolder.uri);
    }
    ```
  - [x] Add unit test for `buildFileTree()` helper
  - [x] Run `npm run check-types`
  - **Estimate:** 30 min
  - **Files:** `src/services/chatParticipantService.ts`, `src/utils/fileTreeBuilder.ts`

- [x] **Task 11: Implement Tool-Specific Progress Messages** (AC: 2.1.5)

  **Research Summary:** `ToolCallHandler.onToolCallStart` currently doesn't pass args. Need to parse args BEFORE calling the callback in `ConversationRunner`.

  **Step 1: Update ConversationRunner to pass args**
  - [x] Modify `handleToolCalls()` in `conversationRunner.ts` to parse args before notification loop
  - [x] Update `ToolCallHandler.onToolCallStart` signature:
    ```typescript
    onToolCallStart?: (toolName: string, args: Record<string, unknown>, toolIndex: number, totalTools: number) => void;
    ```

  **Step 2: Update ToolCallStreamAdapter**
  - [x] Update `onToolCallStart()` to accept and use args
  - [x] Create `formatToolStartMessage(toolName, args)` helper with switch statement:

    | Tool Name | Message Format |
    |-----------|----------------|
    | `read_file` | `📂 Reading {file_path}...` |
    | `find_symbol` | `🔍 Finding symbol \`{name_path}\`...` |
    | `find_usages` | `🔎 Finding usages of \`{symbol_name}\`...` |
    | `list_directory` | `📁 Listing {path}...` |
    | `find_files_by_pattern` | `🔍 Finding files matching \`{pattern}\`...` |
    | `get_symbols_overview` | `📊 Getting symbols in {path}...` |
    | `search_for_pattern` | `🔍 Searching for \`{pattern}\`...` |
    | `run_subagent` | `🤖 Spawning subagent investigation...` |
    | `think_about_context` | `🧠 Reflecting on context...` |
    | `think_about_investigation` | `🧠 Checking investigation progress...` |
    | `think_about_task` | `🧠 Verifying task alignment...` |
    | `think_about_completion` | `🧠 Verifying analysis completeness...` |
    | (default) | `🔧 Running {toolName}...` |

  **Step 3: Tests**
  - [x] Update `conversationRunner.test.ts` for new signature
  - [x] Update `toolCallStreamAdapter.test.ts` for message formatting (20 tests)
  - [x] Run `npm run check-types` and `npm run test`

  - **Estimate:** 45 min
  - **Files:** `src/models/conversationRunner.ts`, `src/models/toolCallStreamAdapter.ts`

---

## Dev Notes

### Code Reuse Patterns

**ChatResponseBuilder Usage Pattern:**

```typescript
import { ChatResponseBuilder } from "../utils/chatResponseBuilder";

// For errors:
const response = new ChatResponseBuilder()
  .addErrorSection(title, message, optionalDetails)
  .build();
stream.markdown(response);

// For success states:
const response = new ChatResponseBuilder()
  .addVerdictLine("success", title)
  .addFollowupPrompt(message)
  .build();
stream.markdown(response);
```

### What NOT to Change

1. **ChatToolCallHandler interface** - Already complete per architecture
2. **DebouncedStreamHandler** - Already complete from Story 0.4
3. ~~**ToolCallStreamAdapter** - Working correctly, only enhance if time permits~~ → Now being enhanced in Task 11
4. ~~**ConversationRunner** - No changes needed~~ → Signature change in Task 11
5. **LLM output handling** - Stream as-is, only format extension-generated messages

### Existing Patterns to Follow

**Import pattern (from existing chatParticipantService.ts):**

```typescript
import { ACTIVITY, SEVERITY } from "../config/chatEmoji";
```

**Logging pattern:**

```typescript
Log.info("[ChatParticipantService]: Message here");
Log.error("[ChatParticipantService]: Error message", error);
```

### Test File Locations

- `src/__tests__/chatResponseBuilder.test.ts` - Add tests for `addErrorSection()`
- `src/__tests__/chatParticipantService.test.ts` - Existing tests should not break
- `src/__tests__/toolAwareSystemPromptGenerator.test.ts` - Add test for UX guidelines
- `src/__tests__/conversationRunner.test.ts` - Update for new `onToolCallStart` signature
- `src/__tests__/toolCallStreamAdapter.test.ts` - Add tests for message formatting

### Definition of Done

1. All 5 inline formatting patterns migrated to ChatResponseBuilder
2. `addErrorSection()` method added and tested
3. System prompt includes UX guidelines section
4. **`stream.filetree()` displays changed files before analysis** (Task 10)
5. **Tool-specific progress messages for all 12 tools** (Task 11)
6. All existing tests pass (no regressions)
7. New tests cover added functionality
8. `npm run check-types` passes
9. Manual verification of error/success message formatting

---

## References

- [Source: docs/epics.md#Story-2.1]
- [Source: docs/architecture.md#Decision-8-Response-Formatting]
- [Source: docs/architecture.md#Decision-10-Three-Layer-Streaming]
- [Source: docs/architecture.md#Decision-11-Hybrid-Output-Approach]
- [Source: docs/ux-design-specification.md#Component-Strategy]
- [Source: docs/ux-design-specification.md#Emoji-Design-System]
- [Source: docs/sprint-artifacts/epic-0-retro-2025-12-17.md]
- [Source: docs/sprint-artifacts/epic-1-retro-2025-12-17.md#Finding-5-ChatResponseBuilder-Not-Used]
- [Source: src/utils/chatResponseBuilder.ts]
- [Source: src/services/chatParticipantService.ts]
- [Source: src/prompts/toolAwareSystemPromptGenerator.ts]

---

## Previous Story Learnings (Epic 0-1)

### From Epic 0 Retrospective

- ChatResponseBuilder created but not integrated into chat participant flow
- System prompt needed UX guidelines but was deferred to Epic 2
- Three-layer streaming architecture is solid foundation

### From Epic 1 Retrospective

- Inline formatting was used for rapid development speed
- ChatResponseBuilder migration explicitly deferred to Story 2.1 (this story)
- `handleCancellation()` method pattern is reusable for other error types
- Tool-calling architecture means findings arrive at END, not progressively

### Patterns Established

- `CANCELLATION_MESSAGE` constant pattern for detecting special returns
- Error handlers check `token.isCancellationRequested` first
- `debouncedHandler.flush()` called before final message processing

---

## Dev Agent Record

### Context Reference

Story context created by SM agent (Bob) via BMAD create-story workflow in YOLO mode with Party Mode research collaboration.

### Agent Model Used

Claude Opus 4.5 (Preview)

### Debug Log References

N/A - Story creation phase

### Completion Notes List

**Implementation Summary:**

1. **ChatResponseBuilder Enhancement (Task 1)**

   - Added `addErrorSection(title, message, details?)` method with JSDoc documentation
   - Uses `SEVERITY.warning` emoji for consistent error styling
   - Optional `details` parameter renders in code block for technical error messages
   - 6 new tests added covering all edge cases

2. **ChatParticipantService Migration (Tasks 2-6)**

   - Migrated 5 inline string formatting patterns to ChatResponseBuilder:
     - Configuration Error → `addErrorSection()`
     - Git Not Initialized → `addErrorSection()`
     - No Changes Found → `addVerdictLine('success')` + `addFollowupPrompt()`
     - Analysis Error → `addErrorSection()` with error details
     - Cancellation → `addVerdictLine('cancelled')` + `addFollowupPrompt()`
   - All 28 existing ChatParticipantService tests continue to pass

3. **System Prompt UX Enhancements (Task 7)**

   - Extended `generateOutputFormat()` with new sections (NOT separate method):
     - `<tone_guidelines>`: Supportive, non-judgmental language guidance
     - `<certainty_principle>`: Exception-based uncertainty flagging with 🔍 Verify: callout
   - Made "What's Good" section mandatory: `### 5. What's Good (REQUIRED - never skip this section)`
   - Used backtick file format (`src/path/file.ts:42`) as required by webview path detection

4. **Test Coverage (Task 8)**
   - Created new test file: `toolAwareSystemPromptGenerator.test.ts` with 21 tests
   - Tests verify: tone guidelines, certainty principle, section ordering, file format

5. **Changed Files Tree Display (Task 10)**
   - Created `buildFileTree()` utility in `src/utils/fileTreeBuilder.ts`
   - Transforms flat `DiffHunk[]` paths into hierarchical `ChatResponseFileTree[]` structure
   - Sorts folders before files alphabetically, deduplicates paths
   - Integrated `stream.filetree()` call in `chatParticipantService.ts` after parsing diff
   - Added 10 comprehensive unit tests covering edge cases

6. **Tool-Specific Progress Messages (Task 11)**
   - Updated `ToolCallHandler.onToolCallStart` signature to include args
   - Pre-parse arguments in `ConversationRunner.handleToolCalls()` before notification loop
   - Implemented `formatToolStartMessage()` in `ToolCallStreamAdapter` with 12 tool-specific templates
   - Progress messages show: file paths, symbol names, patterns, and reflection indicators
   - **Turn indicators removed** - "Turn X/100: 💭 Analyzing..." was noise that competed with tool messages
   - Added 20 tests for message formatting

**UX Improvement (December 18):**
- Removed turn indicator messages from `onIterationStart()` - users care about WHAT is happening (reading files, searching), not iteration counts
- Turn indicators were also being overwritten by `stream.progress()` replacement behavior, causing "missing turns" visual glitch

**Clickable File References - Deferred:**
- Investigated `stream.reference()` and `stream.anchor()` APIs via deepwiki research
- `stream.reference()` adds to "References" section (block-level), not inline with progress messages
- `stream.anchor()` creates inline links but requires `stream.markdown()` context (not compatible with `stream.progress()`)
- `stream.progress()` only accepts plain text - no way to embed clickable anchors
- **Deferred to future story** - would require UX redesign to show file reads in response body instead of progress

**Decisions Made:**

- Applied Anthropic prompt engineering best practices from fetched docs (XML structure, chain of thought guidance)
- Kept UX guidelines as extension of existing `generateOutputFormat()` to avoid duplication
- Followed red-green-refactor cycle for all tasks
- Created `fileTreeBuilder.ts` as separate utility for testability and reuse

### Change Log

| Date       | Author       | Changes                                                                             |
| ---------- | ------------ | ----------------------------------------------------------------------------------- |
| 2025-12-17 | Bob (SM)     | Initial story creation with comprehensive analysis                                  |
| 2025-12-17 | Bob (SM)     | Added Anthropic best practices from fetched docs                                    |
| 2025-12-17 | Bob (SM)     | Added AC-2.1.10: Exception-based certainty flagging (ultrathink + party brainstorm) |
| 2025-12-17 | Bob (SM)     | Implemented `generateUXGuidelines()` in toolAwareSystemPromptGenerator.ts           |
| 2025-12-17 | Amelia (Dev) | Implemented all 9 tasks - 855 tests pass, types check clean                         |
| 2025-12-17 | Amelia (Dev) | Implemented Tasks 10-11: filetree display + tool-specific progress - 878 tests pass |
| 2025-12-18 | Amelia (Dev) | Removed turn indicators (UX improvement), investigated clickable file refs (deferred) |

### File List

**Modified:**

- `src/utils/chatResponseBuilder.ts` - Added `addErrorSection()` method with JSDoc
- `src/services/chatParticipantService.ts` - Migrated 5 inline formatting patterns to ChatResponseBuilder, added `stream.filetree()` call
- `src/prompts/toolAwareSystemPromptGenerator.ts` - Extended `generateOutputFormat()` with UX guidelines
- `src/models/conversationRunner.ts` - Updated `ToolCallHandler.onToolCallStart` signature to include args
- `src/models/toolCallStreamAdapter.ts` - Added `formatToolStartMessage()` with 12 tool-specific templates
- `__mocks__/vscode.js` - Added `ChatResponseFileTreePart` mock
- `docs/archive/brownfield-architecture.md` - Moved from docs/
- `docs/archive/technical-docs.md` - Moved from docs/

**Created:**

- `src/__tests__/toolAwareSystemPromptGenerator.test.ts` - 21 tests for UX guidelines verification
- `src/utils/fileTreeBuilder.ts` - Transforms diff paths into hierarchical file tree structure
- `src/__tests__/fileTreeBuilder.test.ts` - 10 tests for file tree building

**Tests Updated:**

- `src/__tests__/chatResponseBuilder.test.ts` - Added 6 tests for `addErrorSection()` (36 total)
- `src/__tests__/chatParticipantService.test.ts` - Added filetree mock, 1 new test (29 total)
- `src/__tests__/conversationRunner.test.ts` - Updated for new `onToolCallStart` signature (11 total)
- `src/__tests__/toolCallStreamAdapter.test.ts` - Replaced 2 tests with 20 tests for message formatting

---

## Appendix: Anthropic Best Practices Reference

_Fetched from platform.claude.com on December 17, 2025_

### 1. Be Clear and Direct

> "When interacting with Claude, think of it as a brilliant but very new employee who needs explicit instructions."

**Key Techniques:**

- Provide contextual information (task purpose, target audience, workflow context)
- Be specific about what you want—use numbered steps
- Test prompts with a colleague—if they're confused, Claude will be too

**Applied to Lupa:** UX guidelines use numbered sections, explicit format templates, and concrete examples.

### 2. Multishot Prompting (Examples)

> "Examples are your secret weapon shortcut for getting Claude to generate exactly what you need."

**Key Techniques:**

- Include 3-5 diverse, relevant examples
- Wrap examples in `<example>` tags (nested in `<examples>` if multiple)
- Cover edge cases; vary examples to avoid unintended patterns

**Applied to Lupa:** Three examples in `<examples>` block - critical finding, medium finding, positive observation.

### 3. Chain of Thought

> "Giving Claude space to think can dramatically improve its performance."

**Key Techniques:**

- "Think step-by-step" for complex analysis tasks
- Guided prompting: outline specific thinking steps
- Structured prompting: use `<thinking>` and `<answer>` tags
- **Always have Claude output its thinking—without output, no thinking occurs!**

**Applied to Lupa:** Self-reflection tools (think_about_context, think_about_task, think_about_completion) implement structured CoT.

### 4. XML Tags for Structure

> "XML tags can be a game-changer. They help Claude parse your prompts more accurately."

**Key Techniques:**

- Use tags like `<instructions>`, `<example>`, `<formatting>` to separate prompt parts
- Consistent tag names throughout prompts
- Nest tags for hierarchical content
- Makes Claude's output parseable via post-processing

**Applied to Lupa:** UX guidelines use `<ux_guidelines>`, `<severity_levels>`, `<finding_format>`, `<examples>`, `<tone_guidelines>`, `<certainty_principle>`, `<required_sections>`.

### 5. System Prompts (Role Prompting)

> "Role prompting is the most powerful way to use system prompts with Claude."

**Key Techniques:**

- Use `system` parameter to give Claude a role
- Specific roles > generic roles (e.g., "senior code reviewer for TypeScript")
- Dramatically improves accuracy, tone, and focus

**Applied to Lupa:** "You are a Staff Engineer performing a comprehensive pull request review."

### 6. Chain Prompts

> "Breaking down complex tasks into smaller, manageable subtasks."

**Key Techniques:**

- Each subtask gets full attention, reducing errors
- Use XML tags for clear handoffs between steps
- Debugging: isolate problematic steps into their own prompts
- Parallel execution for independent subtasks

**Applied to Lupa:** Subagent delegation for multi-file PRs follows this pattern.

### 7. Long Context Tips

> "Claude's extended context window enables handling complex, data-rich tasks."

**Key Techniques:**

- **Put longform data (diffs, code) at TOP of prompt**
- **Put queries/instructions at END** - improves quality by up to 30%
- Wrap documents with `<document>` tags including `<source>` metadata
- Ask Claude to quote relevant parts before analyzing—cuts through noise

**Applied to Lupa:** ConversationRunner places diff in user message, system prompt contains instructions - already follows this pattern.

---

## Appendix: Certainty Flagging Design Decision

_Brainstormed December 17, 2025 via ultrathink + multi-agent party mode_

### The Question

Should we instruct the LLM to output confidence levels with each finding?

### Analysis Summary

**Severity vs Confidence are orthogonal:**

- Severity: "If this issue exists, how bad is it?" (impact)
- Confidence: "How sure am I that this issue actually exists?" (certainty)

**Arguments FOR LLM confidence:**

1. Epistemic honesty - transparent about uncertainty
2. Better prioritization - developers focus on high-confidence findings first
3. Calibration via Chain of Thought - thinking through certainty improves quality
4. Matches human reviewer behavior ("I'm not sure about this, but...")

**Arguments AGAINST:**

1. LLM confidence is not calibrated - often overconfident when wrong
2. Percentages are "confidence theater" - no meaningful probability estimate
3. UI clutter - another field on every finding
4. Gaming behavior - LLM may claim "high confidence" arbitrarily

### Multi-Agent Brainstorm Results

**Architect:** Recommended MODIFY - integrate into existing `think_about_context` tool, use structured format (✓ verified, ⚠️ needs verification), not standalone principle.

**UX Designer:** Recommended blockquote callout format, remove redundant ⚠️ from header, use 🔍 Verify: prefix (action-oriented, different emoji class).

**Developer:** Would investigate "needs verification" findings MORE carefully, not less. Wants specific uncertainty reasons, not generic labels. Concerned about false confidence calibration.

### Final Decision

**Exception-based certainty flagging:**

- Most findings: No confidence markup (assumed verified)
- Uncertain findings: Blockquote callout with 🔍 Verify: prefix explaining what's missing

This approach:

- Uses Chain of Thought (thinking through certainty)
- Avoids confidence theater (no fake percentages)
- Exception-based reporting (only flags uncertainty)
- Aligns with tool-calling architecture (verification = tool usage)
- Minimal UI impact (no extra fields on every finding)

---

## Changelog

| Date       | Author | Change                                                                                                                                                                                                     |
| ---------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2025-12-17 | Igor   | Created story from PRD Epic 2, Story 2.1                                                                                                                                                                   |
| 2025-12-17 | Igor   | Added AC-2.1.10 for exception-based certainty flagging based on ultrathink + multi-agent brainstorm                                                                                                        |
| 2025-12-17 | Igor   | Fixed AC-2.1.9 & AC-2.1.10: Changed file format from markdown links to backtick format (`` `src/path/file.ts:42` ``) for webview path detection compatibility                                              |
| 2025-12-17 | Igor   | Removed full code implementation from story - story now provides guidance to EXTEND existing `generateOutputFormat()` with only: tone_guidelines, certainty_principle, mandatory "What's Good" section     |
| 2025-12-17 | Igor   | Merged old Task 10 into Task 7 - system prompt UX enhancements are now a single task                                                                                                                       |
| 2025-12-17 | Igor   | Removed duplication with existing code - `generateOutputFormat()` already defines severity levels, finding format, section structure; story now clearly states what's NEW vs what already exists           |
| 2025-12-17 | Igor   | Party Mode verification: Added explicit placement guidance (tone_guidelines BEFORE Summary), added "always find one positive" instruction, noted future markdown migration is separate story               |
| 2025-12-17 | Igor   | **Party Mode proper research:** Replaced tracking tasks with real implementation tasks. Task 10 now implements `stream.filetree()` (~30 min). Task 11 now implements tool-specific messages (~45 min). No doc updates needed (architecture/epics/PRD already cover these features). |
````
