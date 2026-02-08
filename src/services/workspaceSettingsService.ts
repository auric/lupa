import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as z from 'zod';
import { getErrorMessage } from '../utils/errorUtils';
import { Log } from './loggingService';
import {
    WorkspaceSettingsSchema,
    WorkspaceSettings,
    ANALYSIS_LIMITS,
    SUBAGENT_LIMITS,
} from '../models/workspaceSettingsSchema';

const getDefaultSettings = (): WorkspaceSettings =>
    WorkspaceSettingsSchema.parse({});

/**
 * Marker used to indicate the repository path matches the workspace root.
 * Using "." makes settings portable across machines with different absolute paths.
 */
const WORKSPACE_ROOT_MARKER = '.';

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
        const workspaceRoot = workspaceFolders[0]!.uri.fsPath;
        const vscodeDir = path.join(workspaceRoot, '.vscode');

        // Create the .vscode directory if it doesn't exist
        if (!fs.existsSync(vscodeDir)) {
            try {
                fs.mkdirSync(vscodeDir, { recursive: true });
            } catch (error) {
                Log.error(
                    `Failed to create .vscode directory: ${getErrorMessage(error)}`
                );
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
                    Log.error(
                        `Invalid settings in ${this.settingsPath}: ${errorMessages}. Resetting to defaults.`
                    );
                    this.settings = getDefaultSettings();
                    this.saveSettings();
                }
            } else {
                this.settings = getDefaultSettings();
                this.saveSettings();
            }
        } catch (error) {
            Log.error(
                `Failed to load settings: ${getErrorMessage(error)}`,
                error
            );
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
            Log.error(
                `Failed to save settings: ${getErrorMessage(error)}`,
                error
            );
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
    public getSetting<K extends keyof WorkspaceSettings>(
        key: K,
        defaultValue: NonNullable<WorkspaceSettings[K]>
    ): NonNullable<WorkspaceSettings[K]> {
        const value = this.settings[key];
        return value !== undefined
            ? (value as NonNullable<WorkspaceSettings[K]>)
            : defaultValue;
    }

    /**
     * Set a setting by key
     * @param key Setting key
     * @param value Setting value
     */
    public setSetting<K extends keyof WorkspaceSettings>(
        key: K,
        value: WorkspaceSettings[K]
    ): void {
        this.settings[key] = value;
        this.debouncedSaveSettings();
    }

    /**
     * Get the primary workspace root path
     */
    private getWorkspaceRootPath(): string | undefined {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return undefined;
        }
        return workspaceFolders[0]!.uri.fsPath;
    }

    /**
     * Normalize path for comparison.
     * Handles: backslashes, trailing slashes, double slashes, and case sensitivity on Windows.
     */
    private normalizePath(p: string): string {
        let normalized = p
            .replace(/\\/g, '/') // Convert backslashes to forward slashes
            .replace(/\/+/g, '/') // Collapse multiple slashes to single
            .replace(/\/$/, ''); // Remove trailing slash
        return process.platform === 'win32'
            ? normalized.toLowerCase()
            : normalized;
    }

    /**
     * Get the selected repository path for this workspace.
     * Resolves the "." marker back to the workspace root path.
     */
    public getSelectedRepositoryPath(): string | undefined {
        const storedPath = this.settings.selectedRepositoryPath;
        if (storedPath === WORKSPACE_ROOT_MARKER) {
            return this.getWorkspaceRootPath();
        }
        return storedPath;
    }

    /**
     * Set the selected repository path for this workspace.
     * Stores "." when the path matches the workspace root for portability.
     * @param repoPath The absolute path to the repository root
     */
    public setSelectedRepositoryPath(repoPath: string | undefined): void {
        if (repoPath === undefined) {
            this.settings.selectedRepositoryPath = undefined;
            this.debouncedSaveSettings();
            return;
        }

        const workspaceRoot = this.getWorkspaceRootPath();
        if (
            workspaceRoot &&
            this.normalizePath(repoPath) === this.normalizePath(workspaceRoot)
        ) {
            this.settings.selectedRepositoryPath = WORKSPACE_ROOT_MARKER;
        } else {
            this.settings.selectedRepositoryPath = repoPath;
        }
        this.debouncedSaveSettings();
    }

    /**
     * Get the preferred model identifier in 'vendor/id' format.
     */
    public getPreferredModelIdentifier(): string | undefined {
        return this.settings.preferredModelIdentifier;
    }

    /**
     * Set the preferred model identifier.
     * @param identifier Model identifier in 'vendor/id' format (e.g., 'copilot/gpt-4.1')
     */
    public setPreferredModelIdentifier(identifier: string | undefined): void {
        this.settings.preferredModelIdentifier = identifier;
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
        this.settings.requestTimeoutSeconds =
            ANALYSIS_LIMITS.requestTimeoutSeconds.default;
        this.settings.maxSubagentsPerSession =
            SUBAGENT_LIMITS.maxPerSession.default;
        this.debouncedSaveSettings();
    }

    /**
     * Clear all workspace settings (except for selected models and repository)
     */
    public clearWorkspaceSettings(): void {
        const preferredModelIdentifier = this.settings.preferredModelIdentifier;
        const selectedRepositoryPath = this.settings.selectedRepositoryPath;

        this.settings = getDefaultSettings();

        if (preferredModelIdentifier) {
            this.settings.preferredModelIdentifier = preferredModelIdentifier;
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
