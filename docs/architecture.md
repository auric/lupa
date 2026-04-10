# Lupa Architecture Documentation

> **Version**: 0.2.0 | **Generated**: February 21, 2026 | **Type**: VS Code Extension

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
| RLM Diff-on-Demand            | PR diff not embedded in prompt; LLM requests diffs via tools on demand       |
| Recursive Agent Tree          | Root controller decomposes work, child agents investigate in parallel        |

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
│  │  CommandRegistry │     │ AnalysisEngine   │     │   ToolExecutor  │  │
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

| Service                    | Responsibility                            |
| -------------------------- | ----------------------------------------- |
| `ServiceManager`           | DI container with 3-phase initialization  |
| `AnalysisEngine`           | Main analysis loop with tool-calling      |
| `GitOperationsManager`     | Git repository and diff operations        |
| `ChatParticipantService`   | `@lupa` chat participant for Copilot Chat |
| `UIManager`                | Webview panel management                  |
| `WorkspaceSettingsService` | Persisted settings (`.vscode/lupa.json`)  |
| `LoggingService`           | Centralized logging with levels           |
| `StatusBarService`         | Status bar item management                |

### Per-Analysis Components

These components are created fresh for each analysis, not managed as singletons:

| Component                 | Responsibility                                |
| ------------------------- | --------------------------------------------- |
| `SubagentExecutor`        | Isolated subagent investigations              |
| `SubagentSessionManager`  | Subagent spawn count and limits               |
| `RecursiveStateManager`   | Agent tree tracking, depth/budget enforcement |
| `PlanSessionManager`      | Review plan state for current analysis        |
| `TokenValidator` instance | Context window tracking for one analysis      |

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

**Context Tools** (7):

| Tool                     | Purpose                                       |
| ------------------------ | --------------------------------------------- |
| `FindSymbolTool`         | Find code symbol definitions with full source |
| `FindUsagesTool`         | Find all usages of a symbol                   |
| `ReadFileTool`           | Read file content with pagination             |
| `FindFilesByPatternTool` | Glob-based file search                        |
| `GetSymbolsOverviewTool` | Hierarchical symbol structure                 |
| `SearchForPatternTool`   | Ripgrep-based text search                     |
| `GetFileDiffTool`        | Get diff for a specific file                  |

**Quality Tools** (5):

| Tool                       | Purpose                                                        |
| -------------------------- | -------------------------------------------------------------- |
| `ThinkTool`                | Unified structured reasoning (replaces 4 separate think tools) |
| `ThinkAboutCompletionTool` | Completion readiness check                                     |
| `RecordFindingTool`        | Record a review finding with evidence                          |
| `RetractFindingTool`       | Retract a previously recorded finding                          |
| `ValidateClaimTool`        | Validate a claim before recording                              |

**Workflow Tools** (3):

| Tool                   | Purpose                                     |
| ---------------------- | ------------------------------------------- |
| `UpdatePlanTool`       | Create and track review plan with checklist |
| `SubmitReviewTool`     | Explicit completion signal for PR review    |
| `RunSubagentBatchTool` | Delegate investigations to subagents        |

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
| `subagentGuidance.ts`    | Subagent delegation rules (diff-tool-aware)     |
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
AnalysisEngine; // Creates per-analysis: SubagentExecutor, SubagentSessionManager, PlanSessionManager
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
│  AnalysisEngine               │
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

`AnalysisEngine` supports concurrent analysis sessions. Each call to `analyze()` creates isolated per-analysis state:

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
    planManager?: PlanSessionManager;
    subagentSessionManager?: SubagentSessionManager;
    subagentExecutor?: SubagentExecutor;
    cancellationToken: vscode.CancellationToken; // Required
}
```

The `context` parameter is **required** for all tool executions. The `cancellationToken` is always available—pass it to long-running operations for responsive cancellation.

#### Tool ExecutionContext Field Requirements

| Tool                 | Required Fields                              | Notes                    |
| -------------------- | -------------------------------------------- | ------------------------ |
| `run_subagent_batch` | `subagentExecutor`, `subagentSessionManager` | Returns error if missing |
| `update_plan`        | `planManager`                                | Returns error if missing |
| All other tools      | `cancellationToken` only                     | Other fields optional    |

#### Context Creation by Mode

| Mode        | planManager | subagentSessionManager | subagentExecutor |
| ----------- | ----------- | ---------------------- | ---------------- |
| PR Analysis | ✅          | ✅                     | ✅               |
| Exploration | ❌          | ✅                     | ✅               |
| Subagent    | ❌          | ❌                     | ❌               |

**Key design principle:** Tools that require specific context fields are filtered from modes that don't provide them (see `MAIN_ANALYSIS_ONLY_TOOLS` in `toolConstants.ts`).

The `RunSubagentBatchTool` retrieves its executor from this context rather than via constructor injection.

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

    // context: ExecutionContext is REQUIRED for all tool executions
    abstract execute(
        args: z.infer<this['schema']>,
        context: ExecutionContext
    ): Promise<ToolResult>;
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
│  │ → Calls RunSubagentBatchTool                            ││
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
│  │  - Cannot use: run_subagent_batch (prevents recursion)   ││
│  │  - Returns findings to main analysis                     ││
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

### Subagent Cancellation Model

Each subagent gets its own `CancellationTokenSource` (local variable in `RunSubagentBatchTool.executeSubagent()`, never an instance field) to prevent cross-cancellation between parallel subagents. The token is linked to both the root analysis token via `SubagentSessionManager.getParentCancellationToken()` and the immediate parent's `ExecutionContext.cancellationToken` via local `onCancellationRequested` listeners, both disposed in the `finally` block.

**Initialization order**: `SubagentSessionManager.setParentCancellationToken()` must be called early in the analysis flow (before any tool execution) to ensure subagent cancellation propagation works. See `AnalysisEngine.analyze()` for the pattern.

**Cancellation detection**: `SubagentExecutor` checks `ConversationRunner.hitMaxIterations` and `ConversationRunner.wasCancelled` boolean flags rather than raw `token.isCancellationRequested`. This prevents false cancellation signals from unrelated token events. At the top level, `AnalysisEngineResult.wasCancelled` propagates cancellation state from `ConversationRunner` through to coordinators.

**Timeout vs parent cancellation**: `RunSubagentBatchTool` checks `context.cancellationToken.isCancellationRequested` when attributing a cancellation to timeout, giving parent cancellation priority over the timeout timer. This prevents misclassification when both fire during executor unwinding.

**Exit conditions and their reporting**:

| Condition         | ConversationRunner                       | SubagentExecutor            | RunSubagentBatchTool                  |
| ----------------- | ---------------------------------------- | --------------------------- | ------------------------------------- |
| Normal completion | Returns response text                    | `success: true`             | `toolSuccess()`                       |
| Max iterations    | Returns message, sets `hitMaxIterations` | `error: 'max_iterations'`   | `toolError()` with partial findings   |
| Cancellation      | Returns `''`, sets `wasCancelled`        | `error: 'cancelled'`        | `toolError('Subagent was cancelled')` |
| Timeout           | Token cancelled by timer                 | `error: 'cancelled'`        | `toolError(SubagentErrors.timeout())` |
| LLM/Tool error    | Catches and retries                      | `success: false` with error | `toolError(SubagentErrors.failed())`  |

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

| Area               | Implementation                                    |
| ------------------ | ------------------------------------------------- |
| Path Traversal     | `PathSanitizer` validates all file paths          |
| Rate Limiting      | `ToolExecutor` limits tool calls per session      |
| Context Size       | `TokenValidator` manages context window           |
| Subagent Recursion | `run_subagent_batch` tool excluded from subagents |
| Gitignore          | Respected in file discovery and symbol search     |

### Gitignore Handling

File discovery tools (`FindFilesByPatternTool`, `GetSymbolsOverviewTool`) respect gitignore patterns via the `ignore` package. Patterns are loaded from three sources:

1. **Global gitignore**: `core.excludesFile` from git config (e.g., `~/.gitignore_global`)
2. **Root .gitignore**: The `.gitignore` file at the repository root
3. **Local excludes**: `.git/info/exclude` (per-repository local excludes)

**Path matching**: Patterns are matched against full relative paths (e.g., `src/generated/file.ts`), not just basenames. Directory entries include a trailing `/` so the `ignore` library correctly matches directory-only patterns (e.g., `dist/`). Path patterns like `**/*.log` also work correctly.

**Limitation**: Nested `.gitignore` files in subdirectories are **not** supported by these tools. Only root-level patterns are applied.

**Exception**: Ripgrep-based tools (`SearchForPatternTool`) handle nested gitignore correctly via ripgrep's built-in gitignore support.

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

```json
{
    "preferredModelIdentifier": "copilot/gpt-4.1",
    "maxRecursionDepth": 2,
    "logLevel": "info"
}
```

### Analysis Modes

Lupa uses a Recursive Language Model (RLM) approach where a root agent decomposes the PR into focused investigations delegated to child agents.

| Setting             | Default | Description                                          |
| ------------------- | ------- | ---------------------------------------------------- |
| `maxRecursionDepth` | 2       | Maximum agent depth (0 = no recursion, 1+ = enabled) |

Total spawns per analysis are capped by `maxSubagentsPerSession` (hardcoded to 200).

**Recursive mode activates** when `maxRecursionDepth >= 1`. This applies to both `AnalysisEngine` and `ChatParticipantService`. The root agent reads at most 1 key diff (the most impactful file) for orientation, then MUST delegate all investigation to sub-agents via `run_subagent_batch` when there are 3+ files to review. Sub-agents are spawned in parallel (all in the same turn) and each reads their own diffs via `get_file_diff`. Child agents with `canRecurse=true` MUST spawn sub-agents to further decompose when assigned 4+ files — this is enforced as a MANDATORY rule in the system prompts.

**Non-recursive mode** (`maxRecursionDepth === 0`): A single agent reviews all files directly with subagent delegation for larger PRs. Subagents can call `get_file_diff` to read diffs on demand but do not see `<diff_metadata>`; the parent agent must provide explicit file paths when delegating work.

**RecursiveStateManager** (`src/sessions/recursiveStateManager.ts`) tracks the agent tree during analysis:

- Registers agents with parent-child relationships and depth tracking
- Enforces `maxRecursionDepth` via `canSpawnChild()` (total spawn count is guarded by `SubagentSessionManager`)
- Uses an **independent budget model**: each agent receives `DEFAULT_CHILD_BUDGET` (50 iterations) regardless of other agents' usage. For example, at depth 2 with 3 sub-agents each spawning 2 sub-sub-agents, the system runs up to 9 agents × 50 iterations = 450 total iterations, bounded by `maxSubagentsPerSession` (200)
- Tracks file coverage across completed agents to avoid redundant analysis (only `get_file_diff` calls count — `read_file` for context does not constitute reviewing a file's diff)
- Manages agent lifecycle (registered → running → completed/failed/cancelled)

#### Coverage Gap Enforcement

After each `run_subagent_batch` tool call batch completes, the root agent's `afterToolCalls` callback compares files reviewed via `get_file_diff` (aggregated across all agents in the tree) against the full list of changed files. If gaps exist, a programmatic message is injected listing uncovered files and instructing the root to spawn additional subagents. This is system-level enforcement — it does not rely on the LLM's self-assessment.

Key design decisions:

- **Only `get_file_diff` counts as "reviewed"**: Reading a file via `read_file` or `find_symbol` for investigation context does not mark it as covered. An agent must actually view the changed lines.
- **Root-level tracking is sufficient**: The root aggregates coverage from ALL agents in the tree (all depths). If a depth-2 sub-sub-agent skips a file, the root catches the gap after the batch completes and spawns more agents.
- **`think_about_completion`** provides complementary LLM-side reflection with `files_analyzed` and `files_in_diff` fields. The afterToolCalls hook is the programmatic safety net.

### Reset Limits Command

`Lupa: Reset Settings to Defaults` command available in command palette.

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
