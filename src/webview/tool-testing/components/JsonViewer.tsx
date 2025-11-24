import React from 'react';
import { JsonEditor, githubDarkTheme } from 'json-edit-react';

interface JsonViewerProps {
  /** The JSON data to display */
  data: any;
  /** Root key name for the object */
  rootKey?: string;
  /** Maximum depth to auto-expand */
  collapseDepth?: number;
  /** Additional CSS classes */
  className?: string;
}

// Custom theme that integrates with VSCode CSS variables
const vscodeTheme = {
  ...githubDarkTheme,
  styles: {
    ...githubDarkTheme.styles,
    container: {
      backgroundColor: 'transparent',
      fontFamily: 'var(--font-mono), monospace',
      fontSize: '0.75rem', // text-xs
      color: 'hsl(var(--foreground))',
      border: 'none',
      borderRadius: '0',
    },
    property: 'hsl(var(--primary))',
    string: 'hsl(var(--foreground))',
    number: 'hsl(var(--secondary-foreground))', 
    boolean: 'hsl(var(--accent-foreground))',
    null: {
      color: 'hsl(var(--muted-foreground))',
      fontStyle: 'italic'
    },
    bracket: {
      color: 'hsl(var(--foreground))',
      fontWeight: 'bold'
    },
    itemCount: {
      color: 'hsl(var(--muted-foreground))',
      fontStyle: 'italic'
    },
    iconCollection: 'hsl(var(--foreground))',
    iconCopy: 'hsl(var(--foreground))',
    input: 'hsl(var(--input))',
    inputHighlight: 'hsl(var(--accent))',
    error: {
      color: 'hsl(var(--destructive))',
      fontSize: '0.8em',
      fontWeight: 'bold'
    }
  }
};

/**
 * JsonViewer component using json-edit-react with VSCode theming
 * Provides a read-only, expandable tree view of JSON data
 */
export function JsonViewer({ data, className = '', rootKey = 'result', collapseDepth = 2 }: JsonViewerProps) {
  return (
    <div className={`font-mono text-xs ${className}`.trim()}>
      <div className="max-h-[400px] overflow-auto p-0">
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
          stringTruncate={100}
          minWidth="100%"
          maxWidth="100%"
          rootFontSize="0.75rem"
          showErrorMessages={false}
        />
      </div>
    </div>
  );
}

export default React.memo(JsonViewer);