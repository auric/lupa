import React, { useState, useEffect, useMemo, memo, startTransition } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { vs } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { parseDiff, Diff, Hunk } from 'react-diff-view';
import 'react-diff-view/style/index.css';
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

// Memoized components - defined outside to prevent recreation
const MarkdownRenderer = memo<{
    content: string;
    id: string;
    isDarkTheme: boolean;
    showCopy?: boolean;
    onCopy?: (text: string, id: string) => void;
    copiedStates?: Record<string, boolean>;
}>(({
    content,
    id,
    isDarkTheme,
    showCopy = true,
    onCopy,
    copiedStates = {}
}) => {
    const CopyButton: React.FC<{ text: string; id: string; className?: string }> = ({ text, id, className }) => (
        <Button
            variant="outline"
            size="sm"
            onClick={() => onCopy?.(text, id)}
            className={cn("h-8 w-8 p-0 opacity-70 hover:opacity-100 transition-opacity", className)}
            title={copiedStates[id] ? "Copied!" : "Copy to clipboard"}
        >
            {copiedStates[id] ? (
                <Check className="h-4 w-4 text-green-500" />
            ) : (
                <Copy className="h-4 w-4" />
            )}
        </Button>
    );

    return (
        <div className="relative">
            {showCopy && (
                <div className="absolute top-2 right-2 z-10">
                    <CopyButton text={content} id={id} />
                </div>
            )}
            <div className="prose prose-sm max-w-none dark:prose-invert">
                <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                        code: ({ className, children, node, ...props }: any) => {
                            const match = /language-(\w+)/.exec(className || '');
                            const language = match ? match[1] : '';
                            const textContent = String(children).replace(/\n$/, '');

                            // In react-markdown v9, the inline prop was removed
                            // We need to use alternative detection methods:
                            // 1. Check if parent element is <pre> (block code)
                            // 2. Check for newlines in content
                            // 3. Check for language class
                            const isBlock = node?.parent?.tagName === 'pre';
                            const hasNewlines = String(children).includes('\n');
                            const hasLanguageClass = !!match;
                            
                            // A code block is detected if:
                            // - It's wrapped in a <pre> tag, OR
                            // - It has a language class, OR  
                            // - It contains newlines (multiline)
                            const isCodeBlock = isBlock || hasLanguageClass || hasNewlines;

                            // Log for debugging
                            console.log('Code block detection:', {
                                className,
                                parentTag: node?.parent?.tagName,
                                match,
                                language,
                                isBlock,
                                hasNewlines,
                                hasLanguageClass,
                                isCodeBlock,
                                originalLength: String(children).length,
                                processedLength: textContent.length,
                                preview: textContent.substring(0, 100) + '...'
                            });

                            if (isCodeBlock) {
                                // Use a simple hash instead of expensive string operations
                                const codeBlockId = `code-${id}-${Math.abs(textContent.split('').reduce((a, b) => a + b.charCodeAt(0), 0))}`;

                                return (
                                    <div className="relative">
                                        <SyntaxHighlighter
                                            style={isDarkTheme ? (vscDarkPlus as any) : (vs as any)}
                                            language={language || 'text'}
                                            PreTag="div"
                                            showLineNumbers={false}
                                            customStyle={{
                                                margin: 0,
                                                borderRadius: '0.5rem',
                                                background: 'var(--vscode-textCodeBlock-background)',
                                                fontSize: 'var(--vscode-editor-font-size, 12px)',
                                                fontFamily: 'var(--vscode-editor-font-family, monospace)',
                                                color: 'var(--vscode-editor-foreground)',
                                            }}
                                            codeTagProps={{
                                                style: {
                                                    background: 'transparent',
                                                    color: 'inherit',
                                                    fontFamily: 'inherit',
                                                }
                                            }}
                                            {...props}
                                        >
                                            {textContent}
                                        </SyntaxHighlighter>
                                        <CopyButton
                                            text={textContent}
                                            id={codeBlockId}
                                            className="absolute top-2 right-2"
                                        />
                                    </div>
                                );
                            } else {
                                return (
                                    <code className="bg-muted px-1 py-0.5 rounded text-sm" {...props}>
                                        {children}
                                    </code>
                                );
                            }
                        }
                    }}
                >
                    {content}
                </ReactMarkdown>
            </div>
        </div>
    );
});

// Memoized tab content components - defined outside to prevent recreation
const AnalysisTabContent = memo<{
    content: string;
    isDarkTheme: boolean;
    onCopy?: (text: string, id: string) => void;
    copiedStates?: Record<string, boolean>;
}>(({ content, isDarkTheme, onCopy, copiedStates }) => {
    console.time('Analysis tab render');
    const result = <MarkdownRenderer
        content={content}
        id="analysis"
        isDarkTheme={isDarkTheme}
        onCopy={onCopy}
        copiedStates={copiedStates}
    />;
    console.timeEnd('Analysis tab render');
    return result;
});

const ContextTabContent = memo<{
    content: string;
    isDarkTheme: boolean;
    onCopy?: (text: string, id: string) => void;
    copiedStates?: Record<string, boolean>;
}>(({ content, isDarkTheme, onCopy, copiedStates }) => {
    console.time('Context tab render');
    console.log('Context content preview:', content.substring(0, 500) + '...');
    console.log('Context contains code blocks:', content.includes('```'));
    const result = <MarkdownRenderer
        content={content}
        id="context"
        isDarkTheme={isDarkTheme}
        onCopy={onCopy}
        copiedStates={copiedStates}
    />;
    console.timeEnd('Context tab render');
    return result;
});

const DiffTabContent = memo<{ diffFiles: any[]; viewType: 'split' | 'unified' }>(({ diffFiles, viewType }) => {
    console.time('Diff tab render');

    if (diffFiles.length === 0) {
        return <div className="text-center text-muted-foreground p-8">No changes to display</div>;
    }

    const result = (
        <div className="border rounded-lg" style={{ maxHeight: '80vh', overflow: 'auto' }}>
            <div className="w-full">
                {diffFiles.map((file, index) => (
                    <div key={index} className="mb-4">
                        {/* File header */}
                        <div className="bg-muted p-2 text-sm font-mono border-b">
                            {file.oldPath && file.newPath && file.oldPath !== file.newPath ? (
                                <span>{file.oldPath} → {file.newPath}</span>
                            ) : (
                                <span>{file.newPath || file.oldPath}</span>
                            )}
                        </div>

                        {/* Diff content */}
                        <Diff
                            viewType={viewType}
                            diffType={file.type}
                            hunks={file.hunks}
                            className="text-sm"
                        >
                            {hunks => hunks.map(hunk => (
                                <Hunk key={hunk.content} hunk={hunk} />
                            ))}
                        </Diff>
                    </div>
                ))}
            </div>
        </div>
    );

    console.timeEnd('Diff tab render');
    return result;
});

const AnalysisView: React.FC<AnalysisViewProps> = ({ title, diffText, context, analysis }) => {
    const [copiedStates, setCopiedStates] = useState<Record<string, boolean>>({});
    const [isDarkTheme, setIsDarkTheme] = useState<boolean>(false);
    const [windowWidth, setWindowWidth] = useState<number>(window.innerWidth);

    // Detect VSCode theme
    useEffect(() => {
        const detectTheme = () => {
            const bodyStyle = getComputedStyle(document.body);
            const bgColor = bodyStyle.getPropertyValue('--vscode-editor-background');

            // Parse RGB/hex color and calculate luminance
            const getLuminance = (color: string): number => {
                // Remove spaces and normalize
                const normalized = color.trim();

                let r = 0, g = 0, b = 0;

                // Handle different color formats
                if (normalized.startsWith('#')) {
                    // Hex format
                    const hex = normalized.slice(1);
                    r = parseInt(hex.slice(0, 2), 16);
                    g = parseInt(hex.slice(2, 4), 16);
                    b = parseInt(hex.slice(4, 6), 16);
                } else if (normalized.startsWith('rgb')) {
                    // RGB format
                    const values = normalized.match(/\d+/g);
                    if (values && values.length >= 3) {
                        r = parseInt(values[0]);
                        g = parseInt(values[1]);
                        b = parseInt(values[2]);
                    }
                }

                // Calculate relative luminance
                const normalizeComponent = (c: number) => {
                    c = c / 255;
                    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
                };

                return 0.2126 * normalizeComponent(r) + 0.7152 * normalizeComponent(g) + 0.0722 * normalizeComponent(b);
            };

            const luminance = getLuminance(bgColor);
            const isDark = luminance < 0.5;
            console.log('Theme detection:', { bgColor, luminance, isDark });
            setIsDarkTheme(isDark);
        };

        detectTheme();
        // Re-detect theme if CSS variables change
        const observer = new MutationObserver(detectTheme);
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });

        return () => observer.disconnect();
    }, []);

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

    const copyToClipboard = async (text: string, id: string) => {
        try {
            await navigator.clipboard.writeText(text);
            setCopiedStates(prev => ({ ...prev, [id]: true }));
            setTimeout(() => {
                setCopiedStates(prev => ({ ...prev, [id]: false }));
            }, 1000);
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
                                    <AnalysisTabContent
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
                                    <ContextTabContent
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
                                    <DiffTabContent diffFiles={diffFiles} viewType={viewType} />
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