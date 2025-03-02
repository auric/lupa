import * as vscode from 'vscode';
import type { FeatureExtractionPipeline, FeatureExtractionPipelineOptions } from '@xenova/transformers';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Pooling strategy for generating embeddings
 */
export type PoolingStrategy = 'none' | 'mean' | 'cls';

/**
 * Options for generating embeddings
 */
export interface EmbeddingOptions {
    pooling?: PoolingStrategy;
    normalize?: boolean;
}

/**
 * Service for generating embeddings from code using transformer models
 */
export class CodeEmbeddingService {
    private primaryModelName = 'Qodo/Qodo-Embed-1-1.5B';
    private fallbackModelName = 'Xenova/all-MiniLM-L6-v2';
    private embeddingPipeline: FeatureExtractionPipeline | null = null;
    private env: any = null;
    private pipeline: any = null;
    private currentModelName: string;
    private isInitializing = false;
    private initializationPromise: Promise<void> | null = null;
    private primaryCachePath: string = '';
    private fallbackCachePath: string = '';
    private statusBarItem: vscode.StatusBarItem;

    constructor(private context: vscode.ExtensionContext) {
        this.currentModelName = this.primaryModelName;
        // Create status bar item first
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.statusBarItem.text = "$(database) PR Analyzer";
        this.statusBarItem.tooltip = "PR Analyzer Embedding Cache";
        this.statusBarItem.command = "codelens-pr-analyzer.manageCaches";
        this.statusBarItem.show();
        context.subscriptions.push(this.statusBarItem);

        // Now initialize cache paths so updateCacheStatus can use the status bar item
        this.initCachePaths();

        // Register cache management command
        const manageCachesCommand = vscode.commands.registerCommand(
            'codelens-pr-analyzer.manageCaches',
            () => this.showCacheManagementOptions()
        );
        context.subscriptions.push(manageCachesCommand);
    }

    /**
     * Initialize cache paths for workspace-specific caching
     */
    private initCachePaths(): void {
        // Use workspace storage if available, fall back to global storage
        const storagePath = this.context.storageUri || this.context.globalStorageUri;

        if (!storagePath) {
            console.warn('No storage path available, using memory cache only');
            // Transformers.js will use in-memory cache without setting cacheDir
            return;
        }

        // Create workspace-specific cache directory structure
        const workspaceId = vscode.workspace.name || 'default-workspace';
        const workspaceCachePath = vscode.Uri.joinPath(storagePath, 'transformers-cache', workspaceId).fsPath;

        // Create primary and fallback cache paths
        this.primaryCachePath = path.join(workspaceCachePath, 'primary');
        this.fallbackCachePath = path.join(workspaceCachePath, 'fallback');

        // Ensure directories exist
        this.ensureDirectoryExists(this.primaryCachePath);
        this.ensureDirectoryExists(this.fallbackCachePath);

        // Update status display
        this.updateCacheStatus();
    }

    /**
     * Ensure a directory exists
     */
    private ensureDirectoryExists(dirPath: string): void {
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }
    }

    /**
     * Update the cache status display
     */
    private updateCacheStatus(): void {
        const primaryCacheExists = this.primaryCachePath && fs.existsSync(this.primaryCachePath) &&
            fs.readdirSync(this.primaryCachePath).length > 0;
        const fallbackCacheExists = this.fallbackCachePath && fs.existsSync(this.fallbackCachePath) &&
            fs.readdirSync(this.fallbackCachePath).length > 0;

        if (primaryCacheExists && fallbackCacheExists) {
            this.statusBarItem.text = "$(database) PR Analyzer (P+F)";
            this.statusBarItem.tooltip = "PR Analyzer: Primary and fallback caches available";
        } else if (primaryCacheExists) {
            this.statusBarItem.text = "$(database) PR Analyzer (P)";
            this.statusBarItem.tooltip = "PR Analyzer: Primary cache available";
        } else if (fallbackCacheExists) {
            this.statusBarItem.text = "$(database) PR Analyzer (F)";
            this.statusBarItem.tooltip = "PR Analyzer: Fallback cache available";
        } else {
            this.statusBarItem.text = "$(database) PR Analyzer";
            this.statusBarItem.tooltip = "PR Analyzer: No caches available";
        }
    }

    /**
     * Show cache management options
     */
    private async showCacheManagementOptions(): Promise<void> {
        const options = [
            "Clear primary cache",
            "Clear fallback cache",
            "Clear all caches",
            "Regenerate primary cache",
            "Regenerate fallback cache",
            "Show cache info"
        ];

        const selected = await vscode.window.showQuickPick(options, {
            placeHolder: "Select cache management action"
        });

        if (!selected) return;

        switch (selected) {
            case "Clear primary cache":
                await this.clearCache(this.primaryCachePath);
                break;
            case "Clear fallback cache":
                await this.clearCache(this.fallbackCachePath);
                break;
            case "Clear all caches":
                await this.clearCache(this.primaryCachePath);
                await this.clearCache(this.fallbackCachePath);
                break;
            case "Regenerate primary cache":
                await this.regenerateCache(this.primaryModelName, true);
                break;
            case "Regenerate fallback cache":
                await this.regenerateCache(this.fallbackModelName, false);
                break;
            case "Show cache info":
                this.showCacheInfo();
                break;
        }
    }

    /**
     * Clear a specific cache directory
     */
    public async clearCache(cachePath: string): Promise<void> {
        if (!cachePath || !fs.existsSync(cachePath)) {
            vscode.window.showInformationMessage("Cache does not exist");
            return;
        }

        try {
            // Delete all files in directory but keep directory
            const files = fs.readdirSync(cachePath);
            for (const file of files) {
                fs.unlinkSync(path.join(cachePath, file));
            }

            vscode.window.showInformationMessage("Cache cleared successfully");

            // Reset pipeline if it was using this cache
            if (this.embeddingPipeline) {
                this.embeddingPipeline = null;
            }

            this.updateCacheStatus();
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to clear cache: ${errorMessage}`);
        }
    }

    /**
     * Regenerate a specific cache
     */
    private async regenerateCache(modelName: string, isPrimary: boolean): Promise<void> {
        const cachePath = isPrimary ? this.primaryCachePath : this.fallbackCachePath;

        // Clear existing cache
        await this.clearCache(cachePath);

        // Set appropriate cache directory for this operation
        this.env.cacheDir = cachePath;

        vscode.window.showInformationMessage(`Regenerating ${isPrimary ? 'primary' : 'fallback'} cache...`);

        try {
            // Load model to populate cache
            const tempPipeline = await this.pipeline!('feature-extraction', modelName);

            // Generate a small test embedding to ensure cache is populated
            await tempPipeline("test code", { pooling: 'mean' });

            vscode.window.showInformationMessage(`${isPrimary ? 'Primary' : 'Fallback'} cache regenerated successfully`);

            // Reset current pipeline to use new cache if needed
            if (this.embeddingPipeline && this.currentModelName === modelName) {
                this.embeddingPipeline = null;
            }

            this.updateCacheStatus();
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to regenerate cache: ${errorMessage}`);
        }
    }

    /**
     * Show cache information
     */
    private showCacheInfo(): void {
        try {
            const primarySize = this.calculateDirSize(this.primaryCachePath);
            const fallbackSize = this.calculateDirSize(this.fallbackCachePath);

            const primaryFiles = this.primaryCachePath && fs.existsSync(this.primaryCachePath) ?
                fs.readdirSync(this.primaryCachePath).length : 0;
            const fallbackFiles = this.fallbackCachePath && fs.existsSync(this.fallbackCachePath) ?
                fs.readdirSync(this.fallbackCachePath).length : 0;

            const infoMessage =
                `Primary cache (${this.primaryModelName}):\n` +
                `- Location: ${this.primaryCachePath}\n` +
                `- Files: ${primaryFiles}\n` +
                `- Size: ${this.formatBytes(primarySize)}\n\n` +
                `Fallback cache (${this.fallbackModelName}):\n` +
                `- Location: ${this.fallbackCachePath}\n` +
                `- Files: ${fallbackFiles}\n` +
                `- Size: ${this.formatBytes(fallbackSize)}`;

            vscode.window.showInformationMessage(infoMessage, { modal: true });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to retrieve cache info: ${errorMessage}`);
        }
    }

    /**
     * Calculate directory size recursively
     */
    private calculateDirSize(dirPath: string): number {
        if (!dirPath || !fs.existsSync(dirPath)) {
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
     * Format bytes to human-readable format
     */
    private formatBytes(bytes: number): string {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    /**
     * Initialize the embedding model
     */
    public async initializeModel(): Promise<void> {
        // If already initializing, return the existing promise
        if (this.isInitializing && this.initializationPromise) {
            return this.initializationPromise;
        }

        this.isInitializing = true;
        this.initializationPromise = this._initializeModel();

        try {
            await this.initializationPromise;
        } finally {
            this.isInitializing = false;
        }
    }

    /**
     * Internal initialization method
     */
    private async _initializeModel(): Promise<void> {
        try {
            const TransformersApi = Function('return import("@xenova/transformers")')();
            const { pipeline, env } = await TransformersApi;
            this.pipeline = pipeline;
            this.env = env;
            this.env.allowLocalModels = false;
            this.env.allowRemoteModels = true;

            this.context.workspaceState.update('codeEmbeddingService.status', 'initializing');
            this.currentModelName = this.primaryModelName;

            vscode.window.setStatusBarMessage(`Loading code embedding model...`, 3000);
            this.embeddingPipeline = await this.pipeline!('feature-extraction', this.currentModelName);

            vscode.window.setStatusBarMessage(`Code embedding model loaded.`, 3000);
            this.context.workspaceState.update('codeEmbeddingService.status', 'ready');
            this.context.workspaceState.update('codeEmbeddingService.model', this.currentModelName);

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showWarningMessage(`Failed to load primary embedding model. Using fallback model.`);
            console.error(`Failed to load embedding model ${this.currentModelName}:`, errorMessage);

            try {
                this.currentModelName = this.fallbackModelName;

                vscode.window.setStatusBarMessage(`Loading fallback embedding model...`, 3000);
                this.embeddingPipeline = await this.pipeline!('feature-extraction', this.currentModelName);

                vscode.window.setStatusBarMessage(`Fallback embedding model loaded.`, 3000);
                this.context.workspaceState.update('codeEmbeddingService.status', 'ready-fallback');
                this.context.workspaceState.update('codeEmbeddingService.model', this.currentModelName);

            } catch (fallbackError) {
                const fallbackErrorMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
                vscode.window.showErrorMessage(`Failed to load embedding models. Some functionality may be limited.`);
                console.error(`Failed to load fallback embedding model:`, fallbackErrorMessage);
                this.context.workspaceState.update('codeEmbeddingService.status', 'error');
                throw new Error(`Failed to initialize embedding models: ${fallbackErrorMessage}`);
            }
        }
    }

    /**
     * Check if the embedding model is initialized
     */
    public isModelReady(): boolean {
        return this.embeddingPipeline !== null;
    }

    /**
     * Get the name of the currently active model
     */
    public getCurrentModelName(): string {
        return this.currentModelName;
    }

    /**
     * Generate embedding from code text
     * @param code Code text to generate embedding for
     * @param options Embedding options
     * @returns Float32Array containing the embedding
     */
    public async generateEmbedding(code: string, options: EmbeddingOptions = {}): Promise<Float32Array> {
        // Initialize model if not already initialized
        if (!this.isModelReady()) {
            await this.initializeModel();
        }

        try {
            // Configure options with defaults
            const embeddingOptions: FeatureExtractionPipelineOptions = {
                pooling: options.pooling || 'mean',
                normalize: options.normalize !== undefined ? options.normalize : true
            };

            // Generate embedding
            const result = await this.embeddingPipeline!(code, embeddingOptions);

            // Convert BigInt values to numbers and create Float32Array
            return new Float32Array(Array.from(result.data, Number));
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error('Error generating embedding:', errorMessage);

            // If this is the first error after successful initialization, try reinitializing
            if (this.isModelReady()) {
                this.embeddingPipeline = null;
                vscode.window.showWarningMessage('Embedding generation failed. Attempting to reinitialize model...');

                try {
                    await this.initializeModel();
                    return this.generateEmbedding(code, options);
                } catch (reinitError) {
                    const reinitErrorMessage = reinitError instanceof Error ? reinitError.message : String(reinitError);
                    console.error('Failed to reinitialize embedding model:', reinitErrorMessage);
                    throw new Error(`Failed to generate embedding: ${errorMessage}`);
                }
            }

            throw new Error(`Failed to generate embedding: ${errorMessage}`);
        }
    }

    /**
     * Generate batch embeddings for multiple code snippets
     * @param codeSnippets Array of code snippets
     * @param options Embedding options
     * @returns Array of Float32Array embeddings
     */
    public async generateBatchEmbeddings(
        codeSnippets: string[],
        options: EmbeddingOptions = {}
    ): Promise<Float32Array[]> {
        // Process in batches of reasonable size to avoid memory issues
        const batchSize = 10;
        const results: Float32Array[] = [];

        for (let i = 0; i < codeSnippets.length; i += batchSize) {
            const batch = codeSnippets.slice(i, i + batchSize);
            const batchPromises = batch.map(snippet => this.generateEmbedding(snippet, options));
            const batchResults = await Promise.all(batchPromises);
            results.push(...batchResults);
        }

        return results;
    }

    /**
     * Release resources used by the embedding model
     */
    public dispose(): void {
        this.embeddingPipeline = null;
        // No explicit dispose method in transformers.js, but we can set to null to allow GC
    }
}
