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

const MAX_RETRIES = 50;
const RETRY_INTERVAL_MS = 20;

/**
 * Wait for analysisData to be available on window object.
 * VS Code webviews can have timing issues where the inline script
 * setting window.analysisData hasn't completed when the module script runs.
 */
function waitForAnalysisData(retries = 0): Promise<AnalysisData> {
    return new Promise((resolve, reject) => {
        if (window.analysisData) {
            resolve(window.analysisData);
            return;
        }

        if (retries >= MAX_RETRIES) {
            reject(new Error('Analysis data not found after timeout'));
            return;
        }

        setTimeout(() => {
            waitForAnalysisData(retries + 1)
                .then(resolve)
                .catch(reject);
        }, RETRY_INTERVAL_MS);
    });
}

async function initializeApp(): Promise<void> {
    const container = document.getElementById('root');
    if (!container) {
        console.error('Root container not found');
        return;
    }

    try {
        const analysisData = await waitForAnalysisData();

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
    } catch (error) {
        console.error('Failed to initialize analysis view:', error);
        container.innerHTML =
            '<div style="padding: 20px; color: var(--vscode-errorForeground, red);">Failed to load analysis data. Please try reopening the panel.</div>';
    }
}

// Initialize when DOM is ready (single initialization path)
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp);
} else {
    initializeApp();
}
