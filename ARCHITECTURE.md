# Architecture & Technical Reference

> This document contains detailed technical knowledge about the Lupa codebase. Read this when you need to understand architecture, implement features, or follow code conventions. For agent behavior and workflow instructions, see [CLAUDE.md](CLAUDE.md).

## Key Technologies

- **Language**: TypeScript
- **Framework**: VS Code Extension API
- **Build Tool**: Vite (dual build: Node.js extension + browser webview)
- **Testing**: Vitest with VS Code mocks
- **UI**: React 19 with React Compiler, shadcn/ui, Tailwind CSS v4
- **Search**: VS Code's built-in ripgrep (via `vscode.env.appRoot`)

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

- `SubagentSessionManager` — Tracks subagent spawn count and limits
- `SubagentExecutor` — Executes subagent investigations
- `PlanSessionManager` — Review plan state
- `RecursiveStateManager` — Agent tree, budget tracking, deduplication (when `maxRecursionDepth >= 1`)
- `TokenValidator` instance — Context window tracking

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
6. Subagent delegation via `RunSubagentBatchTool` — accepts an array of investigation tasks and runs all subagents in parallel (uses per-analysis `SubagentExecutor` from `ExecutionContext`)

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

**ToolExecutor is the centralized error handler** — most tools don't need try-catch blocks at all:

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

- **VS Code APIs don't throw CancellationError** — they return `undefined` or empty results when cancelled
- **Only `withCancellableTimeout` throws CancellationError** — when the token fires before the operation completes
- **Tests should NOT mock VS Code APIs to throw CancellationError** — use pre-cancelled tokens instead

**Testing CancellationError propagation**:

1. Pre-cancel the token before calling the function under test (preferred)
2. When testing ToolExecutor/middleware, you MAY create a mock tool that throws CancellationError

**Error handling helpers**:

- `rethrowIfCancellationOrTimeout(error)` — Use in catch blocks when you need to handle other errors but let cancel/timeout propagate
- `isTimeoutError(error)` — Check explicitly when you want to return partial results on timeout
- `isCancellationError(error)` — Use in catch blocks to detect cancellation; **prefer this over checking `token.isCancellationRequested`** since the token state may not be set yet when the error is thrown

**Other error/timeout patterns**:

- **TimeoutError class**: Use `TimeoutError.create(operation, timeoutMs)` for timeout scenarios
- **Async file discovery**: Use `fdir.crawl().withPromise()` instead of `.sync()` to keep VS Code responsive
- **fdir abort behavior**: fdir resolves with partial results on AbortSignal, never throws. Check signal state AFTER fdir resolves and throw appropriate error (see `FileDiscoverer`)
- **Cancel propagation**: Pass `ExecutionContext.cancellationToken` through to `SymbolExtractor` methods
- **Linked tokens for child processes**: When spawning processes with timeouts, use `CancellationTokenSource` linked to the parent token (see `SearchForPatternTool`)
- **Subagent CancellationTokenSource must be local**: `RunSubagentBatchTool.execute()` uses a local `CancellationTokenSource`, never an instance variable—tools are singletons, so parallel executions would share and corrupt the source
- **Subagent cancellation detection**: `SubagentExecutor` checks `ConversationRunner.hitMaxIterations` and `ConversationRunner.wasCancelled` boolean flags instead of raw `token.isCancellationRequested`—avoids false cancellation signals from unrelated token events
- **Timeout vs parent cancellation**: `RunSubagentBatchTool` checks `context.cancellationToken.isCancellationRequested` when attributing cancellation to timeout, giving parent cancellation priority over timeout timer

### Timeout Strategies

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
    - `createMockExecutionContext()` — ExecutionContext with cancellationToken (required for tool tests)
    - `createMockCancellationTokenSource()` — CancellationToken with proper listener tracking
    - `createMockWorkspaceSettings()` — WorkspaceSettingsService
    - `createMockFdirInstance()` — fdir file discovery
    - `createMockGitRepository()` — Git repository
    - `createMockPosition()` / `createMockRange()` — VS Code Position/Range with proper methods
- **Vitest 4**: Constructor mocks require `function` syntax, not arrow functions
