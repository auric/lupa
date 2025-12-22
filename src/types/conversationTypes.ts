import * as z from 'zod';
import type { MessageRole } from './modelTypes';

type ConversationRole = Exclude<MessageRole, 'system'>;

export const messageSchema = z.object({
  role: z.enum(['user', 'assistant', 'tool'] satisfies ConversationRole[]),
  content: z.string().nullable(),
  toolCalls: z.array(z.any()).optional(),
  toolCallId: z.string().optional(),
});

export type Message = z.infer<typeof messageSchema>;
