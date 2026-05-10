import React from 'react';
import { MarkdownRenderer } from './MarkdownRenderer';
import { TRUNCATED_MESSAGE } from '../../constants/messages';

interface AnalysisTabProps {
    content: string;
    isDarkTheme: boolean;
    onCopy?: (text: string) => void;
    wasTruncated: boolean;
}

export const AnalysisTab = ({
    content,
    isDarkTheme,
    onCopy,
    wasTruncated,
}: AnalysisTabProps) => {
    console.time('Analysis tab render');
    const result = (
        <div>
            {wasTruncated && (
                <div className="analysis-truncated-banner" role="alert">
                    <span
                        className="analysis-truncated-icon"
                        role="img"
                        aria-label="Warning"
                    >
                        ⚠️
                    </span>
                    <span className="analysis-truncated-text">
                        {TRUNCATED_MESSAGE}
                    </span>
                </div>
            )}
            <MarkdownRenderer
                content={content}
                id="analysis"
                isDarkTheme={isDarkTheme}
                onCopy={onCopy}
            />
        </div>
    );
    console.timeEnd('Analysis tab render');
    return result;
};
