/**
 * Shared global type declarations for webview scripts.
 * Import this file in any webview entry point to ensure consistent typing.
 */

export interface ThemeData {
    kind: number;
    isDarkTheme: boolean;
}

export interface VsCodeApi {
    postMessage(message: unknown): void;
    getState(): unknown;
    setState(state: unknown): void;
}

// Declare acquireVsCodeApi which is injected by VS Code webview runtime
declare global {
    function acquireVsCodeApi(): VsCodeApi;

    interface Window {
        vscode: VsCodeApi | null;
        initialTheme: ThemeData | undefined;
    }
}
