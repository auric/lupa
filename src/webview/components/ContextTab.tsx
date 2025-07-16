import React, { memo } from 'react';
import { MarkdownRenderer } from './MarkdownRenderer';

interface ContextTabProps {
    content: string;
    isDarkTheme: boolean;
    onCopy?: (text: string, id: string) => void;
    copiedStates?: Record<string, boolean>;
}

export const ContextTab = memo<ContextTabProps>(({ 
    content, 
    isDarkTheme, 
    onCopy, 
    copiedStates 
}) => {
    console.time('Context tab render');
    console.log('Context content preview:', content.substring(0, 500) + '...');
    console.log('Context contains code blocks:', content.includes('```'));
    const result = (
        <MarkdownRenderer
            content={content}
            id="context"
            isDarkTheme={isDarkTheme}
            onCopy={onCopy}
            copiedStates={copiedStates}
        />
    );
    console.timeEnd('Context tab render');
    return result;
});