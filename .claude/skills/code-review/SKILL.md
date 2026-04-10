---
name: code-review
description: Conduct comprehensive code review of branch changes against main branch using massive parallel subagent orchestration. Use this skill when (1) reviewing code changes on a feature branch, (2) performing security audits on recent changes, (3) checking TypeScript best practices compliance, (4) detecting and removing AI slop (obvious comments, over-abstraction), or (5) finding code duplication opportunities. This skill spawns unlimited parallel subagents for thorough research, uses DeepWiki/Tavily for external knowledge, and applies sequential thinking for deep analysis.
---

# Code Review

Conduct thorough code reviews using massive parallel subagent orchestration. Each subagent handles ONE focused subtask. No limits on subagent count—spawn as many as needed for comprehensive analysis.

## Quick Reference

| Phase         | Action                                  | Tools                                  |
| ------------- | --------------------------------------- | -------------------------------------- |
| Discovery     | Get changed files, spawn file analyzers | `get_changed_files`, `runSubagent`     |
| Research      | Find existing patterns, trace usages    | `runSubagent` (parallel)               |
| Deep Analysis | Verify findings, security review        | `sequentialthinking`, DeepWiki, Tavily |
| Auto-Fix      | Remove obvious comments                 | `replace_string_in_file`               |
| Synthesis     | Prioritize, categorize, report          | `sequentialthinking`                   |

## Core Workflow

### Phase 1: Discovery

1. **Get branch diff**: Call `get_changed_files` comparing current branch to main
2. **Spawn file analyzers**: For EACH changed file, spawn a dedicated subagent
3. **Spawn pattern researchers**: Parallel subagents to find existing implementations

```
FOR each changed_file IN diff:
    spawn_subagent(file_analysis_task(changed_file))
    spawn_subagent(pattern_research_task(changed_file))
    spawn_subagent(usage_tracing_task(changed_file))
```

### Phase 2: Parallel Research

Spawn ALL research subagents simultaneously:

| Subagent Type     | Focus                            | Template                                                                    |
| ----------------- | -------------------------------- | --------------------------------------------------------------------------- |
| File Analyzer     | Security, bugs, TypeScript, slop | [subagent-templates.md](references/subagent-templates.md#file-analyzer)     |
| Pattern Finder    | Existing implementations         | [subagent-templates.md](references/subagent-templates.md#pattern-finder)    |
| Usage Tracer      | Impact on callers                | [subagent-templates.md](references/subagent-templates.md#usage-tracer)      |
| Security Reviewer | Auth, injection, secrets         | [subagent-templates.md](references/subagent-templates.md#security-reviewer) |
| SOLID/DRY Checker | Principle violations             | [subagent-templates.md](references/subagent-templates.md#solid-dry-checker) |

**CRITICAL**: Do NOT limit subagent count. Spawn one per file, one per concern, one per research question.

### Phase 3: External Research Protocol

When subagent findings involve unfamiliar patterns:

```
IF unknown_library_or_api:
    1. DeepWiki: ask_question(repo_path, specific_question)
    2. IF insufficient: Tavily search for official docs

IF security_pattern_verification:
    1. DeepWiki for framework-specific security
    2. Tavily for OWASP patterns and CVEs

IF architectural_decision_validation:
    1. Sequential thinking to analyze implications
    2. Research best practices via Tavily
```

**DeepWiki repos**: `microsoft/vscode`, `vitest-dev/vitest`, `facebook/react`, etc.

### Phase 4: Deep Synthesis

**MANDATORY**: Use sequential thinking before final report.

```
sequential_thinking:
    1. Aggregate all subagent findings
    2. Cross-reference with codebase patterns
    3. Prioritize: branch_changes > codebase_issues
    4. Validate security findings
    5. Identify obvious comments for removal
    6. Formulate recommendations
```

### Phase 5: Auto-Fix

Remove obvious comments WITHOUT asking user:

```typescript
// These patterns trigger auto-removal:
// increment counter        → REMOVE
// initialize variable      → REMOVE
// return result            → REMOVE
// call function            → REMOVE
// check if null            → REMOVE
```

For each identified comment:

1. Call `replace_string_in_file` to remove
2. Log in final report under "Auto-Fixes Applied"

See [slop-patterns.md](references/slop-patterns.md) for complete list.

### Phase 6: Report

Structure findings:

```markdown
## Code Review Summary

### Overview

[Brief description of changes and assessment]

### Critical Findings (Block Merge)

- [file:line] SECURITY: {issue}
- [file:line] BUG: {issue}

### High Priority (Should Fix)

- [findings...]

### Medium Priority (Should Fix Soon)

- [findings...]

### Low Priority (Nice to Have)

- [findings...]

### Code Duplication Opportunities

- {new_pattern} already exists at {existing_path}

### Auto-Fixes Applied

- Removed {N} obvious comments in {files}

### Recommendations

- [actionable items]
```

## Quality Detection

### Security (see [security-checklist.md](references/security-checklist.md))

- Authentication/authorization bypass
- Injection vulnerabilities (SQL, command, XSS)
- Secrets in code
- Insecure cryptography
- Missing input validation

### TypeScript Best Practices

- Prefer `T | undefined` over `T?` for explicit nullability
- No `any` types without justification
- Proper error handling (no empty catch blocks)
- Named constants over magic numbers
- Async/await over raw promises where appropriate

### SOLID Violations

- Single Responsibility: classes/functions doing too much
- Interface Segregation: large interfaces that should split
- Dependency Inversion: concrete dependencies instead of abstractions

### DRY Violations

Subagents MUST search for:

- Existing utility functions
- Patterns already implemented elsewhere
- Copy-pasted code with variations

## AI Slop Detection

Auto-detect and flag (or auto-remove):

| Category         | Examples                     | Action      |
| ---------------- | ---------------------------- | ----------- |
| Obvious Comments | `// increment counter`       | AUTO-REMOVE |
| Type Restating   | JSDoc that restates types    | FLAG        |
| Over-Abstraction | Factory for 1 implementation | FLAG        |
| Magic Values     | Hardcoded strings/numbers    | FLAG        |
| Vibe-Coding      | `// TODO: fix later`         | FLAG        |

See [slop-patterns.md](references/slop-patterns.md) for complete detection rules.

## Subagent Task Format

Every subagent task MUST include:

```
Research only (do not edit files).
{specific_investigation_task}

Context:
{relevant_changes_or_code}

Return:
- file: {path}
- line: {number}
- severity: CRITICAL|HIGH|MEDIUM|LOW
- category: security|bug|style|slop|duplication
- issue: {description}
- suggestion: {fix or recommendation}
```

See [subagent-templates.md](references/subagent-templates.md) for ready-to-use templates.

## Prioritization Rules

1. **Branch changes** > codebase issues not related to changes
2. **CRITICAL** findings first (security, data loss, crashes)
3. **Affected callers** of changed functions
4. **Pattern violations** in new code
5. **Style issues** last

## Anti-Patterns

NEVER:

- Limit subagent count arbitrarily
- Skip external research when uncertain
- Report findings without file:line references
- Suggest changes to unchanged code without justification
- Miss obvious comments that should be removed
- Ignore existing implementations when reporting duplication

ALWAYS:

- Spawn subagent per file, per concern, per research question
- Use sequential thinking before synthesis
- Verify security findings with external research
- Apply auto-fixes for obvious comments
- Cross-reference with existing codebase patterns
