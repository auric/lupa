import React, { useState, useCallback } from 'react';
import { CopyButton } from './CopyButton';
import { JsonViewer } from './JsonViewer';
import { LiveTimer } from './LiveTimer';
import { StatusIndicator } from './StatusIndicator';
import { useCopyToClipboard } from '../hooks/useCopyToClipboard';
import type { ToolTestSession } from '../types/toolTestingTypes';
import type { ExecutionStatus } from './StatusIndicator';

interface ResultsPanelProps {
  session: ToolTestSession | null;
  isExecuting: boolean;
  onNavigateToFile?: (filePath: string, line?: number) => void;
}

export const ResultsPanel: React.FC<ResultsPanelProps> = ({
  session,
  isExecuting,
  onNavigateToFile
}) => {
  const copyToClipboard = useCopyToClipboard();
  const [activeTab, setActiveTab] = useState<'output' | 'raw'>('output');

  const formatExecutionTime = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  };

  const getExecutionStatus = (): ExecutionStatus => {
    if (isExecuting) return 'running';
    if (!session) return 'idle';
    return session.status as ExecutionStatus;
  };

  const handleTabChange = useCallback((tab: 'output' | 'raw') => {
    setActiveTab(tab);
  }, []);

  const renderResultContent = (data: any, index: number) => {
    let content: string;
    
    if (typeof data === 'string') {
      content = data;
    } else if (typeof data === 'object') {
      content = JSON.stringify(data, null, 2);
    } else {
      content = String(data);
    }

    // Simple detection of file paths for navigation
    const filePathRegex = /^[a-zA-Z]:[\\\/][\w\s\\\/.-]+\.(ts|tsx|js|jsx|py|java|cpp|c|h|hpp|cs|php|rb|go|rs|swift|kt|scala)$/;
    const isFilePath = filePathRegex.test(content.trim());

    return (
      <div className="result-content-wrapper">
        <div className="result-content-header">
          <span className="result-index">Result {index + 1}</span>
          <div className="result-actions">
            <CopyButton
              text={content}
              onCopy={copyToClipboard}
              className="copy-btn-small"
            />
            {isFilePath && onNavigateToFile && (
              <button
                className="file-navigate-btn"
                onClick={() => onNavigateToFile(content.trim())}
                title="Open file"
              >
                📁
              </button>
            )}
          </div>
        </div>
        <pre className="result-content">
          <code>{content}</code>
        </pre>
      </div>
    );
  };

  // Show loading state
  if (isExecuting) {
    return (
      <div className="results-panel toolTesting-resultsPanel">
        <div className="results-header toolTesting-resultsHeader">
          <StatusIndicator status="running" />
          <LiveTimer isRunning={true} className="toolTesting-executionTimer" />
        </div>
        <div className="results-content toolTesting-resultsContent">
          <div className="loading-container toolTesting-loadingContainer">
            <div className="toolTesting-loadingSpinner large"></div>
            <p className="loading-text toolTesting-loadingText">Running tool...</p>
          </div>
        </div>
      </div>
    );
  }

  // Show empty state when no session
  if (!session) {
    return (
      <div className="results-panel toolTesting-resultsPanel">
        <div className="results-header toolTesting-resultsHeader">
          <StatusIndicator status="idle" />
        </div>
        <div className="results-content toolTesting-resultsContent">
          <div className="empty-state toolTesting-emptyState">
            <div className="empty-state-icon toolTesting-emptyStateIcon">📊</div>
            <h3 className="empty-state-title toolTesting-emptyStateTitle">No Results Yet</h3>
            <p className="empty-state-description toolTesting-emptyStateDescription">
              Configure parameters and execute a tool to see results here
            </p>
          </div>
        </div>
      </div>
    );
  }

  const executionStatus = getExecutionStatus();

  // Show results
  return (
    <div className="results-panel toolTesting-resultsPanel">
      {/* Results Header */}
      <div className="results-header toolTesting-resultsHeader">
        <StatusIndicator status={executionStatus} />
        
        <div className="execution-metadata toolTesting-executionMetadata">
          {isExecuting ? (
            <LiveTimer 
              isRunning={true} 
              className="toolTesting-executionTimer" 
            />
          ) : session.executionTime ? (
            <span className="execution-time toolTesting-executionTime">
              Final: {formatExecutionTime(session.executionTime)}
            </span>
          ) : null}
          <span className="execution-timestamp toolTesting-executionTimestamp">
            {session.timestamp.toLocaleTimeString()}
          </span>
        </div>

        {/* Copy all results button */}
        {session.results && session.results.length > 0 && (
          <CopyButton
            text={session.results.map((result, index) => {
              const content = typeof result.data === 'string' 
                ? result.data 
                : JSON.stringify(result.data, null, 2);
              return `--- Result ${index + 1} ---\n${content}`;
            }).join('\n\n')}
            onCopy={copyToClipboard}
            className="copy-all-btn toolTesting-copyAllBtn"
          />
        )}
      </div>

      {/* Results Tabs */}
      <div className="toolTesting-resultsTabs">
        <div className="toolTesting-tabList">
          <button
            className={`toolTesting-tab ${activeTab === 'output' ? 'active' : ''}`}
            onClick={() => handleTabChange('output')}
          >
            Output
          </button>
          <button
            className={`toolTesting-tab ${activeTab === 'raw' ? 'active' : ''}`}
            onClick={() => handleTabChange('raw')}
          >
            Raw
          </button>
        </div>
      </div>

      {/* Results Content */}
      <div className="results-content toolTesting-resultsContent">
        {session.status === 'error' && session.error ? (
          <div className="error-display toolTesting-errorDisplay">
            <div className="error-header toolTesting-errorHeader">
              <StatusIndicator status="error" showText={false} />
              <span className="error-title toolTesting-errorTitle">Execution Error</span>
            </div>
            <pre className="error-content toolTesting-errorContent">
              <code>{session.error}</code>
            </pre>
            <div className="error-actions toolTesting-errorActions">
              <CopyButton
                text={session.error}
                onCopy={copyToClipboard}
              />
            </div>
          </div>
        ) : session.results && session.results.length > 0 ? (
          <div className="toolTesting-tabContent">
            {activeTab === 'output' && (
              <div className="toolTesting-outputTab">
                {session.results.map((result, index) => (
                  <div key={result.id || index} className="toolTesting-resultItem">
                    <JsonViewer
                      data={result.data}
                      rootKey={`Result ${index + 1}`}
                      defaultExpanded={index === 0}
                      autoExpandDepth={1}
                    />
                  </div>
                ))}
              </div>
            )}
            {activeTab === 'raw' && (
              <div className="toolTesting-rawTab">
                <div className="toolTesting-rawHeader">
                  <span className="toolTesting-rawTitle">Raw JSON Output</span>
                  <CopyButton
                    text={JSON.stringify(session.results.map(r => r.data), null, 2)}
                    onCopy={copyToClipboard}
                    className="toolTesting-jsonViewerCopyBtn"
                  />
                </div>
                <pre className="toolTesting-rawContent">
                  <code>
                    {JSON.stringify(session.results.map(r => r.data), null, 2)}
                  </code>
                </pre>
              </div>
            )}
          </div>
        ) : (
          <div className="empty-results toolTesting-emptyResults">
            <div className="empty-state toolTesting-emptyState">
              <div className="empty-state-icon toolTesting-emptyStateIcon">📭</div>
              <h3 className="empty-state-title toolTesting-emptyStateTitle">No Output</h3>
              <p className="empty-state-description toolTesting-emptyStateDescription">
                The tool executed successfully but returned no results
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default React.memo(ResultsPanel);