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

// Complex services
import { IndexingService } from './indexingService';
import { EmbeddingDatabaseAdapter } from './embeddingDatabaseAdapter';
import { ContextProvider } from './contextProvider';
import { AnalysisProvider } from './analysisProvider';
import { IndexingManager } from './indexingManager';
import { IEmbeddingStorage } from '../interfaces/embeddingStorage';
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

    // Model services
    embeddingModelSelection: EmbeddingModelSelectionService;
    vectorDatabase: VectorDatabaseService;
    copilotModelManager: CopilotModelManager;
    codeAnalysis: CodeAnalysisService;

    // UI and Git services
    uiManager: UIManager;
    gitOperations: GitOperationsManager;

    // Complex services
    indexingService: IndexingService;
    embeddingDatabaseAdapter: EmbeddingDatabaseAdapter;
    contextProvider: ContextProvider;
    analysisProvider: AnalysisProvider;
    indexingManager: IndexingManager;
}

/**
 * Service lifecycle phases for proper initialization ordering
 */
enum ServicePhase {
    Foundation = 1,
    Core = 2,
    Complex = 3,
    High = 4
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

        // UI and Git services (independent)
        this.services.uiManager = new UIManager(this.context);
        this.services.gitOperations = new GitOperationsManager();
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

        // Vector database service
        this.services.vectorDatabase = VectorDatabaseService.getInstance(this.context);

        // Set initial model dimension
        const initialModelInfo = this.services.embeddingModelSelection.selectOptimalModel().modelInfo;
        if (initialModelInfo && initialModelInfo.dimensions) {
            this.services.vectorDatabase.setCurrentModelDimension(initialModelInfo.dimensions);
        }
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

        // Analysis provider
        this.services.analysisProvider = new AnalysisProvider(
            this.services.contextProvider,
            this.services.copilotModelManager!
        );
    }

    /**
     * Dispose all services in reverse order
     */
    public dispose(): void {
        if (this.disposed) return;

        const servicesToDispose = [
            this.services.analysisProvider,
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