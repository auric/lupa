import * as vscode from 'vscode';
import { StatusBarService } from './statusBarService';
import { AnalysisMode } from '../types/modelTypes';
import type { ToolCallsData } from '../types/toolCallTypes';
import {
    type AnalysisTargetType,
    ANALYSIS_TARGET_OPTIONS,
} from '../types/analysisTypes';
import { Log } from './loggingService';
import type {
    WebviewMessageType,
    OpenFilePayload,
    ValidatePathPayload,
    PathValidationResultPayload,
    ThemeUpdatePayload,
} from '../types/webviewMessages';
import { safeJsonStringify } from '../utils/safeJson';

/**
 * UIManager handles all UI-related functionality
 */
export class UIManager {
    private statusBarService: StatusBarService;
    private activeAnalysisPanel: vscode.WebviewPanel | undefined;

    constructor(
        private readonly extensionContext: vscode.ExtensionContext,
        private readonly gitRepositoryRoot: string
    ) {
        this.statusBarService = StatusBarService.getInstance();
    }

    /**
     * Show quick pick for analysis type selection.
     * Only offers targets that maintain consistency between diff and tool-accessible state.
     */
    public async showAnalysisTypeOptions(): Promise<
        AnalysisTargetType | undefined
    > {
        const selectedOption = await vscode.window.showQuickPick(
            ANALYSIS_TARGET_OPTIONS.map((opt) => ({
                label: opt.label,
                description: opt.description,
                target: opt.target,
            })),
            {
                placeHolder: 'Select what to analyze',
                matchOnDescription: true,
            }
        );

        return selectedOption?.target;
    }

    /**
     * Select analysis mode for PR analysis
     */
    public async selectAnalysisMode(): Promise<AnalysisMode | undefined> {
        const options = [
            {
                label: 'Critical Issues',
                description: 'Focus only on high-impact problems',
                detail: 'Identifies bugs, errors, security vulnerabilities, and performance issues that could cause failures.',
                mode: AnalysisMode.Critical,
            },
            {
                label: 'Comprehensive Review',
                description: 'Full analysis of all aspects of code',
                detail: 'Examines logic errors, security, performance, style, architecture, and testing coverage.',
                mode: AnalysisMode.Comprehensive,
            },
            {
                label: 'Security Focus',
                description: 'Analyze for security vulnerabilities',
                detail: 'Identifies injection risks, auth issues, data exposure, insecure dependencies, and more.',
                mode: AnalysisMode.Security,
            },
            {
                label: 'Performance Focus',
                description: 'Optimize code performance',
                detail: 'Finds algorithmic issues, resource leaks, I/O bottlenecks, and other performance concerns.',
                mode: AnalysisMode.Performance,
            },
        ];

        const selected = await vscode.window.showQuickPick(options, {
            placeHolder: 'Select analysis focus mode',
            matchOnDetail: true,
            matchOnDescription: true,
        });

        return selected?.mode;
    }

    /**
     * Remove XML output tags from AI response before displaying to user
     * @param analysis The analysis text containing XML tags
     * @returns Cleaned analysis text without XML tags
     */
    private stripOutputTags(analysis: string): string {
        // Strip XML-style tags like <suggestion_security>, <example_fix>, etc.
        return analysis.replace(
            /<\/?(suggestion_\w+|example_fix|explanation)(\s[^>]*)?>/g,
            ''
        );
    }

    /**
     * Generate PR analysis with HTML that loads React app
     */
    public generatePRAnalysisHtml(
        title: string,
        diffText: string,
        analysis: string,
        panel: vscode.WebviewPanel,
        toolCalls: ToolCallsData | undefined
    ): string {
        // Strip output tags before sending to frontend
        const cleanedAnalysis = this.stripOutputTags(analysis);

        let titleTruncated = title;
        if (title.length > 100) {
            titleTruncated = title.substring(0, 97) + '...';
        }

        // Generate URIs for the assets using extension context
        const mainScriptUri = panel.webview.asWebviewUri(
            vscode.Uri.joinPath(
                this.extensionContext.extensionUri,
                'dist',
                'webview',
                'main.js'
            )
        );

        const mainStylesUri = panel.webview.asWebviewUri(
            vscode.Uri.joinPath(
                this.extensionContext.extensionUri,
                'dist',
                'webview',
                'main.css'
            )
        );

        return `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${titleTruncated}</title>
            <link href="${mainStylesUri}" rel="stylesheet">
            <style>
                body {
                    margin: 0;
                    padding: 0;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    background-color: #ffffff;
                    color: #000000;
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
                    color: #666;
                }
            </style>
        </head>
        <body>
            <div id="root">
                <div class="loading">Loading analysis...</div>
            </div>

            <script>
                // Acquire VSCode API immediately and make it globally available
                window.vscode = (function() {
                    if (typeof acquireVsCodeApi !== 'undefined') {
                        return acquireVsCodeApi();
                    }
                    return null;
                })();
            </script>
            <script id="analysis-data" type="application/json">
                ${safeJsonStringify({
                    title: titleTruncated,
                    diffText: diffText,
                    analysis: cleanedAnalysis,
                    toolCalls: toolCalls ?? null,
                })}
            </script>
            <script>
                // Parse analysis data from JSON script tag
                // Using JSON script tag avoids issues with special characters in JS template literals
                var jsonScript = document.getElementById('analysis-data');
                try {
                    if (jsonScript && jsonScript.textContent) {
                        window.analysisData = JSON.parse(jsonScript.textContent);
                    } else {
                        // Explicitly mark that no analysis data was available
                        window.analysisData = null;
                        console.error('Analysis data script tag is missing or empty.');
                    }
                } catch (e) {
                    window.analysisData = null;
                    var contentPreview = jsonScript && jsonScript.textContent
                        ? jsonScript.textContent.slice(0, 200)
                        : '';
                    console.error(
                        'Failed to parse analysis data. Content preview (first 200 chars):',
                        contentPreview,
                        'Error:',
                        e
                    );
                }

                // Inject initial theme data
                window.initialTheme = {
                    kind: ${vscode.window.activeColorTheme.kind},
                    isDarkTheme: ${
                        vscode.window.activeColorTheme.kind ===
                            vscode.ColorThemeKind.Dark ||
                        vscode.window.activeColorTheme.kind ===
                            vscode.ColorThemeKind.HighContrast
                    }
                };
            </script>
            <script type="module" src="${mainScriptUri}"></script>
        </body>
        </html>
        `;
    }

    /**
     * Display analysis results in a webview (reuses existing panel if open)
     */
    public displayAnalysisResults(
        title: string,
        diffText: string,
        analysis: string,
        toolCalls: ToolCallsData | undefined = undefined
    ): vscode.WebviewPanel {
        let panel: vscode.WebviewPanel;

        if (this.activeAnalysisPanel) {
            // Reuse existing panel (may have been showing progress)
            panel = this.activeAnalysisPanel;
            panel.title = title;
        } else {
            // Create new panel
            panel = vscode.window.createWebviewPanel(
                'prAnalyzerResults',
                title,
                vscode.ViewColumn.Beside,
                { enableScripts: true, retainContextWhenHidden: true }
            );
            this.activeAnalysisPanel = panel;
        }

        panel.webview.html = this.generatePRAnalysisHtml(
            title,
            diffText,
            analysis,
            panel,
            toolCalls
        );

        // Set up message listeners for webview communication
        this.setupWebviewMessageHandlers(panel.webview);

        // Listen for theme changes and update webview
        const themeChangeDisposable = vscode.window.onDidChangeActiveColorTheme(
            () => {
                this.sendThemeToWebview(panel.webview);
            }
        );

        // Clean up when panel is disposed
        panel.onDidDispose(() => {
            themeChangeDisposable.dispose();
            if (this.activeAnalysisPanel === panel) {
                this.activeAnalysisPanel = undefined;
            }
        });

        return panel;
    }

    /**
     * Set up message handlers for webview communication
     */
    private setupWebviewMessageHandlers(webview: vscode.Webview): void {
        webview.onDidReceiveMessage((message: WebviewMessageType) => {
            switch (message.command) {
                case 'openFile':
                    this.handleOpenFileMessage(message.payload);
                    break;
                case 'validatePath':
                    this.handleValidatePathMessage(message.payload, webview);
                    break;
                default:
                    Log.warn(
                        `Unknown webview message command: ${(message as any).command}`
                    );
            }
        });
    }

    /**
     * Handle openFile message from webview
     */
    private async handleOpenFileMessage(
        payload: OpenFilePayload
    ): Promise<void> {
        try {
            Log.debug(
                `Opening file from webview: ${payload.filePath}`,
                payload
            );

            // Use vscode.Uri for secure file path handling
            // Note: payload.filePath is now the resolved absolute path from validation
            const fileUri = vscode.Uri.file(payload.filePath);

            // Open the document
            const document = await vscode.workspace.openTextDocument(fileUri);

            // Prepare show options with line/column positioning
            const showOptions: vscode.TextDocumentShowOptions = {
                viewColumn: vscode.ViewColumn.One,
            };

            // Set selection if line/column are provided
            if (payload.line !== undefined) {
                const line = Math.max(0, payload.line - 1); // Convert to 0-based indexing
                const column = Math.max(0, (payload.column ?? 1) - 1); // Convert to 0-based indexing

                if (payload.endLine !== undefined) {
                    // Create range for line range selection
                    const endLine = Math.max(0, payload.endLine - 1); // Convert to 0-based indexing
                    const startPosition = new vscode.Position(line, column);
                    const endPosition = new vscode.Position(
                        endLine,
                        Number.MAX_SAFE_INTEGER
                    ); // End of endLine
                    showOptions.selection = new vscode.Range(
                        startPosition,
                        endPosition
                    );
                } else {
                    // Single line selection
                    const position = new vscode.Position(line, column);
                    showOptions.selection = new vscode.Range(
                        position,
                        position
                    );
                }
            }

            // Show the document in the editor
            await vscode.window.showTextDocument(document, showOptions);

            Log.debug(
                `Successfully opened file: ${payload.filePath}${payload.line ? ` at line ${payload.line}` : ''}`
            );
        } catch (error) {
            Log.error(`Failed to open file: ${payload.filePath}`, error);

            // Show user-friendly error message
            vscode.window.showErrorMessage(
                `Could not open file: ${payload.filePath}. ${error instanceof Error ? error.message : 'Unknown error'}`
            );
        }
    }

    /**
     * Handle validatePath message from webview
     */
    private async handleValidatePathMessage(
        payload: ValidatePathPayload,
        webview: vscode.Webview
    ): Promise<void> {
        try {
            Log.debug(`Validating file path from webview: ${payload.filePath}`);

            let isValid = false;
            let resolvedPath: string | undefined;

            // Strategy 1: Absolute path
            if (
                payload.filePath.includes(':') ||
                payload.filePath.startsWith('/')
            ) {
                const fileUri = vscode.Uri.file(payload.filePath);
                try {
                    const fileStat = await vscode.workspace.fs.stat(fileUri);
                    isValid = fileStat.type === vscode.FileType.File;
                    if (isValid) {
                        resolvedPath = fileUri.fsPath;
                    }
                } catch {}
            }

            // Strategy 2: Relative to Git repository root (primary strategy for PR paths)
            if (
                !isValid &&
                this.gitRepositoryRoot &&
                this.gitRepositoryRoot.trim() !== ''
            ) {
                const gitRelativeUri = vscode.Uri.joinPath(
                    vscode.Uri.file(this.gitRepositoryRoot),
                    payload.filePath
                );
                try {
                    const fileStat =
                        await vscode.workspace.fs.stat(gitRelativeUri);
                    isValid = fileStat.type === vscode.FileType.File;
                    if (isValid) {
                        resolvedPath = gitRelativeUri.fsPath;
                    }
                } catch {}
            }

            // Strategy 3: Relative to workspace root (fallback)
            if (
                !isValid &&
                vscode.workspace.workspaceFolders &&
                vscode.workspace.workspaceFolders.length > 0
            ) {
                const workspaceRoot = vscode.workspace.workspaceFolders[0]!.uri;
                const workspaceRelativeUri = vscode.Uri.joinPath(
                    workspaceRoot,
                    payload.filePath
                );
                try {
                    const fileStat =
                        await vscode.workspace.fs.stat(workspaceRelativeUri);
                    isValid = fileStat.type === vscode.FileType.File;
                    if (isValid) {
                        resolvedPath = workspaceRelativeUri.fsPath;
                    }
                } catch {}
            }

            // Send validation result back to webview (including resolved path for openFile)
            const response: PathValidationResultPayload = {
                filePath: payload.filePath,
                isValid,
                requestId: payload.requestId,
                ...(resolvedPath && { resolvedPath }),
            };

            webview.postMessage({
                command: 'pathValidationResult',
                payload: response,
            });

            Log.debug(
                `Path validation result for ${payload.filePath}: ${isValid}${resolvedPath ? ` (resolved: ${resolvedPath})` : ''}`
            );
        } catch (error) {
            // File doesn't exist or access error
            Log.debug(
                `Path validation failed for ${payload.filePath}: ${error instanceof Error ? error.message : 'Unknown error'}`
            );

            // Send negative validation result
            const response: PathValidationResultPayload = {
                filePath: payload.filePath,
                isValid: false,
                requestId: payload.requestId,
            };

            webview.postMessage({
                command: 'pathValidationResult',
                payload: response,
            });
        }
    }

    /**
     * Send current theme information to webview
     */
    private sendThemeToWebview(webview: vscode.Webview): void {
        const activeTheme = vscode.window.activeColorTheme;
        const themeData: ThemeUpdatePayload = {
            kind: activeTheme.kind,
            isDarkTheme:
                activeTheme.kind === vscode.ColorThemeKind.Dark ||
                activeTheme.kind === vscode.ColorThemeKind.HighContrast,
        };

        webview.postMessage({
            command: 'themeUpdate',
            payload: themeData,
        });
    }
}
