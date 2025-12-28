import React from 'react';
import { createRoot } from 'react-dom/client';
import AnalysisView from './AnalysisView';
import type { ToolCallsData } from '../types/toolCallTypes';
import './globals.css';

interface AnalysisData {
    title: string;
    diffText: string;
    analysis: string;
    toolCalls: ToolCallsData | null;
}

declare global {
    interface Window {
        analysisData: AnalysisData;
    }
}

function initializeApp(): void {
    const container = document.getElementById('root');
    if (!container) {
        console.error('Root container not found');
        return;
    }

    const analysisData = window.analysisData;
    if (!analysisData) {
        console.error('Analysis data not found on window object');
        container.innerHTML =
            '<div style="padding: 20px; color: var(--vscode-errorForeground, #f14c4c);">Analysis data not available. This may indicate a CSP or script loading issue.</div>';
        return;
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
