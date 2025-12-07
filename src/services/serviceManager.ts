import * as vscode from 'vscode';
import * as path from 'path';

// Core services
import { WorkspaceSettingsService } from './workspaceSettingsService';
import { ResourceDetectionService } from './resourceDetectionService';
import { LoggingService } from './loggingService';
import { StatusBarService } from './statusBarService';
import { EmbeddingModelSelectionService } from './embeddingModelSelectionService';
import { VectorDatabaseService } from './vectorDatabaseService';
import { CopilotModelManager } from '../models/copilotModelManager';
import { CodeAnalysisService, CodeAnalysisServiceInitializer } from './codeAnalysisService';
import { UIManager } from './uiManager';
import { GitOperationsManager } from './gitOperationsManager';
import { ToolTestingWebviewService } from './toolTestingWebview';

// Complex services
import { IndexingService } from './indexingService';
import { EmbeddingDatabaseAdapter } from './embeddingDatabaseAdapter';
import { ContextProvider } from './contextProvider';
import { PromptGenerator } from '../models/promptGenerator';
import { TokenManagerService } from './tokenManagerService';
import { AnalysisProvider } from './analysisProvider';
import { IndexingManager } from './indexingManager';

// Utility services
import { SymbolExtractor } from '../utils/symbolExtractor';

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

// Subagent services
import { SubagentExecutor } from './subagentExecutor';
import { SubagentSessionManager } from './subagentSessionManager';
import { SubagentPromptGenerator } from '../prompts/subagentPromptGenerator';

import { EmbeddingModel } from './embeddingModelSelectionService';
import { Log } from './loggingService';

/**
 * Service registry interface for type-safe service access
 */
export interface IServiceRegistry {
    // Foundation services
    workspaceSettings: WorkspaceSettingsService;
    resourceDetection: ResourceDetectionService;
    logging: LoggingService;
    statusBar: StatusBarService;

    // Embeddings services
    embeddingModelSelection: EmbeddingModelSelectionService;
    vectorDatabase: VectorDatabaseService;
    codeAnalysis: CodeAnalysisService;

    // LLM services
    copilotModelManager: CopilotModelManager;
    promptGenerator: PromptGenerator;

    // UI and Git services
    uiManager: UIManager;
    gitOperations: GitOperationsManager;
    toolTestingWebview: ToolTestingWebviewService;

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

    // Complex services
    indexingService: IndexingService;
    embeddingDatabaseAdapter: EmbeddingDatabaseAdapter;
    contextProvider: ContextProvider;
    tokenManager: TokenManagerService;
    analysisProvider: AnalysisProvider;
    indexingManager: IndexingManager;
}

/**
 * ServiceManager handles centralized dependency injection and service lifecycle
 * Eliminates circular dependencies through proper initialization phases
 */
export class ServiceManager implements vscode.Disposable {
    private services: Partial<IServiceRegistry> = {};
    private initialized = false;
    private disposed = false;

    constructor(private readonly context: vscode.ExtensionContext) { }

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

            // Phase 3: Complex services (require careful ordering)
            await this.initializeComplexServices();

            // Phase 4: High-level services (depend on complex services)
            await this.initializeHighLevelServices();

            this.initialized = true;
            return this.services as IServiceRegistry;
        } catch (error) {
            throw new Error(`Service initialization failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Get initialized service registry
     */
    public getServices(): IServiceRegistry {
        if (!this.initialized) {
            throw new Error('ServiceManager not initialized. Call initialize() first.');
        }
        return this.services as IServiceRegistry;
    }

    /**
     * Phase 1: Initialize foundation services
     */
    private async initializeFoundationServices(): Promise<void> {
        // Initialize CodeAnalysisService first
        CodeAnalysisServiceInitializer.initialize(this.context.extensionPath);

        // Foundation services with no dependencies
        this.services.workspaceSettings = new WorkspaceSettingsService(this.context);
        this.services.resourceDetection = new ResourceDetectionService({
            memoryReserveGB: 4
        });
        this.services.logging = LoggingService.getInstance();
        this.services.logging.initialize(this.services.workspaceSettings);
        this.services.logging.setOutputTarget('channel');

        this.services.statusBar = StatusBarService.getInstance();
        this.services.codeAnalysis = new CodeAnalysisService();

        // Initialize Git operations first to get repository root
        this.services.gitOperations = new GitOperationsManager();
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
        // Model selection service
        this.services.embeddingModelSelection = new EmbeddingModelSelectionService(
            path.join(this.context.extensionPath, 'dist', 'models'),
            this.services.workspaceSettings!,
            this.services.resourceDetection!
        );

        // Language model manager
        this.services.copilotModelManager = new CopilotModelManager(this.services.workspaceSettings!);
        this.services.promptGenerator = new PromptGenerator();

        // Vector database service
        this.services.vectorDatabase = VectorDatabaseService.getInstance(this.context);

        // Set initial model dimension
        const initialModelInfo = this.services.embeddingModelSelection.selectOptimalModel().modelInfo;
        if (initialModelInfo && initialModelInfo.dimensions) {
            this.services.vectorDatabase.setCurrentModelDimension(initialModelInfo.dimensions);
        }

        // Utility services (depend on gitOperations)
        this.services.symbolExtractor = new SymbolExtractor(this.services.gitOperations!);
    }

    /**
     * Phase 3: Initialize complex services (dependency inversion pattern)
     * Uses true dependency inversion to eliminate circular dependencies
     */
    private async initializeComplexServices(): Promise<void> {
        // Step 1: Create IndexingManager with null storage interface initially
        // This breaks the circular dependency by depending on abstraction (interface)
        this.services.indexingManager = new IndexingManager(
            this.context,
            this.services.workspaceSettings!,
            this.services.embeddingModelSelection!,
            this.services.vectorDatabase!,
            this.services.resourceDetection!,
            null // Depend on interface abstraction, not concrete implementation
        );

        // Step 2: Get IndexingService from manager (independent of storage)
        this.services.indexingService = this.services.indexingManager.getIndexingService()!;

        if (!this.services.indexingService) {
            throw new Error('Failed to create IndexingService from IndexingManager');
        }

        // Step 3: Create concrete implementation of IEmbeddingStorage
        // The adapter implements the interface, creating true dependency inversion
        this.services.embeddingDatabaseAdapter = EmbeddingDatabaseAdapter.getInstance(
            this.context,
            this.services.vectorDatabase!,
            this.services.workspaceSettings!,
            this.services.indexingService
        );

        // Step 4: Inject the concrete implementation via the interface
        // IndexingManager depends on IEmbeddingStorage interface, not the concrete class
        this.services.indexingManager.setEmbeddingStorage(this.services.embeddingDatabaseAdapter);

        // Verify the dependency injection was successful
        if (!this.services.embeddingDatabaseAdapter) {
            throw new Error('Failed to create EmbeddingDatabaseAdapter');
        }
    }

    /**
     * Phase 4: Initialize high-level services
     */
    private async initializeHighLevelServices(): Promise<void> {
        // Context provider
        this.services.contextProvider = ContextProvider.createSingleton(
            this.context,
            this.services.embeddingDatabaseAdapter!,
            this.services.copilotModelManager!,
            this.services.codeAnalysis!
        );

        // Initialize tool-calling services
        this.services.toolRegistry = new ToolRegistry();
        this.services.toolExecutor = new ToolExecutor(this.services.toolRegistry, this.services.workspaceSettings!);
        this.services.conversationManager = new ConversationManager();
        this.services.subagentSessionManager = new SubagentSessionManager(this.services.workspaceSettings!);
        this.services.toolCallingAnalysisProvider = new ToolCallingAnalysisProvider(
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
        this.services.toolCallingAnalysisProvider.setSubagentExecutor(this.services.subagentExecutor);

        // Register available tools (including subagent tool)
        this.initializeTools();

        // Initialize tool testing webview service
        const gitRootPath = this.services.gitOperations!.getRepository()?.rootUri.fsPath || '';
        this.services.toolTestingWebview = new ToolTestingWebviewService(
            this.context,
            gitRootPath,
            this.services.toolRegistry,
            this.services.toolExecutor
        );

        this.services.tokenManager = new TokenManagerService(
            this.services.copilotModelManager!,
            this.services.promptGenerator!
        );
        this.services.analysisProvider = new AnalysisProvider(
            this.services.contextProvider,
            this.services.copilotModelManager!,
            this.services.tokenManager,
            this.services.promptGenerator!
        );
    }

    /**
     * Initialize and register available tools for the LLM
     */
    private initializeTools(): void {
        try {
            // Register the FindSymbolTool (Get Definition functionality)
            const findSymbolTool = new FindSymbolTool(this.services.gitOperations!, this.services.symbolExtractor!);
            this.services.toolRegistry!.registerTool(findSymbolTool);

            // Register the FindUsagesTool (Find Usages functionality)
            const findUsagesTool = new FindUsagesTool();
            this.services.toolRegistry!.registerTool(findUsagesTool);

            // Register the ListDirTool (List Directory functionality)
            const listDirTool = new ListDirTool(this.services.gitOperations!);
            this.services.toolRegistry!.registerTool(listDirTool);

            // Register the FindFileTool (Find File functionality)
            const findFileTool = new FindFilesByPatternTool(this.services.gitOperations!);
            this.services.toolRegistry!.registerTool(findFileTool);

            // Register the ReadFileTool (Read File functionality)
            const readFileTool = new ReadFileTool(this.services.gitOperations!);
            this.services.toolRegistry!.registerTool(readFileTool);

            // Register the GetSymbolsOverviewTool (Get Symbols Overview functionality)
            const getSymbolsOverviewTool = new GetSymbolsOverviewTool(this.services.gitOperations!, this.services.symbolExtractor!);
            this.services.toolRegistry!.registerTool(getSymbolsOverviewTool);

            // Register the SearchForPatternTool (Search for Pattern functionality)
            const searchForPatternTool = new SearchForPatternTool(this.services.gitOperations!);
            this.services.toolRegistry!.registerTool(searchForPatternTool);

            this.services.toolRegistry!.registerTool(new ThinkAboutContextTool());
            this.services.toolRegistry!.registerTool(new ThinkAboutTaskTool());
            this.services.toolRegistry!.registerTool(new ThinkAboutCompletionTool());
            this.services.toolRegistry!.registerTool(new ThinkAboutInvestigationTool());

            // Register the RunSubagentTool for delegating complex investigations
            const runSubagentTool = new RunSubagentTool(
                this.services.subagentExecutor!,
                this.services.subagentSessionManager!,
                this.services.workspaceSettings!
            );
            this.services.toolRegistry!.registerTool(runSubagentTool);

            Log.info(`Registered ${this.services.toolRegistry!.getToolNames().length} tools: ${this.services.toolRegistry!.getToolNames().join(', ')}`);
        } catch (error) {
            Log.error(`Failed to initialize tools: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Dispose all services in reverse order
     */
    public dispose(): void {
        if (this.disposed) return;

        const servicesToDispose = [
            this.services.analysisProvider,
            this.services.tokenManager,
            this.services.promptGenerator,
            this.services.toolCallingAnalysisProvider,
            this.services.conversationManager,
            this.services.toolExecutor,
            this.services.toolRegistry,
            this.services.contextProvider,
            this.services.embeddingDatabaseAdapter,
            this.services.indexingManager,
            this.services.vectorDatabase,
            this.services.copilotModelManager,
            this.services.embeddingModelSelection,
            this.services.gitOperations,
            this.services.statusBar,
            this.services.logging
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

    /**
     * Handle embedding model change with proper reinitialization
     * Used by EmbeddingModelCoordinator to delegate complex service reinitialization
     */
    public async handleEmbeddingModelChange(newSelectedModelEnumValue: EmbeddingModel | undefined): Promise<void> {
        if (!this.initialized) {
            throw new Error('ServiceManager not initialized');
        }

        const previousModel = this.services.indexingManager!.getSelectedModel();

        // Update workspace settings
        this.services.workspaceSettings!.setSelectedEmbeddingModel(newSelectedModelEnumValue);

        // Determine the actual model that will be used after selection
        const actualNewModelInfo = this.services.embeddingModelSelection!.selectOptimalModel();
        const actualNewModelName = actualNewModelInfo.modelInfo.name;

        // Check if the model has actually changed
        const modelChanged = previousModel !== actualNewModelName;

        if (modelChanged) {
            vscode.window.showInformationMessage(
                `Embedding model changed from "${previousModel || 'auto'}" to "${actualNewModelName}". The existing embedding database is incompatible and must be rebuilt.`
            );

            // Set the new model dimension in VectorDatabaseService
            const newDimension = actualNewModelInfo.modelInfo.dimensions;
            if (newDimension) {
                this.services.vectorDatabase!.setCurrentModelDimension(newDimension);
            } else {
                Log.warn('ServiceManager: Could not determine new model dimension for VectorDatabaseService during model change.');
            }

            // Reinitialize IndexingManager and dependent services with the new model
            await this.services.indexingManager!.initializeIndexingService(actualNewModelInfo.modelInfo);

            // Update the IndexingService reference
            this.services.indexingService = this.services.indexingManager!.getIndexingService()!;

            // Update the EmbeddingDatabaseAdapter with the new IndexingService instance
            const newEmbeddingDatabaseAdapter = EmbeddingDatabaseAdapter.getInstance(
                this.context,
                this.services.vectorDatabase!,
                this.services.workspaceSettings!,
                this.services.indexingService
            );

            this.services.embeddingDatabaseAdapter = newEmbeddingDatabaseAdapter;
            this.services.indexingManager!.setEmbeddingStorage(newEmbeddingDatabaseAdapter);

            // Ask if user wants to rebuild database with new model
            const rebuildChoice = await vscode.window.showQuickPick(['Yes, rebuild now', 'No, I will do it later'], {
                placeHolder: `Rebuild embedding database for the new model "${actualNewModelName}"? This is required for context retrieval to work correctly.`,
                ignoreFocusOut: true
            });

            if (rebuildChoice === 'Yes, rebuild now') {
                await this.services.indexingManager!.performFullReindexing();
            } else {
                vscode.window.showWarningMessage(
                    `Database not rebuilt. Context retrieval may not work correctly until the database is rebuilt for model "${actualNewModelName}".`
                );
            }
        } else {
            vscode.window.showInformationMessage(`Embedding model selection confirmed: "${actualNewModelName}". No change detected.`);
        }
    }
}