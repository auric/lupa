# Lupa

VS Code extension for PR analysis using GitHub Copilot. See [CLAUDE.md](../CLAUDE.md) for full architecture.

## Critical Constraints

- **Workers cannot use `vscode` module** - Worker processes (`src/workers/`) run in isolated `child_process` with no VS Code API access
- **Code chunking is single-threaded** - `web-tree-sitter` has memory leaks in worker threads; chunking stays in main thread
- **Circular deps use null+setter injection** - `ServiceManager` creates `IndexingManager` with null, then injects `EmbeddingDatabaseAdapter` via setter
- **Two model types** - Embedding models (local, semantic search) vs Language models (Copilot API, analysis)

## Commands

- `npm run build` - Build extension + webview
- `npm run test` - Run tests (output can be long; read final summary only)
- `npm run package` - Production build
- `npx vitest run src/__tests__/file.test.ts` - Single test

## Conventions

- Use `Log` from `loggingService.ts`, not `console.log` (exception: workers/webviews)
- Use `toolSuccess()`/`toolError()` for tool return values
- Prefer `param: string | undefined` over `param?: string`
- New tools: extend `BaseTool`, use Zod schema, register in `ServiceManager.initializeTools()`
- New services: implement `vscode.Disposable`, use `getInstance()` for singletons
- Tests mock VS Code via `__mocks__/vscode.js`

## Key Files

- [serviceManager.ts](../src/services/serviceManager.ts) - DI container, 4-phase initialization
- [toolCallingAnalysisProvider.ts](../src/services/toolCallingAnalysisProvider.ts) - Main analysis loop
- [vectorDatabaseService.ts](../src/services/vectorDatabaseService.ts) - SQLite + HNSWlib storage
- [vite.config.mts](../vite.config.mts) - Dual build config (Node.js extension + browser webview)
