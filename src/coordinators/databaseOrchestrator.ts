import * as vscode from 'vscode';
import { UIManager } from '../services/uiManager';
import { EmbeddingDatabaseAdapter } from '../services/embeddingDatabaseAdapter';
import { IndexingManager } from '../services/indexingManager';
import { IServiceRegistry } from '../services/serviceManager';

/**
 * DatabaseOrchestrator handles database management operations
 * Coordinates database optimization, rebuilding, and statistics
 */
export class DatabaseOrchestrator implements vscode.Disposable {
    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly services: IServiceRegistry
    ) {}

    /**
     * Show database management options
     */
    public async showDatabaseManagementOptions(): Promise<void> {
        // Show management options
        const selected = await this.services.uiManager.showDatabaseManagementOptions();

        if (!selected) {
            return;
        }

        switch (selected) {
            case 'Optimize database':
                await this.optimizeDatabase();
                break;

            case 'Rebuild entire database':
                await this.services.indexingManager.performFullReindexing();
                break;

            case 'Show database statistics':
                const detailedStats = await this.services.embeddingDatabaseAdapter.getStorageStats();
                vscode.window.showInformationMessage(detailedStats, { modal: true });
                break;
        }
    }

    /**
     * Optimize the vector database
     */
    private async optimizeDatabase(): Promise<void> {
        await this.services.uiManager.showAnalysisProgress('Optimizing database', async (progress) => {
            progress.report({ message: 'Running optimization...' });

            try {
                this.services.embeddingDatabaseAdapter.optimizeStorage();
                vscode.window.showInformationMessage('Database optimization complete');
            } catch (error) {
                vscode.window.showErrorMessage(`Database optimization failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        });
    }

    /**
     * Dispose of resources
     */
    public dispose(): void {
        // DatabaseOrchestrator doesn't own services, just coordinates them
        // Services are disposed by ServiceManager
    }
}