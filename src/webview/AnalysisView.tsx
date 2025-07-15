import React, { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { html } from 'diff2html';
import { ColorSchemeType } from 'diff2html/lib/types';
import { Copy, Check } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface AnalysisViewProps {
    title: string;
    diffText: string;
    context: string;
    analysis: string;
}

const AnalysisView: React.FC<AnalysisViewProps> = ({ title, diffText, context, analysis }) => {
    const [copiedStates, setCopiedStates] = useState<Record<string, boolean>>({});
    const [diffHtml, setDiffHtml] = useState<string>('');

    useEffect(() => {
        if (diffText) {
            try {
                const diffHtmlString = html(diffText, {
                    outputFormat: 'side-by-side',
                    drawFileList: true,
                    matching: 'lines',
                    colorScheme: ColorSchemeType.DARK
                });
                setDiffHtml(diffHtmlString);
            } catch (error) {
                console.error('Error generating diff HTML:', error);
                setDiffHtml('<div class="text-destructive">Error rendering diff</div>');
            }
        }
    }, [diffText]);

    const copyToClipboard = async (text: string, id: string) => {
        try {
            await navigator.clipboard.writeText(text);
            setCopiedStates(prev => ({ ...prev, [id]: true }));
            setTimeout(() => {
                setCopiedStates(prev => ({ ...prev, [id]: false }));
            }, 2000);
        } catch (err) {
            console.error('Failed to copy text: ', err);
        }
    };

    const CopyButton: React.FC<{ text: string; id: string; className?: string }> = ({ text, id, className }) => (
        <Button
            variant="outline"
            size="sm"
            onClick={() => copyToClipboard(text, id)}
            className={cn("h-8 w-8 p-0", className)}
        >
            {copiedStates[id] ? (
                <Check className="h-4 w-4" />
            ) : (
                <Copy className="h-4 w-4" />
            )}
        </Button>
    );

    const MarkdownRenderer: React.FC<{ content: string; id: string; showCopy?: boolean }> = ({
        content,
        id,
        showCopy = true
    }) => (
        <div className="relative">
            {showCopy && (
                <div className="absolute top-2 right-2 z-10">
                    <CopyButton text={content} id={id} />
                </div>
            )}
            <div className="prose prose-sm max-w-none dark:prose-invert">
                <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    rehypePlugins={[rehypeHighlight]}
                    components={{
                        pre: ({ children, ...props }) => (
                            <div className="relative">
                                <pre {...props} className="bg-muted/50 overflow-auto rounded-lg p-4">
                                    {children}
                                </pre>
                                <CopyButton
                                    text={children?.toString() || ''}
                                    id={`code-${id}-${Math.random()}`}
                                    className="absolute top-2 right-2"
                                />
                            </div>
                        ),
                        code: ({ children, className, ...props }) => {
                            const isInline = !className;
                            return isInline ? (
                                <code className="bg-muted px-1 py-0.5 rounded text-sm" {...props}>
                                    {children}
                                </code>
                            ) : (
                                <code className={className} {...props}>
                                    {children}
                                </code>
                            );
                        }
                    }}
                >
                    {content}
                </ReactMarkdown>
            </div>
        </div>
    );

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
                                    <MarkdownRenderer content={analysis} id="analysis" />
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
                                    <MarkdownRenderer content={context} id="context" />
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
                                    <div className="border rounded-lg overflow-hidden">
                                        <div
                                            className={cn(
                                                "diff-container w-full overflow-auto",
                                                "bg-background text-foreground"
                                            )}
                                            dangerouslySetInnerHTML={{ __html: diffHtml }}
                                        />
                                    </div>
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