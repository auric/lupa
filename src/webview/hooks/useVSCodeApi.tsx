import type {
    WebviewMessageType,
    ToolTestingMessageType,
} from '../../types/webviewMessages';

/**
 * VSCode API interface for type safety
 */
interface WebviewAPI {
    postMessage: (message: WebviewMessageType | ToolTestingMessageType) => void;
}

/**
 * Custom hook to safely access the VSCode API
 * Uses the globally available vscode instance set in HTML
 * @returns VSCode API instance or null if not available
 */
export const useVSCodeApi = (): WebviewAPI | null => {
    // Simply return the global vscode instance that was acquired in the HTML
    const vscode = (window as any).vscode;

    // Type guard to ensure the API has the expected interface
    if (vscode && typeof vscode.postMessage === 'function') {
        return vscode as WebviewAPI;
    }

    return null;
};
