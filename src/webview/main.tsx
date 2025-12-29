import React from 'react';
import { createRoot } from 'react-dom/client';
import AnalysisView from './AnalysisView';
import type { ToolCallsData } from '../types/toolCallTypes';
import './types/webviewGlobals'; // Import for side-effect (global declarations)
import './globals.css';

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

const AnalysisApp: React.FC = () => {
    const analysisData = window.analysisData;

    if (!analysisData) {
        return (
            <div
                style={{
                    display: 'flex',
                    justifyContent: 'center',
                    alignItems: 'center',
                    height: '100vh',
                    color: 'var(--vscode-errorForeground)',
                }}
            >
                Analysis data not available
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

document.addEventListener('DOMContentLoaded', () => {
    const container = document.getElementById('root');
    if (!container) {
        console.error('Root container not found');
        return;
    }

    const root = createRoot(container);
    root.render(
        <React.StrictMode>
            <AnalysisApp />
        </React.StrictMode>
    );
});
