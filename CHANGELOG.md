# Changelog

All notable changes to Lupa will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.6] - 2026-01-02

### Fixed

#### Concurrent Analysis Support

- **Thread-safe ToolCallingAnalysisProvider**: Refactored `ToolCallingAnalysisProvider` to support concurrent analyses from the chat participant. Previously, instance-level state (`tokenValidator`, `toolCallRecords`, `currentIteration`, etc.) would be corrupted if multiple analyses ran simultaneously. Now all per-analysis state is created locally within the `analyze()` method, enabling safe concurrent execution.

- **Per-analysis subagent services**: `SubagentExecutor` and `SubagentSessionManager` are now created per-analysis instead of as shared singletons. Previously, mutable state (progress callbacks, spawn counts, cancellation tokens) could be overwritten when concurrent analyses ran, causing race conditions. These services are now instantiated within `ToolCallingAnalysisProvider.analyze()` and passed to tools via `ExecutionContext`.

- **Per-request ToolExecutor in ToolTestingWebview**: Fixed concurrency issue where `ToolTestingWebviewService` used a shared `ToolExecutor` singleton. Now creates per-request executor instances to ensure isolation from concurrent analysis sessions.

- **Review extraction for unclosed code blocks**: Improved `extractReviewFromMalformedToolCall()` to handle cases where the LLM outputs JSON in an unclosed code block (forgets closing triple backticks). Added logging for debugging failed extractions.

#### Exploration Mode Tool Filtering

- **Main-only tools excluded from exploration**: Chat participant exploration mode now correctly filters out tools that require PR context (`submit_review`, `update_plan`, `think_about_completion`, `think_about_context`, `think_about_task`). Previously all 14 tools were exposed in exploration mode, causing confusing behavior when users invoked PR-specific tools outside of a review.

### Added

#### Subagent Support in Exploration Mode

- **`run_subagent` now available in exploration mode**: Users can now delegate complex multi-module questions to focused investigation agents when using Lupa without a slash command. Previously, subagent delegation was only available during PR analysis.

- **Exploration subagent guidance**: Added `generateExplorationSubagentGuidance()` prompt block - a simpler version without diff-related warnings since exploration mode has no diff context.

- **Exploration tool guide updated**: Added `run_subagent` to the exploration mode tool selection table with guidance on when to delegate complexity.

#### Concurrency Tests

- **Concurrent analysis regression tests**: Added integration tests verifying that multiple analyses can run simultaneously without state interference. Tests validate that tool call records, iteration counts, and results remain isolated per-analysis.

- **Subagent isolation tests**: Added test verifying `SubagentSessionManager` instances are isolated between concurrent analyses, with independent spawn counts and cancellation tokens.

#### Plan Tool

- **`update_plan` tool**: New tool allowing the LLM to create and update a structured review plan during analysis. The LLM can now maintain a markdown checklist to track which files have been reviewed, what findings were discovered, and what remains to investigate. This improves analysis coverage and helps ensure comprehensive reviews.

#### Modular Prompt Architecture

- **Prompt Builder Pattern**: Refactored prompt generation to use a composable builder pattern. Prompts are now assembled from modular blocks stored in `src/prompts/blocks/`:
    - `roleDefinitions.ts` - Staff Engineer personas for PR review and exploration
    - `toolSection.ts` - Dynamic tool inventory generator
    - `toolSelectionGuide.ts` - When-to-use-what tool reference tables
    - `subagentGuidance.ts` - Condensed delegation rules (~300 tokens vs ~1500 previously)
    - `analysisMethodology.ts` - Step-by-step analysis process
    - `outputFormat.ts` - Review structure and severity guide
    - `selfReflection.ts` - `think_about_*` tools guidance

### Changed

- **Relaxed submit_review minimum length**: Changed from 100 to 20 characters minimum. The previous limit could cause infinite retry loops when the LLM correctly identified "LGTM" scenarios with minimal issues to report.

- **Condensed subagent instructions**: Reduced subagent delegation guidance from ~1500 tokens to ~300 tokens while preserving critical information. Uses table format for mandatory triggers and constraint summary.
- **Simplified user prompt**: Removed redundant tool instructions from user prompt (now in system prompt only). User prompt focuses on diff content and workflow reminder.
- **Improved prompt maintainability**: Each prompt block is now a separate file, making it easier to update individual sections without modifying a 600-line monolithic generator.

### Internal

- `ExecutionContext` extended with optional `subagentSessionManager` and `subagentExecutor` fields
- `SubagentExecutor` constructor accepts `progressCallback` parameter (immutable vs previous mutable setter)
- `RunSubagentTool` retrieves executor and session manager from `ExecutionContext` instead of constructor injection
- `ServiceManager` no longer creates singleton subagent services
- `PlanSessionManager` service for tracking review plan state across tool calls
- `PromptBuilder` class with fluent interface for composing prompts
- Pre-configured builders: `createPRReviewPromptBuilder()`, `createExplorationPromptBuilder()`
- `ToolTestingWebviewService` accepts `WorkspaceSettingsService` instead of `ToolExecutor`, creates per-request executors
- `ChatParticipantService.handleExplorationMode()` creates subagent infrastructure for exploration mode
- Extracted `createSubagentContext()` and `createStreamAdapter()` helpers in `ChatParticipantService` to reduce duplication
- `PromptBuilder.addExplorationSubagentGuidance()` method for exploration mode prompts

## [0.1.5] - 2025-12-29

### Fixed

- `FindFilesByPatternTool`: provided picomatch glob function to fix bundling issues with Vite. Previously, the tool failed to execute in the bundled extension due to missing dependencies.
- **Webview data injection failures**: Fixed critical bug where analysis webview failed on first open with "Analysis data not found" error but worked on subsequent opens. Root cause: JSON data was embedded directly in `<script>` tags as JavaScript literals, which silently failed when content contained special characters (backticks, `${}`, `</script>`) that broke either the HTML parser or JavaScript template literal generation. Fix: Changed to `<script type="application/json">` pattern - data is stored as text in a non-executable script tag and parsed with `JSON.parse()` at runtime, avoiding all parsing conflicts.
- **Webview module script timing**: Fixed issue where `DOMContentLoaded` listener in module scripts never fired because module scripts have implicit `defer` and execute after the event has already fired. Fix: Created `onDomReady()` utility that checks `document.readyState` and either waits for the event or executes immediately if DOM is already ready.
- **Webview panel context preservation**: Added `retainContextWhenHidden: true` to analysis webview panel options to prevent context destruction during panel reuse.

## [0.1.4] - 2025-12-28

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

[0.1.6]: https://github.com/auric/lupa/releases/tag/v0.1.6
[0.1.5]: https://github.com/auric/lupa/releases/tag/v0.1.5
[0.1.4]: https://github.com/auric/lupa/releases/tag/v0.1.4
[0.1.3]: https://github.com/auric/lupa/releases/tag/v0.1.3
[0.1.2]: https://github.com/auric/lupa/releases/tag/v0.1.2
[0.1.1]: https://github.com/auric/lupa/releases/tag/v0.1.1
[0.1.0]: https://github.com/auric/lupa/releases/tag/v0.1.0
