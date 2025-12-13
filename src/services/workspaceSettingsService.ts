import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod/v4';
import { EmbeddingModel } from './embeddingModelSelectionService';
import { Log } from './loggingService';
import { WorkspaceSettingsSchema, WorkspaceSettings, ANALYSIS_LIMITS, SUBAGENT_LIMITS } from '../models/workspaceSettingsSchema';

const getDefaultSettings = (): WorkspaceSettings => WorkspaceSettingsSchema.parse({});

/**
 * Service for persisting and loading workspace-specific settings
 */
export class WorkspaceSettingsService implements vscode.Disposable {
    private static readonly SETTINGS_FILENAME = 'lupa.json';
    private settings: WorkspaceSettings = getDefaultSettings();
    private settingsPath: string | null = null;
    private saveDebounceTimeout: NodeJS.Timeout | null = null;

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
                const parsed = JSON.parse(data);
                const result = WorkspaceSettingsSchema.safeParse(parsed);

                if (result.success) {
                    this.settings = result.data;
                } else {
                    const errorMessages = z.prettifyError(result.error);
                    Log.error(`Invalid settings in ${this.settingsPath}: ${errorMessages}. Resetting to defaults.`);
                    this.settings = getDefaultSettings();
                    this.saveSettings();
                }
            } else {
                this.settings = getDefaultSettings();
                this.saveSettings();
            }
        } catch (error) {
            Log.error(`Failed to load settings: ${error instanceof Error ? error.message : String(error)}`);
            this.settings = getDefaultSettings();
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
    public getSetting<K extends keyof WorkspaceSettings>(key: K, defaultValue: NonNullable<WorkspaceSettings[K]>): NonNullable<WorkspaceSettings[K]> {
        const value = this.settings[key];
        return value !== undefined ? value as NonNullable<WorkspaceSettings[K]> : defaultValue;
    }

    /**
     * Set a setting by key
     * @param key Setting key
     * @param value Setting value
     */
    public setSetting<K extends keyof WorkspaceSettings>(key: K, value: WorkspaceSettings[K]): void {
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
     * Get the selected repository path for this workspace
     */
    public getSelectedRepositoryPath(): string | undefined {
        return this.settings.selectedRepositoryPath;
    }

    /**
     * Set the selected repository path for this workspace
     * @param path The absolute path to the repository root
     */
    public setSelectedRepositoryPath(path: string | undefined): void {
        this.settings.selectedRepositoryPath = path;
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
     */
    public isEmbeddingLspAlgorithmEnabled(): boolean {
        return this.settings.enableEmbeddingLspAlgorithm;
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
     * Get the maximum conversation iterations
     */
    public getMaxIterations(): number {
        return this.settings.maxIterations;
    }

    /**
     * Get the request timeout in seconds
     */
    public getRequestTimeoutSeconds(): number {
        return this.settings.requestTimeoutSeconds;
    }

    /**
     * Get the maximum subagents per analysis session
     */
    public getMaxSubagentsPerSession(): number {
        return this.settings.maxSubagentsPerSession;
    }

    /**
     * Reset all analysis limit settings to their defaults
     */
    public resetAnalysisLimitsToDefaults(): void {
        this.settings.maxIterations = ANALYSIS_LIMITS.maxIterations.default;
        this.settings.requestTimeoutSeconds = ANALYSIS_LIMITS.requestTimeoutSeconds.default;
        this.settings.maxSubagentsPerSession = SUBAGENT_LIMITS.maxPerSession.default;
        this.debouncedSaveSettings();
    }

    /**
     * Clear all workspace settings (except for selected models and repository)
     */
    public clearWorkspaceSettings(): void {
        const selectedEmbeddingModel = this.settings.selectedEmbeddingModel;
        const preferredModelVersion = this.settings.preferredModelVersion;
        const selectedRepositoryPath = this.settings.selectedRepositoryPath;

        this.settings = getDefaultSettings();

        if (selectedEmbeddingModel) {
            this.settings.selectedEmbeddingModel = selectedEmbeddingModel;
        }

        if (preferredModelVersion) {
            this.settings.preferredModelVersion = preferredModelVersion;
        }

        if (selectedRepositoryPath) {
            this.settings.selectedRepositoryPath = selectedRepositoryPath;
        }

        this.saveSettings();
    }

    /**
     * Reset all workspace settings including selected models
     * Use with caution - changing model may cause incompatibility with existing data
     */
    public resetAllSettings(): void {
        this.settings = getDefaultSettings();
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