import { Message } from "../types/conversationTypes";

/**
 * Manager for conversation history, including user, assistant, and tool messages.
 * Maintains the conversation flow and provides access to message history.
 */
export class ConversationManager {
  private messages: Message[] = [];

  /**
   * Deep clone a message to ensure immutability
   * @param message The message to clone
   * @returns Deep copy of the message
   */
  private deepCloneMessage(message: Message): Message {
    return {
      role: message.role,
      content: message.content,
      toolCalls: message.toolCalls ? JSON.parse(JSON.stringify(message.toolCalls)) : undefined,
      toolCallId: message.toolCallId
    };
  }

  /**
   * Add a message to the conversation history.
   * @param message The message to add to the conversation
   */
  addMessage(message: Message): void {
    this.messages.push(this.deepCloneMessage(message));
  }

  /**
   * Get the complete conversation history.
   * @returns Array of all messages in the conversation
   */
  getHistory(): Message[] {
    return this.messages.map(message => this.deepCloneMessage(message));
  }

  /**
   * Get the most recent message from the conversation.
   * @returns The last message or undefined if no messages exist
   */
  getLastMessage(): Message | undefined {
    return this.messages.length > 0 ? this.deepCloneMessage(this.messages[this.messages.length - 1]) : undefined;
  }

  /**
   * Get messages by role (user, assistant, or tool).
   * @param role The role to filter by
   * @returns Array of messages matching the specified role
   */
  getMessagesByRole(role: Message["role"]): Message[] {
    return this.messages.filter(message => message.role === role).map(message => this.deepCloneMessage(message));
  }

  /**
   * Get the number of messages in the conversation.
   * @returns The total number of messages
   */
  getMessageCount(): number {
    return this.messages.length;
  }

  /**
   * Clear all messages from the conversation history.
   */
  clearHistory(): void {
    this.messages = [];
  }

  /**
   * Prepends history messages at the beginning of the conversation.
   * Used to inject prior conversation context before the current user message.
   * @param messages Array of history messages to prepend
   */
  prependHistoryMessages(messages: Message[]): void {
    const clonedMessages = messages.map(m => this.deepCloneMessage(m));
    this.messages = [...clonedMessages, ...this.messages];
  }

  /**
   * Add a user message to the conversation.
   * @param content The user's message content
   */
  addUserMessage(content: string): void {
    this.addMessage({
      role: "user",
      content,
    });
  }

  /**
   * Add an assistant message to the conversation.
   * @param content The assistant's message content
   * @param toolCalls Optional tool calls made by the assistant
   */
  addAssistantMessage(content: string | null, toolCalls?: any[]): void {
    this.addMessage({
      role: "assistant",
      content,
      toolCalls,
    });
  }

  /**
   * Add a tool response message to the conversation.
   * @param toolCallId The ID of the tool call this is responding to
   * @param content The tool's response content
   */
  addToolMessage(toolCallId: string, content: string): void {
    this.addMessage({
      role: "tool",
      content,
      toolCallId,
    });
  }

  /**
   * Check if the conversation has any messages.
   * @returns True if there are messages, false if empty
   */
  hasMessages(): boolean {
    return this.messages.length > 0;
  }

  /**
   * Get a slice of the conversation history.
   * @param start Starting index (inclusive)
   * @param end Ending index (exclusive). If not provided, goes to the end
   * @returns Array of messages in the specified range
   */
  getMessageSlice(start: number, end?: number): Message[] {
    return this.messages.slice(start, end).map(message => this.deepCloneMessage(message));
  }

  dispose(): void {
    // No resources to dispose of currently
    this.clearHistory();
  }
}