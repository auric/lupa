import { describe, it, expect, beforeEach } from 'vitest';
import { ConversationManager } from '../models/conversationManager';
import { Message } from '../types/conversationTypes';

describe('ConversationManager', () => {
  let conversationManager: ConversationManager;

  beforeEach(() => {
    conversationManager = new ConversationManager();
  });

  describe('Message Management', () => {
    it('should start with empty history', () => {
      expect(conversationManager.getHistory()).toHaveLength(0);
      expect(conversationManager.getMessageCount()).toBe(0);
      expect(conversationManager.hasMessages()).toBe(false);
    });

    it('should add messages to history', () => {
      const message: Message = {
        role: 'user',
        content: 'Hello'
      };

      conversationManager.addMessage(message);

      expect(conversationManager.getHistory()).toHaveLength(1);
      expect(conversationManager.getMessageCount()).toBe(1);
      expect(conversationManager.hasMessages()).toBe(true);
    });

    it('should maintain message order', () => {
      const messages: Message[] = [
        { role: 'user', content: 'First message' },
        { role: 'assistant', content: 'Second message' },
        { role: 'user', content: 'Third message' }
      ];

      messages.forEach(msg => conversationManager.addMessage(msg));

      const history = conversationManager.getHistory();
      expect(history).toHaveLength(3);
      expect(history[0].content).toBe('First message');
      expect(history[1].content).toBe('Second message');
      expect(history[2].content).toBe('Third message');
    });

    it('should return deep copies of messages to prevent mutation', () => {
      const originalMessage: Message = {
        role: 'user',
        content: 'Original content'
      };

      conversationManager.addMessage(originalMessage);
      const retrievedHistory = conversationManager.getHistory();

      // Modify the retrieved message
      retrievedHistory[0].content = 'Modified content';

      // Original stored message should remain unchanged
      const freshHistory = conversationManager.getHistory();
      expect(freshHistory[0].content).toBe('Original content');
    });
  });

  describe('Specialized Message Addition', () => {
    it('should add user messages', () => {
      conversationManager.addUserMessage('User message content');

      const history = conversationManager.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].role).toBe('user');
      expect(history[0].content).toBe('User message content');
    });

    it('should add assistant messages without tool calls', () => {
      conversationManager.addAssistantMessage('Assistant response');

      const history = conversationManager.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].role).toBe('assistant');
      expect(history[0].content).toBe('Assistant response');
      expect(history[0].toolCalls).toBeUndefined();
    });

    it('should add assistant messages with tool calls', () => {
      const toolCalls = [{ id: 'call_1', function: { name: 'test_tool', arguments: '{}' } }];
      conversationManager.addAssistantMessage('Assistant with tools', toolCalls);

      const history = conversationManager.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].role).toBe('assistant');
      expect(history[0].content).toBe('Assistant with tools');
      expect(history[0].toolCalls).toEqual(toolCalls);
    });

    it('should add tool messages', () => {
      conversationManager.addToolMessage('call_123', 'Tool response content');

      const history = conversationManager.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].role).toBe('tool');
      expect(history[0].content).toBe('Tool response content');
      expect(history[0].toolCallId).toBe('call_123');
    });

    it('should handle null content in assistant messages', () => {
      conversationManager.addAssistantMessage(null);

      const history = conversationManager.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].role).toBe('assistant');
      expect(history[0].content).toBeNull();
    });
  });

  describe('Message Retrieval', () => {
    beforeEach(() => {
      // Set up a conversation with mixed message types
      conversationManager.addUserMessage('User question');
      conversationManager.addAssistantMessage('Assistant response', [{ id: 'call_1', function: { name: 'tool', arguments: '{}' } }]);
      conversationManager.addToolMessage('call_1', 'Tool result');
      conversationManager.addAssistantMessage('Final response');
    });

    it('should get last message', () => {
      const lastMessage = conversationManager.getLastMessage();
      expect(lastMessage?.role).toBe('assistant');
      expect(lastMessage?.content).toBe('Final response');
    });

    it('should return undefined for last message when empty', () => {
      const emptyManager = new ConversationManager();
      expect(emptyManager.getLastMessage()).toBeUndefined();
    });

    it('should filter messages by role', () => {
      const userMessages = conversationManager.getMessagesByRole('user');
      const assistantMessages = conversationManager.getMessagesByRole('assistant');
      const toolMessages = conversationManager.getMessagesByRole('tool');

      expect(userMessages).toHaveLength(1);
      expect(userMessages[0].content).toBe('User question');

      expect(assistantMessages).toHaveLength(2);
      expect(assistantMessages[0].content).toBe('Assistant response');
      expect(assistantMessages[1].content).toBe('Final response');

      expect(toolMessages).toHaveLength(1);
      expect(toolMessages[0].content).toBe('Tool result');
    });

    it('should get message slices', () => {
      // Get first 2 messages
      const firstTwo = conversationManager.getMessageSlice(0, 2);
      expect(firstTwo).toHaveLength(2);
      expect(firstTwo[0].role).toBe('user');
      expect(firstTwo[1].role).toBe('assistant');

      // Get last 2 messages
      const lastTwo = conversationManager.getMessageSlice(-2);
      expect(lastTwo).toHaveLength(2);
      expect(lastTwo[0].role).toBe('tool');
      expect(lastTwo[1].role).toBe('assistant');

      // Get middle messages
      const middle = conversationManager.getMessageSlice(1, 3);
      expect(middle).toHaveLength(2);
      expect(middle[0].role).toBe('assistant');
      expect(middle[1].role).toBe('tool');
    });

    it('should return deep copies in message slices', () => {
      const slice = conversationManager.getMessageSlice(0, 1);
      slice[0].content = 'Modified';

      const originalHistory = conversationManager.getHistory();
      expect(originalHistory[0].content).toBe('User question');
    });
  });

  describe('History Management', () => {
    beforeEach(() => {
      conversationManager.addUserMessage('Message 1');
      conversationManager.addUserMessage('Message 2');
      conversationManager.addUserMessage('Message 3');
    });

    it('should clear history', () => {
      expect(conversationManager.getMessageCount()).toBe(3);

      conversationManager.clearHistory();

      expect(conversationManager.getMessageCount()).toBe(0);
      expect(conversationManager.getHistory()).toEqual([]);
      expect(conversationManager.hasMessages()).toBe(false);
      expect(conversationManager.getLastMessage()).toBeUndefined();
    });

    it('should maintain accurate message count', () => {
      expect(conversationManager.getMessageCount()).toBe(3);

      conversationManager.addUserMessage('Message 4');
      expect(conversationManager.getMessageCount()).toBe(4);

      conversationManager.clearHistory();
      expect(conversationManager.getMessageCount()).toBe(0);
    });

    it('should prepend history messages at the beginning', () => {
      conversationManager.clearHistory();
      conversationManager.addUserMessage('Current message');

      const historyMessages: Message[] = [
        { role: 'user', content: 'Old question' },
        { role: 'assistant', content: 'Old answer' }
      ];

      conversationManager.prependHistoryMessages(historyMessages);

      const history = conversationManager.getHistory();
      expect(history).toHaveLength(3);
      expect(history[0].content).toBe('Old question');
      expect(history[1].content).toBe('Old answer');
      expect(history[2].content).toBe('Current message');
    });

    it('should prepend to empty conversation', () => {
      conversationManager.clearHistory();

      const historyMessages: Message[] = [
        { role: 'user', content: 'History 1' },
        { role: 'assistant', content: 'History 2' }
      ];

      conversationManager.prependHistoryMessages(historyMessages);

      expect(conversationManager.getMessageCount()).toBe(2);
      expect(conversationManager.getHistory()[0].content).toBe('History 1');
    });

    it('should handle empty prepend array', () => {
      const initialCount = conversationManager.getMessageCount();
      conversationManager.prependHistoryMessages([]);

      expect(conversationManager.getMessageCount()).toBe(initialCount);
    });

    it('should deep clone prepended messages', () => {
      conversationManager.clearHistory();
      const historyMessages: Message[] = [
        { role: 'user', content: 'Original' }
      ];

      conversationManager.prependHistoryMessages(historyMessages);

      // Modify the original array
      historyMessages[0].content = 'Modified';

      // Internal state should be unchanged
      expect(conversationManager.getHistory()[0].content).toBe('Original');
    });

    it('should preserve order when prepending multiple messages', () => {
      conversationManager.clearHistory();
      conversationManager.addUserMessage('Current');

      const historyMessages: Message[] = [
        { role: 'user', content: 'First' },
        { role: 'assistant', content: 'Second' },
        { role: 'user', content: 'Third' }
      ];

      conversationManager.prependHistoryMessages(historyMessages);

      const history = conversationManager.getHistory();
      expect(history.map(m => m.content)).toEqual(['First', 'Second', 'Third', 'Current']);
    });
  });

  describe('Message Types and Validation', () => {
    it('should handle all valid message roles', () => {
      const messages: Message[] = [
        { role: 'user', content: 'User message' },
        { role: 'assistant', content: 'Assistant message' },
        { role: 'tool', content: 'Tool message', toolCallId: 'call_1' }
      ];

      messages.forEach(msg => conversationManager.addMessage(msg));

      const history = conversationManager.getHistory();
      expect(history).toHaveLength(3);
      expect(history.map(m => m.role)).toEqual(['user', 'assistant', 'tool']);
    });

    it('should handle messages with optional fields', () => {
      const messageWithToolCalls: Message = {
        role: 'assistant',
        content: 'Response',
        toolCalls: [{ id: 'call_1', function: { name: 'test', arguments: '{}' } }]
      };

      const messageWithToolCallId: Message = {
        role: 'tool',
        content: 'Tool response',
        toolCallId: 'call_1'
      };

      conversationManager.addMessage(messageWithToolCalls);
      conversationManager.addMessage(messageWithToolCallId);

      const history = conversationManager.getHistory();
      expect(history[0].toolCalls).toBeDefined();
      expect(history[1].toolCallId).toBe('call_1');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty content', () => {
      conversationManager.addUserMessage('');
      const history = conversationManager.getHistory();
      expect(history[0].content).toBe('');
    });

    it('should handle very long content', () => {
      const longContent = 'a'.repeat(10000);
      conversationManager.addUserMessage(longContent);
      const history = conversationManager.getHistory();
      expect(history[0].content).toBe(longContent);
    });

    it('should handle special characters in content', () => {
      const specialContent = '🚀 Special chars: @#$%^&*(){}[]|\\:";\'<>?,./ 中文 العربية';
      conversationManager.addUserMessage(specialContent);
      const history = conversationManager.getHistory();
      expect(history[0].content).toBe(specialContent);
    });
  });

  describe('Disposal', () => {
    it('should clear history on disposal', () => {
      conversationManager.addUserMessage('Test message');
      expect(conversationManager.hasMessages()).toBe(true);

      conversationManager.dispose();

      expect(conversationManager.hasMessages()).toBe(false);
      expect(conversationManager.getMessageCount()).toBe(0);
    });

    it('should not throw on disposal', () => {
      expect(() => conversationManager.dispose()).not.toThrow();
    });
  });
});