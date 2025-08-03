import React, { useCallback } from 'react';
import { CopyButton } from './CopyButton';
import { useCopyToClipboard } from '../hooks/useCopyToClipboard';
import type { ToolTestSession } from '../types/toolTestingTypes';

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

  const formatExecutionTime = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'running': return '⏳';
      case 'completed': return '✅';
      case 'error': return '❌';
      default: return '⭕';
    }
  };

  const getStatusText = (status: string) => {
    switch (status) {
      case 'running': return 'Executing...';
      case 'completed': return 'Completed';
      case 'error': return 'Error';
      default: return 'Unknown';
    }
  };

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
      <div className="results-panel">
        <div className="results-header">
          <div className="execution-status">
            <span className="status-icon">⏳</span>
            <span className="status-text">Executing...</span>
          </div>
        </div>
        <div className="results-content">
          <div className="loading-container">
            <div className="loading-spinner large"></div>
            <p className="loading-text">Running tool...</p>
          </div>
        </div>
      </div>
    );
  }

  // Show empty state when no session
  if (!session) {
    return (
      <div className="results-panel">
        <div className="results-header">
          <div className="execution-status">
            <span className="status-icon">⭕</span>
            <span className="status-text">Ready</span>
          </div>
        </div>
        <div className="results-content">
          <div className="empty-state">
            <div className="empty-state-icon">📊</div>
            <h3 className="empty-state-title">No Results Yet</h3>
            <p className="empty-state-description">
              Configure parameters and execute a tool to see results here
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Show results
  return (
    <div className="results-panel">
      {/* Results Header */}
      <div className="results-header">
        <div className="execution-status">
          <span className="status-icon">{getStatusIcon(session.status)}</span>
          <span className="status-text">{getStatusText(session.status)}</span>
        </div>
        
        <div className="execution-metadata">
          {session.executionTime && (
            <span className="execution-time">
              {formatExecutionTime(session.executionTime)}
            </span>
          )}
          <span className="execution-timestamp">
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
            className="copy-all-btn"
          />
        )}
      </div>

      {/* Results Content */}
      <div className="results-content">
        {session.status === 'error' && session.error ? (
          <div className="error-display">
            <div className="error-header">
              <span className="error-icon">❌</span>
              <span className="error-title">Execution Error</span>
            </div>
            <pre className="error-content">
              <code>{session.error}</code>
            </pre>
            <div className="error-actions">
              <CopyButton
                text={session.error}
                onCopy={copyToClipboard}
              />
            </div>
          </div>
        ) : session.results && session.results.length > 0 ? (
          <div className="results-list">
            {session.results.map((result, index) => (
              <div key={result.id || index} className="result-item">
                {renderResultContent(result.data, index)}
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-results">
            <div className="empty-state">
              <div className="empty-state-icon">📭</div>
              <h3 className="empty-state-title">No Output</h3>
              <p className="empty-state-description">
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