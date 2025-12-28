import React from 'react';
import { createRoot } from 'react-dom/client';
import AnalysisView from './AnalysisView';
import type { ToolCallsData } from '../types/toolCallTypes';
import type { ThemeData } from './types/webviewGlobals';
import './types/webviewGlobals'; // Import for side-effect (global declarations)
import './globals.css';

interface AnalysisData {
    title: string;
    diffText: string;
    analysis: string;
    toolCalls: ToolCallsData | null;
}

/**
 * Read data from a meta tag's data-value attribute.
 * This is the VS Code recommended pattern for passing data to webviews.
 */
function getMetaData<T>(metaId: string): T | null {
    const meta = document.getElementById(metaId) as HTMLMetaElement | null;
    if (!meta) {
        console.error(`Meta tag #${metaId} not found`);
        return null;
    }

    const value = meta.getAttribute('data-value');
    if (!value) {
        console.error(`Meta tag #${metaId} has no data-value attribute`);
        return null;
    }

    try {
        return JSON.parse(value) as T;
    } catch (e) {
        console.error(`Failed to parse data from #${metaId}:`, e);
        return null;
    }
}

function initializeApp(): void {
    const container = document.getElementById('root');
    if (!container) {
        console.error('Root container not found');
        return;
    }

    // Acquire VS Code API
    if (typeof acquireVsCodeApi !== 'undefined') {
        window.vscode = acquireVsCodeApi();
    }

    // Read analysis data from meta tag
    const analysisData = getMetaData<AnalysisData>('analysis-data');
    if (!analysisData) {
        container.innerHTML =
            '<div style="padding: 20px; color: var(--vscode-errorForeground, #f14c4c);">Failed to load analysis data from page.</div>';
        return;
    }

    // Read theme data from meta tag
    const themeData = getMetaData<ThemeData>('theme-data');
    if (themeData) {
        window.initialTheme = themeData;
    }

    const root = createRoot(container);
    root.render(
        <React.StrictMode>
            <AnalysisView
                title={analysisData.title}
                diffText={analysisData.diffText}
                analysis={analysisData.analysis}
                toolCalls={analysisData.toolCalls}
            />
        </React.StrictMode>
    );
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp);
} else {
    initializeApp();
}
