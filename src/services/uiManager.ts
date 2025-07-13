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
    constructor() {
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
     * Generate PR analysis with HTML
     */
    public generatePRAnalysisHtml(title: string, diffText: string, context: string, analysis: string): string {
        let titleTruncated = title;
        if (title.length > 100) {
            titleTruncated = title.substring(0, 97) + '...';
        }
        return `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${titleTruncated}</title>
            <style>
                body {
                    font-family: var(--vscode-font-family);
                    font-size: var(--vscode-font-size);
                    color: var(--vscode-editor-foreground);
                    background-color: var(--vscode-editor-background);
                    padding: 20px;
                    line-height: 1.5;
                }
                h1 {
                    color: var(--vscode-titleBar-activeForeground);
                    font-size: 1.5em;
                    border-bottom: 1px solid var(--vscode-panel-border);
                    padding-bottom: 10px;
                }
                h2 {
                    color: var(--vscode-editor-foreground);
                    font-size: 1.3em;
                    margin-top: 20px;
                }
                h3 {
                    color: var(--vscode-textLink-foreground);
                    font-size: 1.1em;
                    margin-top: 15px;
                }
                pre {
                    background-color: var(--vscode-textCodeBlock-background);
                    padding: 10px;
                    border-radius: 5px;
                    overflow: auto;
                    font-family: var(--vscode-editor-font-family);
                    max-height: 300px;
                }
                code {
                    font-family: var(--vscode-editor-font-family);
                }
                .relevance {
                    color: var(--vscode-charts-green);
                    font-size: 0.9em;
                }
                .diff-stats {
                    color: var(--vscode-textLink-foreground);
                    margin-bottom: 20px;
                }
                .tabs {
                    display: flex;
                    margin-bottom: 20px;
                    border-bottom: 1px solid var(--vscode-panel-border);
                }
                .tab {
                    padding: 10px 15px;
                    cursor: pointer;
                    background-color: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                    margin-right: 5px;
                    border-radius: 5px 5px 0 0;
                }
                .tab.active {
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                }
                .tab-content {
                    display: none;
                }
                .tab-content.active {
                    display: block;
                }
                .hint {
                    font-style: italic;
                    color: var(--vscode-descriptionForeground);
                    margin-top: 10px;
                }
                .partial-truncation-notice {
                    font-style: italic;
                    color: var(--vscode-descriptionForeground); /* Same as hint or a bit more subtle */
                    display: inline-block; /* To allow margin if needed, though <br> handles spacing */
                    /* margin-top: 5px; */ /* Optional: if more space is desired around it */
                }
            </style>
        </head>
        <body>
            <h1>${titleTruncated}</h1>

            <div class="tabs">
                <div class="tab active" onclick="switchTab('analysis')">AI Analysis</div>
                <div class="tab" onclick="switchTab('context')">Context</div>
                <div class="tab" onclick="switchTab('diff')">Changes</div>
            </div>

            <div id="analysis" class="tab-content active">
                <div class="hint">AI analysis of the pull request</div>
                <div class="analysis-content">
                    ${this.markdownToHtml(analysis)}
                </div>
            </div>

            <div id="context" class="tab-content">
                <div class="hint">Showing relevant code context found for the changes</div>
                <div class="context-content">
                    ${this.markdownToHtml(context)}
                </div>
            </div>

            <div id="diff" class="tab-content">
                <div class="hint">Showing raw diff of the changes</div>
                <pre><code>${this.escapeHtml(diffText)}</code></pre>
            </div>

            <script>
                function switchTab(tabId) {
                    // Hide all tab content
                    document.querySelectorAll('.tab-content').forEach(content => {
                        content.classList.remove('active');
                    });

                    // Deactivate all tabs
                    document.querySelectorAll('.tab').forEach(tab => {
                        tab.classList.remove('active');
                    });

                    // Activate selected tab and content
                    document.getElementById(tabId).classList.add('active');
                    document.querySelector('.tab[onclick*="' + tabId + '"]').classList.add('active');
                }
            </script>
        </body>
        </html>
        `;
    }

    /**
     * Convert markdown to HTML (basic implementation)
     */
    private markdownToHtml(markdown: string): string {
        return markdown
            // Headings
            .replace(/^### (.*$)/gm, '<h3>$1</h3>')
            .replace(/^## (.*$)/gm, '<h2>$1</h2>')
            .replace(/^# (.*$)/gm, '<h1>$1</h1>')
            // Code blocks
            .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
            // Inline code
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            // Line breaks
            .replace(/\n/g, '<br>')
            // Specific message for partially truncated files
            .replace(/\[File content partially truncated to fit token limit\]/g, '<span class="partial-truncation-notice">[File content partially truncated to fit token limit]</span>')
            // File paths with relevance scores (ensure this comes after more specific replacements if there's overlap)
            .replace(/### File: `([^`]+)` \(Relevance: ([0-9.]+)%\)/g,
                '<h3>File: <code>$1</code> <span class="relevance">(Relevance: $2%)</span></h3>');
    }

    /**
     * Escape HTML special characters
     */
    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
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
            'Use optimal model (automatic selection)',
            'Force high-memory model (Jina Embeddings)',
            'Force low-memory model (MiniLM)'
        ];

        return await vscode.window.showQuickPick(options, {
            placeHolder: 'Select embedding model preference'
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

        panel.webview.html = this.generatePRAnalysisHtml(title, diffText, context, analysis);
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