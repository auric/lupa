import * as vscode from 'vscode';

/**
 * Types of messages that can be displayed on the status bar
 */
export enum StatusBarMessageType {
    Info = 'info',
    Warning = 'warning',
    Error = 'error',
    Working = 'working'
}

/**
 * Status information for the PR Analyzer
 */
export enum StatusBarState {
    Ready = 'ready',
    Indexing = 'indexing',
    Analyzing = 'analyzing',
    Error = 'error',
    Inactive = 'inactive'
}

/**
 * Service to manage status bar items centrally.
 * Ensures consistent status bar presentation across the extension.
 */
export class StatusBarService {
    private static instance: StatusBarService;
    private statusBarItem: vscode.StatusBarItem | undefined;
    private temporaryMessageTimeout: NodeJS.Timeout | undefined;
    private currentState: StatusBarState = StatusBarState.Ready;

    // Main status bar ID for the extension
    public static readonly MAIN_STATUS_BAR_ID = 'prAnalyzer.main';

    /**
     * Private constructor to enforce singleton pattern
     */
    private constructor() {
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.updateStatusBar();
    }

    /**
     * Get the singleton instance
     */
    public static getInstance(): StatusBarService {
        if (!StatusBarService.instance) {
            StatusBarService.instance = new StatusBarService();
        }
        return StatusBarService.instance;
    }

    /**
     * Reset the singleton instance (mainly for testing)
     */
    public static reset(): void {
        if (StatusBarService.instance) {
            StatusBarService.instance.dispose();
            StatusBarService.instance = undefined as any;
        }
    }

    /**
     * Set the current state of the PR Analyzer
     * @param state The current state
     * @param detail Optional details about the state
     */
    public setState(state: StatusBarState, detail?: string): void {
        this.currentState = state;
        this.updateStatusBar(detail);
    }

    /**
     * Show a temporary message on the status bar
     * @param message The message to show
     * @param timeoutMs How long to show the message (in milliseconds)
     * @param type The type of message
     */
    public showTemporaryMessage(
        message: string,
        timeoutMs: number = 3000,
        type: StatusBarMessageType = StatusBarMessageType.Info
    ): void {
        if (!this.statusBarItem) return;

        // Clear any existing temporary message timeout
        this.clearTemporaryMessage();

        // Remember current state
        const currentState = this.currentState;

        // Show temporary message
        this.setStatusBarText(message, message, type);

        // Set timeout to restore original state
        this.temporaryMessageTimeout = setTimeout(() => {
            this.currentState = currentState;
            this.updateStatusBar();
            this.temporaryMessageTimeout = undefined;
        }, timeoutMs);
    }

    /**
     * Set the text and tooltip of the status bar
     * @param text Status bar text
     * @param tooltip Tooltip text
     * @param type Type of message (affects icon)
     */
    private setStatusBarText(
        text: string,
        tooltip: string = '',
        type: StatusBarMessageType = StatusBarMessageType.Info
    ): void {
        if (!this.statusBarItem) return;

        // Add appropriate icon based on type
        let icon = '$(database)';
        switch (type) {
            case StatusBarMessageType.Warning:
                icon = '$(warning)';
                break;
            case StatusBarMessageType.Error:
                icon = '$(error)';
                break;
            case StatusBarMessageType.Working:
                icon = '$(sync~spin)';
                break;
            case StatusBarMessageType.Info:
            default:
                icon = '$(database)';
                break;
        }

        // Set text and tooltip
        this.statusBarItem.text = `${icon} ${text}`;
        this.statusBarItem.tooltip = tooltip || text;
        this.statusBarItem.show();
    }

    /**
     * Update the status bar based on current state
     * @param detail Optional details to show with the state
     */
    private updateStatusBar(detail?: string): void {
        if (!this.statusBarItem) return;

        let text = 'PR Analyzer';
        let tooltip = 'PR Analyzer';
        let type = StatusBarMessageType.Info;

        switch (this.currentState) {
            case StatusBarState.Ready:
                text = 'PR Analyzer - Ready';
                tooltip = 'PR Analyzer is ready';
                break;

            case StatusBarState.Indexing:
                text = detail ? `PR Analyzer - Indexing ${detail}` : 'PR Analyzer - Indexing';
                tooltip = detail ? `Indexing: ${detail}` : 'Indexing workspace';
                type = StatusBarMessageType.Working;
                break;

            case StatusBarState.Analyzing:
                text = 'PR Analyzer - Analyzing';
                tooltip = 'Analyzing pull request';
                type = StatusBarMessageType.Working;
                break;

            case StatusBarState.Error:
                text = 'PR Analyzer - Error';
                tooltip = detail || 'An error occurred';
                type = StatusBarMessageType.Error;
                break;

            case StatusBarState.Inactive:
                text = 'PR Analyzer';
                tooltip = 'PR Analyzer is inactive';
                break;
        }

        this.setStatusBarText(text, tooltip, type);
    }

    /**
     * Clear any temporary message
     */
    public clearTemporaryMessage(): void {
        if (this.temporaryMessageTimeout) {
            clearTimeout(this.temporaryMessageTimeout);
            this.temporaryMessageTimeout = undefined;
        }

        // Restore status based on current state
        this.updateStatusBar();
    }

    /**
     * Show the status bar
     */
    public show(): void {
        this.statusBarItem?.show();
    }

    /**
     * Hide the status bar
     */
    public hide(): void {
        this.statusBarItem?.hide();
    }

    /**
     * Dispose the status bar item
     */
    public dispose(): void {
        this.clearTemporaryMessage();
        this.statusBarItem?.dispose();
        this.statusBarItem = undefined;
    }
}