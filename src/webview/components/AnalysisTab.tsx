import React from 'react';
import { MarkdownRenderer } from './MarkdownRenderer';

interface AnalysisTabProps {
    content: string;
    isDarkTheme: boolean;
    onCopy?: (text: string) => void;
}

export const AnalysisTab = ({
    content,
    isDarkTheme,
    onCopy
}: AnalysisTabProps) => {
    console.time('Analysis tab render');
    const result = (
        <MarkdownRenderer
            content={content}
            id="analysis"
            isDarkTheme={isDarkTheme}
            onCopy={onCopy}
        />
    );
    console.timeEnd('Analysis tab render');
    return result;
};