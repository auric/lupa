import * as vscode from 'vscode';
import { AnalysisOrchestrator } from './analysisOrchestrator';
import { EmbeddingModelCoordinator } from './embeddingModelCoordinator';
import { CopilotModelCoordinator } from './copilotModelCoordinator';
import { DatabaseOrchestrator } from './databaseOrchestrator';
import { IServiceRegistry } from '../services/serviceManager';

/**
 * CommandRegistry handles all VS Code command registration
 * Centralizes command management and reduces coordinator complexity
 */
export class CommandRegistry implements vscode.Disposable {
    private readonly disposables: vscode.Disposable[] = [];

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly services: IServiceRegistry,
        private readonly analysisOrchestrator: AnalysisOrchestrator,
        private readonly embeddingModelCoordinator: EmbeddingModelCoordinator,
        private readonly copilotModelCoordinator: CopilotModelCoordinator,
        private readonly databaseOrchestrator: DatabaseOrchestrator
    ) { }

    /**
     * Register all extension commands
     */
    public registerAllCommands(): void {
        // Core analysis commands
        this.registerCommand('codelens-pr-analyzer.analyzePR', () =>
            this.analysisOrchestrator.analyzePR()
        );

        // Embedding model commands
        this.registerCommand('codelens-pr-analyzer.selectEmbeddingModel', () =>
            this.embeddingModelCoordinator.showEmbeddingModelSelectionOptions()
        );

        this.registerCommand('codelens-pr-analyzer.showEmbeddingModelsInfo', () =>
            this.embeddingModelCoordinator.showEmbeddingModelsInfo()
        );

        // Copilot language model commands
        this.registerCommand('codelens-pr-analyzer.showLanguageModelsInfo', () =>
            this.copilotModelCoordinator.showCopilotModelsInfo()
        );

        this.registerCommand('codelens-pr-analyzer.selectLanguageModel', () =>
            this.copilotModelCoordinator.showCopilotModelSelectionOptions()
        );

        // Database management commands
        this.registerCommand('codelens-pr-analyzer.manageDatabase', () =>
            this.databaseOrchestrator.showDatabaseManagementOptions()
        );

        // Indexing commands
        this.registerCommand('codelens-pr-analyzer.startContinuousIndexing', () =>
            this.services.indexingManager.startContinuousIndexing()
        );

        this.registerCommand('codelens-pr-analyzer.stopContinuousIndexing', () =>
            this.services.indexingManager.stopContinuousIndexing()
        );

        this.registerCommand('codelens-pr-analyzer.manageIndexing', () =>
            this.services.indexingService.showIndexingManagementOptions()
        );

        // Legacy hello world command
        this.registerCommand('codelens-pr-analyzer.helloWorld', () => {
            vscode.window.showInformationMessage('Hello from CodeLens PR Analyzer!');
        });
    }

    /**
     * Helper method to register a command and track disposables
     */
    private registerCommand(command: string, callback: (...args: any[]) => any): void {
        const disposable = vscode.commands.registerCommand(command, callback);
        this.disposables.push(disposable);
        this.context.subscriptions.push(disposable);
    }

    /**
     * Dispose of all registered commands
     */
    public dispose(): void {
        this.disposables.forEach(disposable => disposable.dispose());
        this.disposables.length = 0;
    }
}