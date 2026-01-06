import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as z from 'zod';
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
 * User-set settings (partial). Only contains values explicitly set by the user.
 * Defaults are NOT stored here - they're applied at runtime from the schema.
 */
type UserSettings = Partial<WorkspaceSettings>;

/**
 * Service for persisting and loading workspace-specific settings.
 *
 * Design principle: Only user-modified values are saved to disk.
 * Defaults are applied at runtime from the Zod schema, ensuring:
 * - Config files remain minimal and portable
 * - New defaults in future versions aren't overridden by stale saved values
 */
export class WorkspaceSettingsService implements vscode.Disposable {
    private static readonly SETTINGS_FILENAME = 'lupa.json';

    /** User-set values only (partial). Saved to disk. */
    private userSettings: UserSettings = {};

    /** Resolved settings (user values merged with defaults). Used at runtime. */
    private settings: WorkspaceSettings = getDefaultSettings();

    private settingsPath: string | null = null;
    private saveDebounceTimeout: NodeJS.Timeout | null = null;

    /** File system watcher for detecting external settings changes */
    private fileWatcher: vscode.FileSystemWatcher | undefined;

    /** Flag to ignore file change events triggered by our own writes */
    private isWriting = false;

    /** Timer for clearing isWriting flag - tracked to prevent premature clearing */
    private isWritingTimeout: NodeJS.Timeout | null = null;

    /** Debounce timer for file change events */
    private reloadDebounceTimeout: NodeJS.Timeout | null = null;

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
        // Dispose existing file watcher if any
        this.fileWatcher?.dispose();
        this.fileWatcher = undefined;

        // Clear any pending reload debounce when reinitializing
        if (this.reloadDebounceTimeout) {
            clearTimeout(this.reloadDebounceTimeout);
            this.reloadDebounceTimeout = null;
        }

        // First try to get settings path from workspace
        this.settingsPath = this.getWorkspaceSettingsPath();

        // If no workspace is open, use global storage
        if (!this.settingsPath) {
            this.settingsPath = this.getGlobalSettingsPath();
        }

        // Load settings
        this.loadSettings();

        // Set up file watcher for external changes
        this.setupFileWatcher();
    }

    /**
     * Set up file system watcher to detect external changes to settings file.
     * Reloads settings when the file is modified externally (not by us).
     */
    private setupFileWatcher(): void {
        if (!this.settingsPath) {
            return;
        }

        try {
            const dir = path.dirname(this.settingsPath);
            const pattern = new vscode.RelativePattern(
                dir,
                WorkspaceSettingsService.SETTINGS_FILENAME
            );
            this.fileWatcher = vscode.workspace.createFileSystemWatcher(
                pattern,
                false, // Don't ignore creates
                false, // Don't ignore changes
                false // Don't ignore deletes
            );

            const handleFileChange = () => {
                // Ignore events triggered by our own writes
                if (this.isWriting) {
                    return;
                }

                // Debounce rapid changes (e.g., editor auto-save)
                if (this.reloadDebounceTimeout) {
                    clearTimeout(this.reloadDebounceTimeout);
                }

                this.reloadDebounceTimeout = setTimeout(() => {
                    this.reloadDebounceTimeout = null;
                    // Re-check isWriting to handle race where write started after event
                    if (this.isWriting) {
                        return;
                    }
                    Log.debug('Settings file changed externally, reloading...');
                    this.loadSettings();
                }, 300);
            };

            this.fileWatcher.onDidChange(handleFileChange);
            this.fileWatcher.onDidCreate(handleFileChange);
            this.fileWatcher.onDidDelete(handleFileChange);
        } catch (error) {
            Log.error(
                `Failed to set up file watcher: ${error instanceof Error ? error.message : String(error)}`
            );
        }
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
                    `Failed to create .vscode directory: ${error instanceof Error ? error.message : String(error)}`
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
     * Load settings from disk.
     * Only loads user-set values and merges with defaults at runtime.
     * Invalid individual settings are dropped, preserving valid ones.
     */
    private loadSettings(): void {
        if (!this.settingsPath) {
            this.userSettings = {};
            this.settings = getDefaultSettings();
            return;
        }

        try {
            if (fs.existsSync(this.settingsPath)) {
                const data = fs.readFileSync(this.settingsPath, 'utf-8');
                const parsed = JSON.parse(data) as UserSettings;

                // Validate the partial settings by merging with defaults
                const result = WorkspaceSettingsSchema.safeParse(parsed);

                if (result.success) {
                    // Store only the user-provided values (not the resolved ones)
                    this.userSettings = parsed;
                    // Apply defaults to get resolved settings
                    this.settings = result.data;
                } else {
                    // Validation failed - try to salvage valid individual keys
                    Log.warn(
                        `Some settings in ${this.settingsPath} are invalid. Keeping valid settings.`
                    );
                    this.userSettings = this.recoverValidSettings(parsed);
                    // Re-validate with salvaged settings to get proper defaults
                    const salvageResult = WorkspaceSettingsSchema.safeParse(
                        this.userSettings
                    );
                    this.settings = salvageResult.success
                        ? salvageResult.data
                        : getDefaultSettings();
                }
            } else {
                // File doesn't exist - use defaults, don't create file
                this.userSettings = {};
                this.settings = getDefaultSettings();
            }
        } catch (error) {
            Log.error(
                `Failed to load settings: ${error instanceof Error ? error.message : String(error)}`
            );
            this.userSettings = {};
            this.settings = getDefaultSettings();
        }
    }

    /**
     * Recover valid individual settings from a partially invalid config.
     * Invalid keys are dropped and logged.
     */
    private recoverValidSettings(
        parsed: Record<string, unknown>
    ): UserSettings {
        const salvaged: UserSettings = {};
        const schemaShape = WorkspaceSettingsSchema.shape;

        for (const key of Object.keys(parsed)) {
            if (!(key in schemaShape)) {
                // Unknown key - skip silently (looseObject strips these anyway)
                continue;
            }

            const fieldSchema = schemaShape[key as keyof typeof schemaShape];
            if (!fieldSchema) {
                continue;
            }

            const fieldResult = fieldSchema.safeParse(parsed[key]);
            if (fieldResult.success) {
                (salvaged as Record<string, unknown>)[key] = parsed[key];
            } else {
                Log.warn(
                    `Invalid setting '${key}': ${z.prettifyError(fieldResult.error)}. Using default.`
                );
            }
        }

        return salvaged;
    }

    /**
     * Save only user-modified settings to disk.
     * Defaults are NOT saved - they're applied at runtime.
     * If no user settings remain, deletes the file to keep config minimal.
     */
    private saveSettings(): void {
        if (!this.settingsPath) {
            return;
        }

        try {
            // If there are no user-set values, delete the file if it exists
            if (Object.keys(this.userSettings).length === 0) {
                if (fs.existsSync(this.settingsPath)) {
                    this.withWriteSuppression(() =>
                        fs.unlinkSync(this.settingsPath!)
                    );
                    Log.debug(
                        `Deleted empty settings file: ${this.settingsPath}`
                    );
                }
                return;
            }

            // Make sure the directory exists (not a watched operation)
            const dir = path.dirname(this.settingsPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            // Write only user-set values (not merged with defaults)
            this.withWriteSuppression(() =>
                fs.writeFileSync(
                    this.settingsPath!,
                    JSON.stringify(this.userSettings, null, 2),
                    'utf-8'
                )
            );
        } catch (error) {
            Log.error(
                `Failed to save settings: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    /**
     * Schedule clearing the isWriting flag after a delay.
     * Clears any existing timeout to prevent premature flag clearing.
     */
    private scheduleIsWritingClear(): void {
        if (this.isWritingTimeout) {
            clearTimeout(this.isWritingTimeout);
        }
        this.isWritingTimeout = setTimeout(() => {
            this.isWriting = false;
            this.isWritingTimeout = null;
        }, 500);
    }

    /**
     * Execute a file operation with write suppression.
     * Centralizes isWriting flag management to ensure consistent behavior:
     * - Sets isWriting before operation
     * - Schedules delayed clear on success (for file watcher grace period)
     * - Immediately clears on error
     */
    private withWriteSuppression<T>(fn: () => T): T {
        this.isWriting = true;
        try {
            const result = fn();
            this.scheduleIsWritingClear();
            return result;
        } catch (error) {
            this.isWriting = false;
            throw error;
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
     * Set a setting by key.
     * The value is marked as user-set and will be persisted.
     * @param key Setting key
     * @param value Setting value
     */
    public setSetting<K extends keyof WorkspaceSettings>(
        key: K,
        value: WorkspaceSettings[K]
    ): void {
        this.userSettings[key] = value;
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
        let valueToStore: string | undefined;

        if (repoPath === undefined) {
            valueToStore = undefined;
        } else {
            const workspaceRoot = this.getWorkspaceRootPath();
            if (
                workspaceRoot &&
                this.normalizePath(repoPath) ===
                    this.normalizePath(workspaceRoot)
            ) {
                valueToStore = WORKSPACE_ROOT_MARKER;
            } else {
                valueToStore = repoPath;
            }
        }

        if (valueToStore === undefined) {
            delete this.userSettings.selectedRepositoryPath;
        } else {
            this.userSettings.selectedRepositoryPath = valueToStore;
        }
        this.settings.selectedRepositoryPath = valueToStore;
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
        if (identifier === undefined) {
            delete this.userSettings.preferredModelIdentifier;
        } else {
            this.userSettings.preferredModelIdentifier = identifier;
        }
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
     * Reset all analysis limit settings to their defaults.
     * Removes the user-set values so defaults are applied at runtime.
     */
    public resetAnalysisLimitsToDefaults(): void {
        // Remove from user settings (so defaults apply)
        delete this.userSettings.maxIterations;
        delete this.userSettings.requestTimeoutSeconds;
        delete this.userSettings.maxSubagentsPerSession;

        // Apply defaults to resolved settings
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
        const preferredModelIdentifier =
            this.userSettings.preferredModelIdentifier;
        const selectedRepositoryPath = this.userSettings.selectedRepositoryPath;

        // Clear user settings
        this.userSettings = {};

        // Restore preserved values
        if (preferredModelIdentifier !== undefined) {
            this.userSettings.preferredModelIdentifier =
                preferredModelIdentifier;
        }
        if (selectedRepositoryPath !== undefined) {
            this.userSettings.selectedRepositoryPath = selectedRepositoryPath;
        }

        // Re-merge with defaults
        this.settings = {
            ...getDefaultSettings(),
            ...this.userSettings,
        };

        this.saveSettings();
    }

    /**
     * Reset all workspace settings including selected models
     * Use with caution - changing model may cause incompatibility with existing data
     */
    public resetAllSettings(): void {
        this.userSettings = {};
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
        if (this.reloadDebounceTimeout) {
            clearTimeout(this.reloadDebounceTimeout);
        }
        if (this.isWritingTimeout) {
            clearTimeout(this.isWritingTimeout);
        }
        this.fileWatcher?.dispose();
    }
}
