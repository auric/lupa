import React, { useState, useEffect, useMemo } from 'react';
import { parseDiff } from 'react-diff-view';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useTheme } from './hooks/useTheme';
import { useCopyToClipboard } from './hooks/useCopyToClipboard';
import { AnalysisTab } from './components/AnalysisTab';
import { ContextTab } from './components/ContextTab';
import { DiffTab } from './components/DiffTab';

interface AnalysisViewProps {
    title: string;
    diffText: string;
    context: string;
    analysis: string;
}

const AnalysisView: React.FC<AnalysisViewProps> = ({ title, diffText, context, analysis }) => {
    const [windowWidth, setWindowWidth] = useState<number>(window.innerWidth);
    
    // Use custom hooks
    const isDarkTheme = useTheme();
    const { copyToClipboard, copiedStates } = useCopyToClipboard();

    // Handle window resize for responsive diff view
    useEffect(() => {
        const handleResize = () => {
            setWindowWidth(window.innerWidth);
        };

        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    // Parse diff using react-diff-view
    const diffFiles = useMemo(() => {
        if (!diffText) return [];

        console.time('Diff parsing');
        try {
            const files = parseDiff(diffText);
            console.timeEnd('Diff parsing');
            return files;
        } catch (error) {
            console.error('Error parsing diff:', error);
            console.timeEnd('Diff parsing');
            return [];
        }
    }, [diffText]);

    const viewType = windowWidth > 1024 ? 'split' : 'unified';

    return (
        <div className="h-full flex flex-col bg-background">
            {/* VSCode-style header */}
            <div className="flex-shrink-0 px-3 py-2 border-b border-border bg-card">
                <h1 className="text-xs font-medium text-foreground truncate">{title}</h1>
                <p className="text-xs text-muted-foreground mt-0.5 opacity-75">Pull request analysis with context and code changes</p>
            </div>

            {/* VSCode-style tabs */}
            <Tabs defaultValue="analysis" className="flex-1 flex flex-col">
                <TabsList className="vscode-tabs-list">
                    <TabsTrigger value="analysis" className="vscode-tab-trigger">
                        Analysis
                    </TabsTrigger>
                    <TabsTrigger value="context" className="vscode-tab-trigger">
                        Context
                    </TabsTrigger>
                    <TabsTrigger value="changes" className="vscode-tab-trigger">
                        Changes
                    </TabsTrigger>
                </TabsList>

                <TabsContent value="analysis" className="vscode-tab-content">
                    <AnalysisTab
                        content={analysis}
                        isDarkTheme={isDarkTheme}
                        onCopy={copyToClipboard}
                        copiedStates={copiedStates}
                    />
                </TabsContent>

                <TabsContent value="context" className="vscode-tab-content">
                    <ContextTab
                        content={context}
                        isDarkTheme={isDarkTheme}
                        onCopy={copyToClipboard}
                        copiedStates={copiedStates}
                    />
                </TabsContent>

                <TabsContent value="changes" className="vscode-tab-content">
                    <DiffTab diffFiles={diffFiles} viewType={viewType} />
                </TabsContent>
            </Tabs>
        </div>
    );
};

export default AnalysisView;