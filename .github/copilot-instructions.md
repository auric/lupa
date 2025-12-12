# Lupa

VS Code extension for PR analysis using GitHub Copilot. See [CLAUDE.md](../CLAUDE.md) for full architecture.

## Critical Constraints

- **Workers cannot use `vscode` module** - Worker processes (`src/workers/`) run in isolated `child_process` with no VS Code API access
- **Code chunking is single-threaded** - `web-tree-sitter` has memory leaks in worker threads; chunking stays in main thread
- **Circular deps use null+setter injection** - `ServiceManager` creates `IndexingManager` with null, then injects `EmbeddingDatabaseAdapter` via setter
- **Two model types** - Embedding models (local, semantic search) vs Language models (Copilot API, analysis)

## Planned Deprecation

The embedding-based context system is being phased out. Do not invest in:

- `IndexingService`, `IndexingManager`, `EmbeddingGenerationService`
- `VectorDatabaseService`, `EmbeddingDatabaseAdapter`
- `ContextProvider` embedding search paths
- Worker-based embedding generation (`src/workers/`)

Future direction: Tool-calling analysis via `ToolCallingAnalysisProvider` only.

## Commands

- `npm run check-types` - Fast type checking (~2s), prefer over `npm run build` for validation
- `npm run build` - Full build (~30s), use sparingly
- `npm run test` - Run all tests; **output is massive**, read only final summary lines
- `npm run package` - Production build
- `npx vitest run src/__tests__/file.test.ts` - Single test

**Context window warning:** Test output can overwhelm context. After running tests, read only the last ~50 lines for the summary. Prefer running specific test files over the full suite.

## Conventions

- Use `Log` from `loggingService.ts`, not `console.log` (exception: workers/webviews)
- Use `toolSuccess()`/`toolError()` for tool return values
- Prefer `param: string | undefined` over `param?: string`
- New tools: extend `BaseTool`, use Zod schema, register in `ServiceManager.initializeTools()`
- New services: implement `vscode.Disposable`, use `getInstance()` for singletons
- Tests mock VS Code via `__mocks__/vscode.js`

## Key Files

- `../src/services/serviceManager.ts` - DI container, 4-phase initialization
- `../src/services/toolCallingAnalysisProvider.ts` - Main analysis loop
- `../src/services/vectorDatabaseService.ts` - SQLite + HNSWlib storage
- `../vite.config.mts` - Dual build config (Node.js extension + browser webview)

## Agent Behavior

Be a skeptical collaborator, not a compliant assistant. Question assumptions, verify claims against the codebase, and push back when something seems wrong. I am not always right. Neither are you, but we both strive for accuracy.

**Code quality expectations:**

- Write production-ready TypeScript: DRY, SOLID, properly typed
- Comments only where non-obvious; avoid redundant explanations
- Documentation should read as if written by a senior engineer, not generated
- Verify changes compile (`npm run build`) and consider test impact

**Working style:**

- Research before implementing—read existing patterns in the codebase first
- When uncertain, investigate rather than guess
- Propose alternatives if you see a better approach
- Acknowledge limitations honestly rather than fabricating answers
- Use subagents for parallel research tasks—break complex work into small, focused subtasks (never delegate the entire task to a single subagent)
