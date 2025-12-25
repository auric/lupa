import * as vscode from 'vscode';
import { IServiceRegistry } from '../services/serviceManager';

/**
 * CopilotModelCoordinator manages GitHub Copilot language model operations
 * Handles selection and configuration of Copilot language models for analysis
 */
export class CopilotModelCoordinator implements vscode.Disposable {
    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly services: IServiceRegistry
    ) { }

    /**
     * Show options for selecting Copilot language model
     */
    public async showCopilotModelSelectionOptions(): Promise<void> {
        try {
            // Get available models
            const models = await this.services.copilotModelManager.listAvailableModels();

            if (models.length === 0) {
                vscode.window.showInformationMessage('No language models available. Please ensure GitHub Copilot is installed and authorized.');
                return;
            }

            const formatTokens = (tokens: number): string => {
                if (tokens >= 1000000) {
                    return `${(tokens / 1000000).toFixed(tokens % 1000000 === 0 ? 0 : 1)}M`;
                }
                if (tokens >= 1000) {
                    return `${(tokens / 1000).toFixed(tokens % 1000 === 0 ? 0 : 1)}K`;
                }
                return tokens.toString();
            };

            const options = models.map(model => ({
                label: model.name,
                description: `${formatTokens(model.maxInputTokens)} tokens`,
                detail: model.id,
                model
            }));

            const selectedModelOption = await vscode.window.showQuickPick(options, {
                placeHolder: 'Select language model',
                matchOnDescription: true,
                matchOnDetail: true
            });

            if (!selectedModelOption) {
                return;
            }

            const selectedModel = selectedModelOption.model;

            this.services.workspaceSettings.setPreferredModelVersion(selectedModel.version);
            vscode.window.showInformationMessage(`Language model set to ${selectedModel.name} (version: ${selectedModel.version})`);

            await this.services.copilotModelManager.selectModel({
                version: selectedModel.version
            });

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Error selecting language model: ${errorMessage}`);
        }
    }

    /**
     * Dispose of resources
     */
    public dispose(): void {
        // CopilotModelCoordinator doesn't own services, just coordinates them
        // Services are disposed by ServiceManager
    }
}