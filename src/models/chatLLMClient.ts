import * as vscode from 'vscode';
import type { ToolCallRequest, ToolCallResponse } from '../types/modelTypes';
import { ILLMClient } from './ILLMClient';
import { ModelRequestHandler } from './modelRequestHandler';

/**
 * ILLMClient implementation that wraps a VS Code LanguageModelChat.
 * Used by the chat participant path (@lupa) where the model is provided
 * via the ChatRequest rather than selected via CopilotModelManager.
 *
 * Delegates message conversion and request handling to ModelRequestHandler
 * for DRY compliance with CopilotModelManager.
 *
 * @see ILLMClient for interface contract
 * @see ModelRequestHandler for shared request logic
 */
export class ChatLLMClient implements ILLMClient {
    /**
     * @param model - The VS Code language model from ChatRequest
     * @param timeoutMs - Request timeout in milliseconds (from WorkspaceSettingsService)
     */
    constructor(
        private readonly model: vscode.LanguageModelChat,
        private readonly timeoutMs: number
    ) {}

    /**
     * Send a request to the language model with tool-calling support.
     * Delegates to ModelRequestHandler.sendRequest for consistent behavior.
     */
    async sendRequest(
        request: ToolCallRequest,
        token: vscode.CancellationToken
    ): Promise<ToolCallResponse> {
        return ModelRequestHandler.sendRequest(
            this.model,
            request,
            token,
            this.timeoutMs
        );
    }

    /**
     * Get the wrapped language model.
     * Required for token counting operations in ConversationRunner.
     */
    async getCurrentModel(): Promise<vscode.LanguageModelChat> {
        return this.model;
    }
}
