# Source Tree Analysis

> **Annotated directory structure for Lupa VS Code extension**

## Project Root

```
lupa/
├── 📁 .github/                    # GitHub configuration
│   ├── agents/                    # GitHub Copilot agent configs
│   └── copilot-instructions.md   # Copilot workspace instructions
│
├── 📁 .vscode/                    # VS Code workspace settings
│   └── tasks.json                # Build tasks
│
├── 📁 __mocks__/                  # Test mocks
│   └── vscode.js                 # VS Code API mock for Vitest
│
├── 📁 _bmad/                      # BMAD workflow system (development tooling)
│
├── 📁 coverage/                   # Test coverage reports (generated)
│
├── 📁 dist/                       # Build output (generated)
│   ├── extension.js              # Bundled extension
│   └── webview/                  # Bundled webview assets
│
├── 📁 docs/                       # Project documentation
│   ├── index.md                  # 👈 Documentation index
│   ├── architecture.md           # Architecture documentation
│   ├── project-overview.md       # Project overview
│   └── research/                 # Technical research notes
│
├── 📁 node_modules/               # Dependencies (gitignored)
│
├── 📁 scripts/                    # Build scripts
│   └── package-extension.js      # VSIX packaging script
│
├── 📁 src/                        # 👈 Source code (see below)
│
├── 📄 CLAUDE.md                   # Development guidelines
├── 📄 components.json             # shadcn/ui configuration
├── 📄 package.json                # Extension manifest
├── 📄 tsconfig.json               # TypeScript configuration
├── 📄 vite.config.mts             # Vite build configuration
└── 📄 vitest.jsdom.setup.ts       # Vitest jsdom setup
```

---

## Source Directory (`src/`)

```
src/
├── 📄 extension.ts                # 🚀 Extension entry point
│                                   # - activate() and deactivate()
│                                   # - Initializes PRAnalysisCoordinator
│
├── 📁 coordinators/               # High-level orchestration
│   ├── analysisOrchestrator.ts   # PR analysis workflow orchestration
│   ├── commandRegistry.ts        # VS Code command registration
│   └── copilotModelCoordinator.ts # Model selection UI
│
├── 📁 services/                   # Core business logic
│   ├── serviceManager.ts         # 🔑 DI container (3-phase init)
│   ├── toolCallingAnalysisProvider.ts # Main analysis engine
│   ├── chatParticipantService.ts # @lupa chat participant
│   ├── gitOperationsManager.ts   # Git repository operations
│   ├── gitService.ts             # Low-level Git commands
│   ├── subagentExecutor.ts       # Subagent isolation
│   ├── subagentSessionManager.ts # Subagent lifecycle
│   ├── uiManager.ts              # Webview management
│   ├── workspaceSettingsService.ts # Settings persistence
│   ├── loggingService.ts         # Centralized logging
│   ├── statusBarService.ts       # Status bar management
│   ├── chatFollowupProvider.ts   # Chat followup suggestions
│   ├── languageModelToolProvider.ts # Agent Mode tool provider
│   ├── ripgrepSearchService.ts   # VS Code ripgrep integration
│   └── toolTestingWebview.ts     # Tool testing UI (dev only)
│
├── 📁 models/                     # LLM interface & state
│   ├── copilotModelManager.ts    # Model selection & API
│   ├── conversationManager.ts    # Conversation history
│   ├── conversationRunner.ts     # Multi-turn loop
│   ├── toolExecutor.ts           # Tool execution + rate limit
│   ├── toolRegistry.ts           # Tool storage
│   ├── promptGenerator.ts        # Prompt generation
│   ├── tokenValidator.ts         # Context window management
│   ├── tokenConstants.ts         # Token limit constants
│   ├── toolConstants.ts          # Tool-related constants
│   ├── modelRequestHandler.ts    # Request/response handling
│   ├── chatLLMClient.ts          # Chat-mode LLM client
│   ├── chatContextManager.ts     # Chat history processing
│   ├── toolCallStreamAdapter.ts  # Progress-only tool feedback
│   ├── subagentStreamAdapter.ts  # Prefixes subagent messages with "🔹 #N:"
│   ├── debouncedStreamHandler.ts # Debounce stream updates
│   ├── workspaceSettingsSchema.ts # Settings Zod schema
│   ├── ILLMClient.ts             # LLM client interface
│   └── loggingTypes.ts           # Logging type definitions
│
├── 📁 tools/                      # LLM-callable tools
│   ├── baseTool.ts               # 🔑 Base class for all tools
│   ├── ITool.ts                  # Tool interface
│   │
│   │ # Core Investigation Tools
│   ├── findSymbolTool.ts         # Find symbol definitions
│   ├── findUsagesTool.ts         # Find symbol usages
│   ├── readFileTool.ts           # Read file content
│   ├── listDirTool.ts            # List directory
│   ├── findFilesByPatternTool.ts # Glob file search
│   ├── getSymbolsOverviewTool.ts # Hierarchical symbols
│   ├── searchForPatternTool.ts   # Text/regex search
│   │
│   │ # Planning Tool
│   ├── updatePlanTool.ts         # Create and track review plan
│   │
│   │ # Structured Thinking Tools
│   ├── thinkAboutContextTool.ts  # Context reasoning
│   ├── thinkAboutTaskTool.ts     # Task decomposition
│   ├── thinkAboutCompletionTool.ts # Completion check
│   ├── thinkAboutInvestigationTool.ts # Investigation planning
│   │
│   │ # Subagent Tool
│   ├── runSubagentTool.ts        # Delegate investigations
│   │
│   │ # Completion Tool
│   ├── submitReviewTool.ts       # Explicit completion signal
│   │
│   │ # Utilities
│   ├── definitionFormatter.ts    # Format symbol definitions
│   ├── usageFormatter.ts         # Format usage results
│   ├── searchResultFormatter.ts  # Format search results
│   └── symbolRangeExpander.ts    # Expand symbol ranges
│
├── 📁 prompts/                    # Prompt generation
│   ├── promptBuilder.ts          # Fluent builder for composing prompts
│   ├── toolAwareSystemPromptGenerator.ts # Main system prompt
│   ├── subagentPromptGenerator.ts # Subagent prompts
│   └── 📁 blocks/                 # Modular prompt blocks
│       ├── promptBlocks.ts       # Re-exports all block generators
│       ├── roleDefinitions.ts    # Role definitions (PR reviewer, explorer)
│       ├── analysisMethodology.ts # Analysis process and plan tracking
│       ├── outputFormat.ts       # Output structure requirements
│       ├── selfReflection.ts     # Self-reflection checkpoint guidance
│       ├── toolSection.ts        # Tool inventory and descriptions
│       ├── toolSelectionGuide.ts # Tool selection guidance
│       └── subagentGuidance.ts   # Subagent delegation rules
│
├── 📁 types/                      # TypeScript type definitions
│   ├── types.ts                  # Common types
│   ├── analysisTypes.ts          # Analysis result types
│   ├── chatTypes.ts              # Chat participant types
│   ├── contextTypes.ts           # Diff/context types
│   ├── conversationTypes.ts      # Conversation types
│   ├── modelTypes.ts             # LLM request/response types
│   ├── toolCallTypes.ts          # Tool call record types
│   ├── toolResultTypes.ts        # Tool result types
│   ├── vscodeGitExtension.ts     # Git extension types
│   └── webviewMessages.ts        # Webview message types
│
├── 📁 utils/                      # Utility functions
│   ├── diffUtils.ts              # Diff parsing
│   ├── pathSanitizer.ts          # Path security
│   ├── symbolExtractor.ts        # VS Code symbol extraction
│   ├── symbolMatcher.ts          # Symbol name matching
│   ├── symbolFormatter.ts        # Symbol formatting
│   ├── outputFormatter.ts        # Tool output formatting
│   ├── fileDiscoverer.ts         # File discovery with fdir
│   ├── fileTreeBuilder.ts        # Build file tree for chat
│   ├── codeFileDetector.ts       # Detect code files
│   ├── codeFileUtils.ts          # Code file utilities
│   ├── gitUtils.ts               # Git helper functions
│   ├── errorUtils.ts             # Error message extraction
│   ├── asyncUtils.ts             # Async utilities (timeout)
│   └── chatResponseBuilder.ts    # Chat response formatting
│
├── 📁 config/                     # Configuration
│   ├── constants.ts              # App constants
│   └── chatEmoji.ts              # Chat emoji definitions
│
├── 📁 lib/                        # shadcn/ui utilities
│   └── utils.ts                  # cn() utility
│
├── 📁 components/                 # shadcn/ui components
│   └── ui/                       # Generated UI components
│
├── 📁 sessions/                   # Session management (if used)
│
├── 📁 webview/                    # React webview UI
│   ├── main.tsx                  # 🚀 Webview entry point
│   ├── AnalysisView.tsx          # Main analysis view
│   ├── globals.css               # Global styles (Tailwind)
│   │
│   ├── 📁 components/            # Webview components
│   │   ├── AnalysisTab.tsx      # Analysis content tab
│   │   ├── DiffTab.tsx          # Diff visualization tab
│   │   ├── ToolCallsTab.tsx     # Tool history tab
│   │   ├── MarkdownRenderer.tsx # Markdown with highlighting
│   │   ├── CopyButton.tsx       # Copy to clipboard
│   │   ├── FileLink.tsx         # File path links
│   │   └── JsonViewer.tsx       # JSON tree viewer
│   │
│   ├── 📁 hooks/                 # React hooks
│   ├── 📁 styles/                # Additional styles
│   ├── 📁 types/                 # Webview-specific types
│   │
│   └── 📁 tool-testing/          # Tool testing UI (dev)
│       └── toolTesting.tsx       # Tool testing interface
│
└── 📁 __tests__/                  # Test files
    ├── *.test.ts                 # Node.js tests
    ├── *.test.tsx                # React component tests
    └── testUtils/
        └── mockFactories.ts      # Shared mock factories
```

---

## Key File Reference

### Entry Points

| File                             | Description                  |
| -------------------------------- | ---------------------------- |
| `src/extension.ts`               | VS Code extension activation |
| `src/webview/main.tsx`           | Webview React entry          |
| `src/services/serviceManager.ts` | DI container                 |

### Core Analysis Flow

| File                                      | Role in Flow                    |
| ----------------------------------------- | ------------------------------- |
| `coordinators/analysisOrchestrator.ts`    | Initiates analysis              |
| `services/toolCallingAnalysisProvider.ts` | Runs analysis loop              |
| `models/conversationRunner.ts`            | Multi-turn conversation         |
| `models/toolExecutor.ts`                  | Executes tools                  |
| `tools/*.ts`                              | Individual tool implementations |

### Configuration

| File              | Purpose                                        |
| ----------------- | ---------------------------------------------- |
| `package.json`    | Extension manifest, commands, chat participant |
| `vite.config.mts` | Build configuration                            |
| `tsconfig.json`   | TypeScript settings                            |
| `components.json` | shadcn/ui config                               |

### Testing

| File                    | Purpose                       |
| ----------------------- | ----------------------------- |
| `__mocks__/vscode.js`   | VS Code API mock              |
| `vitest.jsdom.setup.ts` | jsdom environment setup       |
| `vite.config.mts`       | Test configuration (projects) |
