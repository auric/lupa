# Component Inventory

> **Complete listing of all components, services, tools, and types in Lupa**

---

## Coordinators (`src/coordinators/`)

| Component                 | File                         | Description                                      |
| ------------------------- | ---------------------------- | ------------------------------------------------ |
| `PRAnalysisCoordinator`   | `prAnalysisCoordinator.ts`   | Main extension entry, initializes ServiceManager |
| `AnalysisOrchestrator`    | `analysisOrchestrator.ts`    | Orchestrates PR analysis workflow                |
| `CopilotModelCoordinator` | `copilotModelCoordinator.ts` | Model selection and switching UI                 |
| `CommandRegistry`         | `commandRegistry.ts`         | Registers all VS Code commands                   |

---

## Services (`src/services/`)

| Service                       | File                             | Description                                |
| ----------------------------- | -------------------------------- | ------------------------------------------ |
| `ServiceManager`              | `serviceManager.ts`              | DI container with 3-phase initialization   |
| `ToolCallingAnalysisProvider` | `toolCallingAnalysisProvider.ts` | Main analysis engine with tool-calling     |
| `ChatParticipantService`      | `chatParticipantService.ts`      | `@lupa` chat participant                   |
| `GitOperationsManager`        | `gitOperationsManager.ts`        | High-level Git operations                  |
| `GitService`                  | `gitService.ts`                  | Low-level Git commands                     |
| `UIManager`                   | `uiManager.ts`                   | Webview panel management                   |
| `WorkspaceSettingsService`    | `workspaceSettingsService.ts`    | Settings persistence (`.vscode/lupa.json`) |
| `LoggingService`              | `loggingService.ts`              | Centralized logging with levels            |
| `StatusBarService`            | `statusBarService.ts`            | Status bar item management                 |
| `ChatFollowupProvider`        | `chatFollowupProvider.ts`        | Chat followup suggestions                  |
| `LanguageModelToolProvider`   | `languageModelToolProvider.ts`   | Agent Mode tool registration               |
| `RipgrepSearchService`        | `ripgrepSearchService.ts`        | VS Code ripgrep integration                |
| `ToolTestingWebviewService`   | `toolTestingWebview.ts`          | Tool testing UI (development)              |

### Per-Analysis Components

These components are created fresh for each analysis session, not managed by ServiceManager:

| Component                | File                        | Description                                    |
| ------------------------ | --------------------------- | ---------------------------------------------- |
| `SubagentExecutor`       | `subagentExecutor.ts`       | Isolated subagent execution for one analysis   |
| `SubagentSessionManager` | `subagentSessionManager.ts` | Subagent lifecycle and limits for one analysis |
| `PlanSessionManager`     | `planSessionManager.ts`     | Review plan state for current analysis         |

---

## Models (`src/models/`)

| Model                     | File                         | Description                                              |
| ------------------------- | ---------------------------- | -------------------------------------------------------- |
| `CopilotModelManager`     | `copilotModelManager.ts`     | Model selection and LLM API                              |
| `ConversationManager`     | `conversationManager.ts`     | Conversation history management                          |
| `ConversationRunner`      | `conversationRunner.ts`      | Multi-turn conversation loop                             |
| `ToolExecutor`            | `toolExecutor.ts`            | Parallel tool execution (Promise.all) with rate limiting |
| `ToolRegistry`            | `toolRegistry.ts`            | Tool storage and retrieval                               |
| `PromptGenerator`         | `promptGenerator.ts`         | System and user prompt generation                        |
| `TokenValidator`          | `tokenValidator.ts`          | Context window validation and cleanup                    |
| `TokenConstants`          | `tokenConstants.ts`          | Token limit constants                                    |
| `ToolConstants`           | `toolConstants.ts`           | Tool-related constants and limits                        |
| `ModelRequestHandler`     | `modelRequestHandler.ts`     | Request/response handling                                |
| `ChatLLMClient`           | `chatLLMClient.ts`           | Chat-mode LLM client wrapper                             |
| `ChatContextManager`      | `chatContextManager.ts`      | Chat history processing                                  |
| `ToolCallStreamAdapter`   | `toolCallStreamAdapter.ts`   | Progress-only tool feedback via stream.progress()        |
| `SubagentStreamAdapter`   | `subagentStreamAdapter.ts`   | Prefixes subagent tool messages with "🔹 #N:"            |
| `DebouncedStreamHandler`  | `debouncedStreamHandler.ts`  | Debounces stream updates                                 |
| `WorkspaceSettingsSchema` | `workspaceSettingsSchema.ts` | Settings Zod schema                                      |

### Interfaces

| Interface          | File                | Description           |
| ------------------ | ------------------- | --------------------- |
| `ILLMClient`       | `ILLMClient.ts`     | LLM client interface  |
| `IServiceRegistry` | `serviceManager.ts` | Service registry type |

---

## Tools (`src/tools/`)

### Base Classes and Interfaces

| Component  | File          | Description                       |
| ---------- | ------------- | --------------------------------- |
| `BaseTool` | `baseTool.ts` | Abstract base class for all tools |
| `ITool`    | `ITool.ts`    | Tool interface definition         |

### Investigation Tools

| Tool                     | File                        | Name                   | Description                         |
| ------------------------ | --------------------------- | ---------------------- | ----------------------------------- |
| `FindSymbolTool`         | `findSymbolTool.ts`         | `find_symbol`          | Find symbol definitions with source |
| `FindUsagesTool`         | `findUsagesTool.ts`         | `find_usages`          | Find all usages of a symbol         |
| `ReadFileTool`           | `readFileTool.ts`           | `read_file`            | Read file content with pagination   |
| `ListDirTool`            | `listDirTool.ts`            | `list_directory`       | List directory contents             |
| `FindFilesByPatternTool` | `findFilesByPatternTool.ts` | `find_files`           | Glob-based file search              |
| `GetSymbolsOverviewTool` | `getSymbolsOverviewTool.ts` | `get_symbols_overview` | Hierarchical symbol structure       |
| `SearchForPatternTool`   | `searchForPatternTool.ts`   | `search_for_pattern`   | Text/regex search via ripgrep       |

### Reasoning Tools

| Tool                          | File                             | Name                        | Description            |
| ----------------------------- | -------------------------------- | --------------------------- | ---------------------- |
| `ThinkAboutContextTool`       | `thinkAboutContextTool.ts`       | `think_about_context`       | Context reasoning      |
| `ThinkAboutTaskTool`          | `thinkAboutTaskTool.ts`          | `think_about_task`          | Task decomposition     |
| `ThinkAboutCompletionTool`    | `thinkAboutCompletionTool.ts`    | `think_about_completion`    | Completion check       |
| `ThinkAboutInvestigationTool` | `thinkAboutInvestigationTool.ts` | `think_about_investigation` | Investigation planning |

### Delegation Tools

| Tool              | File                 | Name           | Description                     |
| ----------------- | -------------------- | -------------- | ------------------------------- |
| `RunSubagentTool` | `runSubagentTool.ts` | `run_subagent` | Delegate complex investigations |

### Planning Tools

| Tool             | File                | Name          | Description                                 |
| ---------------- | ------------------- | ------------- | ------------------------------------------- |
| `UpdatePlanTool` | `updatePlanTool.ts` | `update_plan` | Create and track review plan with checklist |

### Completion Tools

| Tool               | File                  | Name            | Description                                           |
| ------------------ | --------------------- | --------------- | ----------------------------------------------------- |
| `SubmitReviewTool` | `submitReviewTool.ts` | `submit_review` | Explicit completion signal - terminates analysis loop |

### Tool Utilities

| Utility                 | File                       | Description                              |
| ----------------------- | -------------------------- | ---------------------------------------- |
| `DefinitionFormatter`   | `definitionFormatter.ts`   | Format symbol definitions                |
| `UsageFormatter`        | `usageFormatter.ts`        | Format usage results                     |
| `SearchResultFormatter` | `searchResultFormatter.ts` | Format search results                    |
| `SymbolRangeExpander`   | `symbolRangeExpander.ts`   | Expand symbol ranges for body extraction |

---

## Prompts (`src/prompts/`)

| Generator                        | File                                | Description                    |
| -------------------------------- | ----------------------------------- | ------------------------------ |
| `ToolAwareSystemPromptGenerator` | `toolAwareSystemPromptGenerator.ts` | Main analysis system prompt    |
| `SubagentPromptGenerator`        | `subagentPromptGenerator.ts`        | Subagent investigation prompts |

---

## Utilities (`src/utils/`)

| Utility                | File                      | Description                            |
| ---------------------- | ------------------------- | -------------------------------------- |
| `DiffUtils`            | `diffUtils.ts`            | Parse and analyze diffs                |
| `PathSanitizer`        | `pathSanitizer.ts`        | Path validation and security           |
| `SymbolExtractor`      | `symbolExtractor.ts`      | VS Code symbol extraction              |
| `SymbolMatcher`        | `symbolMatcher.ts`        | Symbol name matching and cleaning      |
| `SymbolFormatter`      | `symbolFormatter.ts`      | Symbol formatting utilities            |
| `OutputFormatter`      | `outputFormatter.ts`      | Tool output formatting                 |
| `FileDiscoverer`       | `fileDiscoverer.ts`       | File discovery with fdir               |
| `FileTreeBuilder`      | `fileTreeBuilder.ts`      | Build file tree for chat UI            |
| `CodeFileDetector`     | `codeFileDetector.ts`     | Detect source code files               |
| `CodeFileUtils`        | `codeFileUtils.ts`        | Code file utilities                    |
| `GitUtils`             | `gitUtils.ts`             | Git helper functions                   |
| `ErrorUtils`           | `errorUtils.ts`           | Error message extraction               |
| `AsyncUtils`           | `asyncUtils.ts`           | Async utilities (withTimeout)          |
| `ChatResponseBuilder`  | `chatResponseBuilder.ts`  | Chat response formatting               |
| `ChatMarkdownStreamer` | `chatMarkdownStreamer.ts` | Stream markdown with clickable anchors |

---

## Types (`src/types/`)

| Type File               | Key Types                                                      |
| ----------------------- | -------------------------------------------------------------- |
| `types.ts`              | Common shared types                                            |
| `analysisTypes.ts`      | `AnalysisResult`, `AnalysisOptions`                            |
| `chatTypes.ts`          | `ChatToolCallHandler`, `ChatAnalysisMetadata`                  |
| `contextTypes.ts`       | `DiffHunk`, `DiffHunkLine`, `ParsedDiffLine`                   |
| `conversationTypes.ts`  | `Message`, `ConversationRole`                                  |
| `modelTypes.ts`         | `ToolCallRequest`, `ToolCallResponse`, `SubagentTask`          |
| `toolCallTypes.ts`      | `ToolCallRecord`, `ToolCallsData`, `AnalysisProgressCallback`  |
| `toolResultTypes.ts`    | `ToolResult`, `ToolResultMetadata`, `toolSuccess`, `toolError` |
| `vscodeGitExtension.ts` | Git extension API types                                        |
| `webviewMessages.ts`    | Webview message types                                          |

---

## Webview Components (`src/webview/`)

### Main Components

| Component      | File               | Description                     |
| -------------- | ------------------ | ------------------------------- |
| `AnalysisView` | `AnalysisView.tsx` | Main analysis results container |

### Tab Components

| Component      | File                          | Description                    |
| -------------- | ----------------------------- | ------------------------------ |
| `AnalysisTab`  | `components/AnalysisTab.tsx`  | Analysis content with markdown |
| `DiffTab`      | `components/DiffTab.tsx`      | Diff visualization             |
| `ToolCallsTab` | `components/ToolCallsTab.tsx` | Tool execution history         |

### Utility Components

| Component          | File                              | Description                       |
| ------------------ | --------------------------------- | --------------------------------- |
| `MarkdownRenderer` | `components/MarkdownRenderer.tsx` | Markdown with syntax highlighting |
| `CopyButton`       | `components/CopyButton.tsx`       | Copy to clipboard button          |
| `FileLink`         | `components/FileLink.tsx`         | Clickable file path links         |
| `JsonViewer`       | `components/JsonViewer.tsx`       | JSON tree viewer                  |

### Development Components

| Component     | File                           | Description            |
| ------------- | ------------------------------ | ---------------------- |
| `ToolTesting` | `tool-testing/toolTesting.tsx` | Tool testing interface |

---

## Configuration (`src/config/`)

| File           | Contents                                    |
| -------------- | ------------------------------------------- |
| `constants.ts` | Application constants, cancellation message |
| `chatEmoji.ts` | Chat emoji definitions for UI feedback      |

---

## UI Library (`src/lib/` and `src/components/`)

| File               | Description                                 |
| ------------------ | ------------------------------------------- |
| `lib/utils.ts`     | `cn()` utility for className merging        |
| `lib/pathUtils.ts` | File path parsing, markdown link extraction |
| `components/ui/*`  | shadcn/ui generated components              |

---

## Commands (from `package.json`)

| Command ID                 | Title                 | Description          |
| -------------------------- | --------------------- | -------------------- |
| `lupa.analyzePR`           | Analyze Pull Request  | Start PR analysis    |
| `lupa.selectLanguageModel` | Select Language Model | Choose Copilot model |
| `lupa.selectRepository`    | Select Git Repository | Choose repository    |
| `lupa.resetAnalysisLimits` | Reset Analysis Limits | Reset to defaults    |
| `lupa.openToolTesting`     | Open Tool Testing     | Dev tool testing UI  |
| `lupa.testWebview`         | Test Webview          | Dev webview testing  |

---

## Chat Participant (from `package.json`)

| Property    | Value                                  |
| ----------- | -------------------------------------- |
| ID          | `lupa.chat-participant`                |
| Name        | `lupa`                                 |
| Full Name   | Lupa Code Review                       |
| Description | Analyze pull requests and code changes |

### Commands

| Command    | Description                              |
| ---------- | ---------------------------------------- |
| `/branch`  | Analyze current branch vs default branch |
| `/changes` | Analyze uncommitted changes              |

---

## Language Model Tools (from `package.json`)

| Tool Name                 | Display Name         | Description                                 |
| ------------------------- | -------------------- | ------------------------------------------- |
| `lupa_getSymbolsOverview` | Get Symbols Overview | Hierarchical symbol overview for Agent Mode |
