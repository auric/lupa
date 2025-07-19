import React, { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { PrismAsyncLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { vs } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { CopyButton } from './CopyButton';

interface MarkdownRendererProps {
    content: string;
    id: string;
    isDarkTheme: boolean;
    showCopy?: boolean;
    onCopy?: (text: string, id: string) => void;
    copiedStates?: Record<string, boolean>;
}

export const MarkdownRenderer = memo<MarkdownRendererProps>(({
    content,
    id,
    isDarkTheme,
    showCopy = true,
    onCopy,
    copiedStates = {}
}) => {
    return (
        <div className="relative">
            {showCopy && (
                <div className="absolute top-2 right-2 z-10">
                    <CopyButton
                        text={content}
                        id={id}
                        onCopy={onCopy}
                        isCopied={copiedStates[id]}
                    />
                </div>
            )}
            <div className="prose prose-sm max-w-none dark:prose-invert">
                <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                        // Override pre element to prevent default wrapper
                        pre: ({ children }: any) => {
                            return <>{children}</>;
                        },
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
                                    <div style={{ position: 'relative' }}>
                                        <SyntaxHighlighter
                                            style={isDarkTheme ? (vscDarkPlus as any) : (vs as any)}
                                            language={language || 'text'}
                                            PreTag="div"
                                            showLineNumbers={false}
                                            customStyle={{
                                                margin: 0,
                                                borderRadius: '0.5rem',
                                                background: 'var(--vscode-textCodeBlock-background)',
                                                fontSize: 'var(--vscode-editor-font-size)',
                                                fontFamily: 'var(--vscode-editor-font-family)',
                                                fontWeight: 'var(--vscode-editor-font-weight)',
                                                lineHeight: '1.5',
                                                color: 'var(--vscode-editor-foreground)',
                                            }}
                                            codeTagProps={{
                                                style: {
                                                    background: 'transparent',
                                                    color: 'inherit',
                                                    fontFamily: 'var(--vscode-editor-font-family)',
                                                    fontWeight: 'var(--vscode-editor-font-weight)',
                                                    fontSize: 'var(--vscode-editor-font-size)',
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
                                            onCopy={onCopy}
                                            isCopied={copiedStates[codeBlockId]}
                                        />
                                    </div>
                                );
                            } else {
                                return (
                                    <code 
                                        className="bg-muted px-1 py-0.5 rounded" 
                                        style={{
                                            fontFamily: 'var(--vscode-editor-font-family)',
                                            fontSize: 'var(--vscode-editor-font-size)',
                                            fontWeight: 'var(--vscode-editor-font-weight)',
                                        }}
                                        {...props}
                                    >
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