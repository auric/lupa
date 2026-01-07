import * as vscode from 'vscode';
import type {
    ToolCallRequest,
    ToolCallResponse,
    ToolCall,
    ToolCallMessage,
} from '../types/modelTypes';
import { TimeoutError } from '../utils/asyncUtils';
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
     * When a timeout occurs, the underlying request continues in the background.
     * If it later completes, an "[Abandoned]" debug log is emitted for diagnostics.
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
        if (token.isCancellationRequested) {
            throw new vscode.CancellationError();
        }

        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        let cancellationDisposable: vscode.Disposable | undefined;
        let timedOut = false;
        const startTime = Date.now();

        const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
                timedOut = true;
                reject(new TimeoutError('LLM request', timeoutMs));
            }, timeoutMs);
        });

        const cancellationPromise = new Promise<never>((_, reject) => {
            cancellationDisposable = token.onCancellationRequested(() => {
                reject(new vscode.CancellationError());
            });
        });

        // Track when the original thenable completes (even after timeout)
        // to log abandoned operations for diagnostics
        const wrappedThenable = Promise.resolve(thenable);
        wrappedThenable
            .then(() => {
                if (timedOut) {
                    const totalTime = Date.now() - startTime;
                    Log.debug(
                        `[Abandoned] LLM request completed after ${totalTime}ms (was rejected at ${timeoutMs}ms)`
                    );
                }
            })
            .catch(() => {
                if (timedOut) {
                    const totalTime = Date.now() - startTime;
                    Log.debug(
                        `[Abandoned] LLM request failed after ${totalTime}ms (was rejected at ${timeoutMs}ms)`
                    );
                }
            });

        try {
            return await Promise.race([
                wrappedThenable,
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

        const response = await ModelRequestHandler.withTimeout(
            model.sendRequest(messages, options, token),
            timeoutMs,
            token
        );

        let responseText = '';
        const toolCalls: ToolCall[] = [];

        // Stream consumption with max-duration timeout protection.
        // This is intentionally total elapsed time (not inactivity detection),
        // ensuring bounded total analysis time regardless of stream pacing.
        // If the stream stalls or takes too long overall, we throw TimeoutError.
        const streamStartTime = Date.now();
        for await (const chunk of response.stream) {
            // Check for stream consumption timeout (uses same timeout as initial request)
            if (Date.now() - streamStartTime > timeoutMs) {
                throw new TimeoutError('LLM stream consumption', timeoutMs);
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
