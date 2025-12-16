# Research: microsoft/vscode-copilot-chat Extension

**Date:** December 15, 2025
**Source:** DeepWiki analysis of the microsoft/vscode-copilot-chat repository

---

## 1. Built-in Tools Provided by GitHub Copilot Chat

The extension provides extensive built-in tools defined in `package.json` under `contributes.languageModelTools`. Tools use two naming schemes:

- **Internal names:** `ToolName` enum (e.g., `ToolName.ApplyPatch`)
- **External names:** `ContributedToolName` (e.g., `copilot_applyPatch`) - exposed to LLMs

### Core File Operations

| Tool                 | External Name                | Description                             |
| -------------------- | ---------------------------- | --------------------------------------- |
| `readFile`           | `copilot_readFile`           | Reads contents of a specified file      |
| `createFile`         | `copilot_createFile`         | Creates new files in workspace          |
| `createDirectory`    | `copilot_createDirectory`    | Creates new directories                 |
| `applyPatch`         | `copilot_applyPatch`         | Edits text files using patches          |
| `replaceString`      | `copilot_replaceString`      | Replaces specific string in a file      |
| `multiReplaceString` | `copilot_multiReplaceString` | Multiple replace operations in one call |

### Search and Navigation

| Tool                     | External Name                    | Description                                                   |
| ------------------------ | -------------------------------- | ------------------------------------------------------------- |
| `codebase`               | `copilot_searchCodebase`         | Semantic search of workspace (natural language)               |
| `searchWorkspaceSymbols` | `copilot_searchWorkspaceSymbols` | Search code symbols via language services                     |
| `usages`                 | `copilot_listCodeUsages`         | Find all references, definitions, implementations of a symbol |
| `findFiles`              | `copilot_findFiles`              | Search files by glob pattern                                  |
| `findTextInFiles`        | `copilot_findTextInFiles`        | Search for string within files                                |
| `listDirectory`          | `copilot_listDirectory`          | List directory contents                                       |
| `readProjectStructure`   | `copilot_readProjectStructure`   | File tree representation of workspace                         |
| `getChangedFiles`        | `copilot_getChangedFiles`        | Get diffs of changed files                                    |

### VS Code Integration

| Tool                 | External Name                | Description                                 |
| -------------------- | ---------------------------- | ------------------------------------------- |
| `getVSCodeAPI`       | `copilot_getVSCodeAPI`       | VS Code API documentation for extension dev |
| `getErrors`          | `copilot_getErrors`          | Retrieve compile/lint errors                |
| `createNewWorkspace` | `copilot_createNewWorkspace` | Setup steps for new project structures      |
| `openSimpleBrowser`  | `copilot_openSimpleBrowser`  | Preview local website in browser            |
| `runVscodeCommand`   | `copilot_runVscodeCommand`   | Execute VS Code commands                    |
| `installExtension`   | `copilot_installExtension`   | Install VS Code extensions                  |

### Testing

| Tool            | External Name           | Description                         |
| --------------- | ----------------------- | ----------------------------------- |
| `testFailure`   | `copilot_testFailure`   | Include test failure info in prompt |
| `findTestFiles` | `copilot_findTestFiles` | Find corresponding test files       |

### Web/External

| Tool           | External Name          | Description                          |
| -------------- | ---------------------- | ------------------------------------ |
| `fetchWebPage` | `copilot_fetchWebPage` | Fetch content from a URL             |
| `githubRepo`   | `copilot_githubRepo`   | Search GitHub repo for code snippets |

### Memory/Preferences

| Tool                    | External Name                   | Description                                           |
| ----------------------- | ------------------------------- | ----------------------------------------------------- |
| `updateUserPreferences` | `copilot_updateUserPreferences` | Update user preferences based on chat                 |
| `memory`                | `copilot_memory`                | Persistent memory across conversations (experimental) |

---

## 2. Tool Implementation and Registration

### Class Hierarchy

```
ICopilotTool<T> extends ICopilotToolExtension<T>
                extends vscode.LanguageModelTool
```

Key interface methods:

- `invoke(options, token)` - Execute the tool
- `prepareInvocation(options, token)` - Prepare for invocation
- `filterEdits()` - Filter edit operations
- `provideInput()` / `resolveInput()` - Input handling
- `alternativeDefinition()` - Alternative tool definitions

### Registration Flow

1. **Tool Definition:** Each tool is a class implementing `ICopilotTool` in `src/extension/tools/node/`

2. **ToolRegistry:** Singleton collecting all tools via static registration:

   ```typescript
   ToolRegistry.registerTool(ManageTodoListTool);
   ```

3. **allTools.ts:** Imports all tool files, triggering registration on load

4. **ToolsService:** Manages tool instances from registry:

   ```typescript
   constructor(@IInstantiationService instantiationService) {
       this._copilotTools = new Lazy(() =>
           new Map(ToolRegistry.getTools().map(t =>
               [t.toolName, instantiationService.createInstance(t)]
           ))
       );
   }
   ```

5. **ToolsContribution:** Registers with VS Code API:
   ```typescript
   for (const tool of copilotTools) {
     vscode.lm.registerTool(tool.contributedName, tool);
   }
   ```

### Tool Naming

- Internal: `ToolName.ApplyPatch`
- External: `copilot_applyPatch`
- Conversion: `getContributedToolName()` / `getToolName()`

---

## 3. Third-Party Extension Access to Built-in Tools

**Yes, third-party extensions CAN invoke Copilot's built-in tools** via `vscode.lm.invokeTool()`.

### How It Works

1. Tools are declared in `package.json` under `contributes.languageModelTools`
2. At runtime, registered with `vscode.lm.registerTool()`
3. Any extension can call:
   ```typescript
   const result = await vscode.lm.invokeTool(
     "copilot_searchCodebase",
     { input: { query: "find auth functions" } },
     cancellationToken
   );
   ```

### Fully Qualified Tool Names

To avoid conflicts, tools use fully qualified names:

- `codebase` → `search/codebase`
- Format: `{category}/{toolName}`

---

## 4. vscode.lm.invokeTool() Mechanism

### Invocation Flow

```typescript
// 1. Get tool name
const contributedName = getContributedToolName(ToolName.Codebase);
// → 'copilot_searchCodebase'

// 2. Create options
const options: vscode.LanguageModelToolInvocationOptions = {
  input: { query: "find authentication" },
};

// 3. Invoke
const result = await vscode.lm.invokeTool(
  contributedName,
  options,
  cancellationToken
);
```

### ToolsService Internal Flow

```typescript
async invokeTool(name: string, options, token) {
    // Fire pre-invocation event
    this.onWillInvokeTool.fire({ toolName: name });

    // Get external name
    const contributedName = getContributedToolName(name);

    // Invoke via VS Code API
    return vscode.lm.invokeTool(contributedName, options, token);
}
```

### Example Invocations

```typescript
// Codebase search
await toolsService.invokeTool(
  ToolName.Codebase,
  {
    input: { query: "find usages of MyClass" },
  },
  token
);

// Read file
await toolsService.invokeTool(
  ToolName.ReadFile,
  {
    input: { filePath: "/path/to/file.ts" },
  },
  token
);

// Find usages
await toolsService.invokeTool(
  ToolName.Usages,
  {
    input: {
      symbolName: "MyFunction",
      filePaths: ["src/utils.ts"], // optional
    },
  },
  token
);
```

---

## 5. Credit/Quota Tracking API

### Internal Tracking via CopilotToken

The `CopilotToken` class contains quota information:

```typescript
interface CopilotToken {
  copilotPlan: string;
  isFreeUser: boolean;
  isChatQuotaExceeded: boolean;
  isCompletionsQuotaExceeded: boolean;
  limited_user_quotas: {
    chat: QuotaInfo;
    completions: QuotaInfo;
  };
}
```

### Quota Detection

- **HTTP 402:** Payment Required → `ChatFailKind.QuotaExceeded`
- **Response headers:** May include `retry-after` for when to retry

### Public Access for Extensions

**No direct public API** for quota queries, but extensions can:

1. **Context Keys:** Read `github.copilot.chat.quotaExceeded`:

   ```typescript
   const quotaExceeded = vscode.commands.executeCommand(
     "getContext",
     "github.copilot.chat.quotaExceeded"
   );
   ```

2. **Model Metadata:** Via `vscode.lm.selectChatModels()`:
   ```typescript
   const models = await vscode.lm.selectChatModels();
   // models[0].billing?.multiplier for quota tracking
   ```

### Automatic Model Switching

When premium quota exhausted, system attempts switch to `copilot-base` model.

---

## 6. chatParticipantPrivate Proposed API

**Version:** `chatParticipantPrivate@11` (as of this research)

### What It Gates

#### Extended Chat Request Information

```typescript
interface ChatRequest {
  id: string;
  attempt: number;
  sessionId: string;
  enableCommandDetection: boolean;
  isParticipantDetected: boolean;
  location2: ChatLocation; // Panel, Terminal, Notebook, Editor
  editedFileEvents: EditedFileEvent[];
  isSubagent: boolean;
}
```

#### Extended Turn Data

```typescript
class ChatRequestTurn2 {
  id: string;
  prompt: string;
  participant: string;
  command: string;
  references: ChatReference[];
  toolReferences: ToolReference[];
  editedFileEvents: EditedFileEvent[];
}
```

#### Dynamic Participant Creation

```typescript
chat.createDynamicChatParticipant(props: DynamicChatParticipantProps);

interface DynamicChatParticipantProps {
    name: string;
    publisherName: string;
    description: string;
    fullName: string;
}
```

#### Tool Invocation Context

```typescript
interface LanguageModelToolInvocationOptions {
  chatRequestId?: string;
  chatSessionId?: string;
  chatInteractionId?: string;
  terminalCommand?: string;
  fromSubAgent?: boolean;
}
```

#### Ignored File Provider

```typescript
lm.registerIgnoredFileProvider(provider: LanguageModelIgnoredFileProvider);
```

#### Participant Detection

```typescript
chat.registerChatParticipantDetectionProvider(
    provider: ChatParticipantDetectionProvider
);
```

---

## 7. Agent Mode and Tool Calling

### Agentic Loop Architecture

Orchestrated by `DefaultIntentRequestHandler` and `ToolCallingLoop`:

```
┌─────────────────────────────────────────────┐
│                 Agentic Loop                │
├─────────────────────────────────────────────┤
│  1. buildPrompt()                           │
│     - Gather available tools                │
│     - Resolve customizations                │
│     - Render TSX prompt (AgentPrompt)       │
│                                             │
│  2. Make LLM Request                        │
│     - Send prompt + tool list               │
│     - Receive response                      │
│                                             │
│  3. Process Response                        │
│     - If tool calls: invoke tools           │
│     - Add results to conversation           │
│     - Continue loop                         │
│                                             │
│  4. Iteration Check                         │
│     - Max: getAgentMaxRequests() (~200)     │
│     - Exit if complete or limit reached     │
└─────────────────────────────────────────────┘
```

### Tool Selection Logic

The `getAgentTools()` function applies multiple filters:

```typescript
function getAgentTools(model, context) {
  const tools: ToolFilter = {};

  // 1. BYOK learned preferences
  if (isBYOK(model)) {
    const preferred =
      editToolLearningService.getPreferredEndpointEditTool(model);
    // Enable preferred tools
  }

  // 2. Model capabilities
  if (modelSupportsReplaceString(model)) {
    tools[ToolName.ReplaceString] = true;
  }
  if (modelSupportsApplyPatch(model)) {
    tools[ToolName.ApplyPatch] = true;
  }

  // 3. Context-based
  if (testService.hasAnyTests()) {
    tools[ToolName.CoreRunTest] = true;
  }
  if (hasWorkspaceTasks()) {
    tools[ToolName.CoreRunTask] = true;
  }

  // 4. Experimental flags
  if (config.gemini3MultiReplaceString) {
    tools[ToolName.MultiReplaceString] = true;
  }

  return tools;
}
```

### Model-Specific Prompts

Different prompts for different model families:

- `defaultAgentInstructions.tsx` - Base instructions
- `anthropicPrompts.tsx` - Claude-specific
- `geminiPrompts.tsx` - Gemini-specific
- `vscModelPrompts.tsx` - VS Code models

---

## 8. Registering Tools for Agent Mode

### Method 1: package.json Declaration

```json
{
  "contributes": {
    "languageModelTools": [
      {
        "name": "myext_myTool",
        "displayName": "My Tool",
        "toolReferenceName": "myTool",
        "modelDescription": "Description for the LLM",
        "inputSchema": {
          "type": "object",
          "properties": {
            "param1": {
              "type": "string",
              "description": "Parameter description"
            }
          },
          "required": ["param1"]
        }
      }
    ]
  }
}
```

### Method 2: Programmatic Registration

```typescript
vscode.lm.registerTool("myext_myTool", {
  async invoke(options, token) {
    const { param1 } = options.input;
    // Tool logic
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart("Result text"),
    ]);
  },
  async prepareInvocation(options, token) {
    return {
      invocationMessage: "Running my tool...",
    };
  },
});
```

### Method 3: MCP Servers

Tools can be provided via Model Context Protocol servers:

- Configure in VS Code settings or `.vscode/mcp.json`
- Use `MCP: Add Server` command
- MCP tools are auto-discovered and made available

---

## 9. @workspace Participant Implementation

### Architecture

```
User Query → WorkspaceContext → WorkspaceChunkQuery
                                      ↓
                            IWorkspaceChunkSearchService
                                      ↓
                         ┌────────────┴────────────┐
                         ↓                         ↓
              EmbeddingsChunkSearch     TfidfChunkSearch
                         ↓                         ↓
              CodeSearchChunkSearch   FullWorkspaceChunkSearch
```

### Search Strategies

1. **EmbeddingsChunkSearch:** Semantic search using embeddings
2. **TfidfChunkSearch:** Keyword-based TF-IDF search
3. **TfIdfWithSemanticChunkSearch:** Hybrid approach
4. **CodeSearchChunkSearch:** GitHub Code Search integration
5. **FullWorkspaceChunkSearch:** Complete workspace scan

### Search Flow

```typescript
async searchFileChunks(query: WorkspaceChunkQuery, options) {
    // 1. Resolve query to embeddings
    const embeddings = await query.resolveQuery();

    // 2. Execute search strategy
    const results = await strategy.search(embeddings);

    // 3. Filter ignored chunks
    const filtered = filterIgnored(results);

    // 4. Optional reranking
    if (options.enableRerank && reranker) {
        return reranker.rerank(filtered);
    }

    return filtered;
}
```

---

## 10. MCP Tools and Third-Party Participants

### MCP Tool Accessibility

**Yes, MCP tools ARE accessible to third-party participants.**

### Integration Points

1. **McpToolCallingLoop:** Handles MCP tool invocations
2. **LanguageModelToolMCPSource:** Identifies MCP-sourced tools
3. **McpToolInstructions:** Processes MCP tool instructions

### Tool Identification

MCP tools are prefixed with `mcp_`:

```typescript
if (toolName.startsWith("mcp_")) {
  // Handle as MCP tool
}
```

### Configuration

```json
// .vscode/mcp.json
{
  "servers": {
    "myServer": {
      "command": "node",
      "args": ["./mcp-server.js"]
    }
  }
}
```

---

## 11. Tool Visibility and Access Control

### Intent-Based Filtering

Each intent has its own `getAvailableTools()`:

| Intent             | Available Tools                                    |
| ------------------ | -------------------------------------------------- |
| `AgentIntent`      | All editing, search, test tools based on model     |
| `EditIntent`       | EditFile, ReplaceString, notebooks (context-based) |
| `AskIntent`        | Search tools with `vscode_codesearch` tag          |
| `InlineChatIntent` | Fixed set of edit tools + inline_chat_exit         |

### Filtering Mechanisms

```typescript
interface IToolsService {
  getEnabledTools(filter: ToolFilter): Tool[];
}

// Filter function can:
// - Explicitly enable/disable by ToolName
// - Consider tool picker selections
// - Check toolReferences in request
// - Handle dynamically installed tools
```

### Tool Picker Integration

Users can disable tools via UI:

```typescript
if (request.tools.get(tool.name) === false) {
  // Tool was disabled by user in tool picker
  return false;
}
```

---

## 12. Virtual Tool Grouping

### Purpose

When too many tools are available (>64 or >20 built-in), group them to reduce LLM confusion.

### Thresholds

- `START_GROUPING_AFTER_TOOL_COUNT`: 64
- `START_BUILTIN_GROUPING_AFTER_TOOL_COUNT`: 20
- `TOOLS_AND_GROUPS_LIMIT`: Maximum combined count
- `TRIM_THRESHOLD`: 96 (for expansion limiting)

### Grouping Algorithm

```typescript
class VirtualToolGrouper {
  group(tools: Tool[]) {
    // 1. Separate by source
    const { extension, mcp, builtin } = separateBySource(tools);

    // 2. Allocate slots per source
    const slots = allocateSlots(extension, mcp, builtin);

    // 3. Embedding-based clustering
    const embeddings = computeToolEmbeddings(tools);
    const clusters = clusterByEmbedding(embeddings, slots);

    // 4. Create VirtualTool for each cluster
    return clusters.map((c) => new VirtualTool(c));
  }
}
```

### VirtualTool Expansion

When LLM "calls" a virtual tool, it expands to show contained tools for next iteration.

---

## 13. Key Proposed APIs Used

| API                            | Version | Purpose                             |
| ------------------------------ | ------- | ----------------------------------- |
| `chatParticipantPrivate`       | @11     | Extended chat request/response info |
| `chatProvider`                 | @4      | Custom chat provider implementation |
| `defaultChatParticipant`       | @4      | Default participant enhancements    |
| `chatSessionsProvider`         | @3      | Chat session management             |
| `embeddings`                   | -       | Semantic search via embeddings      |
| `languageModelSystem`          | -       | System message access for LLMs      |
| `languageModelCapabilities`    | -       | Query model capabilities            |
| `mappedEditsProvider`          | -       | Complex edit applications           |
| `inlineCompletionsAdditions`   | -       | Enhanced inline suggestions         |
| `terminalExecuteCommandEvent`  | -       | Terminal command events             |
| `terminalQuickFixProvider`     | -       | Terminal quick fixes                |
| `contribLanguageModelToolSets` | -       | Tool set contributions              |
| `languageModelThinkingPart`    | -       | Thinking process exposure           |

---

## Summary: Key Takeaways for Lupa Extension

### What We CAN Do

1. **Invoke Copilot's built-in tools** via `vscode.lm.invokeTool()`:

   - `copilot_searchCodebase` for semantic search
   - `copilot_listCodeUsages` for usages
   - `copilot_readFile` for file contents
   - Any tool registered with `vscode.lm.registerTool()`

2. **Register our own tools** that Copilot can use:

   - Via `package.json` contribution
   - Via `vscode.lm.registerTool()` API

3. **Access MCP tools** if configured

4. **Check quota status** via context key `github.copilot.chat.quotaExceeded`

### What We CANNOT Do

1. **Access internal tool implementations** - only the public API surface
2. **Access CopilotToken directly** - internal quota tracking
3. **Use chatParticipantPrivate features** - requires being the Copilot extension
4. **Modify tool filtering logic** - internal to Copilot

### Recommended Approach

Instead of trying to replicate Copilot's internal tools:

1. Use `vscode.lm.invokeTool()` to call existing Copilot tools
2. Register custom analysis tools that provide unique value
3. Let Copilot's Agent Mode orchestrate tool usage
4. Focus on tool-calling analysis via our `ToolCallingAnalysisProvider`
