# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Lupa** is a VS Code extension that performs comprehensive pull request analysis using GitHub Copilot models. It uses a tool-calling architecture where the LLM dynamically requests context via LSP queries, file reading, and pattern searching.

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

**Context window warning:** `npm run test` output is massive and will overwhelm context. After running tests, read only the last ~50 lines for the summary. Prefer running specific test files over the full suite. Use `npm run check-types` for quick validation instead of full builds.

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

### Key Entry Points

| File                                                                          | Purpose                                  |
| ----------------------------------------------------------------------------- | ---------------------------------------- |
| [serviceManager.ts](src/services/serviceManager.ts)                           | DI container, phase-based initialization |
| [toolCallingAnalysisProvider.ts](src/services/toolCallingAnalysisProvider.ts) | Main analysis loop with tool-calling     |
| [baseTool.ts](src/tools/baseTool.ts)                                          | Tool base class with Zod schema          |
| [vite.config.mts](vite.config.mts)                                            | Dual build configuration                 |

## Conventions

### Logging

Use `Log` from `loggingService.ts`, not `console.log`. Exception: webviews may use `console.log`.

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
- **Shared mock factories**: Use `src/__tests__/testUtils/mockFactories.ts` for common mocks
  - `createMockCancellationTokenSource()` - CancellationToken with proper listener tracking
  - `createMockWorkspaceSettings()` - WorkspaceSettingsService
  - `createMockFdirInstance()` - fdir file discovery
  - `createMockGitRepository()` - Git repository
- **Vitest 4**: Constructor mocks require `function` syntax, not arrow functions

## Data Flow

### Tool-Calling Analysis

1. `AnalysisOrchestrator` → `ToolCallingAnalysisProvider`
2. LLM requests context via tools (`FindSymbolTool`, `ReadFileTool`, etc.)
3. `ToolExecutor` runs tools (rate-limited by session)
4. Multi-turn conversation via `ConversationManager`
5. Subagent delegation for complex investigations via `RunSubagentTool`

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
