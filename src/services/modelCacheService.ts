import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { StatusBarService } from './statusBarService';

/**
 * ModelCacheService manages the paths to pre-bundled ML models
 * and provides access to them for the IndexingService.
 */
export class ModelCacheService implements vscode.Disposable {
    private readonly statusBarId = 'prAnalyzer.model';
    private modelPaths: string;

    constructor(private readonly context: vscode.ExtensionContext) {
        // Get single model path for transformers.js
        this.modelPaths = this.context.asAbsolutePath(
            path.join('models')
        );

        // Check if bundled models are available and update status bar
        this.checkModelsAvailable();

        // Register command for managing models
        this.context.subscriptions.push(
            vscode.commands.registerCommand('codelens-pr-analyzer.manageModelCache',
                () => this.showModelManagementOptions())
        );
    }

    /**
     * Check if the pre-bundled models are available in the extension
     */
    private checkModelsAvailable(): void {
        try {
            // Get status bar service
            const statusBarService = StatusBarService.getInstance();
            const statusBar = statusBarService.getOrCreateItem(this.statusBarId, vscode.StatusBarAlignment.Right, 100);
            statusBar.command = 'codelens-pr-analyzer.manageModelCache';

            // Check if models directory exists and contains files
            const modelsExist = fs.existsSync(this.modelPaths) &&
                fs.readdirSync(this.modelPaths).length > 0;

            // Check for specific model directories
            const primaryModelPath = path.join(this.modelPaths, 'jinaai', 'jina-embeddings-v2-base-code');
            const fallbackModelPath = path.join(this.modelPaths, 'Xenova', 'all-MiniLM-L6-v2');

            const primaryExists = fs.existsSync(primaryModelPath) &&
                fs.readdirSync(primaryModelPath).length > 0;

            const fallbackExists = fs.existsSync(fallbackModelPath) &&
                fs.readdirSync(fallbackModelPath).length > 0;

            // Update status bar based on what's available
            if (primaryExists && fallbackExists) {
                statusBar.text = '$(database) PR Analyzer (P+F)';
                statusBar.tooltip = 'PR Analyzer: Primary and fallback models available';
            } else if (primaryExists) {
                statusBar.text = '$(database) PR Analyzer (P)';
                statusBar.tooltip = 'PR Analyzer: Primary model available';
            } else if (fallbackExists) {
                statusBar.text = '$(database) PR Analyzer (F)';
                statusBar.tooltip = 'PR Analyzer: Fallback model available';
            } else if (modelsExist) {
                statusBar.text = '$(database) PR Analyzer';
                statusBar.tooltip = 'PR Analyzer: Models available';
            } else {
                statusBar.text = '$(warning) PR Analyzer';
                statusBar.tooltip = 'PR Analyzer: No models found';

                // Show warning if no models are found
                vscode.window.showWarningMessage(
                    'No pre-bundled models found for PR Analyzer. ' +
                    'You need to run "npm run prepare-models" to download the required models.',
                    'Run prepare-models'
                ).then(selection => {
                    if (selection === 'Run prepare-models') {
                        const terminal = vscode.window.createTerminal('PR Analyzer - Model Download');
                        terminal.sendText('npm run prepare-models');
                        terminal.show();
                    }
                });
            }

            statusBar.show();
        } catch (error) {
            console.error('Error checking model availability:', error);
            vscode.window.showErrorMessage(`Failed to check model availability: ${error instanceof Error ? error.message : String(error)}`);

            const statusBarService = StatusBarService.getInstance();
            const statusBar = statusBarService.getOrCreateItem(this.statusBarId);
            statusBar.text = '$(error) PR Analyzer';
            statusBar.tooltip = 'PR Analyzer: Error checking model availability';
            statusBar.show();
        }
    }

    /**
     * Show model management options
     */
    private async showModelManagementOptions(): Promise<void> {
        const options = [
            "Show models info",
            "Prepare missing models",
            "Re-download all models"
        ];

        const selected = await vscode.window.showQuickPick(options, {
            placeHolder: "Select model management action"
        });

        if (!selected) return;

        switch (selected) {
            case "Show models info":
                this.showModelsInfo();
                break;
            case "Prepare missing models":
                this.prepareModels(false);
                break;
            case "Re-download all models":
                this.prepareModels(true);
                break;
        }
    }

    /**
     * Show information about the available models
     */
    private showModelsInfo(): void {
        try {
            const primaryModelPath = path.join(this.modelPaths, 'jinaai', 'jina-embeddings-v2-base-code');
            const fallbackModelPath = path.join(this.modelPaths, 'Xenova', 'all-MiniLM-L6-v2');

            const primaryExists = fs.existsSync(primaryModelPath) &&
                fs.readdirSync(primaryModelPath).length > 0;

            const fallbackExists = fs.existsSync(fallbackModelPath) &&
                fs.readdirSync(fallbackModelPath).length > 0;

            const primarySize = primaryExists ? this.calculateDirSize(primaryModelPath) : 0;
            const fallbackSize = fallbackExists ? this.calculateDirSize(fallbackModelPath) : 0;

            const message = `Models information:\n\n` +
                `Primary Model (jinaai/jina-embeddings-v2-base-code):\n` +
                `  Status: ${primaryExists ? 'Available' : 'Not available'}\n` +
                `  Size: ${this.formatBytes(primarySize)}\n\n` +
                `Fallback Model (Xenova/all-MiniLM-L6-v2):\n` +
                `  Status: ${fallbackExists ? 'Available' : 'Not available'}\n` +
                `  Size: ${this.formatBytes(fallbackSize)}\n\n` +
                `Total size: ${this.formatBytes(primarySize + fallbackSize)}`;

            vscode.window.showInformationMessage(message, { modal: true });
        } catch (error) {
            vscode.window.showErrorMessage(`Error getting models info: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Launch the prepare-models script
     */
    private prepareModels(forceRedownload: boolean): void {
        try {
            // Ask for confirmation for force redownload
            if (forceRedownload) {
                vscode.window.showWarningMessage(
                    'This will delete and re-download all models. Continue?',
                    'Yes', 'No'
                ).then(selection => {
                    if (selection !== 'Yes') return;
                    this.runPrepareModelsScript(forceRedownload);
                });
            } else {
                this.runPrepareModelsScript(forceRedownload);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Error preparing models: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Run the prepare-models script
     */
    private runPrepareModelsScript(forceRedownload: boolean): void {
        const terminal = vscode.window.createTerminal('PR Analyzer - Model Download');

        if (forceRedownload) {
            const rimrafCommand = process.platform === 'win32'
                ? 'rimraf -g .\\models\\**\\*'
                : 'rimraf -g ./models/**/*';

            terminal.sendText(rimrafCommand);
        }

        terminal.sendText('npm run prepare-models');
        terminal.show();

        // Notify the user that they'll need to reload the window
        vscode.window.showInformationMessage(
            'Models are being prepared. You may need to reload the window after completion.',
            'Reload Window'
        ).then(selection => {
            if (selection === 'Reload Window') {
                vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
        });
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
            const stat = fs.statSync(filePath);

            if (stat.isDirectory()) {
                size += this.calculateDirSize(filePath);
            } else {
                size += stat.size;
            }
        }

        return size;
    }

    /**
     * Format bytes to a human-readable string
     */
    private formatBytes(bytes: number, decimals: number = 2): string {
        if (bytes === 0) return '0 Bytes';

        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];

        const i = Math.floor(Math.log(bytes) / Math.log(k));

        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
    }

    /**
     * Get the path to the models directory
     */
    public getModelsPath(): string {
        return this.modelPaths;
    }

    /**
     * Clean up resources
     */
    public dispose(): void {
        // Nothing to dispose here since we're using the shared StatusBarService
    }
}