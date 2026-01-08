# Changelog

All notable changes to Lupa will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.11] - 2026-01-08

### Fixed

- **Unresponsive symbol searches resolved**: Previously, a single slow language server could block symbol extraction for 9+ minutes. Now each file has a 5-second timeout, and the search returns partial results gracefully instead of hanging.

- **Cancellation now works instantly**: Stopping an analysis mid-operation now cancels file discovery and symbol extraction immediately. Previously, these operations would continue running in the background.

- **Ripgrep searches stop on cancel**: Pattern searches now terminate immediately when analysis is cancelled, instead of continuing to run in the background.

- **File discovery uses proper cancellation**: Directory crawls now use native fdir cancellation support, ensuring immediate termination when stopped.

- **File discovery no longer blocks VS Code**: Large directory scans now run asynchronously, keeping VS Code responsive during searches.

- **Resource leaks fixed**: Timer handles that accumulated during long symbol searches are now properly cleaned up.

- **Cancellation errors properly propagated**: Fixed multiple locations where cancellation errors were being swallowed instead of re-thrown, causing cancelled operations to appear successful. Affected `FindSymbolTool`, `GetSymbolsOverviewTool`, `conversationRunner`, and `analysisOrchestrator`.

- **File discovery reports partial results on abort**: When file discovery is cancelled mid-crawl, it now correctly reports `truncated: true` instead of silently treating partial results as complete.

- **Consistent path normalization for gitignore**: Directory exclusion now normalizes paths to POSIX format before gitignore checks, matching the behavior of file filters.

- **Unhandled promise rejection warnings eliminated**: Fixed async utilities where cancellation promises could reject after `Promise.race` settled, causing Node.js warning messages. Cancellation promises are now silently handled.

### Added

- **Better timeout error handling**: Tools now use a consistent `TimeoutError` class for all timeout scenarios, enabling more reliable detection and user-friendly messages.

- **Timeout logging**: When operations time out, the system logs details to help diagnose slow language servers.

- **Debug logging for skipped files**: Silent error catches in symbol extraction now log at debug level for easier troubleshooting.

## [0.1.10] - 2026-01-05

### Added

#### Attribution & Licensing

- **Proper copyright attribution**: Added copyright notice to LICENSE file header, package.json author field, README footer, and key source files.
- **License badge**: Added AGPL-3.0 license badge to README.

## [0.1.9] - 2026-01-04

### Added

#### Subagent Tool Visibility

- **See what subagents are doing**: When a subagent is spawned in chat, you now see its tool invocations with a distinctive prefix. For example: "🔹 #1: 📂 Read src/auth.ts" clearly indicates which subagent is performing which action.

- **Visual distinction**: Main agent actions appear normally (e.g., "📂 Read file") while subagent actions are prefixed with "🔹 #N:" to distinguish them from the parent analysis.

- **Clean architecture**: New `SubagentStreamAdapter` class bridges subagent tool calls to the chat UI with proper message prefixing.

### Changed

#### Chat Participant UI

- **Progress-only tool feedback**: Tool invocations use `stream.progress()` for all status messages. Progress messages are transient and clear automatically when the final response appears, providing clean UX without noisy copy/paste output.

- **Improved progress message wording**: Quick actions use past tense ("Read file.ts", "Listed directory"). Search actions use neutral wording that doesn't imply success ("Looked up symbol", "Searched usages"). Long-running actions use present continuous ("Analyzing context...").

- **Input sanitization**: Tool arguments are sanitized before display to prevent markdown injection (backticks escaped, whitespace trimmed).

- **Cleaner iteration messages**: Subagent turn-by-turn iteration counters ("Sub-analysis (1/100)...", etc.) are suppressed. Instead, you see the actual tool actions being performed.

- **Enhanced find_usages progress**: Now shows both the symbol name AND the file path context (e.g., "Searched usages of `login` in src/auth.ts") for more informative feedback.

#### Architecture Improvements

- **Simplified ToolCallStreamAdapter**: The `formatToolMessage()` method returns a plain string. Consolidated from 4 separate methods into one, following Single Responsibility Principle.

### Fixed

- **Subagent tool completions surfaced to chat UI**: `SubagentExecutor` now forwards `onToolCallComplete` events to the subagent stream adapter.

- **Consistent anchor behavior for unresolved paths**: `streamMarkdownWithAnchors` no longer emits anchors for relative file paths when workspace root is unavailable. Now emits plain text instead.

- **Fixed `list_directory` progress message**: Now correctly displays the directory path (e.g., "📂 Listed src/utils") instead of generic "Listing directory..." message.

### Testing

- **SubagentStreamAdapter test suite**: Comprehensive tests covering message prefixing, visual distinction, iteration suppression, and proper delegation.

- **ToolCallStreamAdapter tests**: Updated to expect progress-only output.

- **chatMarkdownStreamer tests**: Added test for plain text output when workspace root is undefined.

## [0.1.8] - 2026-01-02

### Added

#### Multi-Vendor Model Support

- **All model vendors now supported**: Lupa can now use language models from any vendor configured in GitHub Copilot, not just the built-in Copilot models. This includes models added via third-party API keys (OpenAI, etc.).

- **Vendor shown in model picker**: The model selection dialog now displays the vendor name alongside each model (e.g., "copilot · 128K tokens"), making it easier to distinguish between models with similar names from different providers. Copilot models are listed first, with the current/default model at the top.

- **New `preferredModelIdentifier` setting**: Model preferences are now stored using a unique `vendor/id` format (e.g., `copilot/gpt-4.1`), which correctly identifies models even when multiple vendors provide models with similar names or versions.

#### Improved Error Handling

- **Centralized API error detection**: All API error handling is now centralized in `ConversationRunner.detectFatalError()`, ensuring consistent behavior across both command palette and chat participant paths.

- **Anthropic BYOK error handling**: When using Anthropic models configured via "bring your own key", Lupa now shows a clear error message explaining that these models don't work due to VS Code Language Model API limitations (no system prompt support). See [vscode#255286](https://github.com/microsoft/vscode/issues/255286).

- **Invalid request errors**: API errors with `invalid_request_error` type are now detected as fatal errors and show user-friendly messages explaining the issue.

#### Developer Experience

- **Model logging at analysis start**: The selected model name, vendor, ID, and token limit are now logged at the start of each analysis for easier debugging.

- **GitHub Copilot Chat dependency declared**: Added `GitHub.copilot-chat` to `extensionDependencies` in package.json. VS Code now ensures Copilot Chat is installed and enabled before Lupa activates, providing a clear error if it's missing.

### Changed

#### README Improvements

- **Clearer credit consumption warning**: Added prominent warning at the top of the README explaining that Lupa makes 50-100+ tool calls per analysis, which can quickly consume premium request quotas.

- **"Why Lupa?" section**: Added explanation of the name (Spanish for "magnifying glass") and the metaphor behind the extension.

- **GPT-4.1 guidance clarified**: Updated documentation to reflect that GPT-4.1 works reasonably well for small to medium PRs, but struggles with large code changes.

- **Model cost comparison table**: Replaced bullet list with a table showing cost and notes for recommended free models.

- **Anthropic BYOK limitation documented**: Added note that Anthropic models configured via "bring your own key" do not work due to VS Code Language Model API not supporting system prompts ([vscode#255286](https://github.com/microsoft/vscode/issues/255286)).

#### Architecture Improvements

- **Simplified CopilotModelManager.sendRequest()**: Error handling removed from `CopilotModelManager` and `ChatLLMClient`. Both now delegate directly to `ModelRequestHandler`, with error detection handled centrally in `ConversationRunner`.

### Fixed

- **Model identifier validation**: The model identifier parser now validates input format, rejecting malformed identifiers (empty strings, missing vendor/id parts) and falling back to the default model gracefully.

- **Fatal error detection**: Fixed `detectFatalError()` to treat all `invalid_request_error` type errors as fatal. The function checks for `model_not_supported` codes first, then detects `invalid_request_error` types with specialized messages for system-prompt-related failures.

- **CopilotApiError wrapping restored**: Fatal API errors are now properly wrapped in `CopilotApiError` with appropriate error codes, ensuring consistent error type checking across the codebase.

- **Model identifier normalization**: Vendor-less identifiers (e.g., `gpt-4.1`) are now normalized to canonical `vendor/id` form (`copilot/gpt-4.1`) when saved, ensuring consistent settings storage.

- **Default model selector now includes vendor**: When falling back to the default model, the selector now explicitly specifies `vendor: 'copilot'` to prevent ambiguous matches if other vendors provide models with the same ID.

- **Invalid identifiers cleared from settings**: When a malformed model identifier is detected, it's now cleared from settings to prevent repeated fallback warnings on every analysis.

- **Vendor casing normalized**: Model vendor names are now normalized to lowercase for consistent comparison and storage (e.g., `CoPilot/gpt-4.1` becomes `copilot/gpt-4.1`).

- **Binary files filtered from diffs**: Binary file diffs (images, compiled files, etc.) are now automatically filtered out before being sent to the LLM. This prevents wasting tokens on non-reviewable content and avoids confusing the model with binary markers. Comprehensive test coverage added for all git binary diff formats.

## [0.1.7] - 2026-01-02

### Fixed

#### File Link Parsing

- **GitHub-style line references**: Added support for GitHub-style `#L` line references in file links. Links like `[file.cpp:79-85](path/file.cpp#L79-L85)` and `[file.cpp](file.cpp#L42)` now work correctly in both the webview and chat participant. Previously, only colon-based formats (`:79`, `:79-85`) were recognized.

- **Mixed line range formats**: Support for mixed GitHub-style formats like `#L79-85` (L prefix only on start line) in addition to `#L79-L85`.

#### Symbol Tool Improvements

- **Flexible name_path separator**: The `find_symbol` tool now accepts both `/` and `.` as path separators. LLMs sometimes use `ChatParticipantService.handleExplorationRequest` instead of `ChatParticipantService/handleExplorationRequest`, and both now work correctly.

- **Dot-preserving path parsing**: When `/` is present in the name_path, dots are preserved in symbol names. For example, `MyClass/file.spec` correctly parses as `['MyClass', 'file.spec']` instead of incorrectly splitting on the dot.

- **Removed undocumented absolute path claim**: The schema documentation previously claimed `/MyClass/method` would find method in "top-level MyClass only", but this feature was never implemented. The misleading documentation has been removed.

#### Analysis Progress

- **Non-intrusive progress indicator**: Changed analysis progress from a notification toast to the status bar window indicator. The progress is now shown in the status bar instead of a popup notification, providing a cleaner UX without blocking the UI.

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

[0.1.11]: https://github.com/auric/lupa/releases/tag/v0.1.11
[0.1.10]: https://github.com/auric/lupa/releases/tag/v0.1.10
[0.1.9]: https://github.com/auric/lupa/releases/tag/v0.1.9
[0.1.8]: https://github.com/auric/lupa/releases/tag/v0.1.8
[0.1.7]: https://github.com/auric/lupa/releases/tag/v0.1.7
[0.1.6]: https://github.com/auric/lupa/releases/tag/v0.1.6
[0.1.5]: https://github.com/auric/lupa/releases/tag/v0.1.5
[0.1.4]: https://github.com/auric/lupa/releases/tag/v0.1.4
[0.1.3]: https://github.com/auric/lupa/releases/tag/v0.1.3
[0.1.2]: https://github.com/auric/lupa/releases/tag/v0.1.2
[0.1.1]: https://github.com/auric/lupa/releases/tag/v0.1.1
[0.1.0]: https://github.com/auric/lupa/releases/tag/v0.1.0
