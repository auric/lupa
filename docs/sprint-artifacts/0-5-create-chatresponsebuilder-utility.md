# Story 0.5: Create ChatResponseBuilder Utility

**Status:** Done
**Story ID:** 0.5
**Epic:** 0 - Foundation & Interface Abstraction
**Created:** 2025-12-16
**Created By:** Bob (SM) with Party Mode (Winston, Sally, Murat, Amelia)

---

## Story

**As a** developer maintaining Lupa,
**I want** a builder utility for constructing consistent chat responses,
**So that** all analysis responses follow the UX design specification's structure and emotional design patterns.

---

## Business Context

This story completes the **UX Foundation** started in Story 0.4. It creates:

1. **ChatResponseBuilder** - Fluent builder API for constructing analysis responses
2. **Finding Interface** - Type-safe structure for issue/suggestion cards
3. **Response Structure Enforcement** - Verdict-first pattern from UX specification

**Business Value:** Ensures every analysis response follows the same professional structure, reinforcing user trust and enabling consistent emotional design patterns.

**Emotional Design Impact:** The builder enforces the "Supportive, Not Judgmental" principle by:

- Structuring responses with positive notes ("What's Good")
- Using supportive verdict lines ("Looking good!" vs "No errors")
- Ensuring proper visual hierarchy for scannability

**Dependencies:** Story 0.4 (emoji constants) ✅ **COMPLETED**

---

## Acceptance Criteria

### AC-0.5.1: ChatResponseBuilder Class

**Given** the UX specification defines response structure as Verdict → Stats → Findings → Positives → Summary
**When** creating `ChatResponseBuilder`
**Then** the class MUST provide methods:

| Method                                                                          | Purpose                          |
| ------------------------------------------------------------------------------- | -------------------------------- |
| `addVerdictLine(status: 'success' \| 'issues' \| 'cancelled', summary: string)` | Opening line with status emoji   |
| `addSummaryStats(filesAnalyzed: number, critical: number, suggestions: number)` | Statistics bar                   |
| `addFindingsSection(title: string, emoji: string, findings: Finding[])`         | Section for issues/suggestions   |
| `addPositiveNotes(notes: string[])`                                             | "What's Good" section            |
| `addFollowupPrompt(summary: string)`                                            | Closing summary line             |
| `build(): string`                                                               | Returns complete markdown string |

**And** each method MUST return `this` for fluent chaining
**And** the builder MUST use emoji from `chatEmoji.ts` constants (from Story 0.4)
**And** the class MUST be in `src/utils/chatResponseBuilder.ts`

---

### AC-0.5.2: Finding Interface Definition

**Given** the need for type-safe finding cards
**When** adding the `Finding` interface to `chatTypes.ts`
**Then** the interface MUST define:

```typescript
export interface Finding {
  /** Display title for the finding (e.g., "SQL Injection Risk") */
  title: string;
  /** File location display text (e.g., "handler.ts#L45") */
  location: string;
  /** Markdown anchor link (e.g., "src/auth/handler.ts#L45") */
  anchor: string;
  /** Description text explaining the issue and guidance */
  description: string;
}
```

**And** the interface MUST be exported from `src/types/chatTypes.ts`

---

### AC-0.5.3: Finding Card Format (UX-FR-005)

**Given** UX-FR-005 requires specific finding card format
**When** adding findings via `addFindingsSection()`
**Then** each finding MUST render as:

```markdown
**{title}** in [{location}]({anchor})
{description}
```

**And** multiple findings MUST be separated by blank lines
**And** sections MUST be preceded by `---` horizontal rules
**And** empty findings arrays MUST result in NO section being added (skip silently)

---

### AC-0.5.4: Emotional Design Compliance (UX-NFR-004, UX-FR-006)

**Given** the UX specification requires supportive, non-judgmental tone
**When** building responses
**Then** verdict line MUST use appropriate emoji:

| Status      | Emoji | Usage                                |
| ----------- | ----- | ------------------------------------ |
| `success`   | ✅    | No critical issues found             |
| `issues`    | 🔍    | Issues found (neutral, not alarming) |
| `cancelled` | 💬    | Analysis was stopped early           |

**And** the builder MUST support `addPositiveNotes()` for emotional balance per UX-FR-006
**And** heading hierarchy MUST be logical: `##` for verdict, `###` for section titles (UX-NFR-003)

---

### AC-0.5.5: Summary Stats Format

**Given** the UX specification shows summary stats pattern
**When** calling `addSummaryStats()`
**Then** output MUST match:

```markdown
📊 **{files} files** analyzed | **{critical}** critical | **{suggestions}** suggestions
```

**And** MUST use `SECTION.summary` emoji from `chatEmoji.ts`
**And** zeros MUST be displayed (not hidden)

---

### AC-0.5.6: Unit Tests

**Given** the ChatResponseBuilder utility
**When** running tests
**Then** tests MUST verify:

**Verdict Line Tests:**

- `status='success'` renders with ✅ emoji
- `status='issues'` renders with 🔍 emoji
- `status='cancelled'` renders with 💬 emoji
- Summary text is included after emoji

**Summary Stats Tests:**

- Format matches specification exactly
- All three counts are displayed
- Zero values are handled correctly

**Findings Section Tests:**

- Empty findings array → no section rendered
- Single finding → proper card format
- Multiple findings → each separated by blank line
- Section title uses provided emoji
- Horizontal rule precedes section

**Positive Notes Tests:**

- Empty notes array → no section rendered
- Single note → bullet point format
- Multiple notes → bullet list
- Uses ✅ emoji from SEVERITY constants

**Follow-up Prompt Tests:**

- Renders with 📊 prefix from SECTION constants
- Preceded by horizontal rule

**Build Integration Tests:**

- Full response with all sections in correct order
- Response with subset of sections
- Method chaining works (fluent API)

---

## Developer Context (Party Mode Analysis)

### 🏗️ Architecture Context (Winston)

**Design Pattern:** Builder Pattern (Gang of Four)

The ChatResponseBuilder uses the Builder pattern to:

1. Separate complex response construction from its representation
2. Enable step-by-step building with fluent API
3. Allow different configurations to produce correct output

**Dependency Chain:**

```
ChatResponseBuilder
    ↓ imports
chatEmoji.ts (SEVERITY, SECTION constants)
    ↓ uses
Finding interface (from chatTypes.ts)
```

**Why Utils, Not Services:**

- Stateless utility (no lifecycle)
- Pure functions (no side effects)
- No VS Code API dependencies
- Follows existing pattern (`src/utils/diffUtils.ts`)

**Type Safety Strategy:**

- Discriminated union for status: `'success' | 'issues' | 'cancelled'`
- `Finding` interface for type-safe cards
- Return `this` for chained method type safety

**Architecture References:**

- [Architecture Decision 8](docs/architecture.md) - Response Formatting Pattern
- [Architecture Decision 9](docs/architecture.md) - Emoji Design System Constants
- [UX Spec: Response Structure](docs/ux-design-specification.md#design-direction-decision)

---

### 🎨 UX Context (Sally)

**Response Structure Pattern (Verdict-First):**

```markdown
## ✅ Analysis Complete ← Verdict Line

📊 **15 files** analyzed | **2** critical | **3** suggestions ← Summary Stats

---

### 🔴 Critical Issues ← Findings Section (emoji from parameter)

**SQL Injection Risk** in [handler.ts#L45](src/auth/handler.ts#L45)
Description of the issue...

---

### 🟡 Suggestions ← Another Findings Section

**Input validation** in [auth.ts#L12](src/auth/auth.ts#L12)
Consider adding validation...

---

### ✅ What's Good ← Positive Notes

- Clean separation of concerns
- Good error messages

---

📊 Ready for review after addressing critical issues. ← Follow-up Prompt
```

**Emotional Design Requirements:**

| Scenario     | ❌ Don't Say        | ✅ Do Say                                        |
| ------------ | ------------------- | ------------------------------------------------ |
| No issues    | "No errors"         | "Looking good! No critical issues found."        |
| Issues found | "Problems detected" | "Analysis Complete" (neutral)                    |
| Cancelled    | "Aborted"           | "Analysis paused. Here's what I found so far..." |

**Section Ordering Rules:**

1. Verdict Line (always first)
2. Summary Stats (always second)
3. Critical Issues section (if any)
4. Suggestions section (if any)
5. What's Good section (for emotional balance)
6. Follow-up Prompt (always last)

**Horizontal Rules:**

- Use `---` before each major section change
- Creates visual separation for scannability

**Accessibility (Shape-Based Emoji):**
All emoji used must be distinguishable by shape, not just color:

- 🔴 (circle) vs ✅ (checkmark) vs 🔍 (magnifying glass)

**UX References:**

- [UX Spec: Defining Experience](docs/ux-design-specification.md#defining-core-experience)
- [UX Spec: Design Direction](docs/ux-design-specification.md#design-direction-decision)
- [UX Spec: Emotional Design](docs/ux-design-specification.md#desired-emotional-response)

---

### 💻 Implementation Context (Amelia)

**Source Files to Create/Modify:**

| File                                        | Action | Lines (est.) |
| ------------------------------------------- | ------ | ------------ |
| `src/utils/chatResponseBuilder.ts`          | CREATE | ~80          |
| `src/types/chatTypes.ts`                    | MODIFY | +15          |
| `src/__tests__/chatResponseBuilder.test.ts` | CREATE | ~150         |

**Implementation: chatResponseBuilder.ts**

```typescript
import { SEVERITY, SECTION } from "../config/chatEmoji";
import type { Finding } from "../types/chatTypes";

/**
 * Builder utility for constructing consistent chat responses.
 * Implements the verdict-first response structure from UX specification.
 *
 * @example
 * const response = new ChatResponseBuilder()
 *   .addVerdictLine('issues', 'Analysis Complete')
 *   .addSummaryStats(15, 2, 3)
 *   .addFindingsSection('Critical Issues', SEVERITY.critical, criticalFindings)
 *   .addPositiveNotes(['Clean separation of concerns'])
 *   .addFollowupPrompt('Ready for review.')
 *   .build();
 *
 * @see docs/ux-design-specification.md#design-direction-decision
 */
export class ChatResponseBuilder {
  private sections: string[] = [];

  /**
   * Add the opening verdict line with status emoji.
   * @param status - 'success' (✅), 'issues' (🔍), or 'cancelled' (💬)
   * @param summary - Text to display after emoji (e.g., "Analysis Complete")
   */
  addVerdictLine(
    status: "success" | "issues" | "cancelled",
    summary: string
  ): this {
    const emoji =
      status === "success"
        ? SEVERITY.success
        : status === "issues"
        ? "🔍"
        : "💬";
    this.sections.push(`## ${emoji} ${summary}\n`);
    return this;
  }

  /**
   * Add the summary statistics bar.
   * @param filesAnalyzed - Number of files analyzed
   * @param critical - Number of critical issues
   * @param suggestions - Number of suggestions
   */
  addSummaryStats(
    filesAnalyzed: number,
    critical: number,
    suggestions: number
  ): this {
    this.sections.push(
      `\n${SECTION.summary} **${filesAnalyzed} files** analyzed | **${critical}** critical | **${suggestions}** suggestions\n`
    );
    return this;
  }

  /**
   * Add a findings section with title and finding cards.
   * Does nothing if findings array is empty.
   * @param title - Section title (e.g., "Critical Issues")
   * @param emoji - Emoji to prefix title (use SEVERITY constants)
   * @param findings - Array of Finding objects
   */
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

  /**
   * Add the "What's Good" positive notes section.
   * Does nothing if notes array is empty.
   * Supports emotional design by highlighting positives.
   * @param notes - Array of positive observations
   */
  addPositiveNotes(notes: string[]): this {
    if (notes.length === 0) return this;
    this.sections.push(`\n---\n\n### ${SEVERITY.success} What's Good\n\n`);
    for (const note of notes) {
      this.sections.push(`- ${note}\n`);
    }
    return this;
  }

  /**
   * Add the closing follow-up prompt line.
   * @param summary - Closing message (e.g., "Ready for review.")
   */
  addFollowupPrompt(summary: string): this {
    this.sections.push(`\n---\n\n${SECTION.summary} ${summary}\n`);
    return this;
  }

  /**
   * Build and return the complete markdown response.
   * @returns Concatenated markdown string
   */
  build(): string {
    return this.sections.join("");
  }
}
```

**Implementation: Finding Interface Addition to chatTypes.ts**

```typescript
// Add to existing src/types/chatTypes.ts after ChatToolCallHandler

/**
 * Represents a single finding (issue or suggestion) in analysis results.
 * Used by ChatResponseBuilder to format finding cards.
 */
export interface Finding {
  /** Display title for the finding (e.g., "SQL Injection Risk") */
  title: string;
  /** File location display text (e.g., "handler.ts#L45") */
  location: string;
  /** Markdown anchor link (e.g., "src/auth/handler.ts#L45") */
  anchor: string;
  /** Description text explaining the issue and guidance */
  description: string;
}
```

**Estimated Total Changes:**

- ~80 lines in chatResponseBuilder.ts
- ~15 lines addition to chatTypes.ts
- ~150 lines in tests
- **Net new: ~245 lines**

---

### 🧪 Testing Context (Murat)

**Risk Assessment: LOW**

Pure utility class with no external dependencies (only imports emoji constants).

**Test Coverage Requirements:**

| Component           | Test Cases | Coverage Target |
| ------------------- | ---------- | --------------- |
| ChatResponseBuilder | 18+        | 100%            |

**Test File: `src/__tests__/chatResponseBuilder.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { ChatResponseBuilder } from "../utils/chatResponseBuilder";
import { SEVERITY, SECTION } from "../config/chatEmoji";
import type { Finding } from "../types/chatTypes";

describe("ChatResponseBuilder", () => {
  describe("addVerdictLine", () => {
    it("should render success status with checkmark emoji", () => {
      const result = new ChatResponseBuilder()
        .addVerdictLine("success", "Looking good!")
        .build();
      expect(result).toBe("## ✅ Looking good!\n");
    });

    it("should render issues status with search emoji", () => {
      const result = new ChatResponseBuilder()
        .addVerdictLine("issues", "Analysis Complete")
        .build();
      expect(result).toBe("## 🔍 Analysis Complete\n");
    });

    it("should render cancelled status with speech bubble emoji", () => {
      const result = new ChatResponseBuilder()
        .addVerdictLine("cancelled", "Analysis paused")
        .build();
      expect(result).toBe("## 💬 Analysis paused\n");
    });
  });

  describe("addSummaryStats", () => {
    it("should render stats in correct format", () => {
      const result = new ChatResponseBuilder()
        .addSummaryStats(15, 2, 3)
        .build();
      expect(result).toContain("📊 **15 files** analyzed");
      expect(result).toContain("**2** critical");
      expect(result).toContain("**3** suggestions");
    });

    it("should handle zero values", () => {
      const result = new ChatResponseBuilder().addSummaryStats(0, 0, 0).build();
      expect(result).toContain("**0 files**");
      expect(result).toContain("**0** critical");
    });
  });

  describe("addFindingsSection", () => {
    it("should not render section for empty findings", () => {
      const result = new ChatResponseBuilder()
        .addFindingsSection("Critical Issues", SEVERITY.critical, [])
        .build();
      expect(result).toBe("");
    });

    it("should render single finding in card format", () => {
      const findings: Finding[] = [
        {
          title: "SQL Injection Risk",
          location: "handler.ts#L45",
          anchor: "src/auth/handler.ts#L45",
          description: "User input not sanitized.",
        },
      ];
      const result = new ChatResponseBuilder()
        .addFindingsSection("Critical Issues", SEVERITY.critical, findings)
        .build();

      expect(result).toContain("### 🔴 Critical Issues");
      expect(result).toContain(
        "**SQL Injection Risk** in [handler.ts#L45](src/auth/handler.ts#L45)"
      );
      expect(result).toContain("User input not sanitized.");
    });

    it("should render multiple findings with separation", () => {
      const findings: Finding[] = [
        {
          title: "Issue 1",
          location: "a.ts#L1",
          anchor: "a.ts#L1",
          description: "Desc 1",
        },
        {
          title: "Issue 2",
          location: "b.ts#L2",
          anchor: "b.ts#L2",
          description: "Desc 2",
        },
      ];
      const result = new ChatResponseBuilder()
        .addFindingsSection("Issues", "🔴", findings)
        .build();

      expect(result).toContain("**Issue 1**");
      expect(result).toContain("**Issue 2**");
    });

    it("should include horizontal rule before section", () => {
      const findings: Finding[] = [
        {
          title: "Test",
          location: "x.ts#L1",
          anchor: "x.ts#L1",
          description: "Test",
        },
      ];
      const result = new ChatResponseBuilder()
        .addFindingsSection("Test", "🔴", findings)
        .build();

      expect(result).toContain("---");
    });
  });

  describe("addPositiveNotes", () => {
    it("should not render section for empty notes", () => {
      const result = new ChatResponseBuilder().addPositiveNotes([]).build();
      expect(result).toBe("");
    });

    it("should render single note as bullet", () => {
      const result = new ChatResponseBuilder()
        .addPositiveNotes(["Good separation of concerns"])
        .build();
      expect(result).toContain("### ✅ What's Good");
      expect(result).toContain("- Good separation of concerns");
    });

    it("should render multiple notes as bullet list", () => {
      const result = new ChatResponseBuilder()
        .addPositiveNotes(["Note 1", "Note 2", "Note 3"])
        .build();
      expect(result).toContain("- Note 1");
      expect(result).toContain("- Note 2");
      expect(result).toContain("- Note 3");
    });
  });

  describe("addFollowupPrompt", () => {
    it("should render with summary emoji and horizontal rule", () => {
      const result = new ChatResponseBuilder()
        .addFollowupPrompt("Ready for review.")
        .build();
      expect(result).toContain("---");
      expect(result).toContain("📊 Ready for review.");
    });
  });

  describe("build (integration)", () => {
    it("should build complete response with all sections", () => {
      const findings: Finding[] = [
        {
          title: "Issue",
          location: "x.ts#L1",
          anchor: "x.ts#L1",
          description: "Desc",
        },
      ];

      const result = new ChatResponseBuilder()
        .addVerdictLine("issues", "Analysis Complete")
        .addSummaryStats(10, 1, 2)
        .addFindingsSection("Critical", SEVERITY.critical, findings)
        .addPositiveNotes(["Good work"])
        .addFollowupPrompt("Done.")
        .build();

      // Verify order: verdict first, stats second, findings, positives, prompt last
      const verdictIndex = result.indexOf("## 🔍");
      const statsIndex = result.indexOf("📊 **10 files**");
      const findingsIndex = result.indexOf("### 🔴");
      const positivesIndex = result.indexOf("### ✅ What's Good");
      const promptIndex = result.lastIndexOf("📊");

      expect(verdictIndex).toBeLessThan(statsIndex);
      expect(statsIndex).toBeLessThan(findingsIndex);
      expect(findingsIndex).toBeLessThan(positivesIndex);
      expect(positivesIndex).toBeLessThan(promptIndex);
    });

    it("should support method chaining (fluent API)", () => {
      const builder = new ChatResponseBuilder();
      const result = builder
        .addVerdictLine("success", "Test")
        .addSummaryStats(1, 0, 0)
        .build();

      expect(result).toBeTruthy();
    });

    it("should build partial response when some sections omitted", () => {
      const result = new ChatResponseBuilder()
        .addVerdictLine("success", "All good!")
        .addSummaryStats(5, 0, 0)
        .addFollowupPrompt("Nothing to fix.")
        .build();

      expect(result).toContain("✅ All good!");
      expect(result).not.toContain("Critical");
      expect(result).not.toContain("What's Good");
    });
  });
});
```

**Verification Commands:**

```bash
npm run check-types                # Must pass with no errors
npx vitest run src/__tests__/chatResponseBuilder.test.ts
npm run test                       # All tests must pass
```

---

## Technical Requirements

### File Locations

| File                   | Location         | Purpose                      |
| ---------------------- | ---------------- | ---------------------------- |
| chatResponseBuilder.ts | `src/utils/`     | Follows diffUtils.ts pattern |
| chatTypes.ts (modify)  | `src/types/`     | Add Finding interface        |
| Tests                  | `src/__tests__/` | Standard test location       |

### Import Structure

```typescript
// In chatResponseBuilder.ts
import { SEVERITY, SECTION } from "../config/chatEmoji";
import type { Finding } from "../types/chatTypes";

// In tests
import { ChatResponseBuilder } from "../utils/chatResponseBuilder";
import { SEVERITY, SECTION } from "../config/chatEmoji";
import type { Finding } from "../types/chatTypes";
```

### Type Exports

From `chatTypes.ts` (additions):

- `Finding` (interface)

From `chatResponseBuilder.ts`:

- `ChatResponseBuilder` (class)

---

## Tasks / Subtasks

### Task 1: Add Finding Interface (AC: 0.5.2)

- [x] Open `src/types/chatTypes.ts`
- [x] Add Finding interface after ChatToolCallHandler
- [x] Add JSDoc comments explaining each property
- [x] Verify with `npm run check-types`

### Task 2: Create ChatResponseBuilder (AC: 0.5.1, 0.5.3, 0.5.4, 0.5.5)

- [x] Create `src/utils/chatResponseBuilder.ts`
- [x] Import SEVERITY and SECTION from chatEmoji.ts
- [x] Import Finding type from chatTypes.ts
- [x] Implement addVerdictLine() with status emoji mapping
- [x] Implement addSummaryStats() with proper format
- [x] Implement addFindingsSection() with card format
- [x] Implement addPositiveNotes() with bullet list
- [x] Implement addFollowupPrompt() with summary emoji
- [x] Implement build() returning joined sections
- [x] Add comprehensive JSDoc with @example
- [x] Verify with `npm run check-types`

### Task 3: Create Unit Tests (AC: 0.5.6)

- [x] Create `src/__tests__/chatResponseBuilder.test.ts`
- [x] Test addVerdictLine for all three statuses
- [x] Test addSummaryStats format and zero handling
- [x] Test addFindingsSection empty/single/multiple cases
- [x] Test addPositiveNotes empty/single/multiple cases
- [x] Test addFollowupPrompt format
- [x] Test build() integration with ordering
- [x] Test fluent API chaining
- [x] Run tests: `npx vitest run src/__tests__/chatResponseBuilder.test.ts`

### Task 4: Verification (AC: All)

- [x] Run `npm run check-types` - must pass with no errors
- [x] Run `npx vitest run src/__tests__/chatResponseBuilder.test.ts` - all pass
- [x] Run `npm run test` - full suite must pass
- [x] Verify no circular dependencies introduced

---

## Dev Notes

### Integration Clarification (Added 2025-12-15)

**Critical: ChatResponseBuilder is for EXTENSION-GENERATED messages only**

Per Architecture Decision 11 (Hybrid Output Approach), this utility is NOT used to reformat or parse LLM output. The LLM analysis content streams as-is via `stream.markdown()`.

| Message Type           | Uses ChatResponseBuilder? | Method                    |
| ---------------------- | ------------------------- | ------------------------- |
| Greeting/intro         | ✅ Yes                    | Custom greeting method    |
| Progress updates       | ❌ No                     | `DebouncedStreamHandler`  |
| LLM analysis findings  | ❌ No                     | `stream.markdown()` raw   |
| Summary after analysis | ✅ Yes                    | `addSummaryStats()`, etc. |
| Error messages         | ✅ Yes                    | Custom error method       |
| Follow-up chips        | ❌ No                     | `stream.button()`         |

**Why This Approach:**

1. **Smaller LLMs don't follow output formats reliably** - We can't parse or restructure LLM output
2. **We control the bookends** - Greeting, summary, errors are always consistent
3. **LLM controls the core** - Analysis content is the LLM's responsibility
4. **System prompt = best effort** - We ask for emoji severity, but can't enforce

**Integration Pattern (Story 2.1):**

```typescript
// 1. Extension-controlled greeting (uses ChatResponseBuilder)
const greeting = new ChatResponseBuilder()
  .addVerdictLine("issues", "Analyzing your changes...")
  .build();
stream.markdown(greeting);

// 2. LLM-controlled analysis (streams as-is)
for await (const chunk of llmResponse) {
  stream.markdown(chunk);
}

// 3. Extension-controlled summary (uses ChatResponseBuilder)
const summary = new ChatResponseBuilder()
  .addSummaryStats(fileCount, criticalCount, suggestionCount)
  .addFollowupPrompt("Analysis complete.")
  .build();
stream.markdown(summary);
```

**Testing Implications:**

- Test `ChatResponseBuilder` formatting thoroughly (we control it)
- Do NOT test LLM output format compliance (we don't control it)

### Critical Implementation Details

1. **Emoji Source:**

   - Use `SEVERITY.success` from chatEmoji.ts for ✅
   - Use `SECTION.summary` from chatEmoji.ts for 📊
   - Use literal `'🔍'` for issues (not in SEVERITY)
   - Use literal `'💬'` for cancelled (not in constants)

2. **Empty Array Handling:**

   - `addFindingsSection([])` → returns `this` silently, no output
   - `addPositiveNotes([])` → returns `this` silently, no output
   - This is intentional for optional sections

3. **Horizontal Rules:**

   - Include `\n---\n\n` before sections (findingsSection, positiveNotes, followupPrompt)
   - Verdict and stats don't need preceding rules

4. **Finding Card Format:**

   ```
   **{title}** in [{location}]({anchor})
   {description}

   ```

   Note the blank line after description for proper markdown spacing.

5. **Heading Hierarchy:**
   - `##` only for verdict line
   - `###` for all section titles
   - Never `#` or `####`

### Previous Story Intelligence

**From Story 0.4:**

- Created `src/config/chatEmoji.ts` with SEVERITY, ACTIVITY, SECTION constants
- Created `src/types/chatTypes.ts` with ChatToolCallHandler interface
- Created `src/models/debouncedStreamHandler.ts`
- All 751 tests pass

**Git Commit Pattern (from Story 0.4):**

```
feat(utils): add ChatResponseBuilder for consistent response formatting (Story 0.5)
```

### Files to Create

| File                                        | Description                   |
| ------------------------------------------- | ----------------------------- |
| `src/utils/chatResponseBuilder.ts`          | Builder class with fluent API |
| `src/__tests__/chatResponseBuilder.test.ts` | Unit tests (~18 test cases)   |

### Files to Modify

| File                     | Changes                           |
| ------------------------ | --------------------------------- |
| `src/types/chatTypes.ts` | Add Finding interface (~15 lines) |

### Project Structure Notes

**Alignment with Existing Patterns:**

- `src/utils/` contains `diffUtils.ts` - chatResponseBuilder follows same pattern
- Pure utility class, no VS Code dependencies
- Exports class and uses type imports

**No Circular Dependencies:**

- chatResponseBuilder.ts → chatEmoji.ts (constants only)
- chatResponseBuilder.ts → chatTypes.ts (type import only)
- Neither file imports back

### Future Integration

Story 2.1 (Rich Progress Visualization) will:

- Import ChatResponseBuilder from utils
- Use it in ChatStreamHandler to format final output
- Pass Finding objects from analysis results

Story 1.2 (/branch command) will:

- Use ChatResponseBuilder in ChatParticipantService
- Format all analysis responses consistently

### References

- [Architecture Decision 8](docs/architecture.md) - Response Formatting Pattern
- [Architecture Decision 9](docs/architecture.md) - Emoji Design System Constants
- [UX Spec: Design Direction](docs/ux-design-specification.md#design-direction-decision) - Response structure
- [UX Spec: Emotional Design](docs/ux-design-specification.md#desired-emotional-response) - Supportive tone
- [Epic 0 Story 0.5](docs/epics.md#story-05-create-chatresponsebuilder-utility-ux-formatting) - Story definition
- [UX-FR-001, UX-FR-005, UX-FR-006, UX-NFR-003, UX-NFR-004](docs/epics.md#ux-design-requirements-from-ux-design-specification) - UX requirements

---

## Dev Agent Record

### Context Reference

Story created via BMAD create-story workflow with Party Mode analysis from:

- 🏗️ Winston (Architect) - Builder pattern design, location decision
- 🎨 Sally (UX Designer) - Response structure, emotional design, finding format
- 🧪 Murat (Test Architect) - Test coverage requirements, risk assessment
- 💻 Amelia (Dev) - Implementation code, file structure

### Agent Model Used

Claude Opus 4.5 (Preview)

### Debug Log References

N/A - Story creation phase

### Completion Notes List

- ✅ Implemented Finding interface in chatTypes.ts with JSDoc documentation
- ✅ Created ChatResponseBuilder with fluent API (6 methods, all returning `this` for chaining)
- ✅ Verdict line uses discriminated status type with correct emoji mapping (✅/🔍/💬)
- ✅ Empty array handling silently skips sections (no output for empty findings/notes)
- ✅ Horizontal rules properly placed before sections per UX spec
- ✅ All 28 unit tests pass covering all acceptance criteria
- ✅ Full test suite passes (779 tests, 59 files)
- ✅ No circular dependencies - verified clean import chain
- ✅ **Code review refinements (2025-12-17):**
  - Fixed grammatical error: singular "file" vs plural "files" in stats
  - Added 2 pluralization tests
  - Removed unnecessary defensive validation (internal utility, TypeScript enforces types)
- ✅ Final: 30 tests pass, all meaningful, no defensive boilerplate

### Senior Developer Review (AI)

**Reviewed by:** Igor on 2025-12-17
**Status:** ✅ Approved - Simplified and Production-Ready

#### Real Issues Found and Fixed (2 meaningful fixes)

**Fixed:**

1. **Grammatical Error** - "1 files" → "1 file" (added pluralization logic)

**Removed (Unnecessary):**

- Defensive validation (empty strings, negative numbers) - TypeScript handles this
- 6 validation tests that tested runtime checks TypeScript already prevents

**Rationale:** This is an internal utility consumed by code we control. TypeScript's type system is the validation. The builder pattern should be forgiving and simple, not defensive.

**Verification:**

- ✅ 30 meaningful tests pass (4 verdict, 6 stats, 6 findings, 6 notes, 3 followup, 5 integration)
- ✅ Full test suite: 793 tests pass, 0 failures
- ✅ TypeScript compilation: No errors
- ✅ All Acceptance Criteria verified as implemented
- ✅ Cleaner, more maintainable code

### Change Log

| Date       | Author       | Changes                                                    |
| ---------- | ------------ | ---------------------------------------------------------- |
| 2025-12-16 | Bob (SM)     | Initial story creation with party mode analysis            |
| 2025-12-16 | Amelia (Dev) | Implemented all ACs, 28 tests pass, story ready for review |
| 2025-12-17 | Igor (Dev)   | Code review: pluralization fix → DONE                      |

### File List

| File                                        | Status   | Description                                       |
| ------------------------------------------- | -------- | ------------------------------------------------- |
| `src/types/chatTypes.ts`                    | Modified | Added Finding interface (~15 lines)               |
| `src/utils/chatResponseBuilder.ts`          | Created  | Builder class (~95 lines, clean and focused)      |
| `src/__tests__/chatResponseBuilder.test.ts` | Created  | Unit tests (30 meaningful test cases, ~200 lines) |
