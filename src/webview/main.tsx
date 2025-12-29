import React from 'react';
import { createRoot } from 'react-dom/client';
import AnalysisView from './AnalysisView';
import type { ToolCallsData } from '../types/toolCallTypes';
import './types/webviewGlobals'; // Import for side-effect (global declarations)
import './globals.css';
import { onDomReady } from './utils/domReady';

declare global {
    interface Window {
        analysisData: {
            title: string;
            diffText: string;
            analysis: string;
            toolCalls: ToolCallsData | null;
        };
    }
}

// Analysis Application Component
const AnalysisApp: React.FC = () => {
    // Get analysis data from window object injected by extension
    const analysisData = window.analysisData;

    if (!analysisData || typeof analysisData !== 'object') {
        return (
            <div
                style={{
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'center',
                    alignItems: 'center',
                    height: '100vh',
                    fontFamily:
                        "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
                    color: 'var(--vscode-foreground)',
                    backgroundColor: 'var(--vscode-editor-background)',
                    textAlign: 'center',
                    padding: '20px',
                }}
            >
                <div style={{ fontSize: '48px', marginBottom: '20px' }}>⚠️</div>
                <h2 style={{ marginBottom: '10px' }}>
                    Analysis Data Not Found
                </h2>
                <p
                    style={{
                        color: 'var(--vscode-descriptionForeground)',
                        marginBottom: '20px',
                    }}
                >
                    The analysis data was not properly initialized.
                </p>
                <p
                    style={{
                        fontSize: '14px',
                        color: 'var(--vscode-descriptionForeground)',
                    }}
                >
                    Please check the VS Code developer console for more
                    information.
                </p>
            </div>
        );
    }

    return (
        <AnalysisView
            title={analysisData.title}
            diffText={analysisData.diffText}
            analysis={analysisData.analysis}
            toolCalls={analysisData.toolCalls}
        />
    );
};

// Initialize the React application
// Note: Module scripts execute after DOMContentLoaded, so we use onDomReady
// to handle both cases (still loading vs already ready)
onDomReady(() => {
    const container = document.getElementById('root');
    if (!container) {
        console.error('Root container not found');
        return;
    }

    const root = createRoot(container);

    try {
        root.render(<AnalysisApp />);
    } catch (error) {
        console.error('Failed to render analysis interface:', error);

        // Fallback error display
        container.innerHTML = `
      <div style="
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: center;
        height: 100vh;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        color: var(--vscode-foreground);
        background-color: var(--vscode-editor-background);
        text-align: center;
        padding: 20px;
      ">
        <div style="font-size: 48px; margin-bottom: 20px;">⚠️</div>
        <h2 style="margin-bottom: 10px;">Analysis Interface Failed to Load</h2>
        <p style="color: var(--vscode-descriptionForeground); margin-bottom: 20px;">
          There was an error initializing the interface.
        </p>
        <details style="
          max-width: 600px;
          text-align: left;
          background: var(--vscode-editor-background);
          border: 1px solid var(--vscode-panel-border);
          padding: 10px;
          border-radius: 4px;
        ">
          <summary style="cursor: pointer; margin-bottom: 10px;">Error Details</summary>
          <pre style="
            font-family: 'Courier New', monospace;
            font-size: 12px;
            white-space: pre-wrap;
            color: var(--vscode-errorForeground);
          ">${error}</pre>
        </details>
        <p style="margin-top: 20px; font-size: 14px; color: var(--vscode-descriptionForeground);">
          Please check the VS Code developer console for more information.
        </p>
      </div>
    `;
    }
});
