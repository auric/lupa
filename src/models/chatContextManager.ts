import * as vscode from 'vscode';
import { Message } from '../types/conversationTypes';
import { Log } from '../services/loggingService';

/** Reserve tokens for model output to prevent context overflow */
const OUTPUT_RESERVE = 4000;

/** Target percentage of available budget for input tokens */
const BUDGET_THRESHOLD = 0.8;

/**
 * Manages conversation history extraction and token budget for chat participant.
 * Implements sliding window truncation to ensure context fits within model limits.
 */
export class ChatContextManager {
    /**
     * Prepares conversation history for injection into ConversationManager.
     * Processes history newest-first, respecting token budget with sliding window truncation.
     *
     * @param history VS Code chat history from ChatContext
     * @param model Language model for token counting and budget calculation
     * @param systemPrompt System prompt to reserve tokens for
     * @param token Cancellation token for async operations
     * @returns Array of Message objects compatible with ConversationManager
     */
    async prepareConversationHistory(
        history: ReadonlyArray<vscode.ChatRequestTurn | vscode.ChatResponseTurn>,
        model: vscode.LanguageModelChat,
        systemPrompt: string,
        token: vscode.CancellationToken
    ): Promise<Message[]> {
        if (!history.length) {
            return [];
        }

        try {
            const maxTokens = model.maxInputTokens - OUTPUT_RESERVE;
            const targetTokens = maxTokens * BUDGET_THRESHOLD;

            const systemTokens = await model.countTokens(systemPrompt, token);
            let availableTokens = targetTokens - systemTokens;

            if (availableTokens <= 0) {
                Log.warn('[ChatContextManager]: No budget available after system prompt');
                return [];
            }

            const prepared: Message[] = [];

            for (let i = history.length - 1; i >= 0 && availableTokens > 0; i--) {
                if (token.isCancellationRequested) {
                    break;
                }

                const turn = history[i];
                if (!turn) {continue;}
                const message = this.convertTurn(turn);

                if (!message.content) {
                    continue;
                }

                const tokenCount = await model.countTokens(message.content, token);

                if (tokenCount > availableTokens) {
                    Log.info(`[ChatContextManager]: Truncating history at turn ${i} (budget: ${Math.floor(availableTokens)}, needed: ${tokenCount})`);
                    break;
                }

                prepared.unshift(message);
                availableTokens -= tokenCount;
            }

            if (prepared.length < history.length) {
                Log.info(`[ChatContextManager]: Included ${prepared.length} of ${history.length} history turns`);
            }

            return prepared;
        } catch (error) {
            Log.warn('[ChatContextManager]: History processing failed, continuing without history', error);
            return [];
        }
    }

    /**
     * Converts a VS Code chat turn to internal Message format.
     */
    private convertTurn(turn: vscode.ChatRequestTurn | vscode.ChatResponseTurn): Message {
        if (this.isRequestTurn(turn)) {
            return this.extractFromRequestTurn(turn);
        }
        return this.extractFromResponseTurn(turn);
    }

    /**
     * Type guard to determine if turn is a ChatRequestTurn.
     */
    private isRequestTurn(turn: vscode.ChatRequestTurn | vscode.ChatResponseTurn): turn is vscode.ChatRequestTurn {
        return 'prompt' in turn;
    }

    /**
     * Extracts user message from ChatRequestTurn.
     */
    private extractFromRequestTurn(turn: vscode.ChatRequestTurn): Message {
        return {
            role: 'user',
            content: turn.prompt
        };
    }

    /**
     * Extracts assistant message from ChatResponseTurn.
     * Concatenates text from markdown parts, skipping non-text parts.
     */
    private extractFromResponseTurn(turn: vscode.ChatResponseTurn): Message {
        const textParts: string[] = [];

        for (const part of turn.response) {
            const text = this.extractTextFromPart(part);
            if (text) {
                textParts.push(text);
            }
        }

        return {
            role: 'assistant',
            content: textParts.join('\n\n') || null
        };
    }

    /**
     * Extracts text content from a response part.
     * Only processes markdown parts, skipping fileTree, anchor, commandButton, etc.
     */
    private extractTextFromPart(part: vscode.ChatResponsePart): string | null {
        if (part instanceof vscode.ChatResponseMarkdownPart) {
            return part.value.value;
        }
        return null;
    }
}
