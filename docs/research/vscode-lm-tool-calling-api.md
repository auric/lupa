# VS Code Language Model Tool Calling API Research

**Date:** December 15, 2025
**Source:** microsoft/vscode repository via DeepWiki

---

## Table of Contents

1. [vscode.lm.invokeTool() Signature](#1-vscodelmeinvoketool-signature)
2. [Invoking Built-in Copilot Tools](#2-invoking-built-in-copilot-tools)
3. [Public API Tools (No Proposed API Required)](#3-public-api-tools-no-proposed-api-required)
4. [Registering Tools for Copilot Agent Mode](#4-registering-tools-for-copilot-agent-mode)
5. [languageModelTools Contribution Point](#5-languagemodeltools-contribution-point)
6. [LanguageModelToolCallPart in Response Stream](#6-languagemodeltoolcallpart-in-response-stream)
7. [registerTool() vs package.json Contribution](#7-registertool-vs-packagejson-contribution)
8. [Proposed API Requirements](#8-proposed-api-requirements)
9. [Tool Sets (languageModelToolSets)](#9-tool-sets-languagemodeltoolsets)

---

## 1. vscode.lm.invokeTool() Signature

### TypeScript Signature

```typescript
invokeTool<T>(
  name: string,
  parameters: vscode.LanguageModelToolInvocationOptions<T>,
  token?: vscode.CancellationToken
): Promise<vscode.LanguageModelToolResult>
```

### Parameters

| Parameter    | Type                                    | Description                                                       |
| ------------ | --------------------------------------- | ----------------------------------------------------------------- |
| `name`       | `string`                                | The name of the tool to invoke                                    |
| `parameters` | `LanguageModelToolInvocationOptions<T>` | Contains `input` (of type `T`) and optional `toolInvocationToken` |
| `token`      | `CancellationToken`                     | Optional cancellation token                                       |

### LanguageModelToolInvocationOptions Interface

```typescript
interface LanguageModelToolInvocationOptions<T> {
    input: T; // Matches the inputSchema defined for the tool
    toolInvocationToken?: unknown; // Token from ChatRequest for tool invocation context
}
```

### Usage Example

```typescript
// Invoke a tool from within a chat participant
const participant = vscode.chat.createChatParticipant(
    'my-extension.participant',
    async (request, context, progress, token) => {
        // Invoke a registered tool
        const result = await vscode.lm.invokeTool(
            'my_tool_name',
            {
                input: { filePath: '/path/to/file.ts', query: 'search term' },
                toolInvocationToken: request.toolInvocationToken,
            },
            token
        );

        // Process result
        for (const part of result.content) {
            if (part instanceof vscode.LanguageModelTextPart) {
                progress.report({ content: part.value });
            }
        }

        return { metadata: { complete: true } };
    }
);
```

### Internal Processing

When `invokeTool()` is called:

1. `ExtHostLanguageModelTools.invokeTool()` retrieves the registered tool
2. Constructs invocation options including `toolInvocationToken`
3. If `chatParticipantPrivate`/`chatParticipantAdditions` is enabled, adds `chatRequestId`, `chatSessionId`, `model`, etc.
4. Calls the tool's `invoke` method wrapped in `raceCancellation`
5. Returns the tool result

---

## 2. Invoking Built-in Copilot Tools

### Can Third-Party Extensions Invoke Built-in Copilot Tools?

**Yes, but with restrictions.** Built-in Copilot tools like `copilot_readFile`, `copilot_searchCodebase` are considered **internal tools**.

### Requirements

- Tools prefixed with `copilot_` or `vscode_` require the **`chatParticipantPrivate`** proposed API
- Without this proposal, these tools are **not visible** in `vscode.lm.tools`

### Internal Tool IDs

The following internal tools require `chatParticipantPrivate`:

```typescript
// Internal tool IDs (require chatParticipantPrivate)
InternalEditToolId;
ExtensionEditToolId;
InternalFetchWebPageToolId;
SearchExtensionsToolId;
```

### Tool Discovery

```typescript
// Get available tools (filtered based on proposed API access)
const tools = vscode.lm.tools;

for (const tool of tools) {
    console.log(`Tool: ${tool.name}`);
    console.log(`Description: ${tool.description}`);
    console.log(`Input Schema: ${JSON.stringify(tool.inputSchema)}`);
}
```

### Tool Sets

VS Code defines internal tool sets:

| Tool Set         | Description                          |
| ---------------- | ------------------------------------ |
| `vscodeToolSet`  | General VS Code features             |
| `executeToolSet` | Executing code and terminal commands |
| `readToolSet`    | Reading files in the workspace       |

---

## 3. Public API Tools (No Proposed API Required)

### Publicly Available `vscode.lm` APIs

| API                                     | Description                                     |
| --------------------------------------- | ----------------------------------------------- |
| `selectChatModels(selector)`            | Select language models by criteria              |
| `onDidChangeChatModels`                 | Event when available models change              |
| `registerTool(name, tool)`              | Register a language model tool                  |
| `invokeTool(name, params, token)`       | Invoke a registered tool                        |
| `tools`                                 | Getter for available tools (filtered by access) |
| `fileIsIgnored(uri)`                    | Check if a file is ignored by LM                |
| `registerIgnoredFileProvider(provider)` | Register ignored file provider                  |

### Embedding APIs (Require `embeddings` proposed API)

| API                                    | Description                        |
| -------------------------------------- | ---------------------------------- |
| `embeddingModels`                      | Get available embedding models     |
| `onDidChangeEmbeddingModels`           | Event when embedding models change |
| `registerEmbeddingsProvider(provider)` | Register embedding provider        |
| `computeEmbeddings(model, input)`      | Compute embeddings                 |

### APIs Requiring `chatParticipantPrivate`

| API                                  | Description                                       |
| ------------------------------------ | ------------------------------------------------- |
| `registerLanguageModelProxyProvider` | Register LM proxy provider                        |
| `onDidChangeChatRequestTools`        | Event when request tools change                   |
| Internal tools access                | `InternalEditToolId`, `ExtensionEditToolId`, etc. |

---

## 4. Registering Tools for Copilot Agent Mode

### Using vscode.lm.registerTool()

```typescript
import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    // Define input type matching the schema
    interface MyToolInput {
        filePath: string;
        options?: {
            includeContent: boolean;
        };
    }

    const toolRegistration = vscode.lm.registerTool<MyToolInput>(
        'my_extension_tool',
        {
            // Called when the tool is invoked
            invoke: async (options, token) => {
                const { filePath, options: opts } = options.input;

                // Perform tool logic
                const content = await processFile(
                    filePath,
                    opts?.includeContent ?? false
                );

                // Return result with content parts
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(content),
                ]);
            },

            // Optional: Called before invocation for confirmation
            prepareInvocation: async (options, token) => {
                return {
                    invocationMessage: 'Reading file...',
                    pastTenseMessage: 'Read file',
                    confirmationMessages: {
                        title: 'Confirm File Read',
                        message: `Are you sure you want to read ${options.input.filePath}?`,
                    },
                };
            },
        }
    );

    context.subscriptions.push(toolRegistration);
}
```

### Tool Implementation Interface

```typescript
interface LanguageModelTool<T> {
    invoke(
        options: LanguageModelToolInvocationOptions<T>,
        token: CancellationToken
    ): ProviderResult<LanguageModelToolResult>;

    prepareInvocation?(
        options: LanguageModelToolInvocationPrepareOptions<T>,
        token: CancellationToken
    ): ProviderResult<PreparedToolInvocation>;
}
```

### PreparedToolInvocation Interface

```typescript
interface PreparedToolInvocation {
    invocationMessage?: string; // Message shown during invocation
    pastTenseMessage?: string; // Message after completion
    confirmationMessages?: {
        title: string;
        message: string;
    };
}
```

---

## 5. languageModelTools Contribution Point

### package.json Schema

```json
{
    "contributes": {
        "languageModelTools": [
            {
                "name": "my_tool_name",
                "displayName": "My Tool",
                "modelDescription": "Description used by AI to select this tool",
                "userDescription": "Description shown to users",
                "toolReferenceName": "myTool",
                "canBeReferencedInPrompt": true,
                "icon": "$(symbol-method)",
                "when": "editorLangId == typescript",
                "tags": ["filesystem", "read"],
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "filePath": {
                            "type": "string",
                            "description": "The path to the file"
                        },
                        "lineNumber": {
                            "type": "integer",
                            "description": "Optional line number",
                            "minimum": 1
                        }
                    },
                    "required": ["filePath"],
                    "additionalProperties": false
                }
            }
        ]
    }
}
```

### Required Fields

| Field              | Type     | Description                                                                      |
| ------------------ | -------- | -------------------------------------------------------------------------------- |
| `name`             | `string` | Unique identifier, pattern `^[\w-]+$`. Cannot start with `copilot_` or `vscode_` |
| `displayName`      | `string` | Human-readable name for UI                                                       |
| `modelDescription` | `string` | Description for AI model selection                                               |

### Optional Fields

| Field                     | Type       | Description                        |
| ------------------------- | ---------- | ---------------------------------- | ------------------ |
| `toolReferenceName`       | `string`   | Name for `#` references in prompts |
| `userDescription`         | `string`   | Description shown to users         |
| `canBeReferencedInPrompt` | `boolean`  | Allow user to add via `#`          |
| `icon`                    | `string    | object`                            | Theme icon or path |
| `when`                    | `string`   | Condition for tool availability    |
| `tags`                    | `string[]` | Capability tags                    |
| `inputSchema`             | `object`   | JSON Schema for tool input         |

### inputSchema Allowed Types

The schema supports JSON Schema Draft-07 subset:

```typescript
// Allowed simple types
type SimpleTypes =
    | 'array'
    | 'boolean'
    | 'integer'
    | 'null'
    | 'number'
    | 'object'
    | 'string';
```

Supported schema keywords:

- `$id`, `$ref`, `$comment`, `title`, `description`
- `type`, `enum`, `const`
- `multipleOf`, `maximum`, `minimum`, `exclusiveMaximum`, `exclusiveMinimum`
- `maxLength`, `minLength`, `pattern`
- `items`, `maxItems`, `minItems`, `uniqueItems`, `contains`
- `properties`, `additionalProperties`, `required`
- `allOf`, `anyOf`, `oneOf`, `not`, `if`, `then`, `else`

### Complete inputSchema Example

```json
{
    "inputSchema": {
        "type": "object",
        "properties": {
            "title": {
                "type": "string",
                "description": "Title for the confirmation dialog"
            },
            "message": {
                "type": "string",
                "description": "Message to show"
            },
            "confirmationType": {
                "type": "string",
                "enum": ["basic", "terminal"],
                "description": "Type of confirmation"
            },
            "options": {
                "type": "object",
                "properties": {
                    "timeout": {
                        "type": "integer",
                        "minimum": 0,
                        "description": "Timeout in milliseconds"
                    }
                }
            }
        },
        "required": ["title", "message", "confirmationType"],
        "additionalProperties": false
    }
}
```

---

## 6. LanguageModelToolCallPart in Response Stream

### Understanding Tool Call Parts

When a language model decides to call a tool, it emits `LanguageModelToolCallPart` objects in the response stream.

### LanguageModelToolCallPart Structure

```typescript
class LanguageModelToolCallPart {
    readonly callId: string; // Unique ID for this tool call
    readonly name: string; // Tool name to invoke
    readonly input: object; // Parameters for the tool
}
```

### Agentic Tool-Calling Loop Implementation

```typescript
import * as vscode from 'vscode';

async function agenticToolLoop(
    model: vscode.LanguageModelChat,
    messages: vscode.LanguageModelChatMessage[],
    tools: vscode.LanguageModelChatTool[],
    token: vscode.CancellationToken
): Promise<string> {
    let finalResponse = '';

    while (true) {
        // Send request with tools
        const response = await model.sendRequest(messages, { tools }, token);

        const toolCalls: vscode.LanguageModelToolCallPart[] = [];
        let textContent = '';

        // Process the response stream
        for await (const part of response.stream) {
            if (part instanceof vscode.LanguageModelTextPart) {
                textContent += part.value;
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
                // Collect tool calls
                toolCalls.push(part);
            }
        }

        // If no tool calls, we're done
        if (toolCalls.length === 0) {
            finalResponse = textContent;
            break;
        }

        // Add assistant message with tool calls
        const assistantMessage = vscode.LanguageModelChatMessage.Assistant('');
        assistantMessage.content2 = toolCalls;
        messages.push(assistantMessage);

        // Process each tool call and collect results
        const toolResults: vscode.LanguageModelToolResultPart[] = [];

        for (const toolCall of toolCalls) {
            try {
                // Invoke the tool
                const result = await vscode.lm.invokeTool(
                    toolCall.name,
                    {
                        input: toolCall.input,
                    },
                    token
                );

                // Create result part
                toolResults.push(
                    new vscode.LanguageModelToolResultPart(
                        toolCall.callId,
                        result.content
                    )
                );
            } catch (error) {
                // Handle tool error
                toolResults.push(
                    new vscode.LanguageModelToolResultPart(
                        toolCall.callId,
                        [new vscode.LanguageModelTextPart(`Error: ${error}`)],
                        true // isError
                    )
                );
            }
        }

        // Add tool results as user message
        const userMessage = vscode.LanguageModelChatMessage.User('');
        userMessage.content2 = toolResults;
        messages.push(userMessage);
    }

    return finalResponse;
}
```

### LanguageModelToolResultPart Structure

```typescript
class LanguageModelToolResultPart {
    constructor(
        callId: string, // Matches the toolCall.callId
        content: (
            | LanguageModelTextPart
            | LanguageModelDataPart
            | LanguageModelPromptTsxPart
        )[],
        isError?: boolean // Indicates if this is an error result
    );
}
```

### Response Stream Part Types

| Part Type                   | Description                                    |
| --------------------------- | ---------------------------------------------- |
| `LanguageModelTextPart`     | Plain text content                             |
| `LanguageModelToolCallPart` | Request to invoke a tool                       |
| `LanguageModelThinkingPart` | Model's internal reasoning (extended thinking) |

---

## 7. registerTool() vs package.json Contribution

### Key Differences

| Aspect             | `vscode.lm.registerTool()`         | `package.json` contribution    |
| ------------------ | ---------------------------------- | ------------------------------ |
| **Timing**         | Runtime (when extension activates) | Extension load time            |
| **Definition**     | Code + implementation              | Metadata only                  |
| **Flexibility**    | Dynamic (can register/unregister)  | Static                         |
| **Implementation** | Included via `invoke` method       | Requires separate registration |
| **Use Case**       | Dynamic tools, conditional logic   | Static tool definitions        |

### package.json: Metadata Only

```json
{
    "contributes": {
        "languageModelTools": [
            {
                "name": "my_static_tool",
                "displayName": "My Static Tool",
                "modelDescription": "Does something useful",
                "inputSchema": { "type": "object" }
            }
        ]
    }
}
```

**Important:** Declarative registration only provides metadata. You must ALSO register the implementation:

```typescript
// Must also register the implementation
vscode.lm.registerTool('my_static_tool', {
    invoke: async (options, token) => {
        // Implementation
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart('Result'),
        ]);
    },
});
```

### registerTool(): Complete Definition

```typescript
// Single call provides both metadata and implementation
vscode.lm.registerTool('my_dynamic_tool', {
    invoke: async (options, token) => {
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart('Result'),
        ]);
    },
});
```

### When to Use Each

**Use package.json when:**

- Tool should appear in tool lists before extension activates
- Tool has static schema and description
- Tool should be discoverable without activation

**Use registerTool() when:**

- Tool depends on runtime conditions
- Tool schema is dynamic
- Tool needs to be registered/unregistered conditionally

### Best Practice: Both Together

```json
{
    "contributes": {
        "languageModelTools": [
            {
                "name": "my_tool",
                "displayName": "My Tool",
                "modelDescription": "Comprehensive description for model",
                "userDescription": "User-friendly description",
                "canBeReferencedInPrompt": true,
                "toolReferenceName": "myTool",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string" }
                    },
                    "required": ["query"]
                }
            }
        ]
    }
}
```

```typescript
// Register implementation
context.subscriptions.push(
    vscode.lm.registerTool('my_tool', {
        invoke: async (options, token) => {
            const { query } = options.input as { query: string };
            const result = await performSearch(query);
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(result),
            ]);
        },
    })
);
```

---

## 8. Proposed API Requirements

### Overview of Tool-Related Proposed APIs

| Proposed API               | Purpose                    | Key Features                                     |
| -------------------------- | -------------------------- | ------------------------------------------------ |
| `lmTools`                  | Core tool functionality    | `registerTool`, `invokeTool`, `tools`            |
| `chatParticipantAdditions` | Enhanced chat features     | Tool maps, confirmation data, new response parts |
| `chatParticipantPrivate`   | Internal/privileged access | Internal tools, dynamic participants             |

### lmTools Proposed API

**Status:** Core tool API, may require enablement

Features:

- `vscode.lm.registerTool()`
- `vscode.lm.invokeTool()`
- `vscode.lm.tools`
- `LanguageModelToolInformation` with source

### chatParticipantAdditions Proposed API

**Enables:**

- `acceptedConfirmationData` and `rejectedConfirmationData` in ChatRequest
- `tools` map in ChatRequest
- `onDidChangeChatRequestTools` event
- `participantVariableProvider`
- New response parts:
    - `ChatResponseMarkdownWithVulnerabilitiesPart`
    - `ChatResponseCodeblockUriPart`
    - `ChatResponseConfirmationPart`
    - `ChatResponseCodeCitationPart`
    - `ChatPrepareToolInvocationPart`
    - `ChatToolInvocationPart`

### chatParticipantPrivate Proposed API

**Enables:**

- Access to internal tools (`copilot_*`, `vscode_*`)
- `vscode.chat.createDynamicChatParticipant()`
- `ChatParticipantDetectionProvider`
- `LanguageModelProxyProvider`
- Extended ChatRequest properties:
    - `id`, `attempt`, `enableCommandDetection`
    - `isParticipantDetected`, `location`, `location2`
    - `editedFileEvents`, `sessionId`, `isSubagent`

### Enabling Proposed APIs

In `package.json`:

```json
{
    "enabledApiProposals": ["lmTools", "chatParticipantAdditions"]
}
```

**Note:** `chatParticipantPrivate` is typically not available to third-party extensions.

---

## 9. Tool Sets (languageModelToolSets)

### Contribution Point

```json
{
    "contributes": {
        "languageModelToolSets": [
            {
                "name": "my_tool_set",
                "description": "A collection of related tools",
                "tools": ["my_tool_1", "my_tool_2", "another_tool_set"]
            }
        ]
    }
}
```

### Built-in Tool Sets

| Tool Set         | Description              | Contains                                                         |
| ---------------- | ------------------------ | ---------------------------------------------------------------- |
| `vscodeToolSet`  | General VS Code features | Various VS Code tools                                            |
| `executeToolSet` | Executing code/commands  | `GetTerminalOutputToolData`, `RunInTerminalToolData`             |
| `readToolSet`    | Reading workspace files  | `GetTerminalSelectionToolData`, `GetTerminalLastCommandToolData` |

### Tool Set Schema

| Field         | Type       | Required | Description                  |
| ------------- | ---------- | -------- | ---------------------------- |
| `name`        | `string`   | Yes      | Unique identifier            |
| `description` | `string`   | Yes      | Description of the set       |
| `tools`       | `string[]` | Yes      | Tool names or tool set names |
| `icon`        | `string`   | No       | Theme icon                   |

---

## Summary: Implementing Tool Calling in Lupa

### Recommended Approach for Lupa

Given that Lupa is a VS Code extension for PR analysis:

1. **Declare tools in package.json** for discovery and schema documentation
2. **Register implementations via `registerTool()`** for the actual logic
3. **Use `invokeTool()` within chat participant** to execute tools
4. **Implement agentic loop** for multi-step analysis

### Limitations Without chatParticipantPrivate

- Cannot access `copilot_readFile`, `copilot_searchCodebase`
- Cannot register tools with `copilot_` or `vscode_` prefix
- Limited access to internal tool sets

### What IS Available (Public API)

- Register custom tools with unique names
- Invoke any registered tool (including from other extensions)
- Full tool calling loop with `LanguageModelToolCallPart`
- Tool schema definition via `inputSchema`
- User confirmation via `prepareInvocation`

---

## References

- VS Code API: `vscode.lm` namespace
- Source: `src/vs/workbench/api/common/extHostLanguageModelTools.ts`
- Source: `src/vs/workbench/contrib/chat/common/tools/languageModelToolsContribution.ts`
- Source: `src/vs/workbench/api/common/extHostTypeConverters.ts`
