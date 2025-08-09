import React from 'react';
import { JsonEditor, githubDarkTheme } from 'json-edit-react';
import { useCopyToClipboard } from '../hooks/useCopyToClipboard';
import { CopyButton } from './CopyButton';

interface JsonViewerProps {
  /** The JSON data to display */
  data: any;
  /** Root key name for the object */
  rootKey?: string;
  /** Initial expanded state */
  defaultExpanded?: boolean;
  /** Maximum depth to auto-expand */
  autoExpandDepth?: number;
  /** Additional CSS classes */
  className?: string;
}

// Custom theme that integrates with VSCode CSS variables
const vscodeTheme = {
  ...githubDarkTheme,
  styles: {
    ...githubDarkTheme.styles,
    container: {
      backgroundColor: 'var(--vscode-editor-background)',
      fontFamily: 'var(--vscode-editor-font-family), monospace',
      fontSize: 'var(--font-size-xs)',
      color: 'var(--vscode-editor-foreground)',
      border: '1px solid var(--vscode-panel-border)',
      borderRadius: 'var(--radius)',
    },
    property: 'var(--vscode-symbolIcon-keywordForeground)',
    string: 'var(--vscode-symbolIcon-stringForeground)',
    number: 'var(--vscode-symbolIcon-numberForeground)', 
    boolean: 'var(--vscode-symbolIcon-booleanForeground)',
    null: {
      color: 'var(--vscode-symbolIcon-nullForeground)',
      fontStyle: 'italic'
    },
    bracket: {
      color: 'var(--vscode-symbolIcon-colorForeground)',
      fontWeight: 'bold'
    },
    itemCount: {
      color: 'var(--vscode-descriptionForeground)',
      fontStyle: 'italic'
    },
    iconCollection: 'var(--vscode-symbolIcon-colorForeground)',
    iconCopy: 'var(--vscode-symbolIcon-colorForeground)',
    input: 'var(--vscode-input-foreground)',
    inputHighlight: 'var(--vscode-list-hoverBackground)',
    error: {
      color: 'var(--vscode-errorForeground)',
      fontSize: '0.8em',
      fontWeight: 'bold'
    }
  }
};

/**
 * JsonViewer component using json-edit-react with VSCode theming
 * Provides a read-only, expandable tree view of JSON data
 */
export const JsonViewer: React.FC<JsonViewerProps> = ({
  data,
  rootKey = 'root',
  defaultExpanded = true,
  autoExpandDepth = 2,
  className = ''
}) => {
  const copyToClipboard = useCopyToClipboard();

  // Convert autoExpandDepth to collapse setting
  const collapseDepth = autoExpandDepth > 0 ? autoExpandDepth : false;

  return (
    <div className={`toolTesting-jsonViewer ${className}`.trim()}>
      <div className="toolTesting-jsonViewerHeader">
        <span className="toolTesting-jsonViewerTitle">JSON Output</span>
        <CopyButton
          text={JSON.stringify(data, null, 2)}
          onCopy={copyToClipboard}
          className="toolTesting-jsonViewerCopyBtn"
        />
      </div>
      
      <div className="toolTesting-jsonViewerContent">
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
          rootFontSize="var(--font-size-xs)"
          showErrorMessages={false}
        />
      </div>
    </div>
  );
};

export default React.memo(JsonViewer);