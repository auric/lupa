import * as vscode from 'vscode';
import { EmbeddingModel } from '../services/embeddingModelSelectionService';
import { Log } from '../services/loggingService';
import { IServiceRegistry, ServiceManager } from '../services/serviceManager';

/**
 * EmbeddingModelCoordinator manages embedding model UI interactions and selection workflow
 * Coordinates with ServiceManager for actual service reinitialization
 */
export class EmbeddingModelCoordinator implements vscode.Disposable {
    private selectedModel: string;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly services: IServiceRegistry,
        private readonly serviceManager: ServiceManager
    ) {
        const { modelInfo } = this.services.embeddingModelSelection.selectOptimalModel();
        this.selectedModel = modelInfo.name;
    }

    /**
     * Show options for selecting embedding model
     */
    public async showEmbeddingModelSelectionOptions(): Promise<void> {
        const previousModel = this.selectedModel;

        // Show options and get selection
        const selectedOption = await this.services.uiManager.showModelSelectionOptions();

        if (!selectedOption) {
            return;
        }

        let newSelectedModelEnumValue: EmbeddingModel | undefined;

        // Update settings based on selection
        switch (selectedOption) {
            case 'Use default model (MiniLM)':
                // MiniLM is now the default model
                newSelectedModelEnumValue = EmbeddingModel.MiniLM;
                this.services.workspaceSettings.setSelectedEmbeddingModel(newSelectedModelEnumValue);
                break;
            case 'Use high-memory model (Jina Embeddings)':
                // Only use Jina if explicitly selected
                newSelectedModelEnumValue = EmbeddingModel.JinaEmbeddings;
                this.services.workspaceSettings.setSelectedEmbeddingModel(newSelectedModelEnumValue);
                break;
            default:
                return;
        }

        // Handle embedding model change
        await this.handleEmbeddingModelChange(previousModel, newSelectedModelEnumValue);
    }

    /**
     * Handle embedding model change by delegating to ServiceManager
     */
    private async handleEmbeddingModelChange(previousModel: string, newSelectedModelEnumValue: EmbeddingModel | undefined): Promise<void> {
        // Delegate the complex reinitialization logic to ServiceManager
        await this.serviceManager.handleEmbeddingModelChange(newSelectedModelEnumValue);
        
        // Update our local selected model tracking
        const actualNewModelInfo = this.services.embeddingModelSelection.selectOptimalModel();
        this.selectedModel = actualNewModelInfo.modelInfo.name;
    }

    /**
     * Get currently selected embedding model
     */
    public getSelectedEmbeddingModel(): string {
        return this.selectedModel;
    }

    /**
     * Show embedding models information
     */
    public showEmbeddingModelsInfo(): void {
        this.services.embeddingModelSelection.showModelsInfo();
    }

    /**
     * Dispose of resources
     */
    public dispose(): void {
        // EmbeddingModelCoordinator doesn't own services, just coordinates them
        // Services are disposed by ServiceManager
    }
}