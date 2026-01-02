import * as vscode from 'vscode';
import { Log } from '../services/loggingService';
import { ToolCallRequest, ToolCallResponse } from '../types/modelTypes';
import { WorkspaceSettingsService } from '../services/workspaceSettingsService';
import type { ILLMClient } from './ILLMClient';
import { ModelRequestHandler } from './modelRequestHandler';

export class CopilotApiError extends Error {
    constructor(
        message: string,
        public readonly code: string
    ) {
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
    vendor: string;
    maxInputTokens: number;
    /** Unique identifier in format 'vendor/id' */
    identifier: string;
}

/**
 * Model selection options
 */
export interface ModelSelectionOptions {
    /** Model identifier in 'vendor/id' format */
    identifier?: string;
}

/**
 * Service for managing language models through VS Code's API
 */
export class CopilotModelManager implements vscode.Disposable, ILLMClient {
    private readonly DEFAULT_MODEL_ID = 'gpt-4.1';
    private readonly DEFAULT_MODEL_IDENTIFIER = `copilot/${this.DEFAULT_MODEL_ID}`;
    private currentModel: vscode.LanguageModelChat | null = null;

    constructor(private readonly settings: WorkspaceSettingsService) {
        // Watch for model changes
        vscode.lm.onDidChangeChatModels(() => {
            // Clear current model when available models change
            this.currentModel = null;
        });
    }

    private get requestTimeoutMs(): number {
        return this.settings.getRequestTimeoutSeconds() * 1000;
    }

    /**
     * Get the effective model identifier (saved preference or default)
     */
    getEffectiveModelIdentifier(): string {
        return (
            this.settings.getPreferredModelIdentifier() ||
            this.DEFAULT_MODEL_IDENTIFIER
        );
    }

    /**
     * Get all available language models with version information
     */
    async listAvailableModels(): Promise<ModelDetail[]> {
        try {
            // Get all available models (not just copilot vendor)
            const allModels = await vscode.lm.selectChatModels({});

            const modelDetails = allModels.map((model) => ({
                id: model.id,
                name: model.name,
                family: model.family,
                version: model.version || 'default',
                vendor: model.vendor,
                maxInputTokens: model.maxInputTokens,
                identifier: `${model.vendor}/${model.id}`,
            }));

            return modelDetails;
        } catch (err) {
            Log.error('Error listing models:', err);
            return [];
        }
    }

    /**
     * Parse a model identifier into vendor and id components.
     * Returns null if the identifier is malformed.
     */
    private parseModelIdentifier(
        identifier: string
    ): { vendor: string; id: string } | null {
        if (!identifier || identifier.trim() === '') {
            return null;
        }

        const slashIndex = identifier.indexOf('/');
        if (slashIndex === -1) {
            // No vendor prefix, assume copilot
            const id = identifier.trim();
            return id ? { vendor: 'copilot', id } : null;
        }

        // Normalize vendor to lowercase for consistent comparison/storage
        const vendor = identifier.substring(0, slashIndex).trim().toLowerCase();
        const id = identifier.substring(slashIndex + 1).trim();

        // Both parts must be non-empty
        if (!vendor || !id) {
            return null;
        }

        return { vendor, id };
    }

    /**
     * Select a specific model by identifier
     */
    async selectModel(
        options?: ModelSelectionOptions
    ): Promise<vscode.LanguageModelChat> {
        try {
            // Check if we should load model preferences from settings
            if (!options) {
                const savedIdentifier =
                    this.settings.getPreferredModelIdentifier();

                if (savedIdentifier) {
                    options = {
                        identifier: savedIdentifier,
                    };
                }
            }

            let selector: vscode.LanguageModelChatSelector = {};

            if (options?.identifier) {
                // Format: vendor/id
                const parsed = this.parseModelIdentifier(options.identifier);
                if (parsed) {
                    selector = { vendor: parsed.vendor, id: parsed.id };
                } else {
                    Log.warn(
                        `Invalid model identifier format: ${options.identifier}, using default`
                    );
                    // Clear invalid identifier so we don't repeatedly fall back
                    this.settings.setPreferredModelIdentifier('');
                    selector = { vendor: 'copilot', id: this.DEFAULT_MODEL_ID };
                }
            } else {
                // Default model: GPT-4.1
                selector = { vendor: 'copilot', id: this.DEFAULT_MODEL_ID };
            }

            const models = await vscode.lm.selectChatModels(selector);

            if (models.length === 0) {
                Log.info(
                    `Model ${options?.identifier || 'default'} not available, using fallback`
                );
                return this.selectFallbackModel();
            }

            const model = models[0]!;
            this.currentModel = model;

            // Save preference in canonical vendor/id form
            if (options?.identifier) {
                const parsed = this.parseModelIdentifier(options.identifier);
                if (parsed) {
                    const canonical = `${parsed.vendor}/${parsed.id}`;
                    this.settings.setPreferredModelIdentifier(canonical);
                }
            }

            return model;
        } catch (err) {
            Log.error(
                `Failed to select model ${options?.identifier || ''}:`,
                err
            );
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
     * This method is required by the ILLMClient interface and IS actively used
     * by ConversationRunner for all analysis operations (command palette and chat).
     *
     * Delegates to ModelRequestHandler for message conversion and request execution.
     * Error handling is centralized in ConversationRunner.detectFatalError().
     */
    async sendRequest(
        request: ToolCallRequest,
        token: vscode.CancellationToken
    ): Promise<ToolCallResponse> {
        const model = await this.getCurrentModel();
        return ModelRequestHandler.sendRequest(
            model,
            request,
            token,
            this.requestTimeoutMs
        );
    }

    /**
     * Dispose of resources
     */
    public dispose(): void {
        this.currentModel = null;
    }
}
