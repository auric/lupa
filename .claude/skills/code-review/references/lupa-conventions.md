# Lupa Project Conventions

Checklist of project-specific patterns for code review. Each item is a common source of review findings.

## Tool Architecture

- All tools extend `BaseTool` with Zod schema for input validation
- `execute(args, context)` receives `ExecutionContext` as second parameter — this is **required**
- Return values use `toolSuccess(data)` and `toolError(message)` from `src/types/toolResultTypes.ts`
- Register new tools in `ServiceManager.initializeTools()`
- Tools are **singletons** — never store per-execution state as instance variables (use local variables or ExecutionContext)

## ExecutionContext

```typescript
interface ExecutionContext {
    planManager?: PlanSessionManager;
    subagentSessionManager?: SubagentSessionManager;
    subagentExecutor?: SubagentExecutor;
    cancellationToken: vscode.CancellationToken; // Always present
}
```

- Pass `cancellationToken` to all long-running operations
- Access per-analysis dependencies through context, not global state

## Error Handling

**ToolExecutor is the centralized error handler.** Most tools should NOT have try-catch blocks — let errors propagate.

ToolExecutor handles:

- `CancellationError` → rethrows (propagates cancellation up the stack)
- `TimeoutError` → returns helpful message to LLM
- Other errors → converts to `toolError(message)` for LLM

**When tools SHOULD have try-catch:**

- Specific error messages (e.g., "File not found" vs generic error)
- Partial results on timeout (return what you found before timeout)
- Graceful degradation (fall back to alternative behavior)
- Continue-on-error loops (skip failed items, continue processing)

**When tools should NOT have try-catch:**

- Wrapping entire `execute()` just to call `rethrowIfCancellationOrTimeout` then `toolError()` — that's exactly what ToolExecutor does

## CancellationToken Patterns

- **VS Code APIs don't throw CancellationError** — they return `undefined` or empty results when cancelled
- **Only `withCancellableTimeout` throws CancellationError** — when token fires before operation completes
- **Tests should NOT mock VS Code APIs to throw CancellationError** — use pre-cancelled tokens instead
- Use `isCancellationError(error)` in catch blocks — prefer over checking `token.isCancellationRequested` (token state may not be set yet)
- Use `rethrowIfCancellationOrTimeout(error)` when you handle other errors but need cancel/timeout to propagate
- Use `isTimeoutError(error)` when you want to return partial results on timeout

## Timeout Strategies

| Pattern                  | Use When                                    | Default            | Example                           |
| ------------------------ | ------------------------------------------- | ------------------ | --------------------------------- |
| **Graceful Degradation** | Exploratory; LLM can work with partial data | 15s                | `FileDiscoverer.discoverFiles()`  |
| **Per-Item Tracking**    | Processing many items; some failures OK     | 5s/file, 60s total | `getDirectorySymbols()`           |
| **Hard Timeout**         | Must complete or fail; no partial results   | Operation-specific | LSP operations, single file reads |

- Graceful: Return partial results with `truncated: true`, use `AbortController`
- Per-Item: Timeout on single item, increment counter, continue loop
- Hard: Throw `TimeoutError` via `withCancellableTimeout()`

## Path Resolution

- **Always use Git repository root** for file operations, not workspace folder
- Get via `gitOperationsManager.getRepository()?.rootUri.fsPath`
- **Never** use `vscode.workspace.workspaceFolders[0]` for file operations in tools
- **Never** use `vscode.workspace.asRelativePath()` — use `path.relative(gitRoot, absolutePath)` instead
- `WorkspaceSettingsService` stores `.` as relative marker when repo = workspace root

## Logging

- Use `Log` from `loggingService.ts` — never `console.log`
- Exception: webview code (browser context, no access to VS Code APIs) may use `console.log`

## Type Conventions

- Prefer `param: string | undefined` over `param?: string` for explicit nullability
- No `any` types without justification
- Use named constants, not magic numbers or strings

## Service Architecture

- Services implement `vscode.Disposable`
- `ServiceManager` initializes in 3 phases:
    1. Foundation: Settings, Logging, StatusBar, Git, UI
    2. Core: CopilotModelManager, PromptGenerator, SymbolExtractor
    3. High-Level: ToolRegistry, ToolExecutor, ConversationManager, AnalysisEngine, Tools
- Per-analysis components (NOT singletons): SubagentSessionManager, SubagentExecutor, PlanSessionManager, RecursiveStateManager, TokenValidator

## Subagent Patterns

- `RunSubagentBatchTool` uses LOCAL `CancellationTokenSource` — tools are singletons, so instance variables would be shared across parallel executions
- Child CancellationTokenSource links to both: analysis-root parent token AND immediate parent ExecutionContext token
- `SubagentExecutor` checks `hitMaxIterations` and `wasCancelled` booleans, not raw `token.isCancellationRequested`
- ReasoningChain is NOT propagated to child subagents (each child gets a fresh one)

## File Discovery

- Use `fdir.crawl().withPromise()` instead of `.sync()` to keep VS Code responsive
- fdir resolves with partial results on AbortSignal — it never throws. Check signal state AFTER fdir resolves
- Use `TimeoutError.create(operation, timeoutMs)` for timeout scenarios
- `FileDiscoverer` uses graceful degradation: returns partial results with `truncated: true`

## Process Spawning & Streams

- `RipgrepSearchService` uses a final watchdog (5s after SIGKILL) to force-reject if process ignores termination
- Use `CancellationTokenSource` linked to parent token when spawning processes with timeouts
- `ModelRequestHandler` actively cancels stream consumption on timeout using a linked `CancellationTokenSource` — prevents resource leaks from background streams
- Track settlement state with a `settled` flag for process cleanup

## Architecture Layers

| Layer        | Path                | Purpose                             |
| ------------ | ------------------- | ----------------------------------- |
| Coordinators | `src/coordinators/` | High-level orchestration            |
| Services     | `src/services/`     | Core business logic                 |
| Tools        | `src/tools/`        | LLM-callable tools (BaseTool + Zod) |
| Models       | `src/models/`       | Token management, conversation      |
| Prompts      | `src/prompts/`      | System prompt generators            |
| Webview      | `src/webview/`      | React UI (browser context)          |

New code should go in the appropriate layer. Tools go in `src/tools/`, services in `src/services/`, etc.

## Webview Boundary

- Webview code runs in browser context — no access to `vscode` module
- React 19 with React Compiler, shadcn/ui, Tailwind CSS v4
- Communication via `postMessage` only

## Testing Conventions

- Test files: `*.test.ts`, `*.spec.ts` in `src/__tests__/`
- VS Code mocked via `__mocks__/vscode.js`
- Use shared mock factories from `src/__tests__/testUtils/mockFactories.ts`:
    - `createMockExecutionContext()` — required for tool tests
    - `createMockCancellationTokenSource()` — with proper listener tracking
    - `createMockWorkspaceSettings()`, `createMockFdirInstance()`, `createMockGitRepository()`
    - `createMockPosition()` / `createMockRange()` — with proper methods
- **Vitest 4**: Constructor mocks require `function` syntax, not arrow functions
- Validation: `npm run check-types` (fast, ~2s) or `npm run build` (full, ~30s)

## Code Quality Standards

- DRY, SOLID, properly typed — no shortcuts
- Comments only when intent is non-obvious
- No empty catch blocks
- Follow existing patterns — read codebase before writing new code
- Don't add features, docstrings, or error handling beyond what's needed
