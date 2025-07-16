import * as vscode from 'vscode';
import { StatusBarService } from './statusBarService';
import { AnalysisMode } from '../types/modelTypes';

/**
 * UIManager handles all UI-related functionality
 */
export class UIManager {
    private statusBarService: StatusBarService;

    /**
     * Create a new UIManager
     */
    constructor(private readonly extensionContext: vscode.ExtensionContext) {
        this.statusBarService = StatusBarService.getInstance();
    }

    /**
     * Show quick pick for analysis type selection
     */
    public async showAnalysisTypeOptions(): Promise<string | undefined> {
        const analysisOptions = [
            { label: 'Current Branch vs Default Branch', description: 'Compare the current branch with the default branch' },
            { label: 'Select Branch', description: 'Select a branch to compare with the default branch' },
            { label: 'Select Commit', description: 'Select a specific commit to analyze' },
            { label: 'Current Changes', description: 'Analyze uncommitted changes' }
        ];

        const selectedOption = await vscode.window.showQuickPick(analysisOptions, {
            placeHolder: 'Select what to analyze',
            matchOnDescription: true
        });

        return selectedOption?.label;
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
                mode: AnalysisMode.Critical
            },
            {
                label: 'Comprehensive Review',
                description: 'Full analysis of all aspects of code',
                detail: 'Examines logic errors, security, performance, style, architecture, and testing coverage.',
                mode: AnalysisMode.Comprehensive
            },
            {
                label: 'Security Focus',
                description: 'Analyze for security vulnerabilities',
                detail: 'Identifies injection risks, auth issues, data exposure, insecure dependencies, and more.',
                mode: AnalysisMode.Security
            },
            {
                label: 'Performance Focus',
                description: 'Optimize code performance',
                detail: 'Finds algorithmic issues, resource leaks, I/O bottlenecks, and other performance concerns.',
                mode: AnalysisMode.Performance
            }
        ];

        const selected = await vscode.window.showQuickPick(options, {
            placeHolder: 'Select analysis focus mode',
            matchOnDetail: true,
            matchOnDescription: true
        });

        return selected?.mode;
    }

    /**
     * Generate PR analysis with HTML that loads React app
     */
    public generatePRAnalysisHtml(title: string, diffText: string, context: string, analysis: string, panel: vscode.WebviewPanel): string {
        let titleTruncated = title;
        if (title.length > 100) {
            titleTruncated = title.substring(0, 97) + '...';
        }

        // Generate URIs for the assets using extension context
        const mainScriptUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(
            this.extensionContext.extensionUri, 'dist', 'webview', 'main.js'
        ));

        return `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${titleTruncated}</title>
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
                    overflow: auto;
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
                // Inject analysis data into window object
                window.analysisData = {
                    title: ${JSON.stringify(titleTruncated)},
                    diffText: ${JSON.stringify(diffText)},
                    context: ${JSON.stringify(context)},
                    analysis: ${JSON.stringify(analysis)}
                };
            </script>
            <script src="${mainScriptUri}"></script>
        </body>
        </html>
        `;
    }

    /**
     * Show database management options
     */
    public async showDatabaseManagementOptions(): Promise<string | undefined> {
        const options = [
            'Optimize database',
            'Rebuild entire database',
            'Show database statistics'
        ];

        return await vscode.window.showQuickPick(options, {
            placeHolder: 'Select database management action'
        });
    }

    /**
     * Show model selection options
     */
    public async showModelSelectionOptions(): Promise<string | undefined> {
        const options = [
            'Use default model (MiniLM)',
            'Use high-memory model (Jina Embeddings)'
        ];

        return await vscode.window.showQuickPick(options, {
            placeHolder: 'Select embedding model'
        });
    }

    /**
     * Display analysis results in a webview
     */
    public displayAnalysisResults(title: string, diffText: string, context: string, analysis: string): vscode.WebviewPanel {
        const panel = vscode.window.createWebviewPanel(
            'prAnalyzerResults',
            title,
            vscode.ViewColumn.Beside,
            { enableScripts: true }
        );

        panel.webview.html = this.generatePRAnalysisHtml(title, diffText, context, analysis, panel);
        return panel;
    }

    /**
     * Show PR analysis progress
     */
    public showAnalysisProgress<T>(title: string, task: (progress: vscode.Progress<{ message?: string; increment?: number }>, token: vscode.CancellationToken) => Thenable<T>): Thenable<T> {
        return vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title,
            cancellable: true
        }, task);
    }

}