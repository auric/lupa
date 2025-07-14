import * as vscode from 'vscode';
import { ServiceManager, IServiceRegistry } from './serviceManager';
import { AnalysisOrchestrator } from '../coordinators/analysisOrchestrator';
import { EmbeddingModelCoordinator } from '../coordinators/embeddingModelCoordinator';
import { CopilotModelCoordinator } from '../coordinators/copilotModelCoordinator';
import { DatabaseOrchestrator } from '../coordinators/databaseOrchestrator';
import { CommandRegistry } from '../coordinators/commandRegistry';

/**
 * Refactored PRAnalysisCoordinator with decomposed architecture
 * Uses specialized coordinators to manage different aspects of the system
 * Eliminates circular dependencies through proper service management
 */
export class PRAnalysisCoordinator implements vscode.Disposable {
    private serviceManager: ServiceManager;
    private services: IServiceRegistry | null = null;
    
    // Specialized coordinators
    private analysisOrchestrator: AnalysisOrchestrator | null = null;
    private embeddingModelCoordinator: EmbeddingModelCoordinator | null = null;
    private copilotModelCoordinator: CopilotModelCoordinator | null = null;
    private databaseOrchestrator: DatabaseOrchestrator | null = null;
    private commandRegistry: CommandRegistry | null = null;

    /**
     * Create a new PRAnalysisCoordinator
     * @param context VS Code extension context
     */
    constructor(private readonly context: vscode.ExtensionContext) {
        this.serviceManager = new ServiceManager(context);
        this.initializeAsync();
    }

    /**
     * Initialize the coordinator asynchronously
     */
    private async initializeAsync(): Promise<void> {
        try {
            // Initialize all services through ServiceManager
            this.services = await this.serviceManager.initialize();

            // Create specialized coordinators
            this.analysisOrchestrator = new AnalysisOrchestrator(this.context, this.services);
            this.embeddingModelCoordinator = new EmbeddingModelCoordinator(this.context, this.services, this.serviceManager);
            this.copilotModelCoordinator = new CopilotModelCoordinator(this.context, this.services);
            this.databaseOrchestrator = new DatabaseOrchestrator(this.context, this.services);

            // Register all commands through CommandRegistry
            this.commandRegistry = new CommandRegistry(
                this.context,
                this.services,
                this.analysisOrchestrator,
                this.embeddingModelCoordinator,
                this.copilotModelCoordinator,
                this.databaseOrchestrator
            );
            
            this.commandRegistry.registerAllCommands();

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to initialize PR Analyzer: ${errorMessage}`);
            console.error('PRAnalysisCoordinator initialization failed:', error);
        }
    }

    /**
     * Get the analysis orchestrator for external access
     */
    public getAnalysisOrchestrator(): AnalysisOrchestrator | null {
        return this.analysisOrchestrator;
    }

    /**
     * Get the embedding model coordinator for external access
     */
    public getEmbeddingModelCoordinator(): EmbeddingModelCoordinator | null {
        return this.embeddingModelCoordinator;
    }

    /**
     * Get the Copilot model coordinator for external access
     */
    public getCopilotModelCoordinator(): CopilotModelCoordinator | null {
        return this.copilotModelCoordinator;
    }

    /**
     * Get the database orchestrator for external access
     */
    public getDatabaseOrchestrator(): DatabaseOrchestrator | null {
        return this.databaseOrchestrator;
    }

    /**
     * Get the service registry for external access
     */
    public getServices(): IServiceRegistry | null {
        return this.services;
    }

    /**
     * Dispose of all resources
     */
    public dispose(): void {
        // Dispose coordinators first
        this.commandRegistry?.dispose();
        this.databaseOrchestrator?.dispose();
        this.copilotModelCoordinator?.dispose();
        this.embeddingModelCoordinator?.dispose();
        this.analysisOrchestrator?.dispose();

        // Then dispose the service manager (which disposes all services)
        this.serviceManager?.dispose();
    }
}