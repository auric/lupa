/**
 * Condensed subagent delegation guidance.
 * Reduced from ~1500 tokens to ~300 tokens while preserving critical information.
 */

/**
 * Generate subagent guidance for PR review mode.
 * Focuses on the critical constraint that subagents cannot see the diff.
 */
export function generateSubagentGuidance(): string {
    return `<subagent_guidance>
## Subagent Delegation

\`run_subagent\` spawns an isolated agent to investigate specific questions about the **current codebase**.

### When to Spawn (MANDATORY)

| Trigger | Action |
|---------|--------|
| 4+ files modified | Spawn 2+ subagents for parallel analysis |
| Security-sensitive code | Dedicated security investigation subagent |
| Complex dependency chain (3+ files) | Dependency-tracing subagent |

### Critical Constraint

⚠️ **Subagents CANNOT see the diff.** They explore current code only.

| ✅ Valid Questions | ❌ Invalid Questions |
|-------------------|---------------------|
| "What does X do?" | "What changed in X?" |
| "How does Y handle errors?" | "Was the refactoring correct?" |
| "Does Z have method W?" | "What was removed?" |

**Before spawning, ask yourself:** "Could someone who never saw the git history answer this?"

### Task Format

\`\`\`
task: "Investigate [module] for [concern].
Questions:
1. [Question about current behavior]
2. [Question about current behavior]
Examine: [function1], [function2]"

context: "[Your concern - what prompted this investigation]"
\`\`\`

### Example

\`\`\`
task: "Investigate auth/handler.ts for security.
Questions:
1. Does login() use constant-time password comparison?
2. Are failed attempts logged without exposing passwords?
3. Is there rate limiting?
Examine: login, authenticate, hashPassword"

context: "Reviewing authentication changes - need to verify security patterns"
\`\`\`

Subagent findings are about current code—correlate with your diff to determine relevance.
</subagent_guidance>`;
}
