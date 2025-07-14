import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { StatusBarService } from './statusBarService';
import { WorkspaceSettingsService } from './workspaceSettingsService';
import { ResourceDetectionService, type SystemResources } from './resourceDetectionService';

/**
 * Available embedding models
 */
export enum EmbeddingModel {
    JinaEmbeddings = 'jinaai/jina-embeddings-v2-base-code',
    MiniLM = 'Xenova/all-MiniLM-L6-v2'
}

/**
 * Model size and memory requirements
 */
export interface ModelInfo {
    name: EmbeddingModel;
    path: string;
    isHighMemory: boolean;
    memoryRequirementGB: number;
    dimensions: number;
    contextLength: number;
    description: string;
}

/**
 * Options for model selection
 */
export interface ModelSelectionOptions {
    /**
     * Memory threshold in GB for using high memory models
     * If available memory is less than this, low memory models will be used
     */
    highMemoryThreshold?: number;

    /**
     * Force using high memory model even if system resources are insufficient
     */
    forceHighMemoryModel?: boolean;

    /**
     * Force using low memory model even if system resources are sufficient
     */
    forceLowMemoryModel?: boolean;
}

/**
 * Service for selecting the optimal embedding model based on system resources
 */
export class EmbeddingModelSelectionService implements vscode.Disposable {
    private readonly modelInfos: Record<EmbeddingModel, ModelInfo> = {
        [EmbeddingModel.JinaEmbeddings]: {
            name: EmbeddingModel.JinaEmbeddings,
            path: 'jinaai/jina-embeddings-v2-base-code',
            isHighMemory: true,
            memoryRequirementGB: 8,
            contextLength: 8192,
            dimensions: 768,
            description: 'High-quality code embeddings (Apache 2.0 license)'
        },
        [EmbeddingModel.MiniLM]: {
            name: EmbeddingModel.MiniLM,
            path: 'Xenova/all-MiniLM-L6-v2',
            isHighMemory: false,
            memoryRequirementGB: 2,
            contextLength: 256,
            dimensions: 384,
            description: 'Lightweight general-purpose embeddings (MIT license)'
        }
    };

    private readonly defaultOptions: Required<ModelSelectionOptions> = {
        highMemoryThreshold: 8, // GB
        forceHighMemoryModel: false,
        forceLowMemoryModel: false
    };

    private options: Required<ModelSelectionOptions>;
    private statusBarService: StatusBarService;

    /**
     * Creates a new EmbeddingModelSelectionService
     * @param basePath Base path to the models directory
     * @param options Configuration options
     */
    constructor(
        private readonly basePath: string,
        private readonly workspaceSettingsService: WorkspaceSettingsService,
        private readonly resourceDetectionService: ResourceDetectionService,
        options?: ModelSelectionOptions
    ) {
        this.options = { ...this.defaultOptions, ...options };
        this.statusBarService = StatusBarService.getInstance();
    }

    public getBasePath(): string {
        return this.basePath;
    }

    /**
     * Select the optimal model based on system resources and available models
     */
    public selectOptimalModel(): {
        model: EmbeddingModel;
        modelInfo: ModelInfo;
        useHighMemoryModel: boolean;
    } {
        const savedModel = this.workspaceSettingsService.getSelectedEmbeddingModel();
        if (savedModel && savedModel in this.modelInfos) {
            const modelInfo = this.modelInfos[savedModel];
            return {
                model: savedModel,
                modelInfo,
                useHighMemoryModel: savedModel === EmbeddingModel.JinaEmbeddings
            };
        }

        const systemResources = this.resourceDetectionService.detectSystemResources();
        const modelsInfo = this.checkModelsAvailability();

        // Default to MiniLM unless user has explicitly selected Jina
        // No automatic selection of high memory model anymore
        const model = EmbeddingModel.MiniLM;
        const useHighMemoryModel = false;

        const modelInfo = this.modelInfos[model];

        // Update status bar with model info
        this.updateModelStatusInfo(model, modelsInfo);

        return {
            model,
            modelInfo,
            useHighMemoryModel
        };
    }

    /**
     * Check which models are available
     */
    private checkModelsAvailability(): {
        primaryExists: boolean;
        fallbackExists: boolean;
    } {
        // Check for specific model directories
        // MiniLM is now the primary model, Jina is fallback
        const primaryModelPath = path.join(
            this.basePath,
            this.modelInfos[EmbeddingModel.MiniLM].path
        );

        const fallbackModelPath = path.join(
            this.basePath,
            this.modelInfos[EmbeddingModel.JinaEmbeddings].path
        );

        const primaryExists = fs.existsSync(primaryModelPath) &&
            fs.readdirSync(primaryModelPath).length > 0;

        const fallbackExists = fs.existsSync(fallbackModelPath) &&
            fs.readdirSync(fallbackModelPath).length > 0;

        return {
            primaryExists,
            fallbackExists
        };
    }

    /**
     * Update the status bar with information about the selected model
     */
    private updateModelStatusInfo(
        selectedModel: EmbeddingModel,
        modelsInfo: { primaryExists: boolean; fallbackExists: boolean; }
    ): void {
        let modelInfo = '';

        // MiniLM is now primary, Jina is fallback
        if (modelsInfo.primaryExists && modelsInfo.fallbackExists) {
            modelInfo = selectedModel === EmbeddingModel.MiniLM ?
                'Using MiniLM (primary)' :
                'Using Jina Embeddings';
        } else if (modelsInfo.primaryExists) {
            modelInfo = 'Using MiniLM (primary)';
        } else if (modelsInfo.fallbackExists) {
            modelInfo = 'Using Jina Embeddings (fallback)';
        } else {
            this.statusBarService.showTemporaryMessage('No embedding models available', 5000, 'error');
            return;
        }

        // Show temporary message about selected model
        this.statusBarService.showTemporaryMessage(modelInfo, 5000, 'check');
    }

    /**
     * Display information about available models
     */
    public showModelsInfo(): void {
        try {
            const { primaryExists, fallbackExists } = this.checkModelsAvailability();

            const primaryModelPath = path.join(
                this.basePath,
                this.modelInfos[EmbeddingModel.JinaEmbeddings].path
            );

            const fallbackModelPath = path.join(
                this.basePath,
                this.modelInfos[EmbeddingModel.MiniLM].path
            );

            let primarySize = 0;
            let fallbackSize = 0;

            if (primaryExists) {
                primarySize = this.calculateDirSize(primaryModelPath);
            }

            if (fallbackExists) {
                fallbackSize = this.calculateDirSize(fallbackModelPath);
            }

            // Get system resources
            const resources = this.resourceDetectionService.detectSystemResources();

            // Format as message
            const message = `Models information:\n\n` +
                `System Resources:\n` +
                `  Total Memory: ${this.formatBytes(resources.totalMemoryGB * 1024 * 1024 * 1024)}\n` +
                `  Available Memory: ${this.formatBytes(resources.availableMemoryGB * 1024 * 1024 * 1024)}\n` +
                `  CPU Cores: ${resources.cpuCount}\n\n` +
                `Primary Model (${EmbeddingModel.MiniLM}):\n` +
                `  Status: ${primaryExists ? 'Available' : 'Not available'}\n` +
                `  Size: ${this.formatBytes(primarySize)}\n` +
                `  Context Length: ${this.modelInfos[EmbeddingModel.MiniLM].contextLength} tokens\n\n` +
                `Fallback Model (${EmbeddingModel.JinaEmbeddings}):\n` +
                `  Status: ${fallbackExists ? 'Available' : 'Not available'}\n` +
                `  Size: ${this.formatBytes(fallbackSize)}\n` +
                `  Context Length: ${this.modelInfos[EmbeddingModel.JinaEmbeddings].contextLength} tokens\n\n` +
                `Total size: ${this.formatBytes(primarySize + fallbackSize)}`;

            vscode.window.showInformationMessage(message, { modal: true });
        } catch (error) {
            vscode.window.showErrorMessage(`Error getting models info: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Calculate directory size recursively
     */
    private calculateDirSize(dirPath: string): number {
        if (!fs.existsSync(dirPath)) {
            return 0;
        }

        let size = 0;
        const files = fs.readdirSync(dirPath);

        for (const file of files) {
            const filePath = path.join(dirPath, file);
            const stats = fs.statSync(filePath);

            if (stats.isDirectory()) {
                size += this.calculateDirSize(filePath);
            } else {
                size += stats.size;
            }
        }

        return size;
    }

    /**
     * Format bytes to a human-readable string
     */
    private formatBytes(bytes: number, decimals: number = 2): string {
        if (bytes === 0) {
            return '0 Bytes';
        }

        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];

        const i = Math.floor(Math.log(bytes) / Math.log(k));

        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
    }

    /**
     * Clean up resources
     */
    public dispose(): void {
        // No status bar items to clean up anymore - the central StatusBarService handles that
    }
}