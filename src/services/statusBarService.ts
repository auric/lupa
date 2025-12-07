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
 * Service to manage multiple, independent status bar items.
 * Supports contextual, on-demand progress indicators and temporary messages.
 */
export class StatusBarService {
    private static instance: StatusBarService;
    private activeStatusItems: Map<string, vscode.StatusBarItem> = new Map();

    // Main status bar ID for the extension
    public static readonly MAIN_STATUS_BAR_ID = 'prAnalyzer.main';

    /**
     * Private constructor to enforce singleton pattern
     */
    private constructor() {
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
     * Show a progress indicator with a unique ID
     * @param id Unique identifier for this progress item
     * @param text Text to display (without icon)
     * @param tooltip Tooltip text
     * @param command Optional command to execute when clicked
     */
    public showProgress(id: string, text: string, tooltip: string, command?: string | vscode.Command): void {
        // Get existing item or create new one
        let statusItem = this.activeStatusItems.get(id);
        if (!statusItem) {
            statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
            this.activeStatusItems.set(id, statusItem);
        }

        // Set text with spinning icon, tooltip, and optional command
        statusItem.text = `$(sync~spin) ${text}`;
        statusItem.tooltip = tooltip;
        if (command) {
            statusItem.command = command;
        }
        statusItem.show();
    }

    /**
     * Hide and dispose a progress indicator
     * @param id Unique identifier for the progress item to hide
     */
    public hideProgress(id: string): void {
        const statusItem = this.activeStatusItems.get(id);
        if (statusItem) {
            statusItem.hide();
            statusItem.dispose();
            this.activeStatusItems.delete(id);
        }
    }

    /**
     * Update the message of an existing progress indicator
     * @param id Unique identifier for the progress item
     * @param message New message to display
     */
    public updateProgressMessage(id: string, message: string): void {
        const statusItem = this.activeStatusItems.get(id);
        if (statusItem) {
            statusItem.text = `$(sync~spin) ${message}`;
            statusItem.tooltip = message;
        }
    }

    /**
     * Show a temporary message that auto-hides after timeout
     * @param text Text to display (without icon)
     * @param timeout Duration in milliseconds
     * @param icon Icon type to display
     */
    public showTemporaryMessage(text: string, timeout: number, icon: 'check' | 'warning' | 'error' = 'check'): void {
        // Create a separate temporary status item (not stored in the map)
        const tempStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);

        // Set appropriate icon
        let iconString = '$(check)';
        switch (icon) {
            case 'warning':
                iconString = '$(warning)';
                break;
            case 'error':
                iconString = '$(error)';
                break;
            case 'check':
            default:
                iconString = '$(check)';
                break;
        }

        tempStatusItem.text = `${iconString} ${text}`;
        tempStatusItem.tooltip = text;
        tempStatusItem.show();

        // Auto-dispose after timeout
        setTimeout(() => {
            tempStatusItem.dispose();
        }, timeout);
    }

    /**
     * Dispose all status bar items
     */
    public dispose(): void {
        // Dispose all active status items
        for (const [id, statusItem] of this.activeStatusItems) {
            statusItem.dispose();
        }
        this.activeStatusItems.clear();
    }
}