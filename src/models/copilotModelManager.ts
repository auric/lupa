import * as vscode from 'vscode';
import { WorkspaceSettingsService } from '../services/workspaceSettingsService';
import { Log } from '../services/loggingService';

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
export class CopilotModelManager {
    private currentModel: vscode.LanguageModelChat | null = null;
    private modelCache: ModelDetail[] | null = null;
    private lastModelRefresh: number = 0;
    private readonly cacheLifetimeMs = 5 * 60 * 1000; // 5 minutes

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

            const selector: any = {
                vendor: 'copilot'
            };

            // Add family and version if specified
            if (options?.family) {
                selector.family = options.family;

                if (options.version) {
                    selector.version = options.version;
                }
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
}