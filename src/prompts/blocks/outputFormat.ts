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

### Summary (Required)
> **TL;DR**: 2-3 sentences describing what this PR does and your assessment.
>
> **Risk Level**: Low / Medium / High / Critical
> **Recommendation**: Approve / Approve with suggestions / Request changes / Block

### Critical Issues (If Any)
> 🔴 **CRITICAL: [Title]**
>
> **Location**: [src/path/file.ts:42](src/path/file.ts:42)
> **Issue**: Clear description
> **Impact**: What happens if unfixed
> **Fix**:
> \`\`\`typescript
> // corrected code
> \`\`\`

### Suggestions by Category

**Security**
- 🟠 **Issue** at [file.ts:15](file.ts:15) - Recommendation

**Performance**
- 🟡 **Issue** at [file.ts:30](file.ts:30) - Recommendation

**Code Quality**
- 🟢 **Issue** at [file.ts:45](file.ts:45) - Recommendation

### Test Considerations
- What tests should be added?
- Edge cases needing coverage?

### What's Good (REQUIRED)
Always note at least one positive:
- Good pattern at [file.ts:20](file.ts:20)
- Clean implementation of [feature]

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
