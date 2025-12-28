import React, { useState, useEffect } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useTheme } from './hooks/useTheme';
import { useCopyToClipboard } from './hooks/useCopyToClipboard';
import { AnalysisTab } from './components/AnalysisTab';
import { ToolCallsTab } from './components/ToolCallsTab';
import { DiffTab } from './components/DiffTab';
import type { ToolCallsData } from '../types/toolCallTypes';

interface AnalysisViewProps {
    title: string;
    diffText: string;
    analysis: string;
    toolCalls: ToolCallsData | null;
}

const AnalysisView: React.FC<AnalysisViewProps> = ({
    title,
    diffText,
    analysis,
    toolCalls,
}) => {
    const [windowWidth, setWindowWidth] = useState<number>(window.innerWidth);

    // Use custom hooks
    const isDarkTheme = useTheme();
    const copyToClipboard = useCopyToClipboard();

    // Apply dark class to document element when theme changes
    useEffect(() => {
        if (isDarkTheme) {
            document.documentElement.classList.add('dark');
        } else {
            document.documentElement.classList.remove('dark');
        }
    }, [isDarkTheme]);

    // Handle window resize for responsive diff view
    useEffect(() => {
        const handleResize = () => {
            setWindowWidth(window.innerWidth);
        };

        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    const viewType = windowWidth > 1024 ? 'split' : 'unified';

    const toolCallsCount = toolCalls?.totalCalls ?? 0;

    return (
        <div className="h-full flex flex-col bg-background min-h-0">
            {/* VSCode-style header */}
            <div className="flex-shrink-0 px-3 py-2 border-b border-border bg-card">
                <div className="flex justify-between items-start">
                    <div className="flex-1">
                        <h1 className="text-xs font-medium text-foreground truncate">
                            {title}
                        </h1>
                        <p className="text-xs text-muted-foreground mt-0.5 opacity-75">
                            Pull request analysis with tool calls and code
                            changes
                        </p>
                    </div>
                </div>
            </div>

            {/* VSCode-style tabs */}
            <Tabs
                defaultValue="analysis"
                className="flex-1 flex flex-col min-h-0"
            >
                <TabsList className="vscode-tabs-list">
                    <TabsTrigger
                        value="analysis"
                        className="vscode-tab-trigger"
                    >
                        Analysis
                    </TabsTrigger>
                    <TabsTrigger
                        value="toolcalls"
                        className="vscode-tab-trigger"
                    >
                        Tool Calls{' '}
                        {toolCallsCount > 0 && (
                            <span className="ml-1 text-xs opacity-70">
                                ({toolCallsCount})
                            </span>
                        )}
                    </TabsTrigger>
                    <TabsTrigger value="changes" className="vscode-tab-trigger">
                        Changes
                    </TabsTrigger>
                </TabsList>

                <TabsContent
                    value="analysis"
                    className="vscode-tab-content flex-1 min-h-0 overflow-auto bg-background"
                >
                    <AnalysisTab
                        content={analysis}
                        isDarkTheme={isDarkTheme}
                        onCopy={copyToClipboard}
                    />
                </TabsContent>

                <TabsContent
                    value="toolcalls"
                    className="vscode-tab-content flex-1 min-h-0 overflow-hidden flex flex-col bg-background"
                >
                    <ToolCallsTab
                        toolCalls={toolCalls}
                        onCopy={copyToClipboard}
                    />
                </TabsContent>

                <TabsContent
                    value="changes"
                    className="vscode-tab-content flex-1 min-h-0 overflow-hidden flex flex-col bg-background"
                >
                    <DiffTab diffText={diffText} viewType={viewType} />
                </TabsContent>
            </Tabs>
        </div>
    );
};

export default AnalysisView;
