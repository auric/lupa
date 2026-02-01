import * as vscode from 'vscode';
import { IServiceRegistry } from '../services/serviceManager';
import { getErrorMessage } from '../utils/errorUtils';

interface ModelQuickPickItem extends vscode.QuickPickItem {
    identifier: string;
    name: string;
    vendor: string;
}

/**
 * CopilotModelCoordinator manages GitHub Copilot language model operations
 * Handles selection and configuration of Copilot language models for analysis
 */
export class CopilotModelCoordinator implements vscode.Disposable {
    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly services: IServiceRegistry
    ) {}

    /**
     * Show options for selecting Copilot language model
     */
    public async showCopilotModelSelectionOptions(): Promise<void> {
        try {
            // Get available models
            const models =
                await this.services.copilotModelManager.listAvailableModels();

            if (models.length === 0) {
                vscode.window.showInformationMessage(
                    'No language models available. Please ensure GitHub Copilot is installed and authorized.'
                );
                return;
            }

            // Get effective model identifier (saved or default)
            const currentIdentifier =
                this.services.copilotModelManager.getEffectiveModelIdentifier();

            const formatTokens = (tokens: number): string => {
                if (tokens >= 1000000) {
                    return `${(tokens / 1000000).toFixed(tokens % 1000000 === 0 ? 0 : 1)}M`;
                }
                if (tokens >= 1000) {
                    return `${(tokens / 1000).toFixed(tokens % 1000 === 0 ? 0 : 1)}K`;
                }
                return tokens.toString();
            };

            // Build options with vendor info
            const options: ModelQuickPickItem[] = models.map((model) => ({
                label: model.name,
                description: `${model.vendor} · ${formatTokens(model.maxInputTokens)} tokens`,
                detail: model.id,
                identifier: model.identifier,
                name: model.name,
                vendor: model.vendor,
            }));

            // Sort: current/default model first, then copilot vendor, then alphabetically
            options.sort((a, b) => {
                const aIsCurrent = a.identifier === currentIdentifier;
                const bIsCurrent = b.identifier === currentIdentifier;
                if (aIsCurrent && !bIsCurrent) {
                    return -1;
                }
                if (!aIsCurrent && bIsCurrent) {
                    return 1;
                }
                // Copilot vendor comes first
                const aIsCopilot = a.vendor === 'copilot';
                const bIsCopilot = b.vendor === 'copilot';
                if (aIsCopilot && !bIsCopilot) {
                    return -1;
                }
                if (!aIsCopilot && bIsCopilot) {
                    return 1;
                }
                return a.name.localeCompare(b.name);
            });

            const selectedModelOption = await vscode.window.showQuickPick(
                options,
                {
                    placeHolder: 'Select language model',
                    matchOnDescription: true,
                    matchOnDetail: true,
                }
            );

            if (!selectedModelOption) {
                return;
            }

            this.services.workspaceSettings.setPreferredModelIdentifier(
                selectedModelOption.identifier
            );
            vscode.window.showInformationMessage(
                `Language model set to ${selectedModelOption.name}`
            );

            await this.services.copilotModelManager.selectModel({
                identifier: selectedModelOption.identifier,
            });
        } catch (error) {
            const errorMessage = getErrorMessage(error);
            vscode.window.showErrorMessage(
                `Error selecting language model: ${errorMessage}`
            );
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
