import React from 'react';
import { createRoot } from 'react-dom/client';
import AnalysisView from './AnalysisView';
import type { ToolCallsData } from '../types/toolCallTypes';
import './types/webviewGlobals'; // Import for side-effect (global declarations)
import './globals.css';

// Extend Window interface for analysis-specific data
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

// Initialize the React application (matches toolTesting.tsx pattern)
document.addEventListener('DOMContentLoaded', () => {
    const container = document.getElementById('root');
    if (!container) {
        console.error('Root container not found');
        return;
    }

    const analysisData = window.analysisData;
    if (!analysisData) {
        console.error('Analysis data not found on window object');
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
});
