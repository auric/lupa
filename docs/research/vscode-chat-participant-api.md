# VS Code Chat Participant API Research

> Research conducted December 15, 2025 using DeepWiki on microsoft/vscode repository

## Table of Contents

1. [Registering a Chat Participant](#1-registering-a-chat-participant)
2. [ChatRequestHandler Signature](#2-chatrequesthandler-signature)
3. [Defining Slash Commands](#3-defining-slash-commands)
4. [ChatResponseStream for Streaming Responses](#4-chatresponsestream-for-streaming-responses)
5. [Accessing Chat History](#5-accessing-chat-history)
6. [Variables and Model Access](#6-variables-and-model-access)
7. [Follow-up Suggestions](#7-follow-up-suggestions)
8. [Feedback Events](#8-feedback-events)
9. [Package.json Contribution Point](#9-packagejson-contribution-point)
10. [Private/Proposed APIs](#10-privateproposed-apis)
11. [Rich UI Elements](#11-rich-ui-elements)
12. [Sticky Mode](#12-sticky-mode)
13. [Chat Participants vs Language Model Tools](#13-chat-participants-vs-language-model-tools)

---

## 1. Registering a Chat Participant

### API Function

```typescript
vscode.chat.createChatParticipant(id: string, handler: ChatExtendedRequestHandler): ChatParticipant;
```

### Parameters

| Parameter | Type                         | Description                                                                                |
| --------- | ---------------------------- | ------------------------------------------------------------------------------------------ |
| `id`      | `string`                     | Unique identifier matching the `id` in `package.json` under `contributes.chatParticipants` |
| `handler` | `ChatExtendedRequestHandler` | Function invoked when the participant receives a request                                   |

### Example

```typescript
import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext) {
  const participant = vscode.chat.createChatParticipant(
    "myExtension.reviewer",
    async (request, context, response, token) => {
      // Handle chat request
      response.markdown("Hello from my participant!");
      return { metadata: { command: request.command } };
    }
  );

  // Set additional properties
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, "icon.png");

  context.subscriptions.push(participant);
}
```

### Notes

- The `id` must match the static contribution in `package.json`
- The returned `ChatParticipant` object is a `Disposable` - add it to `context.subscriptions`
- There's also a `createDynamicChatParticipant` API (proposed, requires `chatParticipantPrivate`)

---

## 2. ChatRequestHandler Signature

### Type Definition

```typescript
type ChatExtendedRequestHandler = (
  request: ChatRequest,
  context: ChatContext,
  response: ChatResponseStream,
  token: CancellationToken
) => ProviderResult<ChatResult | void>;
```

### ChatRequest Interface

```typescript
interface ChatRequest {
  readonly prompt: string; // User's input text
  readonly command: string | undefined; // Slash command used (e.g., 'hello')
  readonly references: ChatPromptReference[]; // Variables like #file, #selection
  readonly model: LanguageModelChat; // The language model for this request

  // Proposed API (chatParticipantPrivate)
  readonly id: string;
  readonly attempt: number;
  readonly sessionId: string;
  readonly enableCommandDetection: boolean;
  readonly isParticipantDetected: boolean;
  readonly location: ChatLocation;
  readonly location2:
    | ChatRequestEditorData
    | ChatRequestNotebookData
    | undefined;
  readonly editedFileEvents?: ChatRequestEditedFileEvent[];
  readonly isSubagent?: boolean;
  acceptedConfirmationData?: any[];
  rejectedConfirmationData?: any[];
  readonly tools: Map<string, boolean>;
}
```

### ChatContext Interface

```typescript
interface ChatContext {
  readonly history: ReadonlyArray<ChatRequestTurn | ChatResponseTurn>;
  readonly chatSessionContext?: ChatSessionContext;
}
```

### ChatResult Interface

```typescript
interface ChatResult {
  readonly errorDetails?: ChatErrorDetails;
  readonly metadata?: { [key: string]: any };
}
```

---

## 3. Defining Slash Commands

### Package.json Declaration

```json
{
  "contributes": {
    "chatParticipants": [
      {
        "id": "myExtension.reviewer",
        "name": "reviewer",
        "commands": [
          {
            "name": "changes",
            "description": "Review current changes",
            "sampleRequest": "Review my staged changes",
            "isSticky": false
          },
          {
            "name": "branch",
            "description": "Summarize branch changes",
            "when": "git.state != 'empty'"
          }
        ]
      }
    ]
  }
}
```

### Command Properties (IRawChatCommandContribution)

| Property         | Type      | Description                            |
| ---------------- | --------- | -------------------------------------- |
| `name`           | `string`  | Short name invoked with `/` (required) |
| `description`    | `string`  | Description shown in UI                |
| `sampleRequest`  | `string`  | Text submitted when clicked in `/help` |
| `isSticky`       | `boolean` | Keep command active for next message   |
| `when`           | `string`  | Context key expression for enabling    |
| `disambiguation` | `array`   | Metadata for auto-routing questions    |

### Handling Commands

```typescript
const participant = vscode.chat.createChatParticipant(
  "myExtension.reviewer",
  async (request, context, response, token) => {
    switch (request.command) {
      case "changes":
        await handleChangesCommand(request, response);
        break;
      case "branch":
        await handleBranchCommand(request, response);
        break;
      default:
        await handleGeneralQuery(request, response);
    }
    return {};
  }
);

// Declare available commands (mirrors package.json)
participant.commands = [
  { name: "changes", description: "Review current changes" },
  { name: "branch", description: "Summarize branch changes" },
];
```

---

## 4. ChatResponseStream for Streaming Responses

### Available Methods

```typescript
interface ChatResponseStream {
    // Core content methods
    markdown(value: string | MarkdownString): void;
    anchor(value: Uri | Location | SymbolInformation, title?: string): void;
    button(value: Command): void;
    filetree(value: ChatResponseFileTree[], baseUri: Uri): void;

    // Progress and status
    progress(value: string, task?: (progress: Progress<...>) => Thenable<string | void>): void;
    thinkingProgress(thinkingDelta: ThinkingDelta): void;  // Proposed
    warning(message: string | MarkdownString): void;       // Proposed

    // References
    reference(value: Uri | Location | { variableName: string; value?: Uri | Location },
              iconPath?: Uri | ThemeIcon | { light: Uri; dark: Uri }): void;
    reference2(value: ..., iconPath?: ..., options?: { status?: {...} }): void;

    // Code operations (Proposed: chatParticipantAdditions)
    textEdit(target: Uri, edits: TextEdit | TextEdit[]): void;
    textEdit(target: Uri, isDone: true): void;
    notebookEdit(target: Uri, edits: NotebookEdit | NotebookEdit[]): void;
    codeblockUri(uri: Uri, isEdit?: boolean): void;
    codeCitation(value: Uri, license: string, snippet: string): void;
    markdownWithVulnerabilities(value: string | MarkdownString, vulnerabilities: ChatVulnerability[]): void;

    // Interactive elements (Proposed)
    confirmation(title: string, message: string | MarkdownString, data: any, buttons?: string[]): void;

    // Tool invocation
    prepareToolInvocation(toolName: string): void;
    clearToPreviousToolInvocation(reason: ChatResponseClearToPreviousToolInvocationReason): void;

    // Generic push for any part
    push(part: ChatResponsePart | ExtendedChatResponsePart): void;
}
```

### Usage Examples

```typescript
async function handleRequest(
  request: vscode.ChatRequest,
  response: vscode.ChatResponseStream,
  token: vscode.CancellationToken
) {
  // Show progress
  response.progress("Analyzing your code...");

  // Stream markdown content
  response.markdown("## Analysis Results\n\n");
  response.markdown("Found **3 issues** in your code:\n\n");

  // Add reference to a file
  const fileUri = vscode.Uri.file("/path/to/file.ts");
  response.reference(fileUri, vscode.ThemeIcon.File);

  // Add clickable anchor to specific location
  const location = new vscode.Location(
    fileUri,
    new vscode.Range(10, 0, 10, 50)
  );
  response.anchor(location, "See line 11");

  // Add action button
  response.button({
    command: "myExtension.applyFix",
    title: "$(wrench) Apply Fix",
    arguments: [{ fileUri }],
  });

  // Display file tree
  response.filetree(
    [
      { name: "src", children: [{ name: "index.ts" }, { name: "utils.ts" }] },
      { name: "package.json" },
    ],
    vscode.Uri.file("/project")
  );

  // Warning message (proposed API)
  // response.warning('This fix may have side effects');
}
```

---

## 5. Accessing Chat History

### ChatContext.history Structure

The `context.history` array contains previous turns in the conversation:

```typescript
type ChatHistory = ReadonlyArray<ChatRequestTurn | ChatResponseTurn>;
```

### ChatRequestTurn

```typescript
class ChatRequestTurn {
  readonly prompt: string; // User's input
  readonly command: string | undefined; // Slash command used
  readonly references: ChatPromptReference[]; // Variables/references
  readonly participant: string; // Participant ID
  readonly toolReferences: ChatLanguageModelToolReference[];
  readonly id?: string; // Request ID (proposed)
}
```

### ChatResponseTurn

```typescript
class ChatResponseTurn {
  readonly response: ReadonlyArray<
    | ChatResponseMarkdownPart
    | ChatResponseFileTreePart
    | ChatResponseAnchorPart
    | ChatResponseCommandButtonPart
    | ChatToolInvocationPart // Proposed
  >;
  readonly result: ChatResult;
  readonly participant: string;
  readonly command: string | undefined;
}
```

### Example: Using History

```typescript
async function handleWithHistory(
  request: vscode.ChatRequest,
  context: vscode.ChatContext,
  response: vscode.ChatResponseStream
) {
  // Build conversation history for LLM
  const messages: vscode.LanguageModelChatMessage[] = [];

  for (const turn of context.history) {
    if (turn instanceof vscode.ChatRequestTurn) {
      messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
    } else if (turn instanceof vscode.ChatResponseTurn) {
      // Extract text content from response parts
      const responseText = turn.response
        .filter(
          (part): part is vscode.ChatResponseMarkdownPart =>
            part instanceof vscode.ChatResponseMarkdownPart
        )
        .map((part) => part.value.value)
        .join("\n");
      messages.push(vscode.LanguageModelChatMessage.Assistant(responseText));
    }
  }

  // Add current request
  messages.push(vscode.LanguageModelChatMessage.User(request.prompt));

  // Send to language model
  const chatResponse = await request.model.sendRequest(messages, {}, token);

  for await (const chunk of chatResponse.text) {
    response.markdown(chunk);
  }
}
```

---

## 6. Variables and Model Access

### request.references (Variables)

Chat variables like `#file`, `#selection`, `#editor` are parsed into `ChatPromptReference` objects:

```typescript
interface ChatPromptReference {
  readonly id: string; // Variable name (e.g., 'file', 'selection')
  readonly range?: [number, number]; // Position in prompt
  readonly value: string | Uri | Location | ChatReferenceDiagnostic | unknown;
}
```

### Example: Processing Variables

```typescript
async function processVariables(
  request: vscode.ChatRequest,
  response: vscode.ChatResponseStream
) {
  for (const ref of request.references) {
    if (ref.value instanceof vscode.Uri) {
      // User referenced a file with #file
      const content = await vscode.workspace.fs.readFile(ref.value);
      response.markdown(`\n**File: ${ref.value.fsPath}**\n`);
      response.reference(ref.value);
    } else if (ref.value instanceof vscode.Location) {
      // User referenced a specific location
      response.anchor(
        ref.value,
        `Reference at line ${ref.value.range.start.line + 1}`
      );
    } else if (typeof ref.value === "string") {
      // Selection or other text content
      response.markdown(`\nSelected text: "${ref.value}"\n`);
    }
  }
}
```

### request.model (Language Model)

```typescript
interface LanguageModelChat {
  readonly id: string;
  readonly vendor: string;
  readonly family: string;
  readonly version: string;
  readonly name: string;
  readonly maxInputTokens: number;

  sendRequest(
    messages: LanguageModelChatMessage[],
    options?: LanguageModelChatRequestOptions,
    token?: CancellationToken
  ): Thenable<LanguageModelChatResponse>;

  countTokens(
    text: string | LanguageModelChatMessage,
    token?: CancellationToken
  ): Thenable<number>;
}
```

### Example: Using the Model

```typescript
async function queryModel(
  request: vscode.ChatRequest,
  response: vscode.ChatResponseStream
) {
  const model = request.model;

  // Count tokens in user prompt
  const tokenCount = await model.countTokens(request.prompt);
  console.log(`User prompt has ${tokenCount} tokens`);

  // Send request to LLM
  const messages = [vscode.LanguageModelChatMessage.User(request.prompt)];

  const chatResponse = await model.sendRequest(messages, {
    justification: "User requested code review",
  });

  // Stream response
  for await (const chunk of chatResponse.text) {
    response.markdown(chunk);
  }
}
```

---

## 7. Follow-up Suggestions

### ChatFollowupProvider Interface

```typescript
interface ChatFollowupProvider {
  provideFollowups(
    result: ChatResult,
    context: ChatContext,
    token: CancellationToken
  ): ProviderResult<ChatFollowup[]>;
}

interface ChatFollowup {
  prompt: string; // Text to submit
  label?: string; // Button label (defaults to prompt)
  command?: string; // Slash command to use
  participant?: string; // Target participant ID
}
```

### Implementation

```typescript
const participant = vscode.chat.createChatParticipant(
  "myExtension.reviewer",
  handler
);

participant.followupProvider = {
  provideFollowups(result, context, token) {
    const followups: vscode.ChatFollowup[] = [];

    // Check metadata from the result to suggest relevant follow-ups
    if (result.metadata?.hasIssues) {
      followups.push({
        prompt: "Show me how to fix these issues",
        label: "$(lightbulb) Fix Issues",
      });
      followups.push({
        prompt: "Explain the issues in more detail",
        label: "$(info) More Details",
      });
    }

    if (result.metadata?.command === "changes") {
      followups.push({
        prompt: "Review the entire branch",
        command: "branch",
        label: "$(git-branch) Review Branch",
      });
    }

    return followups;
  },
};
```

---

## 8. Feedback Events

### onDidReceiveFeedback Event

Triggered when a user clicks thumbs up/down on a response.

```typescript
interface ChatResultFeedback {
  readonly result: ChatResult;
  readonly kind: ChatResultFeedbackKind;
  readonly unhelpfulReason?: string; // Proposed: chatParticipantAdditions
}

enum ChatResultFeedbackKind {
  Unhelpful = 0,
  Helpful = 1,
}
```

### Implementation

```typescript
const participant = vscode.chat.createChatParticipant(
  "myExtension.reviewer",
  handler
);

participant.onDidReceiveFeedback((feedback) => {
  // Log feedback for telemetry
  const isHelpful = feedback.kind === vscode.ChatResultFeedbackKind.Helpful;

  console.log("Feedback received:", {
    helpful: isHelpful,
    metadata: feedback.result.metadata,
    reason: feedback.unhelpfulReason, // Only with proposed API
  });

  // Send to telemetry service
  telemetryService.trackEvent("chat_feedback", {
    participant: "reviewer",
    helpful: isHelpful,
    command: feedback.result.metadata?.command,
  });
});
```

---

## 9. Package.json Contribution Point

### Full Schema

```json
{
  "contributes": {
    "chatParticipants": [
      {
        "id": "myExtension.reviewer",
        "name": "reviewer",
        "fullName": "Code Reviewer",
        "description": "AI-powered code review assistant",
        "isSticky": false,
        "sampleRequest": "Review my code changes",
        "when": "workspaceFolderCount > 0",
        "disambiguation": [
          {
            "category": "code_review",
            "description": "Questions about code quality, reviews, and best practices",
            "examples": [
              "Review my changes",
              "Check for bugs in this code",
              "Suggest improvements"
            ]
          }
        ],
        "commands": [
          {
            "name": "changes",
            "description": "Review staged changes",
            "sampleRequest": "Review my staged changes",
            "isSticky": true,
            "when": "git.hasChanges",
            "disambiguation": [
              {
                "category": "git_changes",
                "description": "Questions about current git changes",
                "examples": ["What did I change?", "Review my diff"]
              }
            ]
          },
          {
            "name": "branch",
            "description": "Summarize branch changes"
          }
        ],
        "isDefault": false,
        "modes": ["agent", "ask", "edit"],
        "locations": ["panel", "chat"]
      }
    ]
  }
}
```

### Property Reference

| Property         | Type       | Required | Description                                                      |
| ---------------- | ---------- | -------- | ---------------------------------------------------------------- |
| `id`             | `string`   | ✅       | Unique identifier for the participant                            |
| `name`           | `string`   | ✅       | User-facing name (invoked with `@name`)                          |
| `fullName`       | `string`   |          | Display name for responses                                       |
| `description`    | `string`   |          | Description shown in UI                                          |
| `isSticky`       | `boolean`  |          | Keep participant active for next message                         |
| `sampleRequest`  | `string`   |          | Sample text for `/help`                                          |
| `when`           | `string`   |          | Context key expression                                           |
| `disambiguation` | `array`    |          | Routing metadata                                                 |
| `commands`       | `array`    |          | Available slash commands                                         |
| `isDefault`      | `boolean`  |          | Default participant (requires `defaultChatParticipant` proposal) |
| `modes`          | `string[]` |          | `"agent"`, `"ask"`, `"edit"`                                     |
| `locations`      | `string[]` |          | `"panel"`, `"chat"` (requires `chatParticipantAdditions`)        |

---

## 10. Private/Proposed APIs

### chatParticipantPrivate Proposal

Gates internal/advanced features. Enable in `package.json`:

```json
{
  "enabledApiProposals": ["chatParticipantPrivate"]
}
```

#### Features Gated

| Feature                                    | Description                                            |
| ------------------------------------------ | ------------------------------------------------------ |
| `createDynamicChatParticipant`             | Create participants without package.json contribution  |
| `registerChatParticipantDetectionProvider` | Auto-detect which participant should handle requests   |
| `onDidDisposeChatSession`                  | Event when chat session is disposed                    |
| Extended `ChatRequest` properties          | `id`, `attempt`, `sessionId`, `isSubagent`, etc.       |
| Internal tools                             | Tools with names starting with `copilot_` or `vscode_` |
| `supportIssueReporting`                    | Enable issue reporting for participant                 |
| `LanguageModelProxyProvider`               | Register language model proxies                        |
| `lm.registerIgnoredFileProvider`           | Exclude files from LLM context                         |

### chatParticipantAdditions Proposal

```json
{
  "enabledApiProposals": ["chatParticipantAdditions"]
}
```

#### Features Gated

| Feature                       | Description                           |
| ----------------------------- | ------------------------------------- |
| `response.confirmation()`     | Display confirmation prompts          |
| `response.warning()`          | Display warning messages              |
| `response.textEdit()`         | Apply text edits                      |
| `response.thinkingProgress()` | Show thinking/reasoning progress      |
| `response.codeCitation()`     | Display code citations                |
| `unhelpfulReason` in feedback | Get reason for negative feedback      |
| `locations` property          | Specify where participant can be used |

### Dynamic Participant Example (Proposed)

```typescript
// Requires chatParticipantPrivate
const dynamicParticipant = vscode.chat.createDynamicChatParticipant(
  "myExtension.dynamicReviewer",
  {
    name: "dynamic-reviewer",
    fullName: "Dynamic Code Reviewer",
    publisherName: "myPublisher",
    description: "Dynamically created reviewer",
  },
  async (request, context, response, token) => {
    response.markdown("Hello from dynamic participant!");
    return {};
  }
);
```

---

## 11. Rich UI Elements

### Button (ChatResponseCommandButtonPart)

```typescript
response.button({
  command: "myExtension.applyFix",
  title: "$(check) Apply Fix",
  tooltip: "Click to apply the suggested fix",
  arguments: [{ uri: fileUri, range: issueRange }],
});
```

### File Tree (ChatResponseFileTreePart)

```typescript
response.filetree(
  [
    {
      name: "src",
      children: [
        { name: "index.ts" },
        {
          name: "components",
          children: [{ name: "Button.tsx" }, { name: "Input.tsx" }],
        },
      ],
    },
    { name: "package.json" },
    { name: "README.md" },
  ],
  vscode.Uri.file("/workspace")
);
```

### Anchor (ChatResponseAnchorPart)

```typescript
// Link to file
response.anchor(vscode.Uri.file("/path/to/file.ts"), "View source");

// Link to specific location
response.anchor(
  new vscode.Location(
    vscode.Uri.file("/path/to/file.ts"),
    new vscode.Range(15, 0, 15, 30)
  ),
  "Error on line 16"
);

// Link to symbol
response.anchor(symbolInfo, "Jump to definition");
```

### Reference (ChatResponseReferencePart)

```typescript
// File reference with icon
response.reference(
  vscode.Uri.file("/path/to/file.ts"),
  new vscode.ThemeIcon("file-code")
);

// Variable reference
response.reference({
  variableName: "selection",
  value: selectionLocation,
});

// Reference with status (proposed)
response.reference2(
  vscode.Uri.file("/path/to/file.ts"),
  vscode.ThemeIcon.File,
  {
    status: {
      description: "Analyzed",
      kind: vscode.ChatResponseReferencePartStatusKind.Complete,
    },
  }
);
```

### Progress Indicator

```typescript
// Simple progress message
response.progress("Analyzing code...");

// Progress with task (message updates when task completes)
response.progress("Running tests...", async (progress) => {
  const result = await runTests();
  if (result.warnings.length > 0) {
    progress.report(
      new vscode.ChatResponseWarningPart("Some tests had warnings")
    );
  }
  return `Completed: ${result.passed}/${result.total} passed`;
});
```

### Confirmation Prompt (Proposed)

```typescript
// Requires chatParticipantAdditions
response.confirmation(
  "Apply Changes?",
  "This will modify 5 files. Do you want to proceed?",
  { files: filesToModify },
  ["Apply", "Cancel"]
);
```

---

## 12. Sticky Mode

### Concept

Sticky mode keeps a participant or command active for follow-up messages, creating a continuous conversation.

### Package.json Configuration

```json
{
  "contributes": {
    "chatParticipants": [
      {
        "id": "myExtension.reviewer",
        "name": "reviewer",
        "isSticky": true, // Participant stays active
        "commands": [
          {
            "name": "debug",
            "description": "Debug session",
            "isSticky": true // Command stays active
          }
        ]
      }
    ]
  }
}
```

### Behavior

1. When `isSticky: true` on participant:

   - After sending a message to `@reviewer`, the next message automatically goes to `@reviewer`

2. When `isSticky: true` on command:
   - After using `@reviewer /debug`, the next message automatically uses `@reviewer /debug`

### Managing Context Across Turns

```typescript
const participant = vscode.chat.createChatParticipant(
  "myExtension.reviewer",
  async (request, context, response, token) => {
    // Access previous turns to maintain context
    const previousTurns = context.history.filter(
      (turn) => turn.participant === "myExtension.reviewer"
    );

    // Build cumulative context
    const conversationContext = buildContext(previousTurns);

    // Use context in response generation
    const messages = [
      vscode.LanguageModelChatMessage.System(conversationContext),
      vscode.LanguageModelChatMessage.User(request.prompt),
    ];

    const chatResponse = await request.model.sendRequest(messages);
    for await (const chunk of chatResponse.text) {
      response.markdown(chunk);
    }

    return { metadata: { sticky: true } };
  }
);
```

---

## 13. Chat Participants vs Language Model Tools

### Key Differences

| Aspect                 | Chat Participants            | Language Model Tools           |
| ---------------------- | ---------------------------- | ------------------------------ |
| **Purpose**            | Handle user conversations    | Perform specific actions       |
| **Invocation**         | `@participant` in chat       | Called by LLM during reasoning |
| **User Interaction**   | Direct conversation          | Indirect, via LLM              |
| **Output**             | Streaming responses to user  | Structured data to LLM         |
| **Contribution Point** | `chatParticipants`           | `languageModelTools`           |
| **API**                | `chat.createChatParticipant` | `lm.registerTool`              |

### How They Interact

1. **User → Participant → Tool**: A chat participant can invoke tools during its response:

```typescript
const participant = vscode.chat.createChatParticipant(
  "myExtension.reviewer",
  async (request, context, response, token) => {
    // Invoke a tool
    const toolResult = await vscode.lm.invokeTool(
      "myExtension.analyzeCode",
      {
        input: { filePath: "/path/to/file.ts" },
      },
      token
    );

    // Use tool result in response
    response.markdown(`Analysis: ${toolResult.content}`);
  }
);
```

2. **Tool References in Requests**: Users can reference tools with `#toolName`:

```typescript
async function handleRequest(request: vscode.ChatRequest) {
  // Check if user referenced specific tools
  for (const ref of request.toolReferences) {
    console.log(`User referenced tool: ${ref.name}`);
  }
}
```

### Registering a Language Model Tool

```typescript
// In package.json
{
    "contributes": {
        "languageModelTools": [{
            "name": "analyzeCode",
            "displayName": "Analyze Code",
            "modelDescription": "Analyzes code for issues and improvements",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "filePath": {
                        "type": "string",
                        "description": "Path to file to analyze"
                    }
                },
                "required": ["filePath"]
            }
        }]
    }
}
```

```typescript
// In extension code
const tool = vscode.lm.registerTool("myExtension.analyzeCode", {
  async invoke(options, token) {
    const { filePath } = options.input as { filePath: string };
    const analysis = await analyzeFile(filePath);
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(JSON.stringify(analysis)),
    ]);
  },
});
```

---

## Complete Example: PR Review Participant

```typescript
import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext) {
  const participant = vscode.chat.createChatParticipant(
    "prReviewer.reviewer",
    handleChatRequest
  );

  participant.iconPath = vscode.Uri.joinPath(
    context.extensionUri,
    "media",
    "icon.png"
  );

  participant.commands = [
    { name: "changes", description: "Review current changes" },
    { name: "branch", description: "Review branch against main" },
    { name: "file", description: "Review a specific file" },
  ];

  participant.followupProvider = {
    provideFollowups(result, context, token) {
      if (result.metadata?.hasIssues) {
        return [
          {
            prompt: "Explain the most critical issue",
            label: "$(warning) Critical Issue",
          },
          {
            prompt: "Show me how to fix all issues",
            label: "$(tools) Fix All",
          },
        ];
      }
      return [];
    },
  };

  participant.onDidReceiveFeedback((feedback) => {
    console.log(
      "Feedback:",
      feedback.kind === vscode.ChatResultFeedbackKind.Helpful ? "👍" : "👎"
    );
  });

  context.subscriptions.push(participant);
}

async function handleChatRequest(
  request: vscode.ChatRequest,
  context: vscode.ChatContext,
  response: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<vscode.ChatResult> {
  response.progress("Starting review...");

  // Process variables
  const files: vscode.Uri[] = [];
  for (const ref of request.references) {
    if (ref.value instanceof vscode.Uri) {
      files.push(ref.value);
      response.reference(ref.value, vscode.ThemeIcon.File);
    }
  }

  // Handle commands
  switch (request.command) {
    case "changes":
      return await reviewChanges(request, response, token);
    case "branch":
      return await reviewBranch(request, response, token);
    case "file":
      return await reviewFiles(files, request, response, token);
    default:
      return await generalReview(request, context, response, token);
  }
}

async function reviewChanges(
  request: vscode.ChatRequest,
  response: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<vscode.ChatResult> {
  response.markdown("## Reviewing Current Changes\n\n");

  // Stream analysis from LLM
  const messages = [
    vscode.LanguageModelChatMessage.System(
      "You are a code reviewer. Analyze the changes and provide feedback."
    ),
    vscode.LanguageModelChatMessage.User(request.prompt),
  ];

  const chatResponse = await request.model.sendRequest(messages, {}, token);

  for await (const chunk of chatResponse.text) {
    response.markdown(chunk);
  }

  // Add action button
  response.button({
    command: "prReviewer.applyFixes",
    title: "$(check) Apply Suggested Fixes",
  });

  return { metadata: { command: "changes", hasIssues: true } };
}
```

---

## References

- VS Code API Documentation: https://code.visualstudio.com/api
- Chat Extensions Guide: https://code.visualstudio.com/api/extension-guides/chat
- Proposed APIs: https://github.com/microsoft/vscode/tree/main/src/vscode-dts
- Source files researched:
  - `src/vs/workbench/api/common/extHostChatAgents2.ts`
  - `src/vs/workbench/api/common/extHostTypes.ts`
  - `src/vs/workbench/api/common/extHostTypeConverters.ts`
  - `src/vs/workbench/contrib/chat/common/chatParticipantContribTypes.ts`
  - `src/vscode-dts/vscode.proposed.chatParticipantAdditions.d.ts`
  - `src/vscode-dts/vscode.proposed.chatParticipantPrivate.d.ts`
