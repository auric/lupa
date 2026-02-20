# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Lupa** is a VS Code extension that performs comprehensive pull request analysis using GitHub Copilot models. It uses a tool-calling architecture where the LLM dynamically requests context via LSP-based tools, enabling deep code understanding without pre-loading entire codebases.

## Key Technologies

- **Language**: TypeScript
- **Framework**: VS Code Extension API
- **Build Tool**: Vite (dual build: Node.js extension + browser webview)
- **Testing**: Vitest with VS Code mocks
- **UI**: React 19 with React Compiler, shadcn/ui, Tailwind CSS v4
- **Search**: VS Code's built-in ripgrep (via `vscode.env.appRoot`)

## Development Commands

```bash
npm run check-types    # Fast type checking (~2s), prefer for validation
npm run build          # Full build (~30s), use sparingly
npm run test           # Run all tests (see warning below)
npm run package        # Production build
npx vitest run src/__tests__/file.test.ts  # Single test
```

**Context window warning:** `npm run test` output is massive and will overwhelm context. After running tests, read only the last ~50 lines for the summary. Prefer running specific test files over the full suite.

## Architecture

### Layers

| Layer        | Path                | Purpose                                                |
| ------------ | ------------------- | ------------------------------------------------------ |
| Coordinators | `src/coordinators/` | High-level orchestration (analysis, commands)          |
| Services     | `src/services/`     | Core business logic (analysis, settings, UI)           |
| Tools        | `src/tools/`        | LLM-callable tools (extend `BaseTool`, use Zod schema) |
| Models       | `src/models/`       | Token management, conversation, tool execution         |
| Prompts      | `src/prompts/`      | System prompt generators                               |
| Webview      | `src/webview/`      | React UI (browser context, **no vscode access**)       |

### Service Initialization (3 Phases)

The `ServiceManager` initializes services in strict order to resolve dependencies:

1. **Foundation**: Settings, Logging, StatusBar, Git, UI
2. **Core**: CopilotModelManager, PromptGenerator, SymbolExtractor
3. **High-Level**: ToolRegistry, ToolExecutor, ConversationManager, ToolCallingAnalysisProvider, Tools

**Per-analysis components** (created in `ToolCallingAnalysisProvider.analyze()`, not singletons):

- `SubagentSessionManager` - Tracks subagent spawn count and limits
- `SubagentExecutor` - Executes subagent investigations
- `PlanSessionManager` - Review plan state
- `TokenValidator` instance - Context window tracking

### Key Entry Points

| File                                          | Purpose                                  |
| --------------------------------------------- | ---------------------------------------- |
| `src/services/serviceManager.ts`              | DI container, phase-based initialization |
| `src/services/toolCallingAnalysisProvider.ts` | Main analysis loop with tool-calling     |
| `src/tools/baseTool.ts`                       | Tool base class with Zod schema          |
| `vite.config.mts`                             | Dual build configuration                 |

### Data Flow: Tool-Calling Analysis

1. `AnalysisOrchestrator` → `ToolCallingAnalysisProvider`
2. Per-analysis state created: `TokenValidator`, `SubagentSessionManager`, `SubagentExecutor`, `PlanSessionManager`
3. LLM requests context via tools (`FindSymbolTool`, `ReadFileTool`, etc.)
4. `ToolExecutor` runs tools (rate-limited by session)
5. Multi-turn conversation via `ConversationManager`
6. Subagent delegation via `RunSubagentTool` (uses per-analysis `SubagentExecutor` from `ExecutionContext`)

## Code Conventions

### Logging

Use `Log` from `loggingService.ts`, not `console.log`. Exception: webviews may use `console.log`.

### Path Resolution

**Always use Git repository root, not workspace folder**, for file path operations. The Git repo may be in a parent directory or different location than the VS Code workspace.

- Use `gitOperationsManager.getRepository()?.rootUri.fsPath` for the Git root
- Never use `vscode.workspace.workspaceFolders[0]` for file operations in tools
- Never use `vscode.workspace.asRelativePath()` — it computes paths relative to workspace folders, not git root. Use `path.relative(gitRoot, absolutePath)` instead
- `WorkspaceSettingsService` stores `.` as a relative marker when repo path equals workspace root (for portability)

### Tool Results

Use `toolSuccess(data)` and `toolError(message)` helpers from `src/types/toolResultTypes.ts`.

### Type Safety

Prefer `param: string | undefined` over `param?: string` for explicit nullability.

### New Tools

1. Extend `BaseTool`
2. Define Zod schema
3. Implement `execute(args, context)` returning `ToolResult` — `context: ExecutionContext` is required
4. Register in `ServiceManager.initializeTools()`
5. Access per-analysis dependencies (e.g., `SubagentExecutor`, `cancellationToken`) via `ExecutionContext` parameter

### ExecutionContext

Tools receive an `ExecutionContext` with per-analysis dependencies. The `context` parameter is **required** for all tool executions:

```typescript
interface ExecutionContext {
    planManager?: PlanSessionManager;
    subagentSessionManager?: SubagentSessionManager;
    subagentExecutor?: SubagentExecutor;
    cancellationToken: vscode.CancellationToken; // Required
}
```

The `cancellationToken` is always available—pass it to long-running operations (symbol extraction, LSP calls) for responsive cancellation.

### Timeout Handling

**ToolExecutor is the centralized error handler** - most tools don't need try-catch blocks at all:

- **CancellationError**: ToolExecutor rethrows to propagate cancellation up the stack
- **TimeoutError**: ToolExecutor catches and returns a generic helpful message to the LLM
- **Other errors**: ToolExecutor converts to `toolError(message)` for the LLM

**When tools should NOT have try-catch**:

Most tools should let errors propagate to ToolExecutor. Don't wrap your execute method in try-catch just to call `rethrowIfCancellationOrTimeout` and then `toolError()` — that's exactly what ToolExecutor already does.

**When tools SHOULD have try-catch**:

- **Specific error messages**: Inner catches that provide context (e.g., "File not found" vs generic error)
- **Partial results on timeout**: Return what you found before timeout occurred
- **Graceful degradation**: Fall back to alternative behavior (e.g., `symbolRangeExpander` uses heuristic on timeout)
- **Continue-on-error loops**: Skip failed items and continue processing (e.g., `findUsagesTool` continues if one definition check times out)

**VS Code API behavior**:

- **VS Code APIs don't throw CancellationError** - they return `undefined` or empty results when cancelled
- **Only `withCancellableTimeout` throws CancellationError** - when the token fires before the operation completes
- **Tests should NOT mock VS Code APIs to throw CancellationError** - use pre-cancelled tokens instead

**Testing CancellationError propagation**:

1. Pre-cancel the token before calling the function under test (preferred)
2. When testing ToolExecutor/middleware, you MAY create a mock tool that throws CancellationError

**Error handling helpers**:

- `rethrowIfCancellationOrTimeout(error)` - Use in catch blocks when you need to handle other errors but let cancel/timeout propagate
- `isTimeoutError(error)` - Check explicitly when you want to return partial results on timeout
- `isCancellationError(error)` - Use in catch blocks to detect cancellation; **prefer this over checking `token.isCancellationRequested`** since the token state may not be set yet when the error is thrown

**Other patterns**:

- **TimeoutError class**: Use `TimeoutError.create(operation, timeoutMs)` for timeout scenarios
- **Async file discovery**: Use `fdir.crawl().withPromise()` instead of `.sync()` to keep VS Code responsive
- **fdir abort behavior**: fdir resolves with partial results on AbortSignal, never throws. Check signal state AFTER fdir resolves and throw appropriate error (see `FileDiscoverer`)
- **Cancel propagation**: Pass `ExecutionContext.cancellationToken` through to `SymbolExtractor` methods
- **Linked tokens for child processes**: When spawning processes with timeouts, use `CancellationTokenSource` linked to the parent token (see `SearchForPatternTool`)
- **Subagent CancellationTokenSource must be local**: `RunSubagentTool.execute()` uses a local `CancellationTokenSource`, never an instance variable—tools are singletons, so parallel executions would share and corrupt the source
- **Subagent cancellation detection**: `SubagentExecutor` checks `ConversationRunner.hitMaxIterations` and `ConversationRunner.wasCancelled` boolean flags instead of raw `token.isCancellationRequested` or string comparison—avoids both false cancellation signals and theoretical LLM output collision with sentinel strings

### Timeout Patterns

Three timeout strategies based on operation type:

| Pattern                  | Use When                                        | Default            | Example                                 |
| ------------------------ | ----------------------------------------------- | ------------------ | --------------------------------------- |
| **Graceful Degradation** | Exploratory; LLM can work with partial data     | 15s                | `FileDiscoverer.discoverFiles()`        |
| **Per-Item Tracking**    | Processing many items; some failures acceptable | 5s/file, 60s total | `SymbolExtractor.getDirectorySymbols()` |
| **Hard Timeout**         | Must complete or fail; no partial results       | Operation-specific | LSP operations, single file reads       |

**Graceful Degradation**:

- Return partial results with `truncated: true` on timeout
- Use `AbortController`, check signal state after operation completes
- fdir resolves with partial results on abort—never throws

**Per-Item Tracking**:

- Timeout on single item, increment counter, continue loop
- Use try-catch with `isTimeoutError()` check to skip failed items
- Report count of skipped items in result

**Hard Timeout**:

- Throw `TimeoutError` via `withCancellableTimeout()`
- Let ToolExecutor handle the error (converts to helpful message for LLM)

**Stream Cancellation**:

- `ModelRequestHandler` actively cancels stream consumption on timeout using a linked `CancellationTokenSource`
- Prevents resource leaks where streams continued running in background after timeout

**Final Watchdog for Child Processes**:

- `RipgrepSearchService` uses a final watchdog (5s after SIGKILL) to force-reject the promise if a spawned process ignores termination signals
- Pattern: Track settlement state with a `settled` flag, set a final timeout after the kill escalation, clear on normal settlement

### New Services

1. Implement `vscode.Disposable`
2. Add to appropriate phase in `ServiceManager`

## Testing

- Test files: `*.test.ts`, `*.spec.ts` in `src/__tests__/`
- VS Code mocked via `__mocks__/vscode.js`
- Vitest config uses alias: `vscode` → `__mocks__/vscode.js`
- React tests: `.tsx` with jsdom environment
- **Shared mock factories**: Use `src/__tests__/testUtils/mockFactories.ts` for common mocks
    - `createMockExecutionContext()` - ExecutionContext with cancellationToken (required for tool tests)
    - `createMockCancellationTokenSource()` - CancellationToken with proper listener tracking
    - `createMockWorkspaceSettings()` - WorkspaceSettingsService
    - `createMockFdirInstance()` - fdir file discovery
    - `createMockGitRepository()` - Git repository
    - `createMockPosition()` / `createMockRange()` - VS Code Position/Range with proper methods
- **Vitest 4**: Constructor mocks require `function` syntax, not arrow functions

---

## Agent Behavior

Be a skeptical collaborator, not a compliant assistant. Question assumptions, verify claims against the codebase, and push back when something seems wrong. I am not always right. Neither are you, but we both strive for accuracy.

### Before Writing Code

1. **Clarify the problem**: What are the actual requirements vs. assumed ones?
2. **Read existing code**: Understand patterns, conventions, and architectural decisions in this codebase
3. **Consider alternatives**: Generate 2-3 approaches before committing to one
4. **Plan the implementation**: Outline the solution with clear steps before coding

**CRITICAL**: Choose a clear technical direction and execute it with precision. Both minimal implementations and sophisticated architectures work—the key is intentionality, not complexity.

### Code Quality Expectations

- Write production-ready TypeScript: DRY, SOLID, properly typed
- No obvious comments—add comments only when logic is non-trivial or intent is unclear
- Documentation should read as if written by a senior engineer, not generated
- Verify changes compile (`npm run check-types`) and consider test impact

### Anti-Patterns to Avoid

NEVER produce these patterns:

- **Excessive comments** explaining obvious code (`// increment counter` above `counter++`)
- **Over-abstraction** when a simple function would suffice
- **Magic numbers/strings** without named constants
- **Empty catch blocks** that swallow errors silently
- **Copy-paste variations** instead of proper parameterization
- **God objects** that do everything
- **Premature optimization** without measurement

### Working Style

- Research before implementing—read existing patterns in the codebase first
- When uncertain, investigate rather than guess
- Propose alternatives if you see a better approach
- Acknowledge limitations honestly rather than fabricating answers
- At session end, provide a ready-to-use git commit message summarizing changes

#### Subagent Usage Guidelines

Use subagents strategically to preserve context and parallelize work:

**When to use subagents:**

- **Parallel research tasks**—break complex exploration into focused subtasks (e.g., "find all usages of X", "understand how Y works")
- **Bulk similar edits**—repetitive changes across many files (e.g., updating 20+ test files for new API signatures)
- **Isolated refactoring**—changes that don't require understanding the broader context
- **Documentation generation**—writing docs from existing code

**When NOT to use subagents:**

- **Simple tasks**—if you can do it in 2-3 tool calls, do it yourself
- **Context-dependent decisions**—when the change depends on understanding you've already built
- **Small file counts**—editing 3-5 files is faster to do directly
- **Complex architectural changes**—where you need to see the full picture

**Subagent best practices:**

- Never delegate the entire task to a single subagent
- Provide clear, specific instructions with examples
- Include relevant context the subagent needs
- Verify subagent results before trusting them
- Always use Claude Opus 4.6 model in subagents for best results

**Consult DeepWiki MCP for external library questions**—when unsure about API usage, mocking patterns, or library-specific behavior (e.g., Vitest, VS Code API), use Deepwiki MCP with the appropriate repo (e.g., `vitest-dev/vitest`, `microsoft/vscode`)

### Quality Checklist

Before finalizing any implementation:

- [ ] Would a new team member understand this code without explanation?
- [ ] Does this follow existing codebase patterns and conventions?
- [ ] Are edge cases handled gracefully?
- [ ] Is there anything that could be removed without losing functionality?
- [ ] Have type checks passed (`npm run check-types`)?

---

## BMAD Method (v6 Alpha)

This project uses BMAD-METHOD for agent-driven development workflows.

### BMAD Agent Detection

**If your mode/persona starts with `bmd-` or `bmad-`, you ARE a BMAD agent.**

### CRITICAL: File Loading Requirements

**Before any BMAD workflow execution, you MUST read and load the required config and workflow files. Do not proceed from memory—always fetch the actual files.**

1. **Activation is mandatory**: Load agent persona file first, then read `{project-root}/_bmad/core/config.yaml` for user settings
2. **Workflow execution**: Before running any workflow, load `{project-root}/_bmad/core/tasks/workflow.xml` as the core OS
3. **Stay in character**: Follow agent persona and menu system until explicitly dismissed
4. **Output discipline**: Save outputs after each workflow step—never batch multiple steps together

### Why This Matters

BMAD agents may not automatically load instruction files. The explicit file-loading step ensures the agent has current configuration and doesn't operate from stale or missing context.
