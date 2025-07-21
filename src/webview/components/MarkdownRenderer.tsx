import React, { memo, useEffect, useState, useRef, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { PrismAsyncLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { vs } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { CopyButton } from './CopyButton';
import { FileLink } from './FileLink';
import { useVSCodeApi } from '../hooks/useVSCodeApi';
import { parseFilePaths, ParsedPath } from '../../lib/pathUtils';
import { ValidatePathPayload, PathValidationResultPayload } from '../../types/webviewMessages';

interface MarkdownRendererProps {
    content: string;
    id: string;
    isDarkTheme: boolean;
    showCopy?: boolean;
    onCopy?: (text: string, id: string) => void;
    copiedStates?: Record<string, boolean>;
}

interface ValidatedPath extends ParsedPath {
    isValid: boolean;
    isValidating: boolean;
    resolvedPath?: string;
}

interface ValidationQueue {
    path: ParsedPath;
    requestId: string;
}

// Global cache to persist validation results across component re-renders and tab switches
const globalValidationCache = new Map<string, ValidatedPath>();
const globalProcessedContent = new Set<string>();

// Memoized component for processing text with file links
const ProcessedText = memo<{
    children: React.ReactNode;
    elementType: string;
    validatedPaths: Map<string, ValidatedPath>;
    componentId: string;
}>(({ children, elementType, validatedPaths, componentId }) => {

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


        // Split text and replace valid paths with FileLink components
        let result: React.ReactNode[] = [];
        let lastIndex = 0;

        parsedPaths.forEach((path, index) => {
            const validatedPath = validatedPaths.get(path.filePath);

            // Add text before this path
            if (path.startIndex > lastIndex) {
                result.push(text.slice(lastIndex, path.startIndex));
            }

            // Add either FileLink or plain text based on validation
            if (validatedPath?.isValid && !validatedPath.isValidating) {
                result.push(
                    <FileLink
                        key={`${componentId}-link-${index}`}
                        filePath={validatedPath.resolvedPath || path.filePath}
                        line={path.line}
                        column={path.column}
                    >
                        {path.fullMatch.trim()}
                    </FileLink>
                );
            } else {
                // Show original text while validating or if invalid
                result.push(path.fullMatch);
            }

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
    onCopy,
    copiedStates = {}
}) => {
    const [validatedPaths, setValidatedPaths] = useState<Map<string, ValidatedPath>>(() => {
        // Initialize with existing cache
        return new Map(globalValidationCache);
    });
    // Remove renderTrigger - no longer needed with direct state dependency
    const requestIdCounter = useRef(0);
    const validationQueue = useRef<ValidationQueue[]>([]);
    const isProcessingQueue = useRef(false);
    const vscode = useVSCodeApi();

    // Async validation queue processor
    const processValidationQueue = React.useCallback(async () => {
        if (isProcessingQueue.current || !vscode || validationQueue.current.length === 0) {
            return;
        }

        isProcessingQueue.current = true;

        try {
            // Process paths in small batches to prevent UI hangs
            const BATCH_SIZE = 5;
            const DELAY_BETWEEN_BATCHES = 10; // ms

            while (validationQueue.current.length > 0) {
                const batch = validationQueue.current.splice(0, BATCH_SIZE);

                // Send validation requests for this batch
                batch.forEach(({ path, requestId }) => {
                    const payload: ValidatePathPayload = {
                        filePath: path.filePath,
                        requestId
                    };

                    vscode.postMessage({
                        command: 'validatePath',
                        payload
                    });
                });

                // Small delay between batches to prevent blocking
                if (validationQueue.current.length > 0) {
                    await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES));
                }
            }
        } finally {
            isProcessingQueue.current = false;
        }
    }, [vscode]);

    // Parse file paths from content and validate them (only once per content+id combination)
    useEffect(() => {
        // Create a simple hash of content + id to detect when we need to revalidate
        const contentHash = `${content.length}-${id}`;

        // Skip if we've already processed this exact content
        if (globalProcessedContent.has(contentHash)) {
            return;
        }

        const parsedPaths = parseFilePaths(content);

        if (parsedPaths.length === 0) {
            globalProcessedContent.add(contentHash);
            return;
        }

        if (!vscode) {
            return;
        }

        // Mark this content hash as processed globally
        globalProcessedContent.add(contentHash);

        // Initialize validation state for new paths
        const newPathsToValidate: ValidationQueue[] = [];

        setValidatedPaths(prev => {
            const newMap = new Map(prev);

            parsedPaths.forEach(path => {
                // Check if we already have this path cached globally
                if (globalValidationCache.has(path.filePath)) {
                    const cachedPath = globalValidationCache.get(path.filePath)!;
                    newMap.set(path.filePath, cachedPath);
                } else if (!newMap.has(path.filePath)) {
                    const pathState = {
                        ...path,
                        isValid: false,
                        isValidating: true
                    };
                    newMap.set(path.filePath, pathState);
                    globalValidationCache.set(path.filePath, pathState);

                    // Queue for async validation instead of immediate processing
                    const requestId = `${id}-${++requestIdCounter.current}`;
                    newPathsToValidate.push({ path, requestId });
                }
            });

            return newMap;
        });

        // Add to validation queue and process asynchronously
        if (newPathsToValidate.length > 0) {
            validationQueue.current.push(...newPathsToValidate);
            // Use setTimeout to make the processing truly async
            setTimeout(() => processValidationQueue(), 0);
        }
    }, [content, id, vscode]); // Removed processValidationQueue to prevent infinite loops

    // Listen for validation results
    useEffect(() => {
        const handleMessage = (event: MessageEvent) => {
            const message = event.data;
            if (message.command === 'pathValidationResult') {
                const payload: PathValidationResultPayload = message.payload;

                setValidatedPaths(prev => {
                    const newMap = new Map(prev);
                    const existing = newMap.get(payload.filePath);

                    if (existing) {
                        const updatedPath = {
                            ...existing,
                            isValid: payload.isValid,
                            isValidating: false,
                            resolvedPath: payload.resolvedPath
                        };
                        newMap.set(payload.filePath, updatedPath);
                        // Also update global cache
                        globalValidationCache.set(payload.filePath, updatedPath);
                    }

                    return newMap;
                });
            }
        };

        window.addEventListener('message', handleMessage);
        return () => window.removeEventListener('message', handleMessage);
    }, []);


    // Helper function to generate validation key for paths in specific text
    const generateValidationKey = (children: React.ReactNode): string => {
        if (typeof children !== 'string') {
            return 'no-text';
        }

        const pathsInText = parseFilePaths(children).map(p => p.filePath);
        if (pathsInText.length === 0) {
            return 'no-paths';
        }

        // Create key based on validation state of paths in this specific text
        return pathsInText
            .map(path => {
                const validation = validatedPaths.get(path);
                return `${path}:${validation?.isValid || 'pending'}:${validation?.isValidating || false}`;
            })
            .join('|');
    };

    // Custom components with file path replacement using path-specific version tracking
    const customComponents = {
        // Override paragraph and heading rendering to handle file path replacement
        p: ({ children, ...props }: any) => {
            const validationKey = generateValidationKey(children);
            return (
                <p {...props}>
                    <ProcessedText
                        key={`p-${validationKey}`}
                        children={children}
                        elementType="p"
                        validatedPaths={validatedPaths}
                        componentId={id}
                    />
                </p>
            );
        },
        h1: ({ children, ...props }: any) => {
            const validationKey = generateValidationKey(children);
            return (
                <h1 {...props}>
                    <ProcessedText
                        key={`h1-${validationKey}`}
                        children={children}
                        elementType="h1"
                        validatedPaths={validatedPaths}
                        componentId={id}
                    />
                </h1>
            );
        },
        h2: ({ children, ...props }: any) => {
            const validationKey = generateValidationKey(children);
            return (
                <h2 {...props}>
                    <ProcessedText
                        key={`h2-${validationKey}`}
                        children={children}
                        elementType="h2"
                        validatedPaths={validatedPaths}
                        componentId={id}
                    />
                </h2>
            );
        },
        h3: ({ children, ...props }: any) => {
            const validationKey = generateValidationKey(children);
            return (
                <h3 {...props}>
                    <ProcessedText
                        key={`h3-${validationKey}`}
                        children={children}
                        elementType="h3"
                        validatedPaths={validatedPaths}
                        componentId={id}
                    />
                </h3>
            );
        },
        h4: ({ children, ...props }: any) => {
            const validationKey = generateValidationKey(children);
            return (
                <h4 {...props}>
                    <ProcessedText
                        key={`h4-${validationKey}`}
                        children={children}
                        elementType="h4"
                        validatedPaths={validatedPaths}
                        componentId={id}
                    />
                </h4>
            );
        },
        h5: ({ children, ...props }: any) => {
            const validationKey = generateValidationKey(children);
            return (
                <h5 {...props}>
                    <ProcessedText
                        key={`h5-${validationKey}`}
                        children={children}
                        elementType="h5"
                        validatedPaths={validatedPaths}
                        componentId={id}
                    />
                </h5>
            );
        },
        h6: ({ children, ...props }: any) => {
            const validationKey = generateValidationKey(children);
            return (
                <h6 {...props}>
                    <ProcessedText
                        key={`h6-${validationKey}`}
                        children={children}
                        elementType="h6"
                        validatedPaths={validatedPaths}
                        componentId={id}
                    />
                </h6>
            );
        },
        li: ({ children, ...props }: any) => {
            const validationKey = generateValidationKey(children);
            return (
                <li {...props}>
                    <ProcessedText
                        key={`li-${validationKey}`}
                        children={children}
                        elementType="li"
                        validatedPaths={validatedPaths}
                        componentId={id}
                    />
                </li>
            );
        },
        strong: ({ children, ...props }: any) => {
            const validationKey = generateValidationKey(children);
            return (
                <strong {...props}>
                    <ProcessedText
                        key={`strong-${validationKey}`}
                        children={children}
                        elementType="strong"
                        validatedPaths={validatedPaths}
                        componentId={id}
                    />
                </strong>
            );
        },
        em: ({ children, ...props }: any) => {
            const validationKey = generateValidationKey(children);
            return (
                <em {...props}>
                    <ProcessedText
                        key={`em-${validationKey}`}
                        children={children}
                        elementType="em"
                        validatedPaths={validatedPaths}
                        componentId={id}
                    />
                </em>
            );
        },
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
                            id={codeBlockId}
                            className="absolute top-2 right-2"
                            onCopy={onCopy}
                            isCopied={copiedStates[codeBlockId]}
                        />
                    </div>
                );
            } else {
                // Inline code - process for file links
                const validationKey = generateValidationKey(children);
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
                            key={`code-${validationKey}`}
                            children={children}
                            elementType="code"
                            validatedPaths={validatedPaths}
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
                        id={id}
                        onCopy={onCopy}
                        isCopied={copiedStates[id]}
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
});
