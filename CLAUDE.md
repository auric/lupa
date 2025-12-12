# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Lupa** is a VS Code extension that performs comprehensive pull request analysis using GitHub Copilot models. It leverages both Language Server Protocol (LSP) queries and semantic similarity search via embeddings to provide intelligent context for PR analysis.

## Key Technologies

- **Language**: TypeScript
- **Framework**: VS Code Extension API
- **Build Tool**: Vite (dual build: Node.js extension + browser webview)
- **Testing**: Vitest with VS Code mocks
- **UI**: React 19 with React Compiler, shadcn/ui, Tailwind CSS v4
- **Embeddings**: HuggingFace Transformers (Xenova/all-MiniLM-L6-v2)
- **Vector Search**: SQLite (@vscode/sqlite3) + HNSWlib
- **Code Parsing**: Tree-sitter (web-tree-sitter)
- **Workers**: Tinypool for parallel embedding generation

## Development Commands

```bash
npm run check-types    # Fast type checking (~2s), prefer for validation
npm run build          # Full build (~30s), use sparingly
npm run test           # Run all tests (see warning below)
npm run package        # Production build
npx vitest run src/__tests__/file.test.ts  # Single test
```

**Context window warning:** `npm run test` output is massive and will overwhelm context. After running tests, read only the last ~50 lines for the summary. Prefer running specific test files over the full suite. Use `npm run check-types` for quick validation instead of full builds.

## Architecture

### Layers

| Layer        | Path                | Purpose                                                |
| ------------ | ------------------- | ------------------------------------------------------ |
| Coordinators | `src/coordinators/` | High-level orchestration (analysis, models, database)  |
| Services     | `src/services/`     | Core business logic (indexing, context, analysis)      |
| Tools        | `src/tools/`        | LLM-callable tools (extend `BaseTool`, use Zod schema) |
| Models       | `src/models/`       | Token management, conversation, tool execution         |
| Workers      | `src/workers/`      | Isolated embedding generation (**no vscode access**)   |
| Prompts      | `src/prompts/`      | System prompt generators                               |
| Webview      | `src/webview/`      | React UI (browser context, **no vscode access**)       |

### Service Initialization (4 Phases)

The `ServiceManager` initializes services in strict order to resolve dependencies:

1. **Foundation**: Settings, Logging, StatusBar, UI, Git
2. **Core**: EmbeddingModelSelection, CopilotModelManager, VectorDatabase
3. **Complex**: IndexingManager → IndexingService → EmbeddingDatabaseAdapter (circular dep via null+setter injection)
4. **High-Level**: ContextProvider, AnalysisProvider, ToolCallingAnalysisProvider, Tools

### Key Entry Points

| File                                                                          | Purpose                                  |
| ----------------------------------------------------------------------------- | ---------------------------------------- |
| [serviceManager.ts](src/services/serviceManager.ts)                           | DI container, phase-based initialization |
| [toolCallingAnalysisProvider.ts](src/services/toolCallingAnalysisProvider.ts) | Main analysis loop with tool-calling     |
| [vectorDatabaseService.ts](src/services/vectorDatabaseService.ts)             | SQLite + HNSWlib hybrid storage          |
| [baseTool.ts](src/tools/baseTool.ts)                                          | Tool base class with Zod schema          |
| [vite.config.mts](vite.config.mts)                                            | Dual build configuration                 |

## Critical Constraints

- **Workers cannot use `vscode` module** - Worker processes run in isolated `child_process` with no VS Code API access
- **Code chunking is single-threaded** - `web-tree-sitter` has memory leaks in worker threads; chunking stays in main thread
- **Circular deps use null+setter injection** - `IndexingManager` created with null, then `EmbeddingDatabaseAdapter` injected via setter
- **Two model types** - Embedding models (local, semantic search) vs Language models (Copilot API, analysis)

## Conventions

### Logging

Use `Log` from `loggingService.ts`, not `console.log`. Exception: workers and webviews may use `console.log`.

### Tool Results

Use `toolSuccess(data)` and `toolError(message)` helpers from `src/types/toolResultTypes.ts`.

### Type Safety

Prefer `param: string | undefined` over `param?: string` for explicit nullability.

### New Tools

1. Extend `BaseTool`
2. Define Zod schema
3. Implement `execute()` returning `ToolResult`
4. Register in `ServiceManager.initializeTools()`

### New Services

1. Implement `vscode.Disposable`
2. Use singleton via `getInstance()` if shared
3. Add to appropriate phase in `ServiceManager`

## Testing

- Test files: `*.test.ts`, `*.spec.ts` in `src/__tests__/`
- VS Code mocked via `__mocks__/vscode.js`
- Vitest config uses alias: `vscode` → `__mocks__/vscode.js`
- React tests: `.tsx` with jsdom environment

## Data Flow

### Tool-Calling Analysis (Default)

1. `AnalysisOrchestrator` → `ToolCallingAnalysisProvider`
2. LLM requests context via tools (`FindSymbolTool`, `ReadFileTool`, etc.)
3. `ToolExecutor` runs tools (rate-limited: 50 calls/session)
4. Multi-turn conversation via `ConversationManager`

### Embedding-Based Context (Legacy)

1. `IndexingService.processFile()` → Tree-sitter chunking → embeddings
2. Storage in `VectorDatabaseService` (SQLite + HNSWlib)
3. `ContextProvider` combines LSP + embedding search
4. `TokenManagerService` applies waterfall truncation

## Planned Deprecation

The embedding-based context system is being phased out. Do not invest in:

- `IndexingService`, `IndexingManager`, `EmbeddingGenerationService`
- `VectorDatabaseService`, `EmbeddingDatabaseAdapter`
- `ContextProvider` embedding search paths
- Worker-based embedding generation (`src/workers/`)

Future direction: Tool-calling analysis via `ToolCallingAnalysisProvider` only.

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
