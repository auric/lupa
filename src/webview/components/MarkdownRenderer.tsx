import React, { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus, vs } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { CopyButton } from './CopyButton';
import { FileLink } from './FileLink';
import { parseFilePaths } from '../../lib/pathUtils';

interface MarkdownRendererProps {
    content: string;
    id: string;
    isDarkTheme: boolean;
    showCopy?: boolean;
    onCopy?: (text: string) => void;
}

// Memoized component for processing text with file links
const ProcessedText = memo<{
    children: React.ReactNode;
    elementType: string;
    componentId: string;
}>(({ children, elementType, componentId }) => {

    // Handle both string and array children
    const processChildrenRecursively = (children: React.ReactNode): React.ReactNode => {
        // If it's a string, process it for file links
        if (typeof children === 'string') {
            return processStringForLinks(children);
        }

        // If it's an array, recursively process each child
        if (Array.isArray(children)) {
            return <>{children.map((child, index) => (
                <React.Fragment key={index}>
                    {processChildrenRecursively(child)}
                </React.Fragment>
            ))}</>;
        }

        // For other React nodes, return as-is
        return children;
    };

    const processStringForLinks = (text: string): React.ReactNode => {
        const parsedPaths = parseFilePaths(text);
        if (parsedPaths.length === 0) {
            return text;
        }

        // Split text and replace ALL detected paths with FileLink components
        let result: React.ReactNode[] = [];
        let lastIndex = 0;

        parsedPaths.forEach((path, index) => {
            // Add text before this path
            if (path.startIndex > lastIndex) {
                result.push(text.slice(lastIndex, path.startIndex));
            }

            // Always add FileLink - it will handle validation internally
            result.push(
                <FileLink
                    key={`${componentId}-link-${index}`}
                    filePath={path.filePath}
                    line={path.line}
                    column={path.column}
                >
                    {path.fullMatch.trim()}
                </FileLink>
            );

            lastIndex = path.endIndex;
        });

        // Add remaining text after last path
        if (lastIndex < text.length) {
            result.push(text.slice(lastIndex));
        }

        return <>{result}</>;
    };

    return <>{processChildrenRecursively(children)}</>;
});

export const MarkdownRenderer = memo<MarkdownRendererProps>(({
    content,
    id,
    isDarkTheme,
    showCopy = true,
    onCopy
}) => {

    // Custom components with file path replacement
    const customComponents = {
        // Override paragraph and heading rendering to handle file path replacement
        p: ({ children, ...props }: any) => (
            <p {...props}>
                <ProcessedText
                    children={children}
                    elementType="p"
                    componentId={id}
                />
            </p>
        ),
        h1: ({ children, ...props }: any) => (
            <h1 {...props}>
                <ProcessedText
                    children={children}
                    elementType="h1"
                    componentId={id}
                />
            </h1>
        ),
        h2: ({ children, ...props }: any) => (
            <h2 {...props}>
                <ProcessedText
                    children={children}
                    elementType="h2"
                    componentId={id}
                />
            </h2>
        ),
        h3: ({ children, ...props }: any) => (
            <h3 {...props}>
                <ProcessedText
                    children={children}
                    elementType="h3"
                    componentId={id}
                />
            </h3>
        ),
        h4: ({ children, ...props }: any) => (
            <h4 {...props}>
                <ProcessedText
                    children={children}
                    elementType="h4"
                    componentId={id}
                />
            </h4>
        ),
        h5: ({ children, ...props }: any) => (
            <h5 {...props}>
                <ProcessedText
                    children={children}
                    elementType="h5"
                    componentId={id}
                />
            </h5>
        ),
        h6: ({ children, ...props }: any) => (
            <h6 {...props}>
                <ProcessedText
                    children={children}
                    elementType="h6"
                    componentId={id}
                />
            </h6>
        ),
        li: ({ children, ...props }: any) => (
            <li {...props}>
                <ProcessedText
                    children={children}
                    elementType="li"
                    componentId={id}
                />
            </li>
        ),
        strong: ({ children, ...props }: any) => (
            <strong {...props}>
                <ProcessedText
                    children={children}
                    elementType="strong"
                    componentId={id}
                />
            </strong>
        ),
        em: ({ children, ...props }: any) => (
            <em {...props}>
                <ProcessedText
                    children={children}
                    elementType="em"
                    componentId={id}
                />
            </em>
        ),
        // Keep existing code block handling
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
                            className="absolute top-2 right-2"
                            onCopy={onCopy}
                        />
                    </div>
                );
            } else {
                // Inline code - process for file links
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
                        <ProcessedText
                            children={children}
                            elementType="code"
                            componentId={id}
                        />
                    </code>
                );
            }
        }
    };

    return (
        <div className="relative">
            {showCopy && (
                <div className="absolute top-2 right-2 z-10">
                    <CopyButton
                        text={content}
                        onCopy={onCopy}
                    />
                </div>
            )}
            <div className="prose prose-sm max-w-none dark:prose-invert">
                <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={customComponents}
                >
                    {content}
                </ReactMarkdown>
            </div>
        </div>
    );
}, (prevProps, nextProps) => {
    // Simple comparison - no need to check copy states since buttons manage their own state
    return (
        prevProps.content === nextProps.content &&
        prevProps.id === nextProps.id &&
        prevProps.isDarkTheme === nextProps.isDarkTheme &&
        prevProps.showCopy === nextProps.showCopy &&
        prevProps.onCopy === nextProps.onCopy
    );
});
