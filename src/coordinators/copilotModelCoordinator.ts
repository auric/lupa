import * as vscode from 'vscode';
import { CopilotModelManager } from '../models/copilotModelManager';
import { WorkspaceSettingsService } from '../services/workspaceSettingsService';
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
            // First show available models
            await this.services.copilotModelManager.showModelsInfo();

            // Get available model families
            const models = await this.services.copilotModelManager.listAvailableModels();
            const families = Array.from(new Set(models.map(m => m.family)));

            if (families.length === 0) {
                vscode.window.showInformationMessage('No language models available. Please ensure GitHub Copilot is installed and authorized.');
                return;
            }

            // Create quickpick options for model families
            const options = [
                ...models.map(model => ({
                    label: `${model.name}`,
                    description: model.version
                }))
            ];

            // Ask user to select model family
            const selectedModelOption = await vscode.window.showQuickPick(options, {
                placeHolder: 'Select Copilot language model',
                matchOnDescription: true
            });

            if (!selectedModelOption) {
                return;
            }

            const selectedModel = models.find(m => {
                return m.name === selectedModelOption.label;
            })!;

            // Save selected model preferences
            this.services.workspaceSettings.setPreferredModelVersion(selectedModel.version);
            vscode.window.showInformationMessage(`Copilot language model set to ${selectedModel.name} (version: ${selectedModel.version})`);

            // Try to select the model to verify it's available
            await this.services.copilotModelManager.selectModel({
                version: selectedModel.version
            });

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Error selecting Copilot language model: ${errorMessage}`);
        }
    }

    /**
     * Show Copilot language models information
     */
    public async showCopilotModelsInfo(): Promise<void> {
        await this.services.copilotModelManager.showModelsInfo();
    }

    /**
     * Dispose of resources
     */
    public dispose(): void {
        // CopilotModelCoordinator doesn't own services, just coordinates them
        // Services are disposed by ServiceManager
    }
}