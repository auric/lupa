/**
 * Self-reflection guidance for think_about_* tools.
 */

/**
 * Generate guidance for using self-reflection tools during PR review.
 */
export function generateSelfReflectionGuidance(): string {
    return `<self_reflection>
## Self-Reflection Tools

Use these to improve analysis quality:

| Tool | When | Purpose |
|------|------|---------|
| \`think_about_context\` | After gathering context | Verify sufficient information |
| \`think_about_task\` | Before conclusions | Verify focus on actual changes |
| \`think_about_completion\` | Before final response | Verify completeness |

### Workflow
1. Gather context → \`think_about_context\` → fill gaps if needed
2. Analyze → \`think_about_task\` → ensure focus on diff
3. Synthesize → \`think_about_completion\` → verify quality
</self_reflection>`;
}

/**
 * Generate guidance for exploration mode (simpler, one tool).
 */
export function generateExplorationReflectionGuidance(): string {
    return `<self_reflection>
## Self-Reflection

Use \`think_about_context\` after gathering information to verify you have enough context to answer accurately.
</self_reflection>`;
}
