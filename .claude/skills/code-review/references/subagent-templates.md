# Subagent Task Templates

Ready-to-use templates for spawning focused subagents. Each subagent handles ONE specific concern.

> **Note**: Each template intentionally duplicates "Key Lupa conventions" because subagents get fresh context and can't reference shared files. When conventions change, update ALL template copies together.

## Table of Contents

- [File Analyzer](#file-analyzer)
- [Pattern Finder](#pattern-finder)
- [Usage Tracer](#usage-tracer)
- [Security Reviewer](#security-reviewer)
- [SOLID/DRY Checker](#soliddry-checker)
- [External Research](#external-research)
- [Slop Detector](#slop-detector)
- [Test Reviewer](#test-reviewer)

---

## File Analyzer

Analyze a single changed file for multiple quality concerns.

```
Research only (do not edit files).

Analyze the following file for code quality issues:
File: {file_path}

Changes in this file:
{diff_content}

Key Lupa conventions:
- ToolExecutor handles errors centrally — tools should NOT have try-catch wrapping entire execute()
- VS Code APIs return undefined on cancellation, they don't throw CancellationError
- Use Git root for paths, never workspace folders
- Use Log from loggingService, not console.log (except webviews)
- Use toolSuccess()/toolError() for tool return values
- Prefer `param: string | undefined` over `param?: string`

Investigate:
1. SECURITY: Auth bypass, injection, secrets, insecure crypto
2. BUGS: Logic errors, null handling, edge cases, race conditions
3. TYPESCRIPT: Type safety, proper error handling, async patterns
4. STYLE: Naming conventions, code organization, readability
5. CONVENTIONS: ToolExecutor error handling delegation (no unnecessary try-catch in tools),
   CancellationToken propagation (passed to all long-running ops), path resolution
   (git root not workspace folder), logging (Log not console.log), toolSuccess/toolError returns

For each finding, return:
- file: {path}
- line: {number}
- severity: CRITICAL|HIGH|MEDIUM|LOW
- category: security|bug|typescript|style|convention
- issue: {clear description}
- suggestion: {specific fix}
- confidence: HIGH|MEDIUM|LOW
```

---

## Pattern Finder

Search for existing implementations to prevent code duplication.

```
Research only (do not edit files).

Search the codebase for existing patterns similar to this new code:
New implementation: {description_of_new_pattern}
File: {file_path}

Key Lupa conventions:
- ToolExecutor handles errors centrally — tools should NOT have try-catch wrapping entire execute()
- VS Code APIs return undefined on cancellation, they don't throw CancellationError
- Use Git root for paths, never workspace folders
- Use Log from loggingService, not console.log (except webviews)
- Use toolSuccess()/toolError() for tool return values
- Prefer `param: string | undefined` over `param?: string`

Questions to answer:
1. Does similar functionality exist elsewhere in the codebase?
2. Are there utility functions that could be reused?
3. Is there an established pattern for this type of operation?

Use these tools:
- grep_search: Find exact text matches and similar implementations
- semantic_search: Find conceptually related code by meaning
- file_search: Discover related files by name/path pattern
- vscode_listCodeUsages: Trace symbol definitions, references, and implementations

Return:
- existing_path: {where similar pattern exists}
- similarity: HIGH|MEDIUM|LOW
- can_reuse: true|false
- recommendation: {specific suggestion}
```

---

## Usage Tracer

Trace the impact of changes on callers and dependents.

```
Research only (do not edit files).

Trace usages and impact of changes in:
File: {file_path}
Changed symbols: {function_names_or_class_names}

Key Lupa conventions:
- ToolExecutor handles errors centrally — tools should NOT have try-catch wrapping entire execute()
- VS Code APIs return undefined on cancellation, they don't throw CancellationError
- Use Git root for paths, never workspace folders
- Use Log from loggingService, not console.log (except webviews)
- Use toolSuccess()/toolError() for tool return values
- Prefer `param: string | undefined` over `param?: string`

Investigate:
1. Find all direct callers of modified functions
2. Check if callers handle new error cases
3. Identify breaking changes to public APIs
4. Verify signature changes are reflected in all usages

Use vscode_listCodeUsages for each modified symbol — provide the symbol name,
a file where it appears, and a line content substring containing the symbol.

Return for each affected caller:
- caller_file: {path}
- caller_line: {number}
- impact: BREAKING|NEEDS_UPDATE|COMPATIBLE
- issue: {what needs to change}
- suggestion: {how to update}
```

---

## Security Reviewer

Dedicated security analysis for sensitive changes.

```
Research only (do not edit files).

Perform security review on:
File: {file_path}

Changes context:
{diff_content}

Key Lupa security conventions:
- Spawned processes (ripgrep, git) must use proper argument escaping — no user input reaching shell
- CancellationTokens must propagate to all long-running ops to prevent resource exhaustion
- Use Git root for paths, never workspace folders — prevents path traversal
- Log via `Log` from loggingService — never log secrets or sensitive data
- Webviews need CSP headers and postMessage origin validation
- Tool outputs sent to LLM must not contain secrets or credentials

This is a VS Code extension — focus on extension-specific attack surface.

Security checklist:
1. EXTENSION INPUT VALIDATION
   - Is untrusted workspace content (file names, git data, LLM output) sanitized before use?
   - Are command arguments validated before execution?
   - Are there path traversal vectors via relative paths or symlinks?
   - Is webview content sanitized (CSP headers, postMessage origin checks)?

2. SECRETS & DATA EXPOSURE
   - Are any secrets or tokens hardcoded?
   - Is sensitive data logged via Log or console.log?
   - Are API keys, auth tokens, or credentials exposed in tool results sent to LLM?
   - Does error output leak file system paths or internal state?

3. PROCESS & COMMAND EXECUTION
   - Are spawned processes (ripgrep, git) invoked with proper argument escaping?
   - Can user-controlled input reach shell commands?
   - Are child process timeouts and kill signals handled correctly?

4. WEBVIEW SECURITY
   - Is Content Security Policy set and restrictive?
   - Are postMessage handlers validating message origin and shape?
   - Is user-generated or LLM-generated content escaped before rendering?

5. RESOURCE EXHAUSTION
   - Can malicious repos trigger unbounded file reads or searches?
   - Are there missing limits on recursion depth, file count, or response size?
   - Are CancellationTokens propagated to prevent runaway operations?

If uncertain about security patterns, use:
- DeepWiki (microsoft/vscode) for extension security model
- Tavily for OWASP and VS Code extension security guidelines

Return:
- file: {path}
- line: {number}
- severity: CRITICAL|HIGH|MEDIUM
- vulnerability_type: {CWE if applicable}
- issue: {description}
- exploit_scenario: {how could this be exploited}
- remediation: {specific fix}
```

---

## SOLID/DRY Checker

Check for principle violations in changes.

```
Research only (do not edit files).

Analyze SOLID/DRY compliance in:
File: {file_path}

Changes:
{diff_content}

Key Lupa conventions:
- ToolExecutor handles errors centrally — tools should NOT have try-catch wrapping entire execute()
- VS Code APIs return undefined on cancellation, they don't throw CancellationError
- Use Git root for paths, never workspace folders
- Use Log from loggingService, not console.log (except webviews)
- Use toolSuccess()/toolError() for tool return values
- Prefer `param: string | undefined` over `param?: string`

CHECK EACH PRINCIPLE:

1. SINGLE RESPONSIBILITY
   - Does each class/function have one reason to change?
   - Are there methods that should be extracted?
   - Is the module doing too much?

2. OPEN/CLOSED
   - Is the code open for extension, closed for modification?
   - Are there hardcoded behaviors that should be configurable?

3. LISKOV SUBSTITUTION
   - Can derived types substitute base types without issues?
   - Are there unexpected behaviors in subclasses?

4. INTERFACE SEGREGATION
   - Are interfaces focused and minimal?
   - Are clients forced to depend on methods they don't use?

5. DEPENDENCY INVERSION
   - Are high-level modules depending on abstractions?
   - Are there concrete dependencies that should be injected?

6. DRY (Don't Repeat Yourself)
   - Is there duplicated logic?
   - Can common patterns be extracted?
   - Search codebase for similar implementations

Return:
- file: {path}
- line: {number}
- principle: SRP|OCP|LSP|ISP|DIP|DRY
- severity: MEDIUM|LOW
- issue: {description}
- suggestion: {refactoring recommendation}
```

---

## External Research

Research unfamiliar patterns using external tools.

```
Research only (do not edit files).

Research external knowledge for:
Topic: {specific_question}
Context: {why this is needed}

Key Lupa conventions:
- ToolExecutor handles errors centrally — tools should NOT have try-catch wrapping entire execute()
- VS Code APIs return undefined on cancellation, they don't throw CancellationError
- Use Git root for paths, never workspace folders
- Use Log from loggingService, not console.log (except webviews)
- Use toolSuccess()/toolError() for tool return values
- Prefer `param: string | undefined` over `param?: string`

Research protocol:
1. FIRST: Try DeepWiki
   - For library questions: ask_question("{repo_path}", "{question}")
   - Common repos: microsoft/vscode, vitest-dev/vitest, facebook/react

2. IF INSUFFICIENT: Use Tavily
   - Search official documentation
   - Find best practices
   - Look for security advisories if relevant

3. SYNTHESIZE: Combine findings

Return:
- question: {original question}
- sources: [{source1}, {source2}]
- answer: {synthesized answer}
- confidence: HIGH|MEDIUM|LOW
- additional_context: {relevant notes}
```

---

## Slop Detector

Dedicated scanner for AI slop patterns.

```
Research only (do not edit files).

Scan for AI slop patterns in:
File: {file_path}

Changes:
{diff_content}

Key Lupa conventions:
- ToolExecutor handles errors centrally — tools should NOT have try-catch wrapping entire execute()
- VS Code APIs return undefined on cancellation, they don't throw CancellationError
- Use Git root for paths, never workspace folders
- Use Log from loggingService, not console.log (except webviews)
- Use toolSuccess()/toolError() for tool return values
- Prefer `param: string | undefined` over `param?: string`

SCAN FOR:

1. OBVIOUS COMMENTS (for auto-removal)
   - Comments restating code
   - Closing brace comments
   - Trivial section markers

2. JSDOC SLOP
   - Type-restating documentation
   - Self-referential descriptions
   - Constructor/getter/setter docs that add nothing

3. OVER-ABSTRACTION
   - Interfaces with single implementation
   - Factories for trivial creation
   - Pass-through wrappers
   - Over-generic types

4. VIBE-CODING
   - TODO/FIXME without issue references
   - Magic numbers/strings
   - Copy-paste variations
   - Empty catch blocks
   - Unclear variable names

Return for each finding:
- file: {path}
- line: {number}
- pattern_type: obvious_comment|jsdoc|abstraction|vibe
- content: {the problematic code}
- action: AUTO_REMOVE|FLAG
- reason: {why this is slop}
```

---

## Test Reviewer

Review test quality and coverage for changed code.

```
Research only (do not edit files).

Review test quality for:
File: {file_path}
Test file: {test_file_path}

Changes:
{diff_content}

Key Lupa testing conventions:
- Use shared mock factories from `testUtils/mockFactories.ts` (createMockExecutionContext, etc.)
- `createMockExecutionContext()` is required for all tool tests — provides cancellationToken
- Do NOT mock VS Code APIs to throw CancellationError — use pre-cancelled tokens instead
- Vitest 4: constructor mocks require `function` syntax, not arrow functions
- Use toolSuccess()/toolError() for tool return values
- ToolExecutor handles errors centrally — tool tests should verify error propagation, not wrapping

TEST QUALITY CHECKLIST:

1. COVERAGE
   - Are all new/changed code paths tested?
   - Are edge cases covered (empty input, boundary values, error paths)?
   - Are both success and failure scenarios tested?

2. TEST CORRECTNESS
   - Do assertions actually verify the behavior under test (not just "doesn't throw")?
   - Are mocks configured correctly — not mocking the thing being tested?
   - Do tests fail for the right reason when the code is broken?

3. MOCK PATTERNS
   - Are shared mock factories from testUtils/mockFactories.ts used where applicable?
   - Is createMockExecutionContext() used for tool tests (provides cancellationToken)?
   - Are VS Code APIs mocked correctly — returning undefined on cancel, NOT throwing CancellationError?
   - For cancellation tests: are pre-cancelled tokens used instead of mocking APIs to throw?
   - Vitest 4: constructor mocks require `function` syntax, not arrow functions

4. ISOLATION
   - Does each test clean up after itself (no shared mutable state between tests)?
   - Are timers, file system ops, or network calls properly mocked?
   - Can tests run in any order without affecting results?

5. NAMING & STRUCTURE
   - Do test names describe the expected behavior, not the implementation?
   - Are describe blocks organized logically (by method, scenario, or feature)?
   - Are test fixtures/helpers extracted to reduce duplication?

Return for each finding:
- file: {path}
- line: {number}
- severity: HIGH|MEDIUM|LOW
- category: coverage|correctness|mocking|isolation|structure
- issue: {clear description}
- suggestion: {specific fix}
```

---

## Usage Guidelines

1. **Spawn in parallel**: All subagents for a file can run simultaneously
2. **One concern per subagent**: Don't combine multiple templates
3. **Include context**: Always provide relevant code snippets
4. **Specify output format**: Follow the return structure
5. **Research first**: Tell subagent to research, not edit
