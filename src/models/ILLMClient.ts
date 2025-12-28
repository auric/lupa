import type { CancellationToken, LanguageModelChat } from 'vscode';
import type { ToolCallRequest, ToolCallResponse } from '../types/modelTypes';

/**
 * Interface for Language Model clients.
 *
 * This abstraction enables Dependency Inversion, allowing ConversationRunner
 * to work with any model source:
 * - CopilotModelManager for command palette path
 * - ChatLLMClient for @lupa chat participant path
 *
 * Both implementations delegate message conversion to ModelRequestHandler
 * for DRY compliance.
 */
export interface ILLMClient {
    /**
     * Send a request to the language model with tool-calling support.
     *
     * @param request - The request containing messages and optional tools
     * @param token - Cancellation token for request cancellation
     * @returns Promise resolving to the model's response with optional tool calls
     */
    sendRequest(
        request: ToolCallRequest,
        token: CancellationToken
    ): Promise<ToolCallResponse>;

    /**
     * Get the currently selected language model.
     *
     * Required for token counting operations in ConversationRunner.
     * If no model is selected, implementations should select one.
     *
     * @returns Promise resolving to the current language model
     */
    getCurrentModel(): Promise<LanguageModelChat>;
}
