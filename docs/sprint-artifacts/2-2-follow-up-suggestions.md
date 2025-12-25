# Story 2.2: Follow-up Suggestions

**Status:** done
**Epic:** 2 - Rich UX & Agent Mode Integration
**Story ID:** 2.2
**Estimated Effort:** S (0.5-1 day)
**Created:** 2025-12-18

---

## Story

**As a** developer reviewing code with `@lupa`,
**I want to** see contextual follow-up suggestions after analysis completes,
**So that** I can dive deeper into specific findings without typing new prompts.

---

## Acceptance Criteria

### AC-2.2.1: ChatFollowupProvider Registration

**Given** the chat participant is registered
**When** the extension activates
**Then** `participant.followupProvider` MUST be assigned with a provider that:

- Implements the `ChatFollowupProvider` interface
- Returns `ChatFollowup[]` based on analysis metadata

**Implementation Location:** `chatParticipantService.ts` after `createChatParticipant()` call.

### AC-2.2.2: ChatAnalysisMetadata Population

**Given** analysis completes successfully
**When** returning the `ChatResult`
**Then** `result.metadata` MUST include `ChatAnalysisMetadata` with:

| Field                   | Type                    | Source                       |
| ----------------------- | ----------------------- | ---------------------------- |
| `command`               | `'branch' \| 'changes'` | `request.command`            |
| `filesAnalyzed`         | `number`                | `parsedDiff.length`          |
| `issuesFound`           | `boolean`               | Derived from analysis result |
| `hasCriticalIssues`     | `boolean`               | Check for 🔴 in result       |
| `hasSecurityIssues`     | `boolean`               | Check for 🔒 in result       |
| `hasTestingSuggestions` | `boolean`               | Check for 🧪 in result       |
| `cancelled`             | `boolean`               | Token cancellation status    |

**Note:** Issue detection uses simple string matching on LLM output. Not guaranteed accurate but provides best-effort contextual follow-ups.

### AC-2.2.3: Context-Based Follow-up Suggestions

**Given** the follow-up provider receives analysis metadata
**When** generating suggestions
**Then** provide contextual chips based on analysis content:

| Condition               | Follow-up                                     | Label                 |
| ----------------------- | --------------------------------------------- | --------------------- |
| `hasCriticalIssues`     | "Focus on critical issues only"               | "🔴 Critical Focus"   |
| `hasSecurityIssues`     | "Explain the security risks in detail"        | "🔒 Security Details" |
| `hasTestingSuggestions` | "What tests should I add for these changes?"  | "🧪 Test Suggestions" |
| `issuesFound`           | "Show me how to fix the most important issue" | "🔧 Fix Guidance"     |
| Always                  | "What did you like about this code?"          | "✅ What's Good"      |
| Always                  | "Explain these changes to a teammate"         | "💬 Explain Changes"  |

**Limit:** Maximum 4 follow-ups per response (avoid decision paralysis).

### AC-2.2.4: Follow-up Continuation

**Given** a user clicks a follow-up suggestion
**When** the follow-up triggers
**Then** it MUST:

- Submit the follow-up prompt to `@lupa`
- Maintain conversation context (sticky mode already enabled)
- Generate new analysis response

**Note:** This is automatic VS Code behavior—we just return proper `ChatFollowup` objects.

### AC-2.2.5: Prompt Quality (Anthropic Best Practices)

**Given** follow-up prompts are shown to users
**When** crafting prompt text
**Then** apply Anthropic prompt engineering best practices:

| Principle                  | Application                                     |
| -------------------------- | ----------------------------------------------- |
| **Be clear and direct**    | Action-oriented, specific prompts               |
| **Context preservation**   | Prompts reference "these changes" / "this code" |
| **User-friendly language** | No jargon, conversational tone                  |

**Good Example:** "Show me how to fix the most important issue"
**Bad Example:** "Execute remediation workflow for P1 defect"

### AC-2.2.6: Graceful Degradation

**Given** analysis metadata is unavailable or malformed
**When** providing follow-ups
**Then** return a sensible default set:

- "Ask a follow-up question about these changes"
- "What should I focus on next?"

---

## Technical Implementation

### Architecture Context

**Current State Analysis:**

```
ChatParticipantService
├── participant = vscode.chat.createChatParticipant(...)  ← LINE 79
├── participant.followupProvider = ???                     ← NOT YET IMPLEMENTED
└── handleRequest() → returns ChatResult with metadata
```

**From chatParticipantService.ts (current implementation):**

- `ChatResult` is returned from `handleBranchCommand()` / `handleChangesCommand()`
- `handleCancellation()` returns `{ metadata: { cancelled: true, responseIsIncomplete: true } }`
- Analysis success returns `{}` (empty result—needs metadata population)

**From chatTypes.ts (existing interface):**

```typescript
interface ChatAnalysisMetadata {
  mode?: "branch" | "changes";
  baseBranch?: string;
  targetBranch?: string;
  analysisTimestamp?: number;
}
```

### Implementation Changes

#### 1. Extend ChatAnalysisMetadata Interface

**File:** `src/types/chatTypes.ts`

```typescript
/**
 * Metadata stored with chat analysis results for follow-up handling.
 * Used by ChatFollowupProvider to generate contextual suggestions.
 */
export interface ChatAnalysisMetadata {
  /** The command that was used */
  command?: "branch" | "changes";
  /** Number of files in the analyzed diff */
  filesAnalyzed?: number;
  /** Whether any issues were found */
  issuesFound?: boolean;
  /** Whether critical (🔴) issues were found */
  hasCriticalIssues?: boolean;
  /** Whether security (🔒) issues were found */
  hasSecurityIssues?: boolean;
  /** Whether testing (🧪) suggestions were included */
  hasTestingSuggestions?: boolean;
  /** Whether analysis was cancelled */
  cancelled?: boolean;
  /** Unix timestamp when analysis completed */
  analysisTimestamp?: number;
}
```

#### 2. Create FollowupProvider Helper

**File:** `src/services/chatFollowupProvider.ts` (NEW)

```typescript
import * as vscode from "vscode";
import type { ChatAnalysisMetadata } from "../types/chatTypes";

const MAX_FOLLOWUPS = 4;

/**
 * Generates contextual follow-up suggestions based on analysis results.
 * Follows Anthropic prompt engineering best practices:
 * - Clear, direct language
 * - Action-oriented prompts
 * - Context-aware suggestions
 */
export function createFollowupProvider(): vscode.ChatFollowupProvider {
  return {
    provideFollowups(
      result: vscode.ChatResult,
      _context: vscode.ChatContext,
      _token: vscode.CancellationToken
    ): vscode.ChatFollowup[] {
      const metadata = result.metadata as ChatAnalysisMetadata | undefined;

      // Handle cancelled or error states
      if (metadata?.cancelled || result.errorDetails) {
        return getDefaultFollowups();
      }

      return buildContextualFollowups(metadata);
    },
  };
}

function buildContextualFollowups(
  metadata: ChatAnalysisMetadata | undefined
): vscode.ChatFollowup[] {
  const followups: vscode.ChatFollowup[] = [];

  // Priority 1: Critical issues (highest priority)
  if (metadata?.hasCriticalIssues) {
    followups.push({
      prompt: "Focus on critical issues only",
      label: "🔴 Critical Focus",
    });
  }

  // Priority 2: Security issues
  if (metadata?.hasSecurityIssues) {
    followups.push({
      prompt: "Explain the security risks in detail",
      label: "🔒 Security Details",
    });
  }

  // Priority 3: Testing suggestions
  if (metadata?.hasTestingSuggestions) {
    followups.push({
      prompt: "What tests should I add for these changes?",
      label: "🧪 Test Suggestions",
    });
  }

  // Priority 4: Fix guidance (if issues exist)
  if (metadata?.issuesFound && followups.length < MAX_FOLLOWUPS) {
    followups.push({
      prompt: "Show me how to fix the most important issue",
      label: "🔧 Fix Guidance",
    });
  }

  // Fill remaining slots with general follow-ups
  const generalFollowups: vscode.ChatFollowup[] = [
    { prompt: "What did you like about this code?", label: "✅ What's Good" },
    {
      prompt: "Explain these changes to a teammate",
      label: "💬 Explain Changes",
    },
  ];

  for (const followup of generalFollowups) {
    if (followups.length >= MAX_FOLLOWUPS) break;
    followups.push(followup);
  }

  return followups.slice(0, MAX_FOLLOWUPS);
}

function getDefaultFollowups(): vscode.ChatFollowup[] {
  return [
    {
      prompt: "Ask a follow-up question about these changes",
      label: "❓ Ask Question",
    },
    { prompt: "What should I focus on next?", label: "🎯 Next Steps" },
  ];
}
```

#### 3. Populate Metadata in ChatParticipantService

**File:** `src/services/chatParticipantService.ts`

**Add helper function to analyze result content:**

```typescript
import { createFollowupProvider } from "./chatFollowupProvider";

/**
 * Analyzes LLM output to detect issue types for follow-up generation.
 * Uses simple string matching—not guaranteed accurate but sufficient for UX.
 */
function analyzeResultContent(analysisResult: string): {
  issuesFound: boolean;
  hasCriticalIssues: boolean;
  hasSecurityIssues: boolean;
  hasTestingSuggestions: boolean;
} {
  return {
    issuesFound:
      analysisResult.includes("🔴") ||
      analysisResult.includes("🟠") ||
      analysisResult.includes("🟡"),
    hasCriticalIssues: analysisResult.includes("🔴"),
    hasSecurityIssues:
      analysisResult.includes("🔒") ||
      analysisResult.toLowerCase().includes("security"),
    hasTestingSuggestions:
      analysisResult.includes("🧪") ||
      analysisResult.toLowerCase().includes("test"),
  };
}
```

**Modify `registerParticipant()` to add followupProvider:**

```typescript
private registerParticipant(): void {
    try {
        this.participant = vscode.chat.createChatParticipant(
            'lupa.chat-participant',
            this.handleRequest.bind(this)
        );
        if (this.participant) {
            // Register follow-up provider
            this.participant.followupProvider = createFollowupProvider();

            this.disposables.push(this.participant);
        }
        Log.info('[ChatParticipantService]: Chat participant registered successfully');
    } catch (error) {
        // ... existing error handling
    }
}
```

**Modify `runAnalysis()` to return populated metadata:**

```typescript
// After stream.markdown(analysisResult);
const contentAnalysis = analyzeResultContent(analysisResult);

return {
  metadata: {
    command: request.command as "branch" | "changes",
    filesAnalyzed: parsedDiff.length,
    issuesFound: contentAnalysis.issuesFound,
    hasCriticalIssues: contentAnalysis.hasCriticalIssues,
    hasSecurityIssues: contentAnalysis.hasSecurityIssues,
    hasTestingSuggestions: contentAnalysis.hasTestingSuggestions,
    cancelled: false,
    analysisTimestamp: Date.now(),
  } satisfies ChatAnalysisMetadata,
};
```

---

## Tasks / Subtasks

- [x] **Task 1: Extend ChatAnalysisMetadata Interface** (AC: 2.2.2)

  - [x] Add `filesAnalyzed`, `issuesFound`, `hasCriticalIssues` fields
  - [x] Add `hasSecurityIssues`, `hasTestingSuggestions` fields
  - [x] Add JSDoc documentation
  - [x] Consolidate interface (removed redundant `mode` field)
  - [x] Run `npm run check-types`

- [x] **Task 2: Create chatFollowupProvider.ts** (AC: 2.2.1, 2.2.3)

  - [x] Create `src/services/chatFollowupProvider.ts`
  - [x] Implement `createFollowupProvider()` factory function
  - [x] Implement `buildContextualFollowups()` with priority logic
  - [x] Implement `getDefaultFollowups()` for fallback case
  - [x] Limit to MAX_FOLLOWUPS (4) to avoid decision paralysis
  - [x] Run `npm run check-types`

- [x] **Task 3: Register FollowupProvider in ChatParticipantService** (AC: 2.2.1)

  - [x] Import `createFollowupProvider` from new module
  - [x] Add `this.participant.followupProvider = createFollowupProvider()` in `registerParticipant()`
  - [x] Run `npm run check-types`

- [x] **Task 4: Implement analyzeResultContent Helper** (AC: 2.2.2)

  - [x] Add `analyzeResultContent()` function to detect issue types
  - [x] Use emoji detection (🔴, 🟠, 🟡, 🔒, 🧪)
  - [x] Use keyword detection as backup (security, test)
  - [x] Run `npm run check-types`

- [x] **Task 5: Populate Metadata in runAnalysis** (AC: 2.2.2)

  - [x] Modify `runAnalysis()` return statement to include full metadata
  - [x] Call `analyzeResultContent(analysisResult)` before return
  - [x] Include `filesAnalyzed: parsedDiff.length`
  - [x] Include `command: request.command`
  - [x] Include `analysisTimestamp: Date.now()`
  - [x] Run `npm run check-types`

- [x] **Task 6: Unit Tests for chatFollowupProvider** (AC: 2.2.3, 2.2.5, 2.2.6)

  - [x] Create `src/__tests__/chatFollowupProvider.test.ts`
  - [x] Test: Critical issues → includes "🔴 Critical Focus"
  - [x] Test: Security issues → includes "🔒 Security Details"
  - [x] Test: Testing suggestions → includes "🧪 Test Suggestions"
  - [x] Test: Issues found → includes "🔧 Fix Guidance"
  - [x] Test: Empty metadata → returns default follow-ups
  - [x] Test: Cancelled → returns default follow-ups
  - [x] Test: Maximum 4 follow-ups enforced
  - [x] Test: Priority ordering (critical > security > testing > fix)
  - [x] Fix TypeScript errors in tests by casting `ProviderResult` to `ChatFollowup[]`

- [x] **Task 7: Unit Tests for analyzeResultContent** (AC: 2.2.2)

  - [x] Add tests to `src/__tests__/chatParticipantService.test.ts`
  - [x] Test: Detects 🔴 as critical issue
  - [x] Test: Detects 🔒 as security issue
  - [x] Test: Detects 🧪 as testing suggestion
  - [x] Test: Empty string returns all false
  - [x] Test: Multiple indicators detected simultaneously

- [x] **Task 8: Integration Test** (AC: 2.2.4)

  - [x] Manual test: Run `/branch` command
  - [x] Verify follow-up chips appear after analysis
  - [x] Click a follow-up chip
  - [x] Verify new analysis starts with follow-up context

- [x] **Task 9: Verification**
  - [x] Run `npm run check-types` - no errors
  - [x] Run `npm run test` - all tests pass, output is huge, read last 20 lines for summary
  - [x] Manual test: Verify follow-ups display correctly
  - [x] Manual test: Verify follow-up continuation works

---

## Dev Notes

### Existing Patterns to Follow

**Import pattern:**

```typescript
import * as vscode from "vscode";
import type { ChatAnalysisMetadata } from "../types/chatTypes";
```

**Service pattern (already established):**

```typescript
// Export factory function, not class (simpler for this small provider)
export function createFollowupProvider(): vscode.ChatFollowupProvider;
```

**Logging pattern:**

```typescript
Log.info("[ChatFollowupProvider]: Generated N follow-ups");
```

### What NOT to Change

1. **Existing ChatToolCallHandler** - Unrelated to follow-ups
2. **DebouncedStreamHandler** - Already complete
3. **ConversationRunner** - No changes needed
4. **handleCancellation()** - Already returns proper metadata

### Code Reuse Opportunities

**Emoji constants from chatEmoji.ts:**
The follow-up provider doesn't need to import SEVERITY/ACTIVITY emoji—it uses inline emoji in labels which is cleaner for this UI context.

### VS Code API Reference

**ChatFollowupProvider interface:**

```typescript
interface ChatFollowupProvider {
  provideFollowups(
    result: ChatResult,
    context: ChatContext,
    token: CancellationToken
  ): ProviderResult<ChatFollowup[]>;
}

interface ChatFollowup {
  prompt: string; // Text submitted when clicked
  label?: string; // Button label (defaults to prompt)
  command?: string; // Optional slash command
  participant?: string; // Optional target participant
}
```

### Definition of Done

1. Follow-up chips appear after `/branch` and `/changes` analysis
2. Follow-ups are contextual based on analysis content
3. Maximum 4 follow-ups shown
4. Clicking follow-up continues conversation
5. Default follow-ups shown for cancelled/error states
6. All new code has unit tests
7. `npm run check-types` passes
8. `npm run test` passes

---

## References

- [Source: docs/epics.md#Story-2.2]
- [Source: docs/prd.md#FR-030-FR-033]
- [Source: docs/architecture.md#Decision-4-Follow-up-Provider-Strategy]
- [Source: docs/ux-design-specification.md#Follow-up-Patterns]
- [Source: docs/research/vscode-chat-participant-api.md#7-Follow-up-Suggestions]
- [Source: src/services/chatParticipantService.ts]
- [Source: src/types/chatTypes.ts]

---

## Previous Story Learnings (Story 2.1)

### From Story 2.1 Implementation

- `ChatResponseBuilder` is used for extension-generated messages, LLM output streams as-is
- Three-layer streaming architecture is solid and working
- `analyzeResultContent()` helper pattern is simple and effective for UX purposes
- Don't over-engineer detection—simple string matching is sufficient

### Patterns Established

- Helper functions extracted to separate modules for testability
- Factory functions preferred over classes for simple providers
- Emoji detection uses both emoji characters AND keyword fallbacks
- MAX_FOLLOWUPS constant prevents decision paralysis

---

## Dev Agent Record

### Context Reference

Story context created by SM agent (Bob) via BMAD create-story workflow in YOLO mode with Party Mode research.

### Agent Model Used

Gemini 3 Flash (Preview)

### Debug Log References

N/A - Story creation phase

### Completion Notes List

- Extended `ChatAnalysisMetadata` in `src/types/chatTypes.ts` to include analysis findings.
- Created `src/services/chatFollowupProvider.ts` to generate contextual follow-up suggestions.
- Registered `ChatFollowupProvider` in `ChatParticipantService`.
- Implemented `analyzeResultContent` in `ChatParticipantService` to populate metadata from LLM output.
- Added unit tests for `ChatFollowupProvider` and metadata population in `ChatParticipantService`.
- Fixed TypeScript errors in tests by casting `ProviderResult` to `ChatFollowup[]`.
- Consolidated `ChatAnalysisMetadata` by removing redundant `mode` field.
- Verified all tests pass and types are correct.

### Change Log

| Date       | Author       | Changes                                                   |
| ---------- | ------------ | --------------------------------------------------------- |
| 2025-12-18 | Bob (SM)     | Initial story creation with comprehensive analysis        |
| 2025-12-18 | Amelia (Dev) | Implemented follow-up suggestions and metadata population |
| 2025-12-18 | Amelia (Dev) | Fixed TS errors in tests and consolidated metadata        |
| 2025-12-19 | Amelia (Dev) | Code Review: Removed keyword fallbacks, updated docs      |

### File List

**New Files:**

- `src/services/chatFollowupProvider.ts`
- `src/__tests__/chatFollowupProvider.test.ts`

**Modified Files:**

- `src/types/chatTypes.ts` - Extend `ChatAnalysisMetadata`
- `src/services/chatParticipantService.ts` - Register provider, populate metadata
- `src/__tests__/chatParticipantService.test.ts` - Add metadata tests
- `docs/sprint-artifacts/sprint-status.yaml` - Update sprint status
