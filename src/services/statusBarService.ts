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
 * Service to manage status bar items centrally.
 * Ensures we don't create duplicate status bar items for the same functionality.
 */
export class StatusBarService {
    private static instance: StatusBarService;
    private statusBarItems: Map<string, vscode.StatusBarItem> = new Map();
    private temporaryMessages: Map<string, NodeJS.Timeout> = new Map();

    // Main status bar ID for the extension
    public static readonly MAIN_STATUS_BAR_ID = 'prAnalyzer.main';

    /**
     * Private constructor to enforce singleton pattern
     */
    private constructor() { }

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
     * Get or create a status bar item with the specified ID
     * @param id Unique identifier for the status bar item
     * @param alignment Alignment of the status bar item
     * @param priority Priority of the status bar item
     * @returns The status bar item
     */
    public getOrCreateItem(
        id: string,
        alignment: vscode.StatusBarAlignment = vscode.StatusBarAlignment.Right,
        priority: number = 100
    ): vscode.StatusBarItem {
        if (this.statusBarItems.has(id)) {
            return this.statusBarItems.get(id)!;
        }

        const item = vscode.window.createStatusBarItem(alignment, priority);
        this.statusBarItems.set(id, item);
        return item;
    }

    /**
     * Set the text and tooltip of the main status bar item
     * @param text Status bar text
     * @param tooltip Tooltip text
     * @param type Type of message (affects icon)
     */
    public setMainStatusBarText(
        text: string,
        tooltip: string = '',
        type: StatusBarMessageType = StatusBarMessageType.Info
    ): void {
        // Get the main status bar item
        const statusBar = this.getOrCreateItem(
            StatusBarService.MAIN_STATUS_BAR_ID,
            vscode.StatusBarAlignment.Right,
            100
        );

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
        statusBar.text = `${icon} ${text}`;
        statusBar.tooltip = tooltip || text;
        statusBar.show();
    }

    /**
     * Show a temporary message on the main status bar, then revert back
     * @param message The message to show
     * @param timeoutMs How long to show the message (in milliseconds)
     * @param type The type of message
     */
    public showTemporaryMessage(
        message: string,
        timeoutMs: number = 3000,
        type: StatusBarMessageType = StatusBarMessageType.Info
    ): void {
        // Remember current state to restore later
        const statusBar = this.getOrCreateItem(StatusBarService.MAIN_STATUS_BAR_ID);
        const originalText = statusBar.text;
        const originalTooltip = statusBar.tooltip;

        // Show temporary message
        this.setMainStatusBarText(message, message, type);

        // Cancel any existing timeout for this status bar
        if (this.temporaryMessages.has(StatusBarService.MAIN_STATUS_BAR_ID)) {
            clearTimeout(this.temporaryMessages.get(StatusBarService.MAIN_STATUS_BAR_ID)!);
        }

        // Set timeout to restore original state
        const timeout = setTimeout(() => {
            statusBar.text = originalText;
            statusBar.tooltip = originalTooltip;
            this.temporaryMessages.delete(StatusBarService.MAIN_STATUS_BAR_ID);
        }, timeoutMs);

        // Store timeout so it can be cancelled if needed
        this.temporaryMessages.set(StatusBarService.MAIN_STATUS_BAR_ID, timeout);
    }

    /**
     * Hide a status bar item by ID
     * @param id The ID of the status bar item to hide
     */
    public hideItem(id: string): void {
        if (this.statusBarItems.has(id)) {
            this.statusBarItems.get(id)!.hide();
        }
    }

    /**
     * Show a status bar item by ID
     * @param id The ID of the status bar item to show
     */
    public showItem(id: string): void {
        if (this.statusBarItems.has(id)) {
            this.statusBarItems.get(id)!.show();
        }
    }

    /**
     * Clear all temporary messages
     */
    public clearTemporaryMessages(): void {
        for (const timeoutId of this.temporaryMessages.values()) {
            clearTimeout(timeoutId);
        }
        this.temporaryMessages.clear();
    }

    /**
     * Dispose all status bar items
     */
    public dispose(): void {
        // Clear any temporary messages
        this.clearTemporaryMessages();

        // Dispose all status bar items
        this.statusBarItems.forEach(item => item.dispose());
        this.statusBarItems.clear();
    }
}