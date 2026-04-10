---
name: code-review
description: Conduct comprehensive code review of branch changes against main branch using massive parallel subagent orchestration. Use this skill when reviewing code changes on a feature branch, performing security audits, checking TypeScript best practices, detecting AI slop, or finding code duplication. Also use when the user says things like "review my PR", "check my code", "look at the diff", "what do you think of these changes", "review the branch", "code quality check", or any request to examine recent code changes — even casual ones.
---

# Code Review

Conduct thorough code reviews using massive parallel subagent orchestration. This skill is tuned for Lupa — a VS Code extension for PR analysis — where code is primarily written by Claude Opus 4.6 and must be well-understood by humans.

## Quick Reference

| Phase             | Action                                   | Tools                                  |
| ----------------- | ---------------------------------------- | -------------------------------------- |
| Discovery         | Get changed files, assess scope          | `get_changed_files`, `runSubagent`     |
| File Analysis     | Spawn per-file and per-concern subagents | `runSubagent` (parallel)               |
| External Research | Verify findings with docs, patterns      | DeepWiki, Tavily, `sequentialthinking` |
| Synthesis         | Cross-reference, prioritize, deduplicate | `sequentialthinking`                   |
| Auto-Fix          | Remove obvious comments, verify types    | `replace_string_in_file`, terminal     |
| Report            | Categorize findings by severity          | —                                      |

## Project Context

Lupa is a TypeScript VS Code extension using tool-calling architecture. Before reviewing, load project conventions from [lupa-conventions.md](references/lupa-conventions.md) — the most common review misses come from ignoring project-specific patterns like centralized error handling in ToolExecutor, CancellationToken semantics, and path resolution via Git root.

Since the code is written by Claude Opus 4.6, the reviewer (also an LLM) shares the same biases as the author. See [claude-patterns.md](references/claude-patterns.md) for patterns to actively watch for — especially over-engineering, unnecessary defensive coding, and confirmation bias.

## Core Workflow

### Phase 1: Discovery & Scoping

1. **Get branch diff**: Call `get_changed_files` comparing current branch to main
2. **Assess scope** and choose strategy:

| PR Size | Files | Strategy                                                                              |
| ------- | ----- | ------------------------------------------------------------------------------------- |
| Small   | 1-10  | Full analysis per file — spawn one subagent per file plus per-concern subagents       |
| Medium  | 10-30 | Group by directory/module. Prioritize `.ts` files over config/docs                    |
| Large   | 30+   | Skim-then-deep — quick pass to identify hot spots, then deep-dive critical files only |

3. **Handle edge cases**:
    - Empty diff → report "no changes found on this branch vs main" and stop
    - Only config/doc changes → lighter review, skip security analysis

### Phase 2: Parallel File Analysis

Spawn one dedicated subagent per changed file. Each subagent gets a focused task and a fresh context window (which is why parallelization matters — no context pollution across files).

Before spawning subagents, read the full file content (or at minimum the changed functions/classes with surrounding context) — not just the diff. Diffs alone miss convention violations that require understanding the broader function or class structure. Pass both the diff and relevant file context to each subagent.

For each file, spawn these subagents simultaneously:

| Subagent Type     | Focus                              | Template Reference                                                          |
| ----------------- | ---------------------------------- | --------------------------------------------------------------------------- |
| File Analyzer     | Bugs, types, conventions, style    | [subagent-templates.md](references/subagent-templates.md#file-analyzer)     |
| Pattern Finder    | DRY violations, existing utilities | [subagent-templates.md](references/subagent-templates.md#pattern-finder)    |
| Usage Tracer      | Impact on callers of changed APIs  | [subagent-templates.md](references/subagent-templates.md#usage-tracer)      |
| Security Reviewer | Extension-specific vulnerabilities | [subagent-templates.md](references/subagent-templates.md#security-reviewer) |

Additional specialized subagents (SOLID/DRY Checker, Slop Detector, Test Reviewer) can be spawned for relevant files — see [subagent-templates.md](references/subagent-templates.md) for the full template list. Spawn Test Reviewer subagents for any changed test files.

Don't limit subagent count for small and medium PRs — parallel analysis catches cross-cutting issues that sequential review misses, and each subagent gets a fresh context window. For large PRs (30+ files), focus parallel subagents on high-risk files (new code, security-relevant, complex logic) and use lighter single-subagent analysis for config, documentation, and simple test files.

If a subagent fails or returns empty results, log it and continue with others. Missing one file's analysis is better than halting the entire review.

### Phase 3: External Research

When subagent findings reference unfamiliar patterns or libraries:

- **DeepWiki** for framework questions (e.g., `microsoft/vscode` for extension API, `vitest-dev/vitest` for testing)
- **Tavily** for recent changes, security advisories, or patterns not in DeepWiki
- **Sequential thinking** for architectural decisions or complex trade-off analysis

Skip external research for findings already well-understood from codebase context — it takes time and not every finding needs verification.

### Phase 4: Synthesis

Use sequential thinking before writing the final report. Aggregating findings across many subagents requires structured reasoning to:

- Deduplicate findings reported by multiple subagents
- Cross-reference related issues (e.g., a missing error handler + an untested error path)
- Promote findings that affect multiple files
- Ensure branch-change findings are prioritized over pre-existing issues

### Phase 5: Auto-Fix & Verify

Remove obvious comments (the kind that restate the code) without asking — see [slop-patterns.md](references/slop-patterns.md) for the full pattern list. Only auto-remove HIGH confidence, positive impact patterns.

**After auto-fixes, run `npm run check-types`** to verify nothing broke. If types fail, revert the offending auto-fix and flag it for manual review instead. This verification step matters because comment removal can occasionally break template literals, JSX, or conditional blocks.

### Phase 6: Report

Structure findings by severity, with file:line references for every item:

```markdown
## Code Review Summary

### Overview

[Brief assessment: scope of changes, risk level, overall quality]

### Critical Findings (Block Merge)

- [file:line] SECURITY/BUG: {issue} — {why this matters}

### High Priority (Should Fix)

- [file:line] {category}: {issue} — {suggestion}

### Medium Priority (Should Fix Soon)

- [file:line] {category}: {issue} — {suggestion}

### Low Priority (Nice to Have)

- [file:line] {category}: {issue} — {suggestion}

### Code Duplication Opportunities

- {new pattern} already exists at {existing path}

### Auto-Fixes Applied

- Removed {N} obvious comments in {files}
- Type check: PASSED / FAILED (details)

### Test Coverage Gaps

- {changed behavior} lacks test for {scenario}

### Recommendations

[Actionable items, ordered by impact]
```

## Quality Detection

### Lupa Conventions

See [lupa-conventions.md](references/lupa-conventions.md) for the full checklist. Key items reviewers most often miss:

- Tools should NOT have try-catch blocks — ToolExecutor handles errors centrally
- VS Code APIs return `undefined` on cancellation, they don't throw CancellationError
- Use Git root for path resolution, never workspace folders
- Use `Log` for logging (except webviews which use `console.log`)

### Security (VS Code Extension Surface)

See [security-checklist.md](references/security-checklist.md). Focus areas:

- Command injection via `child_process` (ripgrep spawning)
- Path traversal in file operations
- Secrets leaking into LLM prompts or logs
- XSS in webview content
- Prompt injection in tool outputs

### TypeScript Best Practices

See [lupa-conventions.md](references/lupa-conventions.md) for the full list. Most commonly missed in this codebase:

- Async/await opportunities in newly added tools — check for sequential operations that could be parallelized
- `any` type sneaking in via third-party library returns
- Non-exhaustive switch statements on union types

### SOLID/DRY Violations

Focus on the principles that surface most in this codebase:

- **Single Responsibility**: Functions/classes doing too much
- **Dependency Inversion**: Concrete dependencies instead of abstractions
- **DRY**: Search for existing utilities before flagging — Lupa has shared helpers in `utils/`

### Test Quality

- Are tests present for changed behavior?
- Do tests use shared mock factories from `testUtils/mockFactories.ts`?
- Do constructor mocks use `function` syntax (Vitest 4 requirement)?
- Do tests avoid mocking VS Code APIs to throw CancellationError (use pre-cancelled tokens instead)?

## AI Self-Review

This code is written by Claude Opus 4.6 and reviewed by an LLM. The reviewer shares the author's biases — see [claude-patterns.md](references/claude-patterns.md) for detection patterns. Key questions for every finding:

1. **Is this abstraction justified?** Or does it just feel "structurally correct"?
2. **Is this error handling needed?** Given ToolExecutor's centralized handling, most tool try-catch blocks are unnecessary.
3. **Would a human write this?** Over-verbose naming, excessive JSDoc, factory patterns for single implementations — these are LLM tells.
4. **What's NOT being caught?** Claude tends to produce structurally perfect code that misses subtle semantic bugs — especially in async/cancellation/state-rollback scenarios.

## AI Slop Detection

| Category         | Examples                                | Action      |
| ---------------- | --------------------------------------- | ----------- |
| Obvious Comments | `// increment counter`                  | AUTO-REMOVE |
| Type Restating   | JSDoc that restates types               | FLAG        |
| Over-Abstraction | Factory for 1 implementation            | FLAG        |
| Magic Values     | Hardcoded strings/numbers               | FLAG        |
| Vibe-Coding      | `// TODO: fix later`                    | FLAG        |
| Over-Defensive   | Try-catch where caller handles errors   | FLAG        |
| Verbose Naming   | `handleUserDataProcessingAndValidation` | FLAG        |

See [slop-patterns.md](references/slop-patterns.md) for complete detection rules.

## Subagent Task Format

Every subagent task should include:

```
Research only (do not edit files).
{specific_investigation_task}

Context:
{relevant_changes_or_code}

Key Lupa conventions to check:
- ToolExecutor handles errors centrally — tools should NOT have try-catch wrapping execute()
- VS Code APIs return undefined on cancellation, don't throw CancellationError
- Use Git root for paths, never workspace folders
- Use Log from loggingService, not console.log (except webviews)
- Use toolSuccess()/toolError() for return values

Return:
- file: {path}
- line: {number}
- severity: CRITICAL|HIGH|MEDIUM|LOW
- category: security|bug|style|slop|duplication|convention
- issue: {description}
- suggestion: {fix or recommendation}
```

See [subagent-templates.md](references/subagent-templates.md) for ready-to-use templates.

## Prioritization

1. **Branch changes** over pre-existing issues — the goal is reviewing what changed, not auditing the entire repo. Pre-existing issues should only be mentioned when they interact with the changes.
2. **Critical findings** first — security vulnerabilities, data loss risks, and crashes can't ship. Everything else can be iterated on.
3. **Convention violations** in new code — these compound over time. Catching them now prevents patterns from spreading.
4. **Affected callers** of changed functions — ripple effects are easy to miss and cause production issues.
5. **Style and slop** last — important for maintainability but won't break anything in production.
