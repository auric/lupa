import * as vscode from 'vscode';
import { WorkspaceSettingsService } from '../services/workspaceSettingsService';
import { Log } from '../services/loggingService';
import { TokenConstants } from './tokenConstants';
import { ToolCallRequest, ToolCallResponse, ToolCall } from '../types/modelTypes';

/**
 * Model information
 */
export interface ModelDetail {
    id: string;
    name: string;
    family: string;
    version: string;
    maxInputTokens: number;
}

/**
 * Model selection options
 */
export interface ModelSelectionOptions {
    family?: string;
    version?: string;
}

/**
 * Task compatibility requirements
 */
export interface TaskCompatibility {
    minTokenLimit?: number;
    requiresThinking?: boolean;
}

/**
 * Service for managing language models through VS Code's API
 */
export class CopilotModelManager implements vscode.Disposable {
    private currentModel: vscode.LanguageModelChat | null = null;
    private modelCache: ModelDetail[] | null = null;
    private lastModelRefresh: number = 0;
    private readonly cacheLifetimeMs = TokenConstants.DEFAULT_CACHE_LIFETIME_MS;

    /**
     * Create a new model manager
     */
    constructor(private readonly workspaceSettingsService: WorkspaceSettingsService) {
        // Watch for model changes
        vscode.lm.onDidChangeChatModels(() => {
            // Clear cache when available models change
            this.modelCache = null;
        });
    }

    /**
     * Get all available Copilot models with version information
     */
    async listAvailableModels(): Promise<ModelDetail[]> {
        try {
            // Try to use cached models if they're recent enough
            const now = Date.now();
            if (this.modelCache && (now - this.lastModelRefresh) < this.cacheLifetimeMs) {
                return this.modelCache;
            }

            // Get all Copilot models
            const allModels = await vscode.lm.selectChatModels({
                vendor: 'copilot'
            });

            const modelDetails = allModels.map(model => ({
                id: model.id,
                name: model.name,
                family: model.family,
                version: model.version || 'default',
                maxInputTokens: model.maxInputTokens
            }));

            // Update the cache
            this.modelCache = modelDetails;
            this.lastModelRefresh = now;

            return modelDetails;
        } catch (err) {
            Log.error('Error listing models:', err);
            return [];
        }
    }

    /**
     * Select a specific model by family and version
     */
    async selectModel(options?: ModelSelectionOptions): Promise<vscode.LanguageModelChat> {
        try {
            // Check if we should load model preferences from workspace settings
            if (!options && this.workspaceSettingsService) {
                const savedFamily = this.workspaceSettingsService.getPreferredModelFamily();
                const savedVersion = this.workspaceSettingsService.getPreferredModelVersion();

                if (savedFamily) {
                    options = {
                        family: savedFamily,
                        version: savedVersion
                    };
                }
            }

            const selector: vscode.LanguageModelChatSelector = {
                vendor: 'copilot',
                ...options
            };

            if (!options) {
                selector.id = 'gpt-4.1';
            }

            const models = await vscode.lm.selectChatModels(selector);

            if (models.length === 0) {
                Log.info(`Model ${options?.family || 'any'} ${options?.version || ''} not available, using fallback`);
                return this.selectFallbackModel();
            }

            const [model] = models;
            this.currentModel = model;

            // Save selected model to settings if we're using workspace settings
            if (this.workspaceSettingsService && options?.family) {
                this.workspaceSettingsService.setPreferredModelFamily(options.family);
                if (options.version) {
                    this.workspaceSettingsService.setPreferredModelVersion(options.version);
                }
            }

            return model;
        } catch (err) {
            Log.error(`Failed to select model ${options?.family || 'any'} ${options?.version || ''}:`, err);
            return this.selectFallbackModel();
        }
    }

    /**
     * Get the currently selected model
     * If no model is currently selected, selects a model
     */
    async getCurrentModel(): Promise<vscode.LanguageModelChat> {
        if (this.currentModel) {
            return this.currentModel;
        }

        return this.selectModel();
    }

    /**
     * Select a generic fallback model
     * This method tries to select any available model
     */
    private async selectFallbackModel(): Promise<vscode.LanguageModelChat> {
        try {
            // Try to get any available model
            const models = await vscode.lm.selectChatModels({});

            if (models.length === 0) {
                throw new Error('No language models available');
            }

            this.currentModel = models[0];
            return models[0];
        } catch (err) {
            Log.error('Failed to select any model:', err);
            throw new Error('No language models available');
        }
    }

    /**
     * Show information about available models to the user
     */
    async showModelsInfo(): Promise<void> {
        try {
            const models = await this.listAvailableModels();

            if (models.length === 0) {
                vscode.window.showInformationMessage('No language models are available. Please ensure you have GitHub Copilot installed and authorized.');
                return;
            }

            // Group by family
            const modelsByFamily: Record<string, ModelDetail[]> = {};
            models.forEach(model => {
                const family = model.family;
                if (!modelsByFamily[family]) {
                    modelsByFamily[family] = [];
                }
                modelsByFamily[family].push(model);
            });

            // Create markdown content
            let markdown = '# Available Language Models\n\n';

            for (const family in modelsByFamily) {
                markdown += `## ${family}\n\n`;

                for (const model of modelsByFamily[family]) {
                    markdown += `- **${model.name}** (${model.version})\n`;
                    markdown += `  - Max Tokens: ${model.maxInputTokens}\n`;
                    markdown += `  - ID: ${model.id}\n\n`;
                }
            }

            // Show in a markdown preview
            const panel = vscode.window.createWebviewPanel(
                'modelInfo',
                'Available Language Models',
                vscode.ViewColumn.One,
                {}
            );

            panel.webview.html = `
                <!DOCTYPE html>
                <html lang="en">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Available Language Models</title>
                    <style>
                        body { font-family: var(--vscode-font-family); }
                        .model-family { margin-top: 20px; }
                        .model-item { margin: 10px 0; padding-left: 20px; }
                    </style>
                </head>
                <body>
                    ${this.markdownToHtml(markdown)}
                </body>
                </html>
            `;
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to retrieve model information: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Simple markdown to HTML converter
     */
    private markdownToHtml(markdown: string): string {
        return markdown
            .replace(/^# (.*$)/gm, '<h1>$1</h1>')
            .replace(/^## (.*$)/gm, '<h2 class="model-family">$1</h2>')
            .replace(/^### (.*$)/gm, '<h3>$1</h3>')
            .replace(/^- \*\*(.*)\*\*/gm, '<div class="model-item"><strong>$1</strong></div>')
            .replace(/^  - (.*$)/gm, '<div class="model-detail">$1</div>')
            .replace(/\n/gm, '<br>');
    }

    /**
     * Wraps a thenable/promise with a timeout. If it doesn't resolve within
     * the timeout period, it rejects with a timeout error.
     * The timeout is properly cleaned up when either:
     * - The request completes (success or failure)
     * - The cancellation token fires
     * @param thenable The thenable to wrap
     * @param timeoutMs The timeout duration in milliseconds
     * @param token The cancellation token
     * @returns The result of the thenable if it completes in time
     */
    private async withTimeout<T>(
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
     * Send a request to the language model with tool-calling support
     */
    async sendRequest(request: ToolCallRequest, token: vscode.CancellationToken): Promise<ToolCallResponse> {
        try {
            const model = await this.getCurrentModel();

            // Convert our ToolCallMessage format to vscode.LanguageModelChatMessage format
            const messages: vscode.LanguageModelChatMessage[] = [];

            for (const msg of request.messages) {
                if (msg.role === 'system' && msg.content) {
                    messages.push(vscode.LanguageModelChatMessage.Assistant(msg.content));
                } else if (msg.role === 'user' && msg.content) {
                    messages.push(vscode.LanguageModelChatMessage.User(msg.content));
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

                    messages.push(vscode.LanguageModelChatMessage.Assistant(content));
                } else if (msg.role === 'tool') {
                    // Tool responses become user messages with LanguageModelToolResultPart
                    const toolResultContent = [new vscode.LanguageModelTextPart(msg.content || '')];
                    const toolResult = new vscode.LanguageModelToolResultPart(msg.toolCallId || '', toolResultContent);
                    messages.push(vscode.LanguageModelChatMessage.User([toolResult]));
                }
            }

            // Create request options with tools if provided
            const options: vscode.LanguageModelChatRequestOptions = {
                tools: request.tools || []
            };

            // Send the request with timeout
            const response = await this.withTimeout(
                model.sendRequest(messages, options, token),
                TokenConstants.LLM_REQUEST_TIMEOUT_MS,
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

        } catch (error) {
            Log.error('Error in sendRequest:', error);
            throw error;
        }
    }

    /**
     * Dispose of resources
     */
    public dispose(): void {
        // Clear cached data
        this.modelCache = null;
        this.currentModel = null;
        this.lastModelRefresh = 0;
    }
}