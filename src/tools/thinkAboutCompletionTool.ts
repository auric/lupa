import * as z from 'zod';
import { BaseTool } from './baseTool';
import { ToolResult, toolSuccess } from '../types/toolResultTypes';

/**
 * Self-reflection tool for main agent: verifies analysis completeness.
 * Call when ready to provide final review to ensure nothing important was missed
 * and the feedback is well-structured and actionable.
 */
export class ThinkAboutCompletionTool extends BaseTool {
    name = 'think_about_completion';
    description =
        'Call this when you believe you are done to verify the analysis is complete. ' +
        'Helps ensure nothing important was missed before providing the final review.';

    schema = z.object({}).strict();

    async execute(): Promise<ToolResult> {
        return toolSuccess(`## Completion Verification

### Structure Check
My review includes:
□ Summary - 2-3 sentence TL;DR of the PR and key findings
□ Risk Assessment - Overall risk level of merging this PR
□ Critical Issues - Blocking problems (if any)
□ Suggestions - Organized by category with severity
□ Positive Observations - What was done well
□ Questions - Clarifications needed (if any)

### Quality Check
□ Every finding has a specific markdown file link
□ Code examples provided where helpful
□ Severity levels are justified and consistent
□ Recommendations are specific and actionable
□ No claims made without tool verification

### Completeness Check
□ All files in the diff were considered
□ Security implications were evaluated
□ Performance implications were considered
□ Breaking changes were identified (if any)
□ Test coverage implications noted

### Tone Check
□ Review is constructive and professional
□ Good practices are acknowledged
□ Criticism is specific, not personal
□ Provides clear path forward

### Format Check
□ Using Markdown (not XML tags)
□ Severity indicators: 🔴 Critical, 🟠 High, 🟡 Medium, 🟢 Low
□ File references in \`backticks\`
□ Code in fenced blocks with language

### Decision
- [ ] All checks pass → Submit final review
- [ ] Issues found → Fix before submitting

Ready to submit.`);
    }
}
