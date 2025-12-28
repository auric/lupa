# Changelog

All notable changes to Lupa will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.4] - 2025-12-27

### Fixed

- **Webview initialization bug**: Fixed an issue where the analysis webview could fail to load on first open. The root cause was duplicate initialization paths in `main.tsx` - both a `DOMContentLoaded` listener AND an immediate execution check were present, causing race conditions. Simplified to match the working `toolTesting.tsx` pattern: single `DOMContentLoaded` listener only.

### Changed

- **Shared webview type declarations**: Created `webviewGlobals.ts` for consistent `Window` interface declarations across webview entry points, eliminating duplicate type definitions.

## [0.1.3] - 2025-12-26

### Changed

- **Portable repository path settings**: Repository path is now stored as `.` when it matches the workspace root, making `.vscode/lupa.json` portable across machines with different absolute paths

### Fixed

- **Git root vs workspace folder**: Tools and services now correctly use the Git repository root instead of the VS Code workspace folder. This fixes issues when the Git repository is in a parent directory or different location than the workspace folder:
    - `FindUsagesTool` now uses `GitOperationsManager` for path resolution
    - `ChatParticipantService` now uses Git root for file links and filetree display
    - `WorkspaceSettingsService` stores relative path marker (`.`) for workspace-matching repositories

## [0.1.2] - 2025-12-26

### Changed

#### File Link Format

- **Markdown links for file references**: LLM prompts now instruct models to use markdown link format `[file.ts:42](file.ts:42)` instead of backtick format
- **Webview markdown link rendering**: File path links in markdown are now rendered as clickable FileLink components
- **Simplified implementation**: Removed regex-based plain text file path detection in favor of standard markdown links

### Fixed

- **Windows path support in markdown links**: Fixed `parseFilePathFromUrl` to correctly handle Windows absolute paths with drive letters (e.g., `C:\src\file.ts:42`). The regex was incorrectly rejecting paths containing colons.
- **Line range support in file links**: Added support for line ranges like `file.ts:104-115` in markdown file references. Previously only single lines (`:42`) or line:column (`:42:10`) were supported.
- **Chat participant file links**: File references in chat output now use VS Code's `stream.anchor()` API for proper clickable navigation instead of plain markdown links. This fixes the issue where markdown file links like `[file.ts:42](file.ts:42)` were not clickable in VS Code Chat.
- **Dot file support in file links**: Added support for files starting with a dot (e.g., `.gitignore`, `.env`, `src/.eslintrc.js`). These files are now correctly parsed as valid file references.

## [0.1.1] - 2025-12-26

### Changed

#### React Compiler Adoption

- **Removed manual memoization**: Eliminated all `React.memo()`, `useMemo()`, and `useCallback()` from webview components
- **Automatic optimization**: React Compiler now handles memoization automatically, providing equal or better performance
- **Simplified codebase**: Cleaner component code without explicit memoization boilerplate

---

## [0.1.0] - 2025-12-26

### Added

#### Core Analysis Engine

- **Tool-Calling Architecture**: LLM-driven analysis that dynamically requests context via specialized tools
- **Multi-Turn Conversations**: Iterative analysis with persistent conversation state
- **Subagent Delegation**: Complex investigations delegated to autonomous sub-agents for parallel research

#### Analysis Tools

##### Investigation Tools (7)

- `ReadFileTool` - Read file contents with line range support
- `FindSymbolTool` - LSP-based symbol definition lookup
- `FindUsagesTool` - Find all usages/references of a symbol
- `GetSymbolsOverviewTool` - Hierarchical symbol structure extraction
- `ListDirTool` - Directory listing with tree structure
- `FindFilesByPatternTool` - Glob-based file discovery
- `SearchForPatternTool` - Text/regex search via ripgrep

##### Reasoning Tools (4)

- `ThinkAboutContextTool` - Context reasoning
- `ThinkAboutTaskTool` - Task decomposition
- `ThinkAboutCompletionTool` - Completion check
- `ThinkAboutInvestigationTool` - Investigation planning

##### Delegation Tools (1)

- `RunSubagentTool` - Delegate complex analysis to sub-agents

#### User Interface

- **Webview Mode**: Full-featured analysis panel with rich UI
    - Markdown rendering with syntax highlighting
    - Copy-to-clipboard functionality
- **Chat Participant Mode**: Native VS Code chat integration
    - `@lupa /branch` - Analyze changes on current branch vs base
    - `@lupa /changes` - Analyze unstaged/uncommitted changes

#### Model Management

- **Model Selection**: Choose from available Copilot models via command
- **Default Model**: GPT-4.1 (free and available by default)
- **Settings Persistence**: Model preferences saved in `.vscode/lupa.json`

#### Services

- `ServiceManager` - Dependency injection with 3-phase initialization
- `ToolCallingAnalysisProvider` - Main analysis loop with tool execution
- `ConversationManager` - Multi-turn conversation state management
- `ToolExecutor` - Rate-limited tool execution with retry logic
- `ToolRegistry` - Dynamic tool registration and discovery
- `PromptGenerator` - Context-aware system prompt generation
- `CopilotModelManager` - Model selection and capability detection
- `WorkspaceSettingsService` - Persistent settings management
- `GitService` - Git operations and diff retrieval
- `UIService` - Webview panel management
- `StatusBarService` - Status bar indicators
- `LoggingService` - Structured logging

#### Developer Experience

- TypeScript 5.9 with strict mode
- Vite 7.x dual build (Node.js extension + browser webview)
- Vitest 4.x test framework with VS Code mocks
- React 19 with React Compiler for webview
- Tailwind CSS v4 with shadcn/ui components

### Technical Details

- **VS Code Compatibility**: 1.107+
- **Copilot API**: Uses Language Model Tool API for function calling
- **Architecture**: Service-Oriented with tool-calling LLM pattern
- **Session Management**: Rate limiting, token tracking, cancellation support

---

[0.1.4]: https://github.com/auric/lupa/releases/tag/v0.1.4
[0.1.3]: https://github.com/auric/lupa/releases/tag/v0.1.3
[0.1.2]: https://github.com/auric/lupa/releases/tag/v0.1.2
[0.1.1]: https://github.com/auric/lupa/releases/tag/v0.1.1
[0.1.0]: https://github.com/auric/lupa/releases/tag/v0.1.0
