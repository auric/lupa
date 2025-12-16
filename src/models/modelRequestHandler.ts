import * as vscode from 'vscode';
import type { ToolCallRequest, ToolCallResponse, ToolCall, ToolCallMessage } from '../types/modelTypes';

/**
 * Static utility class for handling language model requests.
 *
 * Extracts common message conversion and request handling logic that is shared
 * between CopilotModelManager and ChatLLMClient. This ensures DRY compliance
 * and consistent behavior across all analysis paths.
 *
 * Note: This is a pure utility class with no logging. Logging responsibility
 * remains with the calling services (CopilotModelManager, ChatLLMClient).
 */
export class ModelRequestHandler {
    /**
     * Convert ToolCallMessage array to VS Code LanguageModelChatMessage array.
     *
     * Handles the VS Code API quirk where system messages must be sent as
     * Assistant messages, not a dedicated system call.
     *
     * @param messages - Array of ToolCallMessage to convert
     * @returns Array of VS Code LanguageModelChatMessage
     */
    static convertMessages(messages: ToolCallMessage[]): vscode.LanguageModelChatMessage[] {
        const result: vscode.LanguageModelChatMessage[] = [];

        for (const msg of messages) {
            if (msg.role === 'system' && msg.content) {
                // VS Code API quirk: system messages are sent as Assistant messages
                result.push(vscode.LanguageModelChatMessage.Assistant(msg.content));
            } else if (msg.role === 'user' && msg.content) {
                result.push(vscode.LanguageModelChatMessage.User(msg.content));
            } else if (msg.role === 'assistant') {
                const content: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [];

                // Add text content if present
                if (msg.content) {
                    content.push(new vscode.LanguageModelTextPart(msg.content));
                }

                // Add tool calls if present
                if (msg.toolCalls) {
                    for (const toolCall of msg.toolCalls) {
                        const input = JSON.parse(toolCall.function.arguments);
                        content.push(new vscode.LanguageModelToolCallPart(
                            toolCall.id,
                            toolCall.function.name,
                            input
                        ));
                    }
                }

                result.push(vscode.LanguageModelChatMessage.Assistant(content));
            } else if (msg.role === 'tool') {
                // Tool responses become user messages with LanguageModelToolResultPart
                const toolResultContent = [new vscode.LanguageModelTextPart(msg.content || '')];
                const toolResult = new vscode.LanguageModelToolResultPart(msg.toolCallId || '', toolResultContent);
                result.push(vscode.LanguageModelChatMessage.User([toolResult]));
            }
        }

        return result;
    }

    /**
     * Wraps a thenable/promise with a timeout.
     *
     * If the thenable doesn't resolve within the timeout period, it rejects
     * with a timeout error. The timeout is properly cleaned up when:
     * - The request completes (success or failure)
     * - The cancellation token fires
     *
     * @param thenable - The thenable to wrap
     * @param timeoutMs - The timeout duration in milliseconds
     * @param token - The cancellation token
     * @returns The result of the thenable if it completes in time
     */
    static async withTimeout<T>(
        thenable: Thenable<T>,
        timeoutMs: number,
        token: vscode.CancellationToken
    ): Promise<T> {
        let timeoutId: ReturnType<typeof setTimeout> | undefined;

        const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
                reject(new Error(
                    `LLM request timed out after ${timeoutMs / 1000} seconds. ` +
                    `The model may be overloaded. Please try again.`
                ));
            }, timeoutMs);
        });

        const cleanup = () => {
            if (timeoutId !== undefined) {
                clearTimeout(timeoutId);
            }
        };

        token.onCancellationRequested(cleanup);

        try {
            const result = await Promise.race([Promise.resolve(thenable), timeoutPromise]);
            cleanup();
            return result;
        } catch (error) {
            cleanup();
            throw error;
        }
    }

    /**
     * Send a request to the language model with tool-calling support.
     *
     * This method handles:
     * - Message conversion to VS Code format
     * - Request execution with timeout
     * - Response stream parsing for text and tool calls
     *
     * @param model - The language model to send the request to
     * @param request - The request containing messages and optional tools
     * @param token - Cancellation token for request cancellation
     * @param timeoutMs - Timeout in milliseconds for the request
     * @returns Promise resolving to the model's response with optional tool calls
     */
    static async sendRequest(
        model: vscode.LanguageModelChat,
        request: ToolCallRequest,
        token: vscode.CancellationToken,
        timeoutMs: number
    ): Promise<ToolCallResponse> {
        // Convert messages to VS Code format
        const messages = ModelRequestHandler.convertMessages(request.messages);

        // Create request options with tools if provided
        const options: vscode.LanguageModelChatRequestOptions = {
            tools: request.tools || []
        };

        // Send the request with timeout
        const response = await ModelRequestHandler.withTimeout(
            model.sendRequest(messages, options, token),
            timeoutMs,
            token
        );

        // Parse the response stream for both text and tool calls
        let responseText = '';
        const toolCalls: ToolCall[] = [];

        for await (const chunk of response.stream) {
            if (chunk instanceof vscode.LanguageModelTextPart) {
                responseText += chunk.value;
            } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
                // Parse tool call from response
                toolCalls.push({
                    id: chunk.callId,
                    function: {
                        name: chunk.name,
                        arguments: JSON.stringify(chunk.input)
                    }
                });
            }
        }

        return {
            content: responseText || null,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined
        };
    }
}
