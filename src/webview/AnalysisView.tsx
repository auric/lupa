import React, { useState, useEffect, useMemo } from 'react';
import { parseDiff } from 'react-diff-view';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
        <div className="container mx-auto p-4 max-w-7xl">
            <Card className="w-full">
                <CardHeader>
                    <CardTitle className="text-2xl">{title}</CardTitle>
                    <CardDescription>
                        Pull request analysis with context and code changes
                    </CardDescription>
                </CardHeader>

                <CardContent>
                    <Tabs defaultValue="analysis" className="w-full">
                        <TabsList className="grid w-full grid-cols-3">
                            <TabsTrigger value="analysis">Analysis</TabsTrigger>
                            <TabsTrigger value="context">Context</TabsTrigger>
                            <TabsTrigger value="changes">Changes</TabsTrigger>
                        </TabsList>

                        <TabsContent value="analysis" className="mt-6">
                            <Card>
                                <CardHeader>
                                    <CardTitle className="text-lg">Analysis Results</CardTitle>
                                    <CardDescription>
                                        AI-powered analysis of the pull request
                                    </CardDescription>
                                </CardHeader>
                                <CardContent>
                                    <AnalysisTab
                                        content={analysis}
                                        isDarkTheme={isDarkTheme}
                                        onCopy={copyToClipboard}
                                        copiedStates={copiedStates}
                                    />
                                </CardContent>
                            </Card>
                        </TabsContent>

                        <TabsContent value="context" className="mt-6">
                            <Card>
                                <CardHeader>
                                    <CardTitle className="text-lg">Context Information</CardTitle>
                                    <CardDescription>
                                        Relevant code context and related files
                                    </CardDescription>
                                </CardHeader>
                                <CardContent>
                                    <ContextTab
                                        content={context}
                                        isDarkTheme={isDarkTheme}
                                        onCopy={copyToClipboard}
                                        copiedStates={copiedStates}
                                    />
                                </CardContent>
                            </Card>
                        </TabsContent>

                        <TabsContent value="changes" className="mt-6">
                            <Card>
                                <CardHeader>
                                    <CardTitle className="text-lg">Code Changes</CardTitle>
                                    <CardDescription>
                                        Side-by-side view of code modifications
                                    </CardDescription>
                                </CardHeader>
                                <CardContent>
                                    <DiffTab diffFiles={diffFiles} viewType={viewType} />
                                </CardContent>
                            </Card>
                        </TabsContent>
                    </Tabs>
                </CardContent>
            </Card>
        </div>
    );
};

export default AnalysisView;