# Subagent Task Templates

Ready-to-use templates for spawning focused subagents. Each subagent handles ONE specific concern.

## Table of Contents

- [File Analyzer](#file-analyzer)
- [Pattern Finder](#pattern-finder)
- [Usage Tracer](#usage-tracer)
- [Security Reviewer](#security-reviewer)
- [SOLID/DRY Checker](#solid-dry-checker)
- [External Research](#external-research)
- [Slop Detector](#slop-detector)

---

## File Analyzer

Analyze a single changed file for multiple quality concerns.

```
Research only (do not edit files).

Analyze the following file for code quality issues:
File: {file_path}

Changes in this file:
{diff_content}

Investigate:
1. SECURITY: Auth bypass, injection, secrets, insecure crypto
2. BUGS: Logic errors, null handling, edge cases, race conditions
3. TYPESCRIPT: Type safety, proper error handling, async patterns
4. STYLE: Naming conventions, code organization, readability

For each finding, return:
- file: {path}
- line: {number}
- severity: CRITICAL|HIGH|MEDIUM|LOW
- category: security|bug|typescript|style
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

Questions to answer:
1. Does similar functionality exist elsewhere in the codebase?
2. Are there utility functions that could be reused?
3. Is there an established pattern for this type of operation?

Use these tools:
- search_for_pattern: Find similar implementations
- find_symbol: Locate existing functions/classes
- find_files_by_pattern: Discover related files

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

Investigate:
1. Find all direct callers of modified functions
2. Check if callers handle new error cases
3. Identify breaking changes to public APIs
4. Verify signature changes are reflected in all usages

Use find_usages for each modified symbol.

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

Security checklist:
1. AUTHENTICATION
   - Are credentials properly validated?
   - Is session handling secure?
   - Are tokens properly verified?

2. AUTHORIZATION
   - Are permissions checked before operations?
   - Is access control consistently applied?
   - Can authorization be bypassed?

3. INPUT VALIDATION
   - Is all user input sanitized?
   - Are there injection vectors (SQL, command, XSS)?
   - Are boundaries validated (size, format)?

4. SECRETS
   - Are any secrets hardcoded?
   - Are API keys exposed?
   - Is sensitive data logged?

5. ERROR HANDLING
   - Do errors leak sensitive information?
   - Are stack traces exposed?
   - Is failure handling secure?

If uncertain about security patterns, use:
- DeepWiki for framework-specific security
- Tavily for OWASP guidelines

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

## Usage Guidelines

1. **Spawn in parallel**: All subagents for a file can run simultaneously
2. **One concern per subagent**: Don't combine multiple templates
3. **Include context**: Always provide relevant code snippets
4. **Specify output format**: Follow the return structure
5. **Research first**: Tell subagent to research, not edit
