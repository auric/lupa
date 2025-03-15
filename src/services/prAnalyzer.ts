import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { IndexingService, FileToProcess, IndexingServiceOptions } from './indexingService';
import { StatusBarService, StatusBarMessageType, StatusBarState } from './statusBarService';
import { ResourceDetectionService } from './resourceDetectionService';
import { ModelSelectionService, EmbeddingModel } from './modelSelectionService';
import { WorkspaceSettingsService } from './workspaceSettingsService';
import { VectorDatabaseService } from './vectorDatabaseService';
import { EmbeddingDatabaseAdapter } from './embeddingDatabaseAdapter';
import { ContextProvider } from './contextProvider';
import { GitService, GitBranch, GitCommit } from './gitService';
import { getSupportedFilesGlob, getExcludePattern } from '../models/types';

/**
 * PRAnalyzer handles the main functionality of analyzing pull requests
 */
export class PRAnalyzer implements vscode.Disposable {
    private indexingService: IndexingService | null = null;
    private vectorDatabaseService: VectorDatabaseService;
    private embeddingDatabaseAdapter: EmbeddingDatabaseAdapter;
    private contextProvider: ContextProvider;
    private resourceDetectionService: ResourceDetectionService;
    private modelSelectionService: ModelSelectionService;
    private workspaceSettingsService: WorkspaceSettingsService;
    private statusBarService: StatusBarService;
    private gitService: GitService;
    private selectedModel: string | null = null;
    private continuousIndexingInProgress: boolean = false;
    private continuousIndexingCancellationToken: vscode.CancellationTokenSource | null = null;

    /**
     * Create a new PR Analyzer
     * @param context VS Code extension context
     */
    constructor(
        private readonly context: vscode.ExtensionContext
    ) {
        this.workspaceSettingsService = new WorkspaceSettingsService(context);

        // Initialize the required services
        this.resourceDetectionService = new ResourceDetectionService({
            memoryReserveGB: 4 // 4GB reserve for other processes
        });

        this.modelSelectionService = new ModelSelectionService(
            path.join(context.extensionPath, 'models'),
            this.workspaceSettingsService
        );

        // Initialize the vector database service
        this.vectorDatabaseService = VectorDatabaseService.getInstance(context);

        // Initialize the Git service
        this.gitService = GitService.getInstance();

        // Initialize the indexing service first so we can pass it to the adapter
        this.initializeIndexingService();

        // Initialize the embedding database adapter with the indexing service
        this.embeddingDatabaseAdapter = EmbeddingDatabaseAdapter.getInstance(
            context,
            this.vectorDatabaseService,
            this.workspaceSettingsService,
            this.indexingService!
        );

        // Initialize the context provider
        this.contextProvider = ContextProvider.getInstance(this.embeddingDatabaseAdapter);

        // Get the status bar service
        this.statusBarService = StatusBarService.getInstance();

        // Set the initial status
        this.statusBarService.setState(StatusBarState.Ready);

        // Register analyze PR command
        this.context.subscriptions.push(
            vscode.commands.registerCommand('codelens-pr-analyzer.analyzePR', () => this.analyzePR())
        );

        // Register model selection command
        this.context.subscriptions.push(
            vscode.commands.registerCommand('codelens-pr-analyzer.selectEmbeddingModel', () => this.showModelSelectionOptions())
        );

        // Register model info command
        this.context.subscriptions.push(
            vscode.commands.registerCommand('codelens-pr-analyzer.showModelsInfo', () => this.modelSelectionService.showModelsInfo())
        );

        // Register database management command
        this.context.subscriptions.push(
            vscode.commands.registerCommand('codelens-pr-analyzer.manageDatabase', () => this.showDatabaseManagementOptions())
        );

        // Register continuous indexing command
        this.context.subscriptions.push(
            vscode.commands.registerCommand('codelens-pr-analyzer.startContinuousIndexing', () => this.startContinuousIndexing())
        );

        // Register stop continuous indexing command
        this.context.subscriptions.push(
            vscode.commands.registerCommand('codelens-pr-analyzer.stopContinuousIndexing', () => this.stopContinuousIndexing())
        );
    }

    /**
     * Initialize or reinitialize the indexing service with the appropriate model
     */
    private initializeIndexingService(): void {
        // Dispose existing service if it exists
        if (this.indexingService) {
            this.indexingService.dispose();
        }

        // Get the selected model from ModelSelectionService
        // It will check workspace settings internally and handle model selection
        const { model, modelInfo } = this.modelSelectionService.selectOptimalModel();

        this.selectedModel = model;

        // Calculate optimal worker count
        const isHighMemoryModel = model === EmbeddingModel.JinaEmbeddings;
        const workerCount = this.calculateOptimalWorkerCount(isHighMemoryModel);

        // Create options for indexing service
        const options: IndexingServiceOptions = {
            modelBasePath: this.modelSelectionService.getBasePath(),
            modelName: model,
            maxWorkers: 1,
            contextLength: modelInfo.contextLength
        };

        // Create the indexing service
        this.indexingService = new IndexingService(
            this.context,
            this.workspaceSettingsService,
            options
        );

        console.log(`Initialized IndexingService with model: ${model}, workers: ${workerCount}, context length: ${modelInfo?.contextLength || 'unknown'}`);

        // If we already have an embeddingDatabaseAdapter, update it with the new IndexingService
        if (this.embeddingDatabaseAdapter) {
            // Update the reference to the indexing service by recreating the singleton instance
            this.embeddingDatabaseAdapter = EmbeddingDatabaseAdapter.getInstance(
                this.context,
                this.vectorDatabaseService,
                this.workspaceSettingsService,
                this.indexingService
            );

            // Recreate the context provider with the updated adapter
            this.contextProvider = ContextProvider.getInstance(this.embeddingDatabaseAdapter);
        }
    }

    /**
     * Calculate the optimal number of worker threads based on system resources
     */
    private calculateOptimalWorkerCount(isHighMemoryModel: boolean): number {
        return this.resourceDetectionService.calculateOptimalWorkerCount(
            isHighMemoryModel,
            Math.max(1, Math.floor(os.availableParallelism ? os.availableParallelism() : (os.cpus().length + 1) / 2))
        );
    }

    /**
     * Show options for selecting embedding model
     */
    private async showModelSelectionOptions(): Promise<void> {
        // Show model info first
        this.modelSelectionService.showModelsInfo();

        // Show options
        const options = [
            'Use optimal model (automatic selection)',
            'Force high-memory model (Jina Embeddings)',
            'Force low-memory model (MiniLM)'
        ];

        const selected = await vscode.window.showQuickPick(options, {
            placeHolder: 'Select embedding model preference'
        });

        if (!selected) {
            return;
        }
        let modelChanged = false;

        // Update settings based on selection
        switch (selected) {
            case options[0]: // Automatic
                const currentModel = this.workspaceSettingsService.getSelectedEmbeddingModel();
                modelChanged = currentModel !== undefined;
                this.workspaceSettingsService.setSelectedEmbeddingModel(undefined);
                break;

            case options[1]: // Force high-memory
                const hiMemModel = EmbeddingModel.JinaEmbeddings;
                modelChanged = this.selectedModel !== hiMemModel;
                this.workspaceSettingsService.setSelectedEmbeddingModel(hiMemModel);
                break;

            case options[2]: // Force low-memory
                const lowMemModel = EmbeddingModel.MiniLM;
                modelChanged = this.selectedModel !== lowMemModel;
                this.workspaceSettingsService.setSelectedEmbeddingModel(lowMemModel);
                break;
        }

        // Reinitialize indexing service if model changed
        if (modelChanged) {
            vscode.window.showInformationMessage('Reinitializing with new model selection...');
            this.initializeIndexingService();

            // Ask if user wants to rebuild database with new model
            const rebuild = await vscode.window.showQuickPick(['Yes', 'No'], {
                placeHolder: 'Rebuild embedding database with new model?'
            });

            if (rebuild === 'Yes') {
                // Delete existing embeddings for old model
                await this.rebuildDatabase();
            }
        }
    }

    /**
     * Show database management options
     */
    private async showDatabaseManagementOptions(): Promise<void> {
        // Show database stats first
        // const stats = await this.embeddingDatabaseAdapter.getStorageStats();
        // vscode.window.showInformationMessage(stats, { modal: true });

        // Show management options
        const options = [
            'Optimize database',
            'Rebuild entire database',
            'Show database statistics'
        ];

        const selected = await vscode.window.showQuickPick(options, {
            placeHolder: 'Select database management action'
        });

        if (!selected) {
            return;
        }

        switch (selected) {
            case options[0]: // Optimize
                await this.optimizeDatabase();
                break;

            case options[1]: // Rebuild
                await this.rebuildDatabase();
                break;

            case options[2]: // Stats
                const detailedStats = await this.embeddingDatabaseAdapter.getStorageStats();
                vscode.window.showInformationMessage(detailedStats, { modal: true });
                break;
        }
    }

    /**
     * Optimize the vector database
     */
    private async optimizeDatabase(): Promise<void> {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Optimizing database',
            cancellable: false
        }, async (progress) => {
            progress.report({ message: 'Running optimization...' });

            try {
                this.embeddingDatabaseAdapter.optimizeStorage();
                vscode.window.showInformationMessage('Database optimization complete');
            } catch (error) {
                vscode.window.showErrorMessage(`Database optimization failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        });
    }

    /**
     * Rebuild the database by clearing old embeddings and re-indexing
     */
    private async rebuildDatabase(): Promise<void> {
        const confirm = await vscode.window.showWarningMessage(
            'This will delete all embeddings and rebuild the database. Continue?',
            { modal: true },
            'Yes', 'No'
        );

        if (confirm !== 'Yes') {
            return;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Rebuilding database',
            cancellable: true
        }, async (progress, token) => {
            try {
                // Delete all embeddings for current model
                progress.report({ message: 'Deleting old embeddings...' });
                this.vectorDatabaseService.deleteEmbeddingsByModel(this.selectedModel || '');

                // Find files to reindex
                if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
                    vscode.window.showErrorMessage('No workspace folder open');
                    return;
                }

                const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;

                // Find files to process
                progress.report({ message: 'Finding files to index...' });
                const sourceFiles = await this.findSourceFiles(workspaceRoot);

                if (sourceFiles.length === 0) {
                    vscode.window.showInformationMessage('No files found to index');
                    return;
                }

                // Create file objects for indexing
                progress.report({ message: `Found ${sourceFiles.length} files to index` });
                const filesToProcess: FileToProcess[] = [];

                for (let i = 0; i < sourceFiles.length; i++) {
                    if (token.isCancellationRequested) {
                        vscode.window.showInformationMessage('Operation cancelled');
                        return;
                    }

                    try {
                        const filePath = sourceFiles[i];
                        const content = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
                        const fileContent = Buffer.from(content).toString('utf8');

                        filesToProcess.push({
                            id: filePath,
                            path: filePath,
                            content: fileContent
                        });

                        if (i % 10 === 0) {
                            progress.report({
                                message: `Prepared ${i + 1}/${sourceFiles.length} files`,
                                increment: (1 / sourceFiles.length) * 10
                            });
                        }
                    } catch (error) {
                        console.error(`Error reading file ${sourceFiles[i]}:`, error);
                    }
                }

                // Process files in batches to avoid OOM
                const batchSize = 20;
                for (let i = 0; i < filesToProcess.length; i += batchSize) {
                    if (token.isCancellationRequested) {
                        vscode.window.showInformationMessage('Operation cancelled');
                        return;
                    }

                    const batch = filesToProcess.slice(i, i + batchSize);
                    progress.report({
                        message: `Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(filesToProcess.length / batchSize)}`
                    });

                    // Process the batch
                    const results = await this.indexingService!.processFiles(batch, token);

                    // Store results in database
                    await this.embeddingDatabaseAdapter.storeEmbeddingResults(batch, results);

                    progress.report({
                        increment: (batch.length / filesToProcess.length) * 100,
                        message: `Completed ${Math.min(i + batchSize, filesToProcess.length)}/${filesToProcess.length} files`
                    });
                }

                vscode.window.showInformationMessage(`Database rebuilt with ${filesToProcess.length} files`);
            } catch (error) {
                if (token.isCancellationRequested) {
                    vscode.window.showInformationMessage('Operation cancelled');
                } else {
                    vscode.window.showErrorMessage(`Failed to rebuild database: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
        });
    }

    /**
     * Find source files in workspace for indexing
     */
    private async findSourceFiles(rootPath: string): Promise<string[]> {
        // Use VS Code API to find files
        const include = getSupportedFilesGlob();
        const excludePattern = getExcludePattern();

        const files = await vscode.workspace.findFiles(include, excludePattern);
        return files.map(file => file.fsPath);
    }

    /**
     * Analyze a pull request by selecting a Git branch or commit
     */
    private async analyzePR(): Promise<void> {
        // Ensure indexing service is initialized
        if (!this.indexingService) {
            this.initializeIndexingService();
        }

        try {
            // Set status to analyzing
            this.statusBarService.setState(StatusBarState.Analyzing);

            // Initialize Git service
            const isGitAvailable = await this.gitService.initialize();
            if (!isGitAvailable) {
                vscode.window.showErrorMessage('Git extension not available or no Git repository found in workspace.');
                this.statusBarService.setState(StatusBarState.Ready);
                return;
            }

            // Offer options for analysis type
            const analysisOptions = [
                { label: 'Current Branch vs Default Branch', description: 'Compare the current branch with the default branch' },
                { label: 'Select Branch', description: 'Select a branch to compare with the default branch' },
                { label: 'Select Commit', description: 'Select a specific commit to analyze' },
                { label: 'Current Changes', description: 'Analyze uncommitted changes' }
            ];

            const selectedOption = await vscode.window.showQuickPick(analysisOptions, {
                placeHolder: 'Select what to analyze',
                matchOnDescription: true
            });

            if (!selectedOption) {
                this.statusBarService.setState(StatusBarState.Ready);
                return;
            }

            // Get diff based on selected option
            const diffResult = await this.getDiffFromSelection(selectedOption.label);

            if (!diffResult) {
                this.statusBarService.setState(StatusBarState.Ready);
                return;
            }

            const { diffText, refName, error } = diffResult;

            if (error) {
                vscode.window.showErrorMessage(error);
                this.statusBarService.setState(StatusBarState.Ready);
                return;
            }

            if (!diffText || diffText.trim() === '') {
                vscode.window.showInformationMessage('No changes found to analyze.');
                this.statusBarService.setState(StatusBarState.Ready);
                return;
            }

            // Show progress notification
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'PR Analyzer',
                cancellable: true
            }, async (progress, token) => {
                // Step 1: Generate embeddings for the diff
                progress.report({ message: 'Analyzing changes...', increment: 10 });

                try {
                    // Find relevant code context for the diff
                    progress.report({ message: 'Finding relevant code context...', increment: 40 });

                    // Get context for the diff
                    const context = await this.contextProvider.getContextForDiff(diffText);
                    progress.report({ message: 'Context analysis complete', increment: 25 });

                    // Create a title based on the reference
                    const title = `PR Analysis: ${refName}`;

                    // Display the context in a webview
                    const panel = vscode.window.createWebviewPanel(
                        'prAnalyzerContext',
                        title,
                        vscode.ViewColumn.Beside,
                        { enableScripts: true }
                    );

                    panel.webview.html = this.generatePRContextHtml(title, diffText, context);
                    progress.report({ message: 'Analysis displayed', increment: 25 });

                    // Update status bar
                    this.statusBarService.showTemporaryMessage(
                        'Analysis complete',
                        5000,
                        StatusBarMessageType.Info
                    );
                } catch (error) {
                    if (token.isCancellationRequested) {
                        throw new Error('Operation cancelled');
                    }
                    throw new Error(`Failed to analyze PR: ${error instanceof Error ? error.message : String(error)}`);
                }

                // Reset status to ready
                this.statusBarService.setState(StatusBarState.Ready);
            });
        } catch (error) {
            if (error instanceof Error && error.message.includes('cancelled')) {
                vscode.window.showInformationMessage('Analysis cancelled');
                this.statusBarService.showTemporaryMessage(
                    'Analysis cancelled',
                    3000,
                    StatusBarMessageType.Warning
                );
            } else {
                const errorMessage = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Failed to analyze PR: ${errorMessage}`);
                this.statusBarService.showTemporaryMessage(
                    'Analysis failed',
                    5000,
                    StatusBarMessageType.Error
                );
                this.statusBarService.setState(StatusBarState.Error, errorMessage);
            }
            this.statusBarService.setState(StatusBarState.Ready);
        }
    }

    /**
     * Get diff based on user selection
     * @param selection The user's selected analysis type
     */
    private async getDiffFromSelection(selection: string): Promise<{ diffText: string, refName: string, error?: string } | undefined> {
        switch (selection) {
            case 'Current Branch vs Default Branch': {
                const repository = this.gitService.getRepository();
                if (!repository) {
                    vscode.window.showErrorMessage('No Git repository found in workspace.');
                    return undefined;
                }

                const currentBranch = repository.state.HEAD?.name;
                if (!currentBranch) {
                    vscode.window.showErrorMessage('Not currently on a branch.');
                    return undefined;
                }

                const defaultBranch = await this.gitService.getDefaultBranch();
                if (!defaultBranch) {
                    vscode.window.showErrorMessage('Could not determine default branch.');
                    return undefined;
                }

                return await this.gitService.compareBranches({ base: defaultBranch, compare: currentBranch });
            }

            case 'Select Branch': {
                // Fetch available branches
                const defaultBranch = await this.gitService.getDefaultBranch();
                if (!defaultBranch) {
                    vscode.window.showErrorMessage('Could not determine default branch.');
                    return undefined;
                }

                const branches = await this.gitService.getBranches();
                const branchItems = branches.map(branch => ({
                    label: branch.name,
                    description: branch.isDefault ? '(default branch)' : '',
                    picked: branch.isCurrent
                }));

                const selectedBranch = await vscode.window.showQuickPick(branchItems, {
                    placeHolder: 'Select a branch to analyze',
                });

                if (!selectedBranch) {
                    return undefined;
                }

                return await this.gitService.compareBranches({ base: defaultBranch, compare: selectedBranch.label });
            }

            case 'Select Commit': {
                // Get recent commits
                const commits = await this.gitService.getRecentCommits();

                if (commits.length === 0) {
                    vscode.window.showErrorMessage('No commits found in the repository.');
                    return undefined;
                }

                const commitItems = commits.map(commit => ({
                    label: commit.hash.substring(0, 7),
                    description: `${commit.message} (${new Date(commit.date).toLocaleDateString()})`,
                    detail: commit.author
                }));

                const selectedCommit = await vscode.window.showQuickPick(commitItems, {
                    placeHolder: 'Select a commit to analyze',
                });

                if (!selectedCommit) {
                    return undefined;
                }

                const fullCommitHash = commits.find(c => c.hash.startsWith(selectedCommit.label))?.hash;
                if (!fullCommitHash) {
                    vscode.window.showErrorMessage('Could not find the selected commit.');
                    return undefined;
                }

                // Get the diff for a single commit
                return await this.gitService.getCommitDiff(fullCommitHash);
            }

            case 'Current Changes': {
                // Get uncommitted changes
                return await this.gitService.getUncommittedChanges();
            }

            default:
                return undefined;
        }
    }

    /**
     * Generate HTML to display PR analysis context
     */
    private generatePRContextHtml(title: string, diffText: string, context: string): string {
        return `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${title}</title>
            <style>
                body {
                    font-family: var(--vscode-font-family);
                    font-size: var(--vscode-font-size);
                    color: var(--vscode-editor-foreground);
                    background-color: var(--vscode-editor-background);
                    padding: 20px;
                    line-height: 1.5;
                }
                h1 {
                    color: var(--vscode-titleBar-activeForeground);
                    font-size: 1.5em;
                    border-bottom: 1px solid var(--vscode-panel-border);
                    padding-bottom: 10px;
                }
                h2 {
                    color: var(--vscode-editor-foreground);
                    font-size: 1.3em;
                    margin-top: 20px;
                }
                h3 {
                    color: var(--vscode-textLink-foreground);
                    font-size: 1.1em;
                    margin-top: 15px;
                }
                pre {
                    background-color: var(--vscode-textCodeBlock-background);
                    padding: 10px;
                    border-radius: 5px;
                    overflow: auto;
                    font-family: var(--vscode-editor-font-family);
                    max-height: 300px;
                }
                code {
                    font-family: var(--vscode-editor-font-family);
                }
                .relevance {
                    color: var(--vscode-charts-green);
                    font-size: 0.9em;
                }
                .diff-stats {
                    color: var(--vscode-textLink-foreground);
                    margin-bottom: 20px;
                }
                .tabs {
                    display: flex;
                    margin-bottom: 20px;
                    border-bottom: 1px solid var(--vscode-panel-border);
                }
                .tab {
                    padding: 10px 15px;
                    cursor: pointer;
                    background-color: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                    margin-right: 5px;
                    border-radius: 5px 5px 0 0;
                }
                .tab.active {
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                }
                .tab-content {
                    display: none;
                }
                .tab-content.active {
                    display: block;
                }
                .hint {
                    font-style: italic;
                    color: var(--vscode-descriptionForeground);
                    margin-top: 10px;
                }
            </style>
        </head>
        <body>
            <h1>${title}</h1>

            <div class="tabs">
                <div class="tab active" onclick="switchTab('context')">Context Analysis</div>
                <div class="tab" onclick="switchTab('diff')">Changes</div>
            </div>

            <div id="context" class="tab-content active">
                <div class="hint">Showing relevant code context found for the changes</div>
                <div class="context-content">
                    ${this.markdownToHtml(context)}
                </div>
            </div>

            <div id="diff" class="tab-content">
                <div class="hint">Showing raw diff of the changes</div>
                <pre><code>${this.escapeHtml(diffText)}</code></pre>
            </div>

            <script>
                function switchTab(tabId) {
                    // Hide all tab content
                    document.querySelectorAll('.tab-content').forEach(content => {
                        content.classList.remove('active');
                    });

                    // Deactivate all tabs
                    document.querySelectorAll('.tab').forEach(tab => {
                        tab.classList.remove('active');
                    });

                    // Activate selected tab and content
                    document.getElementById(tabId).classList.add('active');
                    document.querySelector('.tab[onclick*="' + tabId + '"]').classList.add('active');
                }
            </script>
        </body>
        </html>
        `;
    }

    /**
     * Convert markdown to HTML (basic implementation)
     */
    private markdownToHtml(markdown: string): string {
        return markdown
            // Headings
            .replace(/^### (.*$)/gm, '<h3>$1</h3>')
            .replace(/^## (.*$)/gm, '<h2>$1</h2>')
            .replace(/^# (.*$)/gm, '<h1>$1</h1>')
            // Code blocks
            .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
            // Inline code
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            // Line breaks
            .replace(/\n/g, '<br>')
            // File paths with relevance scores
            .replace(/### File: `([^`]+)` \(Relevance: ([0-9.]+)%\)/g,
                '<h3>File: <code>$1</code> <span class="relevance">(Relevance: $2%)</span></h3>');
    }

    /**
     * Escape HTML special characters
     */
    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    /**
     * Start continuous indexing of workspace files
     * This will keep running in the background, indexing files that have not been indexed yet
     * or files that have been modified since they were last indexed
     */
    public async startContinuousIndexing(): Promise<void> {
        // Don't start if already in progress
        if (this.continuousIndexingInProgress) {
            vscode.window.showInformationMessage('Continuous indexing is already in progress');
            return;
        }

        // Ensure indexing service is initialized
        if (!this.indexingService) {
            this.initializeIndexingService();
        }

        // Create a cancellation token source
        this.continuousIndexingCancellationToken = new vscode.CancellationTokenSource();

        // Set flag to indicate indexing is in progress
        this.continuousIndexingInProgress = true;

        // Update status bar
        this.statusBarService.setState(StatusBarState.Indexing, 'continuous');

        try {
            // Find files to process
            if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
                vscode.window.showErrorMessage('No workspace folder open');
                this.continuousIndexingInProgress = false;
                this.statusBarService.setState(StatusBarState.Ready);
                return;
            }

            const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;

            // Find source files in workspace
            vscode.window.showInformationMessage('Starting continuous file indexing...');
            const sourceFiles = await this.findSourceFiles(workspaceRoot);

            if (sourceFiles.length === 0) {
                vscode.window.showInformationMessage('No files found to index');
                this.continuousIndexingInProgress = false;
                this.statusBarService.setState(StatusBarState.Ready);
                return;
            }

            vscode.window.showInformationMessage(`Found ${sourceFiles.length} files, checking which need indexing...`);

            // Process files in batches to keep memory usage under control
            const batchSize = 20;
            let totalFilesProcessed = 0;
            let totalFilesChecked = 0;
            let totalFilesNeededIndexing = 0;

            // Create a progress notification
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Continuous Indexing',
                cancellable: true
            }, async (progress, token) => {
                // Link our cancellation token with the progress token
                token.onCancellationRequested(() => {
                    if (this.continuousIndexingCancellationToken) {
                        this.continuousIndexingCancellationToken.cancel();
                    }
                });

                // Create a merged cancellation token
                const mergedToken = this.continuousIndexingCancellationToken!.token;

                for (let i = 0; i < sourceFiles.length; i += batchSize) {
                    // Check if operation was cancelled
                    if (mergedToken.isCancellationRequested) {
                        vscode.window.showInformationMessage('Continuous indexing cancelled');
                        break;
                    }

                    // Get batch of files
                    const fileBatch = sourceFiles.slice(i, i + batchSize);

                    // Process this batch of files - check if they need indexing
                    const filesToProcess: FileToProcess[] = [];

                    for (const filePath of fileBatch) {
                        try {
                            // Check if operation was cancelled
                            if (mergedToken.isCancellationRequested) {
                                break;
                            }

                            // Read file content
                            const content = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
                            const fileContent = Buffer.from(content).toString('utf8');

                            // Check if file needs to be indexed
                            const needsIndexing = await this.embeddingDatabaseAdapter.needsReindexing(filePath, fileContent);

                            // Increment total checked files counter
                            totalFilesChecked++;

                            // Update progress based on total files checked
                            const checkingProgressPercent = Math.round((totalFilesChecked / sourceFiles.length) * 100);
                            progress.report({
                                message: `Checked ${totalFilesChecked} of ${sourceFiles.length} files (${totalFilesNeededIndexing} need indexing)`,
                                increment: 100 / sourceFiles.length // Increment by percentage of one file
                            });

                            if (needsIndexing) {
                                // Add file to batch for processing
                                filesToProcess.push({
                                    id: filePath,
                                    path: filePath,
                                    content: fileContent
                                });
                                totalFilesNeededIndexing++;
                            }
                        } catch (error) {
                            console.error(`Error processing file ${filePath}:`, error);
                            totalFilesChecked++; // Still count as checked even if there was an error
                        }
                    }

                    // If there are files to index in this batch, process them
                    if (filesToProcess.length > 0) {
                        // Process files and get embeddings
                        const results = await this.indexingService!.processFiles(
                            filesToProcess,
                            mergedToken,
                            (processed, total) => {
                                // Don't report incremental progress here, just update message
                                // to avoid double-counting progress increments
                                progress.report({
                                    message: `Checked ${totalFilesChecked} of ${sourceFiles.length} files. ` +
                                        `Indexing ${processed}/${total} files in current batch...`
                                });
                            }
                        );

                        // Store embeddings in database
                        await this.embeddingDatabaseAdapter.storeEmbeddingResults(filesToProcess, results);

                        // Update counters
                        totalFilesProcessed += filesToProcess.length;

                        // Show overall progress based on files checked and indexed
                        progress.report({
                            message: `Checked ${totalFilesChecked}/${sourceFiles.length} files. ` +
                                `Indexed ${totalFilesProcessed}/${totalFilesNeededIndexing} files that needed indexing.`
                        });
                    }
                }

                // Finalize operation
                if (mergedToken.isCancellationRequested) {
                    vscode.window.showInformationMessage(
                        `Continuous indexing stopped. ` +
                        `Checked ${totalFilesChecked}/${sourceFiles.length} files. ` +
                        `Indexed ${totalFilesProcessed}/${totalFilesNeededIndexing} files.`
                    );
                } else {
                    vscode.window.showInformationMessage(
                        `Continuous indexing complete. ` +
                        `Checked ${totalFilesChecked}/${sourceFiles.length} files. ` +
                        `Indexed ${totalFilesProcessed}/${totalFilesNeededIndexing} files.`
                    );
                }
            });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Continuous indexing error: ${errorMessage}`);
        } finally {
            // Reset state
            this.continuousIndexingInProgress = false;
            this.continuousIndexingCancellationToken = null;

            // Update status bar
            this.statusBarService.setState(StatusBarState.Ready);
        }
    }

    /**
     * Stop continuous indexing if it's currently running
     */
    public stopContinuousIndexing(): void {
        if (this.continuousIndexingInProgress && this.continuousIndexingCancellationToken) {
            this.continuousIndexingCancellationToken.cancel();
            vscode.window.showInformationMessage('Stopping continuous indexing...');
        } else {
            vscode.window.showInformationMessage('No continuous indexing is currently running');
        }
    }

    /**
     * Dispose of resources
     */
    public dispose(): void {
        if (this.indexingService) {
            this.indexingService.dispose();
        }

        this.contextProvider.dispose();
        this.embeddingDatabaseAdapter.dispose();
        this.vectorDatabaseService.dispose();
        this.workspaceSettingsService.dispose();
        this.modelSelectionService.dispose();
    }
}