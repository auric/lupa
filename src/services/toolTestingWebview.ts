import * as vscode from 'vscode';
import { Log } from './loggingService';
import { ToolRegistry } from '../models/toolRegistry';
import { ToolExecutor } from '../models/toolExecutor';
import type {
    OpenFilePayload,
    ThemeUpdatePayload
} from '../types/webviewMessages';
import type { ToolInfo } from '../webview/types/toolTestingTypes';

/**
 * ToolTestingWebviewService handles the tool testing webview functionality
 */
export class ToolTestingWebviewService {
    constructor(
        private readonly extensionContext: vscode.ExtensionContext,
        private readonly gitRepositoryRoot: string,
        private readonly toolRegistry: ToolRegistry,
        private readonly toolExecutor: ToolExecutor
    ) {}

    /**
     * Open tool testing interface in a webview
     */
    public openToolTestingInterface(initialTool?: string, initialParameters?: Record<string, any>): vscode.WebviewPanel {
        const panel = vscode.window.createWebviewPanel(
            'toolTesting',
            'Tool Testing Interface',
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        panel.webview.html = this.generateToolTestingHtml(panel, initialTool, initialParameters);

        // Set up message listeners for tool testing webview
        this.setupToolTestingMessageHandlers(panel.webview);

        // Listen for theme changes and update webview
        const themeChangeDisposable = vscode.window.onDidChangeActiveColorTheme(() => {
            this.sendThemeToWebview(panel.webview);
        });

        // Clean up theme listener when panel is disposed
        panel.onDidDispose(() => {
            themeChangeDisposable.dispose();
        });

        return panel;
    }

    /**
     * Generate HTML for tool testing webview
     */
    private generateToolTestingHtml(panel: vscode.WebviewPanel, initialTool?: string, initialParameters?: Record<string, any>): string {
        // Generate URIs for the assets using extension context
        const mainScriptUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(
            this.extensionContext.extensionUri, 'dist', 'webview', 'toolTesting.js'
        ));

        const stylesUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(
            this.extensionContext.extensionUri, 'dist', 'webview', 'toolTesting.css'
        ));

        return `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Tool Testing Interface</title>
            <link href="${stylesUri}" rel="stylesheet">
            <style>
                body {
                    margin: 0;
                    padding: 0;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    background-color: var(--vscode-editor-background);
                    color: var(--vscode-editor-foreground);
                    overflow: hidden;
                }
                #root {
                    width: 100%;
                    height: 100vh;
                    overflow: hidden;
                }
                .loading {
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    height: 100vh;
                    font-size: 16px;
                    color: var(--vscode-descriptionForeground);
                }
                .loading-spinner {
                    width: 20px;
                    height: 20px;
                    border: 2px solid var(--vscode-progressBar-background);
                    border-top: 2px solid var(--vscode-progressBar-foreground);
                    border-radius: 50%;
                    animation: spin 1s linear infinite;
                    margin-right: 10px;
                }
                @keyframes spin {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                }
            </style>
        </head>
        <body>
            <div id="root">
                <div class="loading">
                    <div class="loading-spinner"></div>
                    Loading Tool Testing Interface...
                </div>
            </div>

            <script>
                // Acquire VSCode API immediately and make it globally available
                window.vscode = (function() {
                    if (typeof acquireVsCodeApi !== 'undefined') {
                        return acquireVsCodeApi();
                    }
                    return null;
                })();

                // Inject initial data into window object
                window.toolTestingData = {
                    initialTool: ${JSON.stringify(initialTool || null)},
                    initialParameters: ${JSON.stringify(initialParameters || {})}
                };

                // Inject initial theme data
                window.initialTheme = {
                    kind: ${vscode.window.activeColorTheme.kind},
                    isDarkTheme: ${vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark ||
            vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrast}
                };
            </script>
            <script type="module" src="${mainScriptUri}"></script>
        </body>
        </html>
        `;
    }

    /**
     * Set up message handlers for tool testing webview communication
     */
    private setupToolTestingMessageHandlers(webview: vscode.Webview): void {
        webview.onDidReceiveMessage(
            async (message: any) => {
                try {
                    switch (message.command) {
                        case 'getTools':
                            await this.handleGetTools(webview);
                            break;
                        case 'executeTool':
                            await this.handleExecuteTool(message.payload, webview);
                            break;
                        case 'openFile':
                            await this.handleOpenFileMessage(message.payload);
                            break;
                        default:
                            Log.warn(`Unknown tool testing message command: ${message.command}`);
                    }
                } catch (error) {
                    Log.error('Error handling tool testing message:', error);
                    webview.postMessage({
                        type: 'error',
                        payload: {
                            message: error instanceof Error ? error.message : 'Unknown error occurred',
                            suggestions: ['Check VS Code developer console for more details', 'Try refreshing the interface']
                        }
                    });
                }
            },
            undefined,
            this.extensionContext.subscriptions
        );
    }

    /**
     * Handle getting tools for the testing interface
     */
    private async handleGetTools(webview: vscode.Webview): Promise<void> {
        try {
            // Get real tools from ToolRegistry
            const tools = this.toolRegistry.getAllTools();
            
            const toolInfos: ToolInfo[] = tools.map(tool => ({
                name: tool.name,
                description: tool.description,
                schema: tool.schema,
                usageCount: 0, // Could be persisted later if needed
                isFavorite: false // Could be persisted later if needed
            }));

            webview.postMessage({
                type: 'tools',
                payload: { tools: toolInfos }
            });
        } catch (error) {
            Log.error('Error getting tools:', error);
            throw error;
        }
    }

    /**
     * Handle tool execution request
     */
    private async handleExecuteTool(payload: any, webview: vscode.Webview): Promise<void> {
        try {
            const { sessionId, toolName, parameters } = payload;

            Log.info(`Executing tool: ${toolName} with parameters:`, parameters);

            // Execute the actual tool
            const results = await this.toolExecutor.executeTools([{
                name: toolName,
                args: parameters
            }]);

            // Send results back to webview
            webview.postMessage({
                type: 'toolExecutionResult',
                payload: {
                    sessionId,
                    results: results.map(result => ({
                        id: `result-${Date.now()}-${Math.random()}`,
                        data: result
                    })),
                    executionTime: Date.now() // This could be more accurate with timing
                }
            });
        } catch (error) {
            Log.error('Error executing tool:', error);
            webview.postMessage({
                type: 'toolExecutionError',
                payload: {
                    sessionId: payload.sessionId,
                    error: error instanceof Error ? error.message : 'Tool execution failed'
                }
            });
        }
    }

    /**
     * Handle openFile message from webview
     */
    private async handleOpenFileMessage(payload: OpenFilePayload): Promise<void> {
        try {
            Log.info(`Opening file from webview: ${payload.filePath}`, payload);

            // Use vscode.Uri for secure file path handling
            const fileUri = vscode.Uri.file(payload.filePath);

            // Open the document
            const document = await vscode.workspace.openTextDocument(fileUri);

            // Prepare show options with line/column positioning
            const showOptions: vscode.TextDocumentShowOptions = {
                viewColumn: vscode.ViewColumn.One
            };

            // Set selection if line/column are provided
            if (payload.line !== undefined) {
                const line = Math.max(0, payload.line - 1); // Convert to 0-based indexing
                const column = Math.max(0, (payload.column ?? 1) - 1); // Convert to 0-based indexing

                const position = new vscode.Position(line, column);
                showOptions.selection = new vscode.Range(position, position);
            }

            // Show the document in the editor
            await vscode.window.showTextDocument(document, showOptions);

            Log.info(`Successfully opened file: ${payload.filePath}${payload.line ? ` at line ${payload.line}` : ''}`);
        } catch (error) {
            Log.error(`Failed to open file: ${payload.filePath}`, error);

            // Show user-friendly error message
            vscode.window.showErrorMessage(
                `Could not open file: ${payload.filePath}. ${error instanceof Error ? error.message : 'Unknown error'}`
            );
        }
    }

    /**
     * Send current theme information to webview
     */
    private sendThemeToWebview(webview: vscode.Webview): void {
        const activeTheme = vscode.window.activeColorTheme;
        const themeData: ThemeUpdatePayload = {
            kind: activeTheme.kind,
            isDarkTheme: activeTheme.kind === vscode.ColorThemeKind.Dark ||
                activeTheme.kind === vscode.ColorThemeKind.HighContrast
        };

        webview.postMessage({
            command: 'themeUpdate',
            payload: themeData
        });
    }
}