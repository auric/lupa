import React from 'react';
import { MarkdownRenderer } from './MarkdownRenderer';

interface AnalysisTabProps {
    content: string;
    isDarkTheme: boolean;
    onCopy?: (text: string, id: string) => void;
    copiedStates?: Record<string, boolean>;
}

export const AnalysisTab = ({ 
    content, 
    isDarkTheme, 
    onCopy, 
    copiedStates 
}: AnalysisTabProps) => {
    console.time('Analysis tab render');
    const result = (
        <MarkdownRenderer
            content={content}
            id="analysis"
            isDarkTheme={isDarkTheme}
            onCopy={onCopy}
            copiedStates={copiedStates}
        />
    );
    console.timeEnd('Analysis tab render');
    return result;
};