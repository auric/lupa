# Context Window Management in VS Code Chat Participants

**Date:** December 16, 2025
**Research Sources:** DeepWiki on microsoft/vscode, microsoft/vscode-copilot-chat repositories

---

## Executive Summary

VS Code Chat Participant API does **not** provide built-in context window management or automatic history truncation. Extensions are fully responsible for:

1. Tracking token usage via `LanguageModelChat.countTokens()`
2. Deciding when to truncate or summarize history
3. Implementing summarization logic (optionally via `ChatSummarizer` proposed API)

Copilot Chat (the official extension) implements sophisticated summarization for agent mode conversations, serving as the reference implementation.

---

## 1. Does VS Code Provide Built-in Context Window Management?

**No.** The Chat Participant API provides:

- **Full history access**: `ChatContext.history` contains all conversation turns
- **No automatic truncation**: History is not pruned by VS Code
- **No token counting on history**: Extensions must count tokens themselves

### What IS Provided

| API                                   | Purpose                                 |
| ------------------------------------- | --------------------------------------- |
| `LanguageModelChat.maxInputTokens`    | Model's input token limit               |
| `LanguageModelChat.maxOutputTokens`   | Model's output token limit              |
| `LanguageModelChat.countTokens()`     | Count tokens for text or single message |
| `ChatSummarizer` interface (proposed) | Optional summarization hook             |

---

## 2. How ChatContext.history Works

### Structure

```typescript
interface ChatContext {
  readonly history: ReadonlyArray<ChatRequestTurn | ChatResponseTurn>;
}
```

### ChatRequestTurn

```typescript
class ChatRequestTurn {
  readonly prompt: string; // User's input
  readonly command: string | undefined;
  readonly references: ChatPromptReference[];
  readonly participant: string;
  readonly toolReferences: ChatLanguageModelToolReference[];
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
    | ChatToolInvocationPart // Proposed API
  >;
  readonly result: ChatResult;
  readonly participant: string;
}
```

### Key Behaviors

1. **No automatic truncation**: VS Code passes ALL history to your participant
2. **Participant filtering**: If your participant doesn't have `canAccessPreviousChatHistory: true`, you only see requests directed to you
3. **Includes tool invocations**: With proposed API, `ChatResponseTurn2` includes `ChatToolInvocationPart` for tool call details

---

## 3. Detecting Context Limit Approach

### Token Counting API

```typescript
interface LanguageModelChat {
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;

  countTokens(
    text: string | LanguageModelChatMessage,
    token?: CancellationToken
  ): Thenable<number>;
}
```

### Limitations

- **Single message counting only**: `countTokens()` accepts a string or single `LanguageModelChatMessage`, NOT an array
- **Manual aggregation required**: You must count each message and sum the totals
- **No array overload**: Cannot count entire conversation at once

### Implementation Pattern

```typescript
async function countConversationTokens(
  model: vscode.LanguageModelChat,
  messages: vscode.LanguageModelChatMessage[],
  token: vscode.CancellationToken
): Promise<number> {
  let totalTokens = 0;

  for (const message of messages) {
    const count = await model.countTokens(message, token);
    totalTokens += count;
  }

  return totalTokens;
}

async function isApproachingLimit(
  model: vscode.LanguageModelChat,
  messages: vscode.LanguageModelChatMessage[],
  reserveForOutput: number = 4000
): Promise<boolean> {
  const used = await countConversationTokens(model, messages);
  const available = model.maxInputTokens - reserveForOutput;
  return used > available * 0.8; // 80% threshold
}
```

---

## 4. How Copilot Chat Handles Long Conversations

The official Copilot Chat extension (`microsoft/vscode-copilot-chat`) implements comprehensive context management:

### Summarization Strategy

1. **Threshold-based triggering**: Summarizes when agent conversation history exceeds context window
2. **LLM-powered summarization**: Uses `ConversationHistorySummarizationPrompt` to create condensed summaries
3. **Priority preservation**: Keeps recent agent commands and tool executions that triggered summarization
4. **Fallback mechanism**: `SimpleSummarizedHistory` for when main summarization fails

### Key Classes

| Class                                    | Purpose                                                         |
| ---------------------------------------- | --------------------------------------------------------------- |
| `ChatSummarizerProvider`                 | Implements `vscode.ChatSummarizer` interface                    |
| `ConversationHistorySummarizationPrompt` | Prompt template for LLM summarization                           |
| `SimpleSummarizedHistory`                | Text-based fallback (omits attachments, truncates tool results) |

### Configuration Settings

```json
{
  "github.copilot.chat.summarizeAgentConversationHistoryThreshold": "...",
  "github.copilot.chat.agentHistorySummarizationMode": "...",
  "github.copilot.chat.agentHistorySummarizationWithPromptCache": true,
  "github.copilot.chat.useResponsesApiTruncation": true
}
```

### Truncation Strategies

1. **Terminal output**: Limited to 60,000 characters via `sanitizeTerminalOutput()`
2. **Tool results**: Truncated with `[Tool response was too long and was truncated.]` message
3. **General prompts**: `truncatePrompt()` keeps user prompt, truncates context (max ~30,000 chars)
4. **Web page content**: Smart exclusion of less relevant sections

---

## 5. ChatSummarizer Proposed API

### Interface (Requires `defaultChatParticipant` proposal)

```typescript
interface ChatSummarizer {
  provideChatSummary(
    context: ChatContext,
    token: CancellationToken
  ): ProviderResult<string>;
}
```

### Registration

```typescript
// On your ChatParticipant
participant.summarizer = {
  provideChatSummary(context, token) {
    // Called by VS Code when summarization is needed
    const history = context.history;
    return generateSummary(history);
  },
};
```

### How It's Called

1. VS Code calls `$provideChatSummary` on the extension host
2. `ExtHostChatAgent.provideSummary()` invokes your summarizer
3. History is pre-converted from `IChatAgentHistoryEntryDto` to `ChatRequestTurn`/`ChatResponseTurn`

**Note:** This is a **proposed API** and may not be available to third-party extensions.

---

## 6. Best Practices for Context Management

### Strategy 1: Token Budget Tracking

```typescript
class ConversationManager {
  private readonly TOKEN_BUDGET = 0.8; // Use 80% of max
  private readonly OUTPUT_RESERVE = 4000;

  async prepareMessages(
    request: vscode.ChatRequest,
    context: vscode.ChatContext
  ): Promise<vscode.LanguageModelChatMessage[]> {
    const model = request.model;
    const maxTokens = model.maxInputTokens - this.OUTPUT_RESERVE;
    const targetTokens = maxTokens * this.TOKEN_BUDGET;

    const messages: vscode.LanguageModelChatMessage[] = [];
    let tokenCount = 0;

    // Always include system prompt
    const systemPrompt = this.getSystemPrompt();
    tokenCount += await model.countTokens(systemPrompt);
    messages.push(systemPrompt);

    // Add history in reverse order until budget exhausted
    const historyMessages = this.convertHistory(context.history);
    for (let i = historyMessages.length - 1; i >= 0; i--) {
      const msgTokens = await model.countTokens(historyMessages[i]);
      if (tokenCount + msgTokens > targetTokens) {
        // Need to summarize or truncate
        break;
      }
      tokenCount += msgTokens;
      messages.unshift(historyMessages[i]); // Add to front
    }

    // Add current request
    messages.push(vscode.LanguageModelChatMessage.User(request.prompt));

    return messages;
  }
}
```

### Strategy 2: Sliding Window with Summarization

```typescript
class SlidingWindowManager {
  private readonly MAX_TURNS = 20;
  private summary: string | null = null;

  async prepareContext(
    context: vscode.ChatContext,
    model: vscode.LanguageModelChat
  ): Promise<vscode.LanguageModelChatMessage[]> {
    const messages: vscode.LanguageModelChatMessage[] = [];

    if (context.history.length > this.MAX_TURNS) {
      // Summarize older turns
      const oldTurns = context.history.slice(0, -this.MAX_TURNS);
      this.summary = await this.summarizeTurns(oldTurns, model);
    }

    // Include summary if exists
    if (this.summary) {
      messages.push(
        vscode.LanguageModelChatMessage.User(
          `Previous conversation summary: ${this.summary}`
        )
      );
    }

    // Include recent turns
    const recentTurns = context.history.slice(-this.MAX_TURNS);
    messages.push(...this.convertToMessages(recentTurns));

    return messages;
  }

  private async summarizeTurns(
    turns: ReadonlyArray<ChatRequestTurn | ChatResponseTurn>,
    model: vscode.LanguageModelChat
  ): Promise<string> {
    const summaryPrompt = [
      vscode.LanguageModelChatMessage.System(
        "Summarize this conversation concisely, preserving key decisions and context:"
      ),
      vscode.LanguageModelChatMessage.User(
        this.convertToMessages(turns)
          .map((m) => m.content)
          .join("\n---\n")
      ),
    ];

    const response = await model.sendRequest(summaryPrompt);
    let summary = "";
    for await (const chunk of response.text) {
      summary += chunk;
    }
    return summary;
  }
}
```

### Strategy 3: Aggressive Tool Result Truncation

```typescript
function truncateToolResult(result: string, maxTokens: number = 2000): string {
  const TRUNCATION_MSG = "\n\n[... output truncated for context limits ...]";

  // Simple character-based approximation (4 chars ≈ 1 token)
  const maxChars = maxTokens * 4;

  if (result.length <= maxChars) {
    return result;
  }

  // Keep head and tail
  const headSize = Math.floor(maxChars * 0.3);
  const tailSize = Math.floor(maxChars * 0.6);

  return result.slice(0, headSize) + TRUNCATION_MSG + result.slice(-tailSize);
}
```

---

## 7. Summary Table

| Question                                                   | Answer                                              |
| ---------------------------------------------------------- | --------------------------------------------------- |
| Does VS Code truncate `ChatContext.history` automatically? | **No**                                              |
| Can extensions detect context limit?                       | **Yes**, via `maxInputTokens` and `countTokens()`   |
| Does `countTokens()` accept message arrays?                | **No**, only single messages                        |
| Is summarization built-in?                                 | **No**, extensions must implement it                |
| Is there a summarization API?                              | **Yes**, but it's a proposed API (`ChatSummarizer`) |
| Who is responsible for context management?                 | **The extension**                                   |
| Does Copilot Chat summarize automatically?                 | **Yes**, for agent mode conversations               |

---

## 8. Recommendations for Lupa

Given that Lupa uses `ToolCallingAnalysisProvider` for multi-turn analysis:

1. **Track token usage** per conversation turn
2. **Implement aggressive tool result truncation** (especially for file contents, diffs)
3. **Consider conversation summarization** when history exceeds ~50% of context
4. **Reserve tokens for output** (4000+ for detailed analysis)
5. **Prioritize recent context** - older analysis results can be summarized

### Not Needed (Given Deprecation Plan)

Per the project's copilot-instructions, the embedding-based context system is being deprecated. Context management should focus on:

- Tool result size management
- Conversation history summarization
- Token budget enforcement in `ToolCallingAnalysisProvider`

---

## References

- DeepWiki: microsoft/vscode Chat System Architecture
- DeepWiki: microsoft/vscode-copilot-chat Summarization
- VS Code API: `src/vscode-dts/vscode.proposed.defaultChatParticipant.d.ts`
- VS Code API: `src/vs/workbench/api/common/extHostLanguageModels.ts`
- VS Code API: `src/vs/workbench/api/common/extHostChatAgents2.ts`
