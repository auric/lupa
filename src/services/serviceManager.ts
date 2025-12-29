import * as vscode from 'vscode';

// Core services
import { WorkspaceSettingsService } from './workspaceSettingsService';
import { LoggingService } from './loggingService';
import { StatusBarService } from './statusBarService';
import { ChatParticipantService } from './chatParticipantService';
import { CopilotModelManager } from '../models/copilotModelManager';
import { UIManager } from './uiManager';
import { GitOperationsManager } from './gitOperationsManager';
import { ToolTestingWebviewService } from './toolTestingWebview';

import { LanguageModelToolProvider } from './languageModelToolProvider';

// Utility services
import { SymbolExtractor } from '../utils/symbolExtractor';
import { PromptGenerator } from '../models/promptGenerator';

// Tool-calling services
import { ToolRegistry } from '../models/toolRegistry';
import { ToolExecutor } from '../models/toolExecutor';
import { ConversationManager } from '../models/conversationManager';
import { ToolCallingAnalysisProvider } from './toolCallingAnalysisProvider';
import { FindSymbolTool } from '../tools/findSymbolTool';
import { FindUsagesTool } from '../tools/findUsagesTool';
import { ListDirTool } from '../tools/listDirTool';
import { FindFilesByPatternTool } from '../tools/findFilesByPatternTool';
import { ReadFileTool } from '../tools/readFileTool';
import { GetSymbolsOverviewTool } from '../tools/getSymbolsOverviewTool';
import { SearchForPatternTool } from '../tools/searchForPatternTool';
import { ThinkAboutContextTool } from '../tools/thinkAboutContextTool';
import { ThinkAboutTaskTool } from '../tools/thinkAboutTaskTool';
import { ThinkAboutCompletionTool } from '../tools/thinkAboutCompletionTool';
import { ThinkAboutInvestigationTool } from '../tools/thinkAboutInvestigationTool';
import { RunSubagentTool } from '../tools/runSubagentTool';
import { UpdatePlanTool } from '../tools/updatePlanTool';

// Subagent services
import { SubagentExecutor } from './subagentExecutor';
import { SubagentSessionManager } from './subagentSessionManager';
import { SubagentPromptGenerator } from '../prompts/subagentPromptGenerator';

import { Log } from './loggingService';

/**
 * Service registry interface for type-safe service access
 */
export interface IServiceRegistry {
    // Foundation services
    workspaceSettings: WorkspaceSettingsService;
    logging: LoggingService;
    statusBar: StatusBarService;

    // LLM services
    copilotModelManager: CopilotModelManager;
    promptGenerator: PromptGenerator;

    // UI and Git services
    uiManager: UIManager;
    gitOperations: GitOperationsManager;
    toolTestingWebview: ToolTestingWebviewService;
    chatParticipantService: ChatParticipantService;

    // Utility services
    symbolExtractor: SymbolExtractor;

    // Tool-calling services
    toolRegistry: ToolRegistry;
    toolExecutor: ToolExecutor;
    conversationManager: ConversationManager;
    toolCallingAnalysisProvider: ToolCallingAnalysisProvider;

    // Subagent services
    subagentExecutor: SubagentExecutor;
    subagentSessionManager: SubagentSessionManager;

    // Language Model Tool Provider
    languageModelToolProvider: LanguageModelToolProvider;
}

/**
 * ServiceManager handles centralized dependency injection and service lifecycle.
 * Uses a 3-phase initialization to properly order dependencies.
 */
export class ServiceManager implements vscode.Disposable {
    private services: Partial<IServiceRegistry> = {};
    private initialized = false;
    private disposed = false;

    constructor(private readonly context: vscode.ExtensionContext) {}

    /**
     * Initialize all services in proper dependency order
     */
    public async initialize(): Promise<IServiceRegistry> {
        if (this.initialized) {
            return this.services as IServiceRegistry;
        }

        try {
            // Phase 1: Foundation services (no dependencies)
            await this.initializeFoundationServices();

            // Phase 2: Core services (depend on foundation)
            await this.initializeCoreServices();

            // Phase 3: High-level services (depend on core services)
            await this.initializeHighLevelServices();

            this.initialized = true;
            return this.services as IServiceRegistry;
        } catch (error) {
            throw new Error(
                `Service initialization failed: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    /**
     * Get initialized service registry
     */
    public getServices(): IServiceRegistry {
        if (!this.initialized) {
            throw new Error(
                'ServiceManager not initialized. Call initialize() first.'
            );
        }
        return this.services as IServiceRegistry;
    }

    /**
     * Phase 1: Initialize foundation services
     */
    private async initializeFoundationServices(): Promise<void> {
        // Foundation services with no dependencies
        this.services.workspaceSettings = new WorkspaceSettingsService(
            this.context
        );
        this.services.logging = LoggingService.getInstance();
        this.services.logging.initialize(this.services.workspaceSettings);

        this.services.statusBar = StatusBarService.getInstance();

        // Initialize Git operations first to get repository root
        this.services.gitOperations = new GitOperationsManager(
            this.services.workspaceSettings
        );
        await this.services.gitOperations.initialize();

        // Get Git repository root path for UIManager dependency injection
        const repository = this.services.gitOperations.getRepository();
        const gitRootPath = repository?.rootUri.fsPath || '';

        // Initialize UIManager with Git repository root path
        this.services.uiManager = new UIManager(this.context, gitRootPath);
    }

    /**
     * Phase 2: Initialize core services
     */
    private async initializeCoreServices(): Promise<void> {
        // Language model manager
        this.services.copilotModelManager = new CopilotModelManager(
            this.services.workspaceSettings!
        );
        this.services.promptGenerator = new PromptGenerator();

        // Utility services (depend on gitOperations)
        this.services.symbolExtractor = new SymbolExtractor(
            this.services.gitOperations!
        );
    }

    /**
     * Phase 3: Initialize high-level services
     */
    private async initializeHighLevelServices(): Promise<void> {
        // Initialize tool-calling services
        this.services.toolRegistry = new ToolRegistry();
        this.services.toolExecutor = new ToolExecutor(
            this.services.toolRegistry,
            this.services.workspaceSettings!
        );
        this.services.conversationManager = new ConversationManager();
        this.services.subagentSessionManager = new SubagentSessionManager(
            this.services.workspaceSettings!
        );
        this.services.toolCallingAnalysisProvider =
            new ToolCallingAnalysisProvider(
                this.services.conversationManager,
                this.services.toolExecutor,
                this.services.copilotModelManager!,
                this.services.promptGenerator!,
                this.services.workspaceSettings!,
                this.services.subagentSessionManager
            );

        this.services.subagentExecutor = new SubagentExecutor(
            this.services.copilotModelManager!,
            this.services.toolRegistry,
            new SubagentPromptGenerator(),
            this.services.workspaceSettings!
        );

        // Wire up SubagentExecutor to ToolCallingAnalysisProvider for progress context sharing
        this.services.toolCallingAnalysisProvider.setSubagentExecutor(
            this.services.subagentExecutor
        );

        // Register available tools
        this.initializeTools();

        // Note: PlanSessionManager is created per-analysis in ToolCallingAnalysisProvider

        // Initialize tool testing webview service
        const gitRootPath =
            this.services.gitOperations!.getRepository()?.rootUri.fsPath || '';
        this.services.toolTestingWebview = new ToolTestingWebviewService(
            this.context,
            gitRootPath,
            this.services.toolRegistry,
            this.services.toolExecutor
        );

        this.services.chatParticipantService =
            ChatParticipantService.getInstance();
        this.services.chatParticipantService.setDependencies({
            toolExecutor: this.services.toolExecutor!,
            toolRegistry: this.services.toolRegistry!,
            workspaceSettings: this.services.workspaceSettings!,
            promptGenerator: this.services.promptGenerator!,
            gitOperations: this.services.gitOperations!,
        });

        // Register language model tools for Agent Mode
        const getSymbolsOverviewTool =
            this.services.toolRegistry!.getToolByName(
                'get_symbols_overview'
            ) as GetSymbolsOverviewTool;
        if (getSymbolsOverviewTool) {
            this.services.languageModelToolProvider =
                new LanguageModelToolProvider(getSymbolsOverviewTool);
            this.services.languageModelToolProvider.register();
        }
    }

    /**
     * Initialize and register available tools for the LLM
     */
    private initializeTools(): void {
        try {
            // Register the FindSymbolTool (Get Definition functionality)
            const findSymbolTool = new FindSymbolTool(
                this.services.gitOperations!,
                this.services.symbolExtractor!
            );
            this.services.toolRegistry!.registerTool(findSymbolTool);

            // Register the FindUsagesTool (Find Usages functionality)
            const findUsagesTool = new FindUsagesTool(
                this.services.gitOperations!
            );
            this.services.toolRegistry!.registerTool(findUsagesTool);

            // Register the ListDirTool (List Directory functionality)
            const listDirTool = new ListDirTool(this.services.gitOperations!);
            this.services.toolRegistry!.registerTool(listDirTool);

            // Register the FindFileTool (Find File functionality)
            const findFileTool = new FindFilesByPatternTool(
                this.services.gitOperations!
            );
            this.services.toolRegistry!.registerTool(findFileTool);

            // Register the ReadFileTool (Read File functionality)
            const readFileTool = new ReadFileTool(this.services.gitOperations!);
            this.services.toolRegistry!.registerTool(readFileTool);

            // Register the GetSymbolsOverviewTool (Get Symbols Overview functionality)
            const getSymbolsOverviewTool = new GetSymbolsOverviewTool(
                this.services.gitOperations!,
                this.services.symbolExtractor!
            );
            this.services.toolRegistry!.registerTool(getSymbolsOverviewTool);

            // Register the SearchForPatternTool (Search for Pattern functionality)
            const searchForPatternTool = new SearchForPatternTool(
                this.services.gitOperations!
            );
            this.services.toolRegistry!.registerTool(searchForPatternTool);

            this.services.toolRegistry!.registerTool(
                new ThinkAboutContextTool()
            );
            this.services.toolRegistry!.registerTool(new ThinkAboutTaskTool());
            this.services.toolRegistry!.registerTool(
                new ThinkAboutCompletionTool()
            );
            this.services.toolRegistry!.registerTool(
                new ThinkAboutInvestigationTool()
            );

            // Register the UpdatePlanTool for tracking review progress
            // Note: UpdatePlanTool gets PlanSessionManager from ToolExecutor per-analysis
            this.services.toolRegistry!.registerTool(
                new UpdatePlanTool(this.services.toolExecutor!)
            );

            // Register the RunSubagentTool for delegating complex investigations
            const runSubagentTool = new RunSubagentTool(
                this.services.subagentExecutor!,
                this.services.subagentSessionManager!,
                this.services.workspaceSettings!
            );
            this.services.toolRegistry!.registerTool(runSubagentTool);

            Log.info(
                `Registered ${this.services.toolRegistry!.getToolNames().length} tools: ${this.services.toolRegistry!.getToolNames().join(', ')}`
            );
        } catch (error) {
            Log.error(
                `Failed to initialize tools: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    /**
     * Dispose all services in reverse order
     */
    public dispose(): void {
        if (this.disposed) {
            return;
        }

        const servicesToDispose = [
            this.services.promptGenerator,
            this.services.languageModelToolProvider,
            this.services.toolCallingAnalysisProvider,
            this.services.conversationManager,
            this.services.toolExecutor,
            this.services.toolRegistry,
            this.services.copilotModelManager,
            this.services.chatParticipantService,
            this.services.gitOperations,
            this.services.statusBar,
            this.services.logging,
        ];

        for (const service of servicesToDispose) {
            if (service && typeof service.dispose === 'function') {
                try {
                    service.dispose();
                } catch (error) {
                    console.error('Error disposing service:', error);
                }
            }
        }

        this.disposed = true;
    }
}
