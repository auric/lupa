# Lupa Architecture Documentation

> **Version**: 0.1.11 | **Generated**: January 6, 2026 | **Type**: VS Code Extension

## Executive Summary

**Lupa** is a VS Code extension that performs comprehensive pull request analysis using GitHub Copilot models. It employs a **tool-calling architecture** where the LLM dynamically requests context via LSP-based tools, enabling deep code understanding without pre-loading entire codebases.

### Key Architectural Decisions

| Decision                      | Rationale                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------- |
| Tool-Calling LLM Pattern      | Enables dynamic context gathering instead of loading entire codebase upfront |
| Service-Oriented Architecture | Clean separation of concerns with DI via ServiceManager                      |
| Dual Build Strategy           | Vite builds both Node.js extension and browser-based webview                 |
| React 19 with Compiler        | Automatic memoization reduces UI performance overhead                        |
| Zod Schema Validation         | Type-safe tool parameter validation with automatic JSON schema generation    |
| Progress-Only Tool Streaming  | Uses `stream.progress()` for transient tool feedback; clears on completion   |
| Parallel Tool Execution       | `ToolExecutor` uses `Promise.all` for concurrent tool calls                  |

---

## Technology Stack

| Category          | Technology            | Version | Purpose                             |
| ----------------- | --------------------- | ------- | ----------------------------------- |
| **Language**      | TypeScript            | 5.9.x   | Primary development language        |
| **Runtime**       | Node.js               | ≥20     | Extension host environment          |
| **Framework**     | VS Code Extension API | 1.107+  | Extension platform                  |
| **UI Library**    | React                 | 19.x    | Webview components                  |
| **UI Components** | shadcn/ui + Radix     | Latest  | Accessible component primitives     |
| **Styling**       | Tailwind CSS          | 4.x     | Utility-first CSS framework         |
| **Build Tool**    | Vite                  | 7.x     | Fast bundling with dual build modes |
| **Testing**       | Vitest                | 4.x     | Unit testing with VS Code mocks     |
| **Validation**    | Zod                   | 4.x     | Runtime schema validation           |

### Key Dependencies

| Package           | Purpose                                 |
| ----------------- | --------------------------------------- |
| `fdir`            | Fast file discovery for tool operations |
| `picomatch`       | Glob pattern matching                   |
| `ignore`          | Gitignore pattern processing            |
| `react-markdown`  | Markdown rendering in webview           |
| `react-diff-view` | Diff visualization                      |
| `lucide-react`    | Icon library                            |

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           VS Code Extension Host                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────────────┐     ┌──────────────────┐     ┌─────────────────┐  │
│  │   Coordinators   │────▶│     Services     │────▶│      Tools      │  │
│  └──────────────────┘     └──────────────────┘     └─────────────────┘  │
│           │                       │                        │             │
│           ▼                       ▼                        ▼             │
│  ┌──────────────────┐     ┌──────────────────┐     ┌─────────────────┐  │
│  │  AnalysisOrch.   │     │ ServiceManager   │     │   ToolRegistry  │  │
│  │  CommandRegistry │     │ ToolCallingProv. │     │   ToolExecutor  │  │
│  │  CopilotModelCo. │     │ GitOperations    │     │   BaseTool      │  │
│  └──────────────────┘     └──────────────────┘     └─────────────────┘  │
│                                   │                                      │
│                                   ▼                                      │
│                          ┌──────────────────┐                           │
│                          │      Models      │                           │
│                          │  (LLM Interface) │                           │
│                          └──────────────────┘                           │
│                                   │                                      │
│                                   ▼                                      │
│                          ┌──────────────────┐                           │
│                          │  GitHub Copilot  │                           │
│                          │       API        │                           │
│                          └──────────────────┘                           │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                           Browser Webview                                │
├─────────────────────────────────────────────────────────────────────────┤
│  ┌──────────────────┐     ┌──────────────────┐     ┌─────────────────┐  │
│  │   AnalysisView   │     │  MarkdownRender  │     │   DiffView      │  │
│  │   ToolCallsTab   │     │  CopyButton      │     │   JsonViewer    │  │
│  └──────────────────┘     └──────────────────┘     └─────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Layered Architecture

### Layer 1: Coordinators (`src/coordinators/`)

High-level orchestration components that coordinate multiple services.

| Component                 | Responsibility                                         |
| ------------------------- | ------------------------------------------------------ |
| `PRAnalysisCoordinator`   | Main extension entry point, initializes ServiceManager |
| `AnalysisOrchestrator`    | Orchestrates PR analysis workflow and UI               |
| `CopilotModelCoordinator` | Manages language model selection                       |
| `CommandRegistry`         | Registers VS Code commands                             |

### Layer 2: Services (`src/services/`)

Core business logic implementing specific capabilities.

| Service                       | Responsibility                            |
| ----------------------------- | ----------------------------------------- |
| `ServiceManager`              | DI container with 3-phase initialization  |
| `ToolCallingAnalysisProvider` | Main analysis loop with tool-calling      |
| `GitOperationsManager`        | Git repository and diff operations        |
| `ChatParticipantService`      | `@lupa` chat participant for Copilot Chat |
| `UIManager`                   | Webview panel management                  |
| `WorkspaceSettingsService`    | Persisted settings (`.vscode/lupa.json`)  |
| `LoggingService`              | Centralized logging with levels           |
| `StatusBarService`            | Status bar item management                |

### Per-Analysis Components

These components are created fresh for each analysis, not managed as singletons:

| Component                 | Responsibility                           |
| ------------------------- | ---------------------------------------- |
| `SubagentExecutor`        | Isolated subagent investigations         |
| `SubagentSessionManager`  | Subagent spawn count and limits          |
| `PlanSessionManager`      | Review plan state for current analysis   |
| `TokenValidator` instance | Context window tracking for one analysis |

### Layer 3: Models (`src/models/`)

Token management, conversation state, and tool execution infrastructure.

| Model                 | Responsibility                                                |
| --------------------- | ------------------------------------------------------------- |
| `ConversationManager` | Maintains conversation history (user/assistant/tool messages) |
| `ConversationRunner`  | Executes multi-turn conversation loop                         |
| `ToolExecutor`        | Executes tools in parallel (Promise.all) with rate limiting   |
| `ToolRegistry`        | Stores and retrieves tool instances                           |
| `CopilotModelManager` | Language model selection and API interface                    |
| `PromptGenerator`     | System and user prompt generation                             |
| `TokenValidator`      | Context window management and cleanup                         |

### Layer 4: Tools (`src/tools/`)

LLM-callable tools extending `BaseTool` with Zod schemas.

| Tool                     | Purpose                                       |
| ------------------------ | --------------------------------------------- |
| `FindSymbolTool`         | Find code symbol definitions with full source |
| `FindUsagesTool`         | Find all usages of a symbol                   |
| `ReadFileTool`           | Read file content with pagination             |
| `ListDirTool`            | List directory contents                       |
| `FindFilesByPatternTool` | Glob-based file search                        |
| `GetSymbolsOverviewTool` | Hierarchical symbol structure                 |
| `SearchForPatternTool`   | Ripgrep-based text search                     |
| `UpdatePlanTool`         | Create and track review plan with checklist   |
| `RunSubagentTool`        | Delegate investigations to subagents          |
| `SubmitReviewTool`       | Explicit completion signal for PR review      |
| `ThinkAbout*Tools`       | Structured reasoning tools                    |

### Layer 5: Prompts (`src/prompts/`)

System prompt generators using a modular block-based architecture.

| Generator                        | Purpose                              |
| -------------------------------- | ------------------------------------ |
| `ToolAwareSystemPromptGenerator` | Main analysis system prompt          |
| `SubagentPromptGenerator`        | Subagent investigation prompts       |
| `PromptBuilder`                  | Fluent builder for composing prompts |

#### Modular Prompt Blocks (`src/prompts/blocks/`)

The prompt system uses composable blocks that can be mixed and matched for different analysis modes:

| Block                    | Purpose                                         |
| ------------------------ | ----------------------------------------------- |
| `roleDefinitions.ts`     | Role definitions (PR reviewer, explorer)        |
| `analysisMethodology.ts` | Step-by-step analysis process and plan tracking |
| `outputFormat.ts`        | Output structure requirements                   |
| `selfReflection.ts`      | Self-reflection checkpoint guidance             |
| `toolSection.ts`         | Tool inventory and descriptions                 |
| `toolSelectionGuide.ts`  | When to use each tool                           |
| `subagentGuidance.ts`    | Subagent delegation rules                       |
| `promptBlocks.ts`        | Re-exports all block generators                 |

The `PromptBuilder` uses a fluent interface to compose these blocks:

```typescript
new PromptBuilder()
    .addPRReviewerRole()
    .addToolInventory(tools)
    .addToolSelectionGuide('pr-review')
    .addAnalysisMethodology()
    .addOutputFormat()
    .build();
```

### Layer 6: Webview (`src/webview/`)

React-based UI running in browser context.

| Component          | Purpose                           |
| ------------------ | --------------------------------- |
| `AnalysisView`     | Main analysis results container   |
| `AnalysisTab`      | Analysis content with markdown    |
| `DiffTab`          | Diff visualization                |
| `ToolCallsTab`     | Tool execution history            |
| `MarkdownRenderer` | Markdown with syntax highlighting |
| `CopyButton`       | Clipboard functionality           |

---

## Service Initialization (3 Phases)

The `ServiceManager` initializes services in strict dependency order:

```typescript
// Phase 1: Foundation (no dependencies)
WorkspaceSettingsService;
LoggingService;
StatusBarService;
GitOperationsManager;
UIManager;

// Phase 2: Core (depend on foundation)
CopilotModelManager;
PromptGenerator;
SymbolExtractor;

// Phase 3: High-Level (depend on core)
ToolRegistry;
ToolExecutor;
ConversationManager;
ToolCallingAnalysisProvider; // Creates per-analysis: SubagentExecutor, SubagentSessionManager, PlanSessionManager
ChatParticipantService;
LanguageModelToolProvider;
// + All tools registered
```

---

## Data Flow: Tool-Calling Analysis

```
User triggers analysis
        │
        ▼
┌───────────────────────┐
│  AnalysisOrchestrator │
│  - Gets diff from Git │
│  - Shows progress UI  │
└───────────┬───────────┘
            │
            ▼
┌───────────────────────────────┐
│  ToolCallingAnalysisProvider  │
│  - Creates per-analysis state │
│  - Generates prompts          │
│  - Manages conversation       │
└───────────────┬───────────────┘
                │
                ▼
┌───────────────────────────────┐
│     ConversationRunner        │◄────────────────┐
│  - Sends messages to LLM      │                 │
│  - Handles tool call loop     │                 │
└───────────────┬───────────────┘                 │
                │                                  │
                ▼                                  │
┌───────────────────────────────┐                 │
│     CopilotModelManager       │                 │
│  - Sends request to Copilot   │                 │
│  - Parses response/tool calls │                 │
└───────────────┬───────────────┘                 │
                │                                  │
    ┌───────────┴───────────┐                     │
    │                       │                     │
    ▼                       ▼                     │
[Text Response]      [Tool Calls]                 │
    │                       │                     │
    ▼                       ▼                     │
┌──────────┐       ┌───────────────┐              │
│  Output  │       │ ToolExecutor  │──────────────┘
│ to User  │       │ - Execute     │     (loop back with
└──────────┘       │ - Rate limit  │      tool results)
                   └───────────────┘
```

### Concurrency Model

`ToolCallingAnalysisProvider` supports concurrent analysis sessions. Each call to `analyze()` creates isolated per-analysis state:

| Component                | Scope        | Purpose                              |
| ------------------------ | ------------ | ------------------------------------ |
| `TokenValidator`         | Per-analysis | Context window tracking for this run |
| `toolCallRecords`        | Per-analysis | Tool execution history               |
| `currentIteration`       | Per-analysis | Iteration counter                    |
| `SubagentSessionManager` | Per-analysis | Tracks subagent count and limits     |
| `SubagentExecutor`       | Per-analysis | Executes subagent investigations     |
| `PlanSessionManager`     | Per-analysis | Review plan state                    |

This ensures multiple concurrent analyses don't share or corrupt state.

### ExecutionContext

Tools receive an `ExecutionContext` containing per-analysis dependencies:

```typescript
interface ExecutionContext {
    traceId: string; // Required: unique ID for log correlation
    contextLabel: string; // "Main", "Chat", "Exploration", "Sub#1"
    currentIteration: number;
    planManager?: PlanSessionManager;
    subagentSessionManager?: SubagentSessionManager;
    subagentExecutor?: SubagentExecutor;
}
```

Trace IDs use `crypto.randomUUID()` for uniqueness and appear in logs as `[traceId:label:iteration]`, enabling correlation across tool calls and subagents.

#### Tool ExecutionContext Requirements

| Tool            | Required Fields                              | Notes                            |
| --------------- | -------------------------------------------- | -------------------------------- |
| `run_subagent`  | `subagentExecutor`, `subagentSessionManager` | Returns error if missing         |
| `update_plan`   | `planManager`                                | Returns error if missing         |
| All other tools | None                                         | Can run without ExecutionContext |

#### Context Creation by Mode

| Mode        | planManager | subagentSessionManager | subagentExecutor |
| ----------- | ----------- | ---------------------- | ---------------- |
| PR Analysis | ✅          | ✅                     | ✅               |
| Exploration | ❌          | ✅                     | ✅               |
| Subagent    | ❌          | ❌                     | ❌               |

**Key design principle:** Tools that require specific context fields are filtered from modes that don't provide them (see `MAIN_ANALYSIS_ONLY_TOOLS` in `toolConstants.ts`).

The `RunSubagentTool` retrieves its executor from this context rather than via constructor injection.

---

## Tool Architecture

All tools extend `BaseTool` and define a Zod schema:

```typescript
export abstract class BaseTool implements ITool {
    abstract name: string;
    abstract description: string;
    abstract schema: z.ZodType;

    getVSCodeTool(): vscode.LanguageModelChatTool {
        return {
            name: this.name,
            description: this.description,
            inputSchema: z.toJSONSchema(this.schema),
        };
    }

    abstract execute(args: z.infer<this['schema']>): Promise<ToolResult>;
}
```

### Tool Result Pattern

```typescript
interface ToolResult {
  success: boolean;
  data?: string;       // LLM-consumable text
  error?: string;      // Error message
  metadata?: {         // Optional structured data
    nestedToolCalls?: ToolCallRecord[];
  };
}

// Helper functions
toolSuccess(data: string): ToolResult
toolError(message: string): ToolResult
```

---

## Subagent Architecture

Subagents enable delegated investigations with isolated context. Each analysis creates its own `SubagentExecutor` and `SubagentSessionManager` for concurrency safety:

```
┌─────────────────────────────────────────────────────────────┐
│                    Main Analysis                             │
│  ┌─────────────────────────────────────────────────────────┐│
│  │ Per-analysis state:                                     ││
│  │ - SubagentSessionManager (tracks spawn count)           ││
│  │ - SubagentExecutor (passed via ExecutionContext)        ││
│  └─────────────────────────────────────────────────────────┘│
│                           │                                  │
│  ┌─────────────────────────────────────────────────────────┐│
│  │ LLM: "This security pattern needs deeper investigation" ││
│  │ → Calls RunSubagentTool                                 ││
│  └─────────────────────────────────────────────────────────┘│
│                           │                                  │
│                           ▼                                  │
│  ┌─────────────────────────────────────────────────────────┐│
│  │            SubagentExecutor (from context)               ││
│  │  - Creates isolated ConversationManager                  ││
│  │  - Filters tools (no recursive subagents)                ││
│  │  - Runs ConversationRunner with own context              ││
│  └─────────────────────────────────────────────────────────┘│
│                           │                                  │
│                           ▼                                  │
│  ┌─────────────────────────────────────────────────────────┐│
│  │                 Subagent #1: Security                    ││
│  │  - Own conversation history                              ││
│  │  - Can use: find_symbol, read_file, search, etc.        ││
│  │  - Cannot use: run_subagent (prevents recursion)         ││
│  │  - Returns findings to main analysis                     ││
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

---

## Build System

Vite dual build configuration:

### Node.js Extension Build (`npm run build:node`)

- Entry: `src/extension.ts`
- Output: `dist/extension.js` (CJS format)
- SSR mode with bundled dependencies
- Target: ES2024

### Browser Webview Build (`npm run build:webview`)

- Entry: `src/webview/main.tsx`
- Output: `dist/webview/main.js` (ESM format)
- React with Compiler plugin
- Tailwind CSS processing
- Target: ES2024

---

## Chat Participant Integration

The `@lupa` chat participant integrates with GitHub Copilot Chat:

```
User: @lupa /branch
        │
        ▼
┌───────────────────────────────┐
│    ChatParticipantService     │
│  - Parses command             │
│  - Gets diff from Git         │
│  - Streams to chat response   │
└───────────────────────────────┘
        │
        ▼
┌───────────────────────────────┐
│     ConversationRunner        │
│  - Same tool-calling loop     │
│  - Streams via ChatLLMClient  │
└───────────────────────────────┘
        │
        ▼
┌───────────────────────────────┐
│    Chat Response Stream       │
│  - progress() for status      │
│  - markdown() for content     │
│  - filetree() for structure   │
└───────────────────────────────┘
```

### Commands

| Command      | Description                                        |
| ------------ | -------------------------------------------------- |
| `/branch`    | Analyze current branch vs default branch           |
| `/changes`   | Analyze uncommitted changes                        |
| (no command) | Exploration mode - answer questions about codebase |

---

## Testing Strategy

### Test Structure

```
src/__tests__/
├── *.test.ts          # Node.js tests (Vitest)
├── *.test.tsx         # React component tests (jsdom)
└── testUtils/
    └── mockFactories.ts  # Shared mock factories
```

### Vitest Configuration

Two test environments via Vite projects:

1. **Node environment**: Extension tests with VS Code mocks
2. **jsdom environment**: React component tests

### Mock Strategy

VS Code API mocked via `__mocks__/vscode.js`:

- `vscode.workspace.*` - File system, settings
- `vscode.commands.*` - Symbol providers
- `vscode.lm.*` - Language model API
- `vscode.chat.*` - Chat participant API

---

## Security Considerations

| Area               | Implementation                                |
| ------------------ | --------------------------------------------- |
| Path Traversal     | `PathSanitizer` validates all file paths      |
| Rate Limiting      | `ToolExecutor` limits tool calls per session  |
| Context Size       | `TokenValidator` manages context window       |
| Subagent Recursion | `run_subagent` tool excluded from subagents   |
| Gitignore          | Respected in file discovery and symbol search |

---

## Timeout Configuration

Timeouts protect against slow language servers and runaway searches:

| Operation            | Timeout | Notes                                              |
| -------------------- | ------- | -------------------------------------------------- |
| Per-file LSP symbols | 5s      | Individual file extraction; slow files are skipped |
| Ripgrep search       | 30s     | Pattern search via `search_for_pattern` tool       |

When timeouts occur, tools return actionable error messages suggesting retry strategies (e.g., narrowing search scope).

---

## Extension Points

### Adding a New Tool

1. Create class extending `BaseTool` in `src/tools/`
2. Define Zod schema for parameters
3. Implement `execute()` returning `ToolResult`
4. Register in `ServiceManager.initializeTools()`

### Adding a New Service

1. Implement `vscode.Disposable` interface
2. Add to appropriate phase in `ServiceManager`
3. Update `IServiceRegistry` interface

### Adding a Chat Command

1. Add to `chatParticipants` in `package.json`
2. Implement handler in `ChatParticipantService`
3. Add to followup provider if needed

---

## Configuration

### Workspace Settings (`.vscode/lupa.json`)

Only user-modified values are saved to the settings file. Defaults are applied at runtime from the schema, ensuring config files remain minimal and portable.

```json
{
    "preferredModelIdentifier": "copilot/gpt-4.1",
    "maxIterations": 100,
    "requestTimeoutSeconds": 300,
    "maxSubagentsPerSession": 10,
    "logLevel": "info"
}
```

| Setting                    | Default | Description                                           |
| -------------------------- | ------- | ----------------------------------------------------- |
| `preferredModelIdentifier` | -       | Model in `vendor/id` format (e.g., `copilot/gpt-4.1`) |
| `maxIterations`            | 100     | Maximum conversation turns per analysis               |
| `requestTimeoutSeconds`    | 300     | Timeout for LLM requests                              |
| `maxSubagentsPerSession`   | 10      | Maximum subagent investigations per analysis          |
| `logLevel`                 | `info`  | Logging verbosity: `debug`, `info`, `warn`, `error`   |

### Reset Limits Command

`Lupa: Reset Analysis Limits to Defaults` command available in command palette.

---

## Logging

Use `Log` from `loggingService.ts`:

```typescript
import { Log } from './services/loggingService';

Log.info('Analysis started');
Log.debug('Tool arguments:', args);
Log.warn('Rate limit approaching');
Log.error('Tool execution failed:', error);
```

**Never use `console.log` in extension code.** Exception: webview code may use console.

---

## Related Documentation

- [CLAUDE.md](../CLAUDE.md) - Complete development guidelines
- [Development Guide](development-guide.md) - Build and test commands
- [Component Inventory](component-inventory.md) - Full component listing
- [Source Tree Analysis](source-tree-analysis.md) - Directory structure
