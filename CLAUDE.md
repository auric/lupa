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
3. Implement `execute()` returning `ToolResult`
4. Register in `ServiceManager.initializeTools()`
5. Access per-analysis dependencies (e.g., `SubagentExecutor`) via `ExecutionContext` parameter

### ExecutionContext

Tools receive an `ExecutionContext` with per-analysis dependencies:

```typescript
interface ExecutionContext {
    planManager?: PlanSessionManager;
    subagentSessionManager?: SubagentSessionManager;
    subagentExecutor?: SubagentExecutor;
}
```

### New Services

1. Implement `vscode.Disposable`
2. Add to appropriate phase in `ServiceManager`

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
- Use subagents for parallel research tasks—break complex work into small, focused subtasks (never delegate the entire task to a single subagent)
- **Use subagents for bulk similar edits**—when making the same type of change across many files (e.g., updating test files for new API signatures, adding a parameter to multiple functions), delegate the bulk edits to a subagent with clear instructions and examples
- **Consult DeepWiki MCP for external library questions**—when unsure about API usage, mocking patterns, or library-specific behavior (e.g., Vitest, VS Code API), use Deepwiki MCP with the appropriate repo (e.g., `vitest-dev/vitest`, `microsoft/vscode`)
- At session end, provide a ready-to-use git commit message summarizing changes

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
