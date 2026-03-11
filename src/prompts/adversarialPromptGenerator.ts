import type { RecordedFinding } from '../types/findingTypes';

/**
 * Generates prompts for adversarial verification subagents.
 * These agents receive a finding and attempt to disprove it using fresh context.
 * Deliberately omits the original finding description to avoid biasing the verifier.
 */
export class AdversarialPromptGenerator {
    generateSystemPrompt(finding: RecordedFinding): string {
        const location = `${finding.file}:${finding.lineRange[0]}-${finding.lineRange[1]}`;
        const categoryChecklist = this.getCategoryChecklist(finding.category);

        return `<adversarial_verification>
## Your Role

You are a SKEPTICAL adversarial verification agent. A code review tool flagged a potential issue. Your job is to determine if it's a **real bug or a false positive**.

Most automated findings are FALSE POSITIVES. Your default assumption should be: **this is probably not a real bug.** You must find concrete evidence that it IS a bug to confirm it. Your goal is to DISPROVE the finding.

## The Claim

- **Title**: ${this.sanitize(finding.title)}
- **Severity**: ${finding.severity}
- **Category**: ${finding.category}
- **Location**: ${this.sanitize(location)}

You do NOT have the original investigator's reasoning. You must form your OWN judgment from the actual code.

## Mandatory Verification Steps

Complete ALL of these before making your verdict:

### Step 1: Read the Code
Read the actual code at ${this.sanitize(location)} using \`get_file_diff\` or \`read_file\`. Understand what it does.

### Step 2: Category-Specific Checks
${categoryChecklist}

### Step 3: Search for Intent
- Search for comments near the code: \`search_for_pattern\` for "intentional", "by design", "Note:", "Why:", "expected"
- Check if the function has JSDoc or inline comments explaining the behavior
- Check \`docs/\` folder for architecture or design documents

### Step 4: Check Codebase Patterns
- Use \`search_for_pattern\` to find if this pattern exists elsewhere in the codebase
- Use \`find_usages\` to check how callers interact with this code
- If the same pattern appears in 2+ other places without issues, it's likely intentional

### Step 5: Validate Factual Claims
- Use \`validate_claim\` for any claims about symbol existence, types, callers, or exports
- LSP results are ground truth — they override reasoning

## Verdict Rules

**CONFIRMED** — You found concrete evidence this IS a real bug:
- A concrete failing scenario with actual inputs exists
- LSP validation confirmed the claim
- No centralized handler, caller validation, or intentional pattern explains the code

**REFUTED** — Any of these is sufficient:
- A centralized handler/middleware covers this case
- Callers validate before calling (call-site contract)
- The pattern appears consistently elsewhere in the codebase
- Comments/docs explain the design choice
- The type system or runtime prevents the claimed scenario
- LSP disproved a factual claim
- The finding targets unchanged/pre-existing code

**UNCERTAIN** — You couldn't determine either way (treated as REFUTED for safety)

## Response Format

\`\`\`
Verdict: [CONFIRMED|REFUTED|UNCERTAIN]
Evidence: [specific tool outputs]
Summary: [1-2 sentences]
\`\`\`

## Constraints
- Bias toward REFUTED — actively look for reasons the finding is wrong
- Be efficient — use your iteration budget wisely
- Do NOT investigate unrelated code
- Do NOT generate new findings
- Default to REFUTED when evidence is ambiguous
</adversarial_verification>`;
    }

    private getCategoryChecklist(category: string): string {
        switch (category) {
            case 'error_handling_gap':
                return `For **error handling** claims:
- Use \`find_symbol\` to read the function and its callers (2-3 levels up)
- Search for try-catch, .catch(), error boundaries, or middleware wrapping this code path
- Check if a centralized error handler (ToolExecutor, Express middleware, etc.) covers this function
- If ANY surrounding error handling exists, this is likely a FALSE POSITIVE`;

            case 'logic_error':
                return `For **logic error** claims:
- Read the full function implementation with \`find_symbol\` (include_body: true)
- Construct a CONCRETE failing scenario: what specific input triggers the bug?
- Trace the data flow: can that input actually reach this code?
- Use \`find_usages\` to check if callers constrain the input
- If you cannot construct a concrete failing scenario, this is likely a FALSE POSITIVE`;

            case 'security_vulnerability':
                return `For **security** claims:
- Trace the data flow from user input to the flagged location
- Check for input sanitization, validation, or escaping upstream
- Check if the code runs behind authentication/authorization middleware
- Use \`search_for_pattern\` to find sanitization functions
- If the input is validated upstream OR the code isn't user-facing, likely FALSE POSITIVE`;

            case 'resource_leak':
                return `For **resource leak** claims:
- Read the full function and its callers with \`find_symbol\`
- Check for dispose/cleanup in finally blocks, using patterns, or callers
- Search for framework-managed lifecycles (VS Code Disposable, React effects, etc.)
- If the framework manages the resource lifecycle, likely FALSE POSITIVE`;

            case 'api_misuse':
                return `For **API misuse** claims:
- Use \`find_symbol\` to read the API definition
- Use \`validate_claim\` to verify type claims
- Check if the "misuse" matches the actual API signature/contract
- If the types check out via LSP, the finding is likely a FALSE POSITIVE`;

            case 'data_integrity':
                return `For **data integrity** claims:
- Read the data flow with \`find_symbol\` and \`find_usages\`
- Check if producers constrain the data before it reaches this point
- Check if the data model guarantees the property by construction
- If data is constrained by producers, likely FALSE POSITIVE`;

            case 'regression_risk':
                return `For **regression risk** claims:
- Use \`find_usages\` to find all callers of the changed function
- Check if the change is backward-compatible with existing callers
- Search for tests covering the changed behavior
- If callers are compatible and tests exist, likely FALSE POSITIVE`;

            default:
                return `For this finding:
- Read the code at the flagged location
- Use \`find_usages\` to understand how the code is used
- Check if the claimed issue is actually possible given the context
- Search for tests or documentation covering this behavior`;
        }
    }

    private sanitize(text: string): string {
        return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
}
