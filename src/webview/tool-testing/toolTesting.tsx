import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles/toolTesting.css';
import '../types/webviewGlobals'; // Import for side-effect (global declarations)
import ToolTestingView from './ToolTestingView';
import { onDomReady } from '../utils/domReady';

// Extend Window interface for tool testing specific data
declare global {
    interface Window {
        toolTestingData: {
            initialTool: string | null;
            initialParameters: Record<string, unknown>;
        };
    }
}

const ToolTestingApp: React.FC = () => {
    const { initialTool, initialParameters } = window.toolTestingData || {
        initialTool: null,
        initialParameters: {},
    };

    return (
        <ToolTestingView
            initialTool={initialTool || undefined}
            initialParameters={initialParameters}
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
        root.render(<ToolTestingApp />);
    } catch (error) {
        console.error('Failed to render tool testing interface:', error);

        // Fallback error display - use DOM methods to avoid XSS from error content
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
        <h2 style="margin-bottom: 10px;">Tool Testing Interface Failed to Load</h2>
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
          <pre id="error-details" style="
            font-family: 'Courier New', monospace;
            font-size: 12px;
            white-space: pre-wrap;
            color: var(--vscode-errorForeground);
          "></pre>
        </details>
        <p style="margin-top: 20px; font-size: 14px; color: var(--vscode-descriptionForeground);">
          Please check the VS Code developer console for more information.
        </p>
      </div>
    `;

        // Safely set error content using textContent to prevent XSS
        const errorDetails = container.querySelector('#error-details');
        if (errorDetails) {
            errorDetails.textContent =
                error instanceof Error
                    ? (error.stack ?? error.message)
                    : String(error);
        }
    }
});
