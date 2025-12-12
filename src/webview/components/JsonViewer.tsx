import React from 'react';
import { JsonEditor, githubDarkTheme } from 'json-edit-react';

interface JsonViewerProps {
    data: unknown;
    rootKey?: string;
    collapseDepth?: number;
    className?: string;
    maxHeight?: string;
}

const vscodeTheme = {
    ...githubDarkTheme,
    styles: {
        ...githubDarkTheme.styles,
        container: {
            backgroundColor: 'transparent',
            fontFamily: 'var(--vscode-editor-font-family, monospace)',
            fontSize: '0.75rem',
            color: 'var(--vscode-editor-foreground)',
            border: 'none',
            borderRadius: '0',
        },
        property: 'var(--vscode-symbolIcon-propertyForeground, hsl(var(--primary)))',
        string: 'var(--vscode-debugTokenExpression-string, #ce9178)',
        number: 'var(--vscode-debugTokenExpression-number, #b5cea8)',
        boolean: 'var(--vscode-debugTokenExpression-boolean, #4fc1ff)',
        null: {
            color: 'var(--vscode-descriptionForeground)',
            fontStyle: 'italic'
        },
        bracket: {
            color: 'var(--vscode-editor-foreground)',
            fontWeight: 'bold'
        },
        itemCount: {
            color: 'var(--vscode-descriptionForeground)',
            fontStyle: 'italic'
        },
        iconCollection: 'var(--vscode-editor-foreground)',
        iconCopy: 'var(--vscode-editor-foreground)',
        input: 'var(--vscode-input-background)',
        inputHighlight: 'var(--vscode-list-highlightForeground)',
        error: {
            color: 'var(--vscode-errorForeground)',
            fontSize: '0.8em',
            fontWeight: 'bold'
        }
    }
};

export const JsonViewer = React.memo(function JsonViewer({
    data,
    className = '',
    rootKey = 'data',
    collapseDepth = 2,
    maxHeight = '300px'
}: JsonViewerProps) {
    return (
        <div className={`font-mono text-xs ${className}`.trim()}>
            <div style={{ maxHeight, overflow: 'auto', padding: 0 }}>
                <JsonEditor
                    data={data}
                    viewOnly={true}
                    theme={vscodeTheme}
                    enableClipboard={true}
                    rootName={rootKey}
                    showStringQuotes={true}
                    showCollectionCount={true}
                    showArrayIndices={true}
                    collapse={collapseDepth}
                    stringTruncate={150}
                    minWidth="100%"
                    maxWidth="100%"
                    rootFontSize="0.75rem"
                    showErrorMessages={false}
                />
            </div>
        </div>
    );
});
