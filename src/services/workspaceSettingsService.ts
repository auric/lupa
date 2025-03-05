import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { EmbeddingModel } from './modelSelectionService';

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
     * Other workspace-specific settings can be added here
     */
    [key: string]: any;
}

/**
 * Service for persisting and loading workspace-specific settings
 */
export class WorkspaceSettingsService implements vscode.Disposable {
    private static readonly SETTINGS_FILENAME = 'codelens-pr-analyzer.json';
    private settings: WorkspaceSettings = {};
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
                console.error(`Failed to create .vscode directory: ${error instanceof Error ? error.message : String(error)}`);
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
            console.error(`Failed to load settings: ${error instanceof Error ? error.message : String(error)}`);
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
            console.error(`Failed to save settings: ${error instanceof Error ? error.message : String(error)}`);
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
     * Clear all workspace settings (except for selected model)
     */
    public clearWorkspaceSettings(): void {
        // Keep the selected model to maintain compatibility
        const selectedModel = this.settings.selectedEmbeddingModel;

        // Reset settings
        this.settings = {};

        // Restore selected model
        if (selectedModel) {
            this.settings.selectedEmbeddingModel = selectedModel;
        }

        this.saveSettings();
    }

    /**
     * Reset all workspace settings including selected model
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