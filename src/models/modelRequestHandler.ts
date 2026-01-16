import * as vscode from 'vscode';
import type {
    ToolCallRequest,
    ToolCallResponse,
    ToolCall,
    ToolCallMessage,
} from '../types/modelTypes';
import { TimeoutError } from '../types/errorTypes';
import { Log } from '../services/loggingService';

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
    static convertMessages(
        messages: ToolCallMessage[]
    ): vscode.LanguageModelChatMessage[] {
        const result: vscode.LanguageModelChatMessage[] = [];

        for (const msg of messages) {
            if (msg.role === 'system' && msg.content) {
                // VS Code API quirk: system messages are sent as Assistant messages
                result.push(
                    vscode.LanguageModelChatMessage.Assistant(msg.content)
                );
            } else if (msg.role === 'user' && msg.content) {
                result.push(vscode.LanguageModelChatMessage.User(msg.content));
            } else if (msg.role === 'assistant') {
                const content: (
                    | vscode.LanguageModelTextPart
                    | vscode.LanguageModelToolCallPart
                )[] = [];

                if (msg.content) {
                    content.push(new vscode.LanguageModelTextPart(msg.content));
                }

                if (msg.toolCalls) {
                    for (const toolCall of msg.toolCalls) {
                        try {
                            const input = JSON.parse(
                                toolCall.function.arguments
                            );
                            content.push(
                                new vscode.LanguageModelToolCallPart(
                                    toolCall.id,
                                    toolCall.function.name,
                                    input
                                )
                            );
                        } catch {
                            continue;
                        }
                    }
                }

                // Ensure content is not empty (VS Code API requirement)
                if (content.length === 0) {
                    content.push(new vscode.LanguageModelTextPart(''));
                }

                result.push(vscode.LanguageModelChatMessage.Assistant(content));
            } else if (msg.role === 'tool') {
                // Tool responses become user messages with LanguageModelToolResultPart
                const toolResultContent = [
                    new vscode.LanguageModelTextPart(msg.content || ''),
                ];
                const toolResult = new vscode.LanguageModelToolResultPart(
                    msg.toolCallId || '',
                    toolResultContent
                );
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
        // Wrap thenable in a promise FIRST, before any early exit.
        // This ensures we can attach suppression handler before throwing.
        const thenablePromise = Promise.resolve(thenable);
        // Suppress late rejections from underlying thenable after timeout/cancellation wins.
        // Must be attached before any early throw to prevent unhandled rejections.
        thenablePromise.catch(() => {});

        if (token.isCancellationRequested) {
            throw new vscode.CancellationError();
        }

        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        let cancellationDisposable: vscode.Disposable | undefined;

        const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
                reject(TimeoutError.create('LLM request', timeoutMs));
            }, timeoutMs);
        });

        const cancellationPromise = new Promise<never>((_, reject) => {
            cancellationDisposable = token.onCancellationRequested(() => {
                reject(new vscode.CancellationError());
            });
        });
        // Prevent unhandled rejection if token fires after race settles
        cancellationPromise.catch(() => {});

        try {
            return await Promise.race([
                thenablePromise,
                timeoutPromise,
                cancellationPromise,
            ]);
        } finally {
            if (timeoutId !== undefined) {
                clearTimeout(timeoutId);
            }
            if (cancellationDisposable) {
                cancellationDisposable.dispose();
            }
        }
    }

    /**
     * Send a request to the language model with tool-calling support.
     *
     * This method handles:
     * - Message conversion to VS Code format
     * - Request execution with timeout
     * - Response stream parsing for text and tool calls
     * - Active stream cancellation on timeout (prevents resource leaks)
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
        const messages = ModelRequestHandler.convertMessages(request.messages);

        const options: vscode.LanguageModelChatRequestOptions = {
            tools: request.tools || [],
        };

        // Create a linked CancellationTokenSource that cancels when:
        // 1. User cancellation token fires (user action)
        // 2. Timeout expires (we cancel it to stop stream consumption)
        // This ensures the stream consumer loop exits on timeout, preventing resource leaks.
        const linkedTokenSource = new vscode.CancellationTokenSource();
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        let userCancellationDisposable: vscode.Disposable | undefined;

        try {
            // Pre-check cancellation FIRST before any async work
            if (token.isCancellationRequested) {
                linkedTokenSource.cancel();
                throw new vscode.CancellationError();
            }

            // Register user cancellation listener BEFORE starting stream
            // to avoid race where cancellation fires during stream creation
            userCancellationDisposable = token.onCancellationRequested(() => {
                linkedTokenSource.cancel();
            });

            const streamPromise = ModelRequestHandler.sendAndConsumeStream(
                model,
                messages,
                options,
                linkedTokenSource.token
            );
            // Suppress late rejections from stream consumption if timeout/cancellation wins the race.
            // Must be attached before any early throws to prevent unhandled rejections.
            streamPromise.catch(() => {});

            const timeoutPromise = new Promise<never>((_, reject) => {
                timeoutId = setTimeout(() => {
                    Log.warn(
                        `[Timeout] LLM request abandoned after ${timeoutMs}ms - cancelling stream consumption`
                    );
                    linkedTokenSource.cancel();
                    reject(TimeoutError.create('LLM request', timeoutMs));
                }, timeoutMs);
            });

            // Race the stream consumption against timeout
            // When timeout wins, it also cancels the linked token to stop the stream
            return await Promise.race([streamPromise, timeoutPromise]);
        } finally {
            if (timeoutId !== undefined) {
                clearTimeout(timeoutId);
            }
            userCancellationDisposable?.dispose();
            linkedTokenSource.dispose();
        }
    }

    /**
     * Internal method that sends the request and consumes the entire response stream.
     * Separated from sendRequest to allow the entire operation to be wrapped in timeout.
     */
    private static async sendAndConsumeStream(
        model: vscode.LanguageModelChat,
        messages: vscode.LanguageModelChatMessage[],
        options: vscode.LanguageModelChatRequestOptions,
        token: vscode.CancellationToken
    ): Promise<ToolCallResponse> {
        const response = await model.sendRequest(messages, options, token);

        let responseText = '';
        const toolCalls: ToolCall[] = [];

        for await (const chunk of response.stream) {
            // Check cancellation between chunks for responsive cancellation
            // on slow networks where chunks arrive infrequently
            if (token.isCancellationRequested) {
                throw new vscode.CancellationError();
            }

            if (chunk instanceof vscode.LanguageModelTextPart) {
                responseText += chunk.value;
            } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
                toolCalls.push({
                    id: chunk.callId,
                    function: {
                        name: chunk.name,
                        arguments: JSON.stringify(chunk.input),
                    },
                });
            }
        }

        return {
            content: responseText || null,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        };
    }
}
