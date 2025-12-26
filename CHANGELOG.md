# Changelog

All notable changes to Lupa will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] - 2025-12-26

### Changed

#### File Link Format

- **Markdown links for file references**: LLM prompts now instruct models to use markdown link format `[file.ts:42](file.ts:42)` instead of backtick format
- **Webview markdown link rendering**: File path links in markdown are now rendered as clickable FileLink components
- **Simplified implementation**: Removed regex-based plain text file path detection in favor of standard markdown links

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

[0.1.1]: https://github.com/auric/lupa/releases/tag/v0.1.1
[0.1.0]: https://github.com/auric/lupa/releases/tag/v0.1.0
