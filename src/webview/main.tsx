import React from 'react';
import { createRoot } from 'react-dom/client';
import AnalysisView from './AnalysisView';
import './globals.css';

// Type for the data that will be injected by the extension
interface AnalysisData {
    title: string;
    diffText: string;
    context: string;
    analysis: string;
}

// Extend the Window interface to include our injected data
declare global {
    interface Window {
        analysisData: AnalysisData;
    }
}

// Wait for the DOM to be ready
document.addEventListener('DOMContentLoaded', () => {
    const container = document.getElementById('root');
    if (!container) {
        console.error('Root container not found');
        return;
    }

    // Get the analysis data from the window object
    const analysisData = window.analysisData;
    if (!analysisData) {
        console.error('Analysis data not found on window object');
        return;
    }

    // Create the React root and render the component
    const root = createRoot(container);
    root.render(
        <React.StrictMode>
            <AnalysisView
                title={analysisData.title}
                diffText={analysisData.diffText}
                context={analysisData.context}
                analysis={analysisData.analysis}
            />
        </React.StrictMode>
    );
});

// If DOMContentLoaded has already fired, execute immediately
if (document.readyState === 'loading') {
    // Document is still loading, wait for DOMContentLoaded
} else {
    // Document is already loaded, execute immediately
    const container = document.getElementById('root');
    if (container) {
        const analysisData = window.analysisData;
        if (analysisData) {
            const root = createRoot(container);
            root.render(
                <React.StrictMode>
                    <AnalysisView
                        title={analysisData.title}
                        diffText={analysisData.diffText}
                        context={analysisData.context}
                        analysis={analysisData.analysis}
                    />
                </React.StrictMode>
            );
        }
    }
}