import * as vscode from 'vscode';
import { Log } from '../services/loggingService';
import { TokenConstants } from './tokenConstants';
import { ToolCallRequest, ToolCallResponse } from '../types/modelTypes';
import { WorkspaceSettingsService } from '../services/workspaceSettingsService';
import type { ILLMClient } from './ILLMClient';
import { ModelRequestHandler } from './modelRequestHandler';

export class CopilotApiError extends Error {
    constructor(message: string, public readonly code: string) {
        super(message);
        this.name = 'CopilotApiError';
    }
}

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
    version?: string;
}

/**
 * Service for managing language models through VS Code's API
 */
export class CopilotModelManager implements vscode.Disposable, ILLMClient {
    private readonly DEFAULT_MODEL_ID = 'gpt-4.1';
    private currentModel: vscode.LanguageModelChat | null = null;
    private modelCache: ModelDetail[] | null = null;
    private lastModelRefresh: number = 0;
    private readonly cacheLifetimeMs = TokenConstants.DEFAULT_CACHE_LIFETIME_MS;

    constructor(
        private readonly settings: WorkspaceSettingsService
    ) {
        // Watch for model changes
        vscode.lm.onDidChangeChatModels(() => {
            // Clear cache when available models change
            this.modelCache = null;
        });
    }

    private get requestTimeoutMs(): number {
        return this.settings.getRequestTimeoutSeconds() * 1000;
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
            // Check if we should load model preferences from settings
            if (!options) {
                const savedVersion = this.settings.getPreferredModelVersion();

                if (savedVersion) {
                    options = {
                        version: savedVersion
                    };
                }
            }

            const selector: vscode.LanguageModelChatSelector = {
                vendor: 'copilot',
                ...options
            };

            if (!options) {
                selector.id = this.DEFAULT_MODEL_ID;
            }

            const models = await vscode.lm.selectChatModels(selector);

            if (models.length === 0) {
                Log.info(`Model ${options?.version || 'any'} not available, using fallback`);
                return this.selectFallbackModel();
            }

            const model = models[0]!;
            this.currentModel = model;

            if (options?.version) {
                this.settings.setPreferredModelVersion(options.version);
            }

            return model;
        } catch (err) {
            Log.error(`Failed to select model ${options?.version || ''}:`, err);
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

            const model = models[0]!;
            this.currentModel = model;
            return model;
        } catch (err) {
            Log.error('Failed to select any model:', err);
            throw new Error('No language models available');
        }
    }

    /**
     * Send a request to the language model with tool-calling support.
     *
     * Delegates to ModelRequestHandler for message conversion and request execution.
     * Preserves error handling for CopilotApiError (model_not_supported) detection.
     */
    async sendRequest(request: ToolCallRequest, token: vscode.CancellationToken): Promise<ToolCallResponse> {
        try {
            const model = await this.getCurrentModel();
            return await ModelRequestHandler.sendRequest(
                model,
                request,
                token,
                this.requestTimeoutMs
            );
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            const codeMatch = msg.match(/"code"\s*:\s*"([^"]+)"/);
            if (codeMatch) {
                const code = codeMatch[1];
                if (code === 'model_not_supported') {
                    const modelName = this.currentModel?.name || this.currentModel?.id || 'selected model';
                    const friendlyMessage = `The selected Copilot model ${modelName} is not supported. Please choose another Copilot model in Lupa settings.`;
                    Log.error(`Copilot model not supported: ${modelName}. API response: ${msg.replace(/\\"/g, '"').replace(/\n/g, '')}`);
                    throw new CopilotApiError(friendlyMessage, code);
                }
            }
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