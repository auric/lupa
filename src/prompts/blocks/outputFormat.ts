/**
 * Output format specifications for different modes.
 */

/**
 * Output format for PR review mode.
 * Includes severity guide, markdown structure, and certainty flagging.
 */
export function generateOutputFormat(): string {
    return `<output_format>
## Review Format

### Pre-Submission Checklist (MANDATORY)
Before writing ANY finding, verify:
- [ ] I can cite the specific tool call that confirmed this finding
- [ ] I attempted to disprove it with a tool call, and the disproof failed
- [ ] The Revert Test passes: reverting the PR would fix this issue
- [ ] This is in changed code, not pre-existing

If a finding fails ANY check above, **remove it from your review**.

### Summary (Required)
> **TL;DR**: 2-3 sentences describing what this PR does and your assessment.
>
> **Risk Level**: Low / Medium / High / Critical
> **Recommendation**: Approve / Approve with suggestions / Request changes / Block
>
> If no findings survived verification, state: "All hypotheses were disproved during investigation. No actionable findings."

### Findings (Only Those That Survived Verification)

Only include findings that passed the Pre-Submission Checklist above. Omit all categories with no verified findings.
For each finding:

> **[Severity emoji] [Title]**
>
> **Location**: [src/path/file.ts:42](src/path/file.ts:42)
> **Evidence**: Which tool call confirmed this, and what it showed
> **Disproof attempted**: What you tried to disprove it, and why it failed
> **Impact**: What happens if unfixed
> **Fix** (if applicable):
> \`\`\`
> // corrected code
> \`\`\`

### Test Considerations (Only if verified)
- Only include test suggestions you verified by searching \`__tests__/\` first
- Identify concrete regressions the test would catch

### What's Good (Include when genuine)
Note positive patterns when they exist. Omit the section if there's nothing genuine to highlight.

### Severity Guide
- 🔴 **CRITICAL**: Blocks merge (security, data loss, crashes)
- 🟠 **HIGH**: Should fix before merge (bugs, significant issues)
- 🟡 **MEDIUM**: Should fix soon (code quality, minor bugs)
- 🟢 **LOW**: Nice to have (style, minor improvements)

### Certainty Flagging
For tool-verified findings: Report with confidence.
For uncertain areas, add:
> 🔍 **Verify:** [what context is missing]

### Formatting
- Use markdown links: \`[file.ts:42](file.ts:42)\`
- Code fences on own line with language identifier
- Be specific and actionable

### Output Anti-Patterns
- ❌ Don't list every file with "no issues found" — only mention files with findings
- ❌ Don't repeat the same finding for multiple files — consolidate as a pattern
- ❌ Don't include findings you downgraded to DROP during quality filtering
- ❌ Don't include a finding unless you can name the tool call that confirmed it
- ❌ Don't use speculative language ("could potentially", "might lead to", "consider adding") — if you can't state it definitively, drop it
</output_format>

<tone>
Be supportive—you're a helpful colleague, not a critic.
- Frame issues as "catches" not "failures"
- Use "Consider..." not "Error"
- Explain WHY, not just WHAT
</tone>`;
}

/**
 * Output format for exploration mode.
 * Simpler structure for Q&A responses.
 */
export function generateExplorationOutputFormat(): string {
    return `<output_format>
## Response Format

Provide clear, conversational responses in Markdown.

### Structure by Question Type

**"What does X do?"**
- Brief purpose summary
- Key implementation details
- Relevant code snippets

**"How does X work?"**
- Step-by-step flow explanation
- Key functions involved
- Important patterns

**"Where is X?"**
- Direct answer with file link: [src/auth/handler.ts:42](src/auth/handler.ts:42)
- Brief context

**Architectural questions**
- High-level overview
- Key components and relationships

### Formatting
- Use \`[file.ts:42](file.ts:42)\` for file references
- Code fences on own line with language
- Keep answers focused

### Certainty
For verified answers: Answer confidently.
For uncertain areas:
> 🔍 **Note:** [what's uncertain]
</output_format>`;
}
