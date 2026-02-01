import * as vscode from 'vscode';
import { ServiceManager, IServiceRegistry } from './serviceManager';
import { AnalysisOrchestrator } from '../coordinators/analysisOrchestrator';
import { CopilotModelCoordinator } from '../coordinators/copilotModelCoordinator';
import { CommandRegistry } from '../coordinators/commandRegistry';
import { getErrorMessage } from '../utils/errorUtils';

/**
 * PRAnalysisCoordinator is the main entry point for the extension.
 * Uses specialized coordinators to manage different aspects of the system.
 * Eliminates circular dependencies through proper service management.
 */
export class PRAnalysisCoordinator implements vscode.Disposable {
    private serviceManager: ServiceManager;
    private services: IServiceRegistry | null = null;

    // Specialized coordinators
    private analysisOrchestrator: AnalysisOrchestrator | null = null;
    private copilotModelCoordinator: CopilotModelCoordinator | null = null;
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
            this.analysisOrchestrator = new AnalysisOrchestrator(
                this.context,
                this.services
            );
            this.copilotModelCoordinator = new CopilotModelCoordinator(
                this.context,
                this.services
            );

            // Register all commands through CommandRegistry
            this.commandRegistry = new CommandRegistry(
                this.context,
                this.services,
                this.analysisOrchestrator,
                this.copilotModelCoordinator
            );

            this.commandRegistry.registerAllCommands();
        } catch (error) {
            const errorMessage = getErrorMessage(error);
            vscode.window.showErrorMessage(
                `Failed to initialize PR Analyzer: ${errorMessage}`
            );
            console.error(
                'PRAnalysisCoordinator initialization failed:',
                error
            );
        }
    }

    /**
     * Get the analysis orchestrator for external access
     */
    public getAnalysisOrchestrator(): AnalysisOrchestrator | null {
        return this.analysisOrchestrator;
    }

    /**
     * Get the Copilot model coordinator for external access
     */
    public getCopilotModelCoordinator(): CopilotModelCoordinator | null {
        return this.copilotModelCoordinator;
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
        this.copilotModelCoordinator?.dispose();
        this.analysisOrchestrator?.dispose();

        // Then dispose the service manager (which disposes all services)
        this.serviceManager?.dispose();
    }
}
