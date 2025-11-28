import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { EmbeddingModel } from './embeddingModelSelectionService';
import { Log } from './loggingService';

/**
 * Workspace settings for PR Analyzer
 */
export interface WorkspaceSettings {
    /**
     * Selected embedding model for this workspace
     */
    selectedEmbeddingModel?: EmbeddingModel;

    /**
     * Last indexing timestamp
     */
    lastIndexingTimestamp?: number;

    /**
     * Preferred language model family
     */
    preferredModelFamily?: string;

    /**
     * Preferred language model version
     */
    preferredModelVersion?: string;

    /**
     * Enable embedding-based LSP algorithm (legacy approach)
     * When false (default), uses new tool-calling approach for context retrieval
     */
    enableEmbeddingLspAlgorithm?: boolean;

    /**
     * Maximum number of tool calls per analysis session (default: 50)
     */
    maxToolCalls?: number;

    /**
     * Maximum conversation iterations before forcing final answer (default: 10)
     */
    maxIterations?: number;

    /**
     * Timeout in seconds for LLM requests (default: 60)
     */
    requestTimeoutSeconds?: number;

    /**
     * Other workspace-specific settings can be added here
     */
    [key: string]: any;
}

/**
 * Service for persisting and loading workspace-specific settings
 */
export class WorkspaceSettingsService implements vscode.Disposable {
    private static readonly SETTINGS_FILENAME = 'lupa.json';
    private settings: WorkspaceSettings = {};
    private settingsPath: string | null = null;
    private saveDebounceTimeout: NodeJS.Timeout | null = null;

    // Single source of truth for analysis limit defaults
    public static readonly DEFAULT_MAX_TOOL_CALLS = 50;
    public static readonly DEFAULT_MAX_ITERATIONS = 10;
    public static readonly DEFAULT_REQUEST_TIMEOUT_SECONDS = 60;

    // Valid ranges for clamping
    public static readonly MAX_TOOL_CALLS_RANGE = { min: 10, max: 200 } as const;
    public static readonly MAX_ITERATIONS_RANGE = { min: 3, max: 30 } as const;
    public static readonly REQUEST_TIMEOUT_RANGE = { min: 10, max: 300 } as const;

    /**
     * Creates a new WorkspaceSettingsService
     * @param context VS Code extension context
     */
    constructor(private readonly context: vscode.ExtensionContext) {
        this.initializeSettings();

        // Watch for workspace folder changes
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            this.initializeSettings();
        });
    }

    /**
     * Initialize settings for the current workspace
     */
    private initializeSettings(): void {
        // First try to get settings path from workspace
        this.settingsPath = this.getWorkspaceSettingsPath();

        // If no workspace is open, use global storage
        if (!this.settingsPath) {
            this.settingsPath = this.getGlobalSettingsPath();
        }

        // Load settings
        this.loadSettings();
    }

    /**
     * Get settings file path for the current workspace
     */
    private getWorkspaceSettingsPath(): string | null {
        // Get the workspace folder
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return null;
        }

        // Use the first workspace folder as the root
        const workspaceRoot = workspaceFolders[0].uri.fsPath;
        const vscodeDir = path.join(workspaceRoot, '.vscode');

        // Create the .vscode directory if it doesn't exist
        if (!fs.existsSync(vscodeDir)) {
            try {
                fs.mkdirSync(vscodeDir, { recursive: true });
            } catch (error) {
                Log.error(`Failed to create .vscode directory: ${error instanceof Error ? error.message : String(error)}`);
                return null;
            }
        }

        return path.join(vscodeDir, WorkspaceSettingsService.SETTINGS_FILENAME);
    }

    /**
     * Get settings file path for global storage
     */
    private getGlobalSettingsPath(): string {
        // If no workspace is open, use global storage
        return path.join(
            this.context.globalStorageUri.fsPath,
            WorkspaceSettingsService.SETTINGS_FILENAME
        );
    }

    /**
     * Load settings from disk
     */
    private loadSettings(): void {
        if (!this.settingsPath) {
            return;
        }

        try {
            if (fs.existsSync(this.settingsPath)) {
                const data = fs.readFileSync(this.settingsPath, 'utf-8');
                this.settings = JSON.parse(data);
            } else {
                // Initialize with default settings
                this.settings = {};
                this.saveSettings();
            }
        } catch (error) {
            Log.error(`Failed to load settings: ${error instanceof Error ? error.message : String(error)}`);
            // Initialize with default settings on error
            this.settings = {};
        }
    }

    /**
     * Save settings to disk
     */
    private saveSettings(): void {
        if (!this.settingsPath) {
            return;
        }

        try {
            // Make sure the directory exists
            const dir = path.dirname(this.settingsPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            // Write settings to file
            fs.writeFileSync(
                this.settingsPath,
                JSON.stringify(this.settings, null, 2),
                'utf-8'
            );
        } catch (error) {
            Log.error(`Failed to save settings: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Save settings with debounce to avoid excessive disk writes
     */
    private debouncedSaveSettings(): void {
        if (this.saveDebounceTimeout) {
            clearTimeout(this.saveDebounceTimeout);
        }

        this.saveDebounceTimeout = setTimeout(() => {
            this.saveSettings();
            this.saveDebounceTimeout = null;
        }, 500); // 500ms debounce
    }

    /**
     * Get a setting by key
     * @param key Setting key
     * @param defaultValue Default value if setting is not found
     */
    public getSetting<T>(key: string, defaultValue: T): T {
        return this.settings[key] !== undefined ? this.settings[key] : defaultValue;
    }

    /**
     * Set a setting by key
     * @param key Setting key
     * @param value Setting value
     */
    public setSetting<T>(key: string, value: T): void {
        this.settings[key] = value;
        this.debouncedSaveSettings();
    }

    /**
     * Get the selected embedding model for this workspace
     */
    public getSelectedEmbeddingModel(): EmbeddingModel | undefined {
        return this.settings.selectedEmbeddingModel;
    }

    /**
     * Set the selected embedding model for this workspace
     * @param model The model to set as selected
     */
    public setSelectedEmbeddingModel(model: EmbeddingModel | undefined): void {
        this.settings.selectedEmbeddingModel = model;
        this.debouncedSaveSettings();
    }

    /**
     * Get the preferred language model family
     */
    public getPreferredModelFamily(): string | undefined {
        return this.settings.preferredModelFamily;
    }

    /**
     * Set the preferred language model family
     * @param family The model family to set as preferred
     */
    public setPreferredModelFamily(family: string | undefined): void {
        this.settings.preferredModelFamily = family;
        this.debouncedSaveSettings();
    }

    /**
     * Get the preferred language model version
     */
    public getPreferredModelVersion(): string | undefined {
        return this.settings.preferredModelVersion;
    }

    /**
     * Set the preferred language model version
     * @param version The model version to set as preferred
     */
    public setPreferredModelVersion(version: string | undefined): void {
        this.settings.preferredModelVersion = version;
        this.debouncedSaveSettings();
    }

    /**
     * Get the last indexing timestamp
     */
    public getLastIndexingTimestamp(): number | undefined {
        return this.settings.lastIndexingTimestamp;
    }

    /**
     * Update the last indexing timestamp to current time
     */
    public updateLastIndexingTimestamp(): void {
        this.settings.lastIndexingTimestamp = Date.now();
        this.debouncedSaveSettings();
    }

    /**
     * Get whether embedding-based LSP algorithm is enabled
     * @returns true if enabled, false (default) if disabled
     */
    public isEmbeddingLspAlgorithmEnabled(): boolean {
        return this.settings.enableEmbeddingLspAlgorithm || false;
    }

    /**
     * Set whether embedding-based LSP algorithm is enabled
     * @param enabled Whether to enable the embedding LSP algorithm
     */
    public setEmbeddingLspAlgorithmEnabled(enabled: boolean): void {
        this.settings.enableEmbeddingLspAlgorithm = enabled;
        this.debouncedSaveSettings();
    }

    /**
     * Get the maximum number of tool calls per analysis session
     */
    public getMaxToolCalls(): number {
        return this.settings.maxToolCalls ?? WorkspaceSettingsService.DEFAULT_MAX_TOOL_CALLS;
    }

    /**
     * Set the maximum number of tool calls per analysis session
     */
    public setMaxToolCalls(value: number): void {
        const { min, max } = WorkspaceSettingsService.MAX_TOOL_CALLS_RANGE;
        this.settings.maxToolCalls = Math.max(min, Math.min(max, value));
        this.debouncedSaveSettings();
    }

    /**
     * Get the maximum conversation iterations
     */
    public getMaxIterations(): number {
        return this.settings.maxIterations ?? WorkspaceSettingsService.DEFAULT_MAX_ITERATIONS;
    }

    /**
     * Set the maximum conversation iterations
     */
    public setMaxIterations(value: number): void {
        const { min, max } = WorkspaceSettingsService.MAX_ITERATIONS_RANGE;
        this.settings.maxIterations = Math.max(min, Math.min(max, value));
        this.debouncedSaveSettings();
    }

    /**
     * Get the request timeout in seconds
     */
    public getRequestTimeoutSeconds(): number {
        return this.settings.requestTimeoutSeconds ?? WorkspaceSettingsService.DEFAULT_REQUEST_TIMEOUT_SECONDS;
    }

    /**
     * Set the request timeout in seconds
     */
    public setRequestTimeoutSeconds(value: number): void {
        const { min, max } = WorkspaceSettingsService.REQUEST_TIMEOUT_RANGE;
        this.settings.requestTimeoutSeconds = Math.max(min, Math.min(max, value));
        this.debouncedSaveSettings();
    }

    /**
     * Reset all analysis limit settings to their defaults
     */
    public resetAnalysisLimitsToDefaults(): void {
        delete this.settings.maxToolCalls;
        delete this.settings.maxIterations;
        delete this.settings.requestTimeoutSeconds;
        this.debouncedSaveSettings();
    }

    /**
     * Clear all workspace settings (except for selected models)
     */
    public clearWorkspaceSettings(): void {
        // Keep the selected models to maintain compatibility
        const selectedEmbeddingModel = this.settings.selectedEmbeddingModel;
        const preferredModelFamily = this.settings.preferredModelFamily;
        const preferredModelVersion = this.settings.preferredModelVersion;

        // Reset settings
        this.settings = {};

        // Restore selected models
        if (selectedEmbeddingModel) {
            this.settings.selectedEmbeddingModel = selectedEmbeddingModel;
        }

        if (preferredModelFamily) {
            this.settings.preferredModelFamily = preferredModelFamily;
        }

        if (preferredModelVersion) {
            this.settings.preferredModelVersion = preferredModelVersion;
        }

        this.saveSettings();
    }

    /**
     * Reset all workspace settings including selected models
     * Use with caution - changing model may cause incompatibility with existing data
     */
    public resetAllSettings(): void {
        this.settings = {};
        this.saveSettings();
    }

    /**
     * Clean up resources
     */
    public dispose(): void {
        if (this.saveDebounceTimeout) {
            clearTimeout(this.saveDebounceTimeout);
            this.saveSettings(); // Save immediately before disposal
        }
    }
}