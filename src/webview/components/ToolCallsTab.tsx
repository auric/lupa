import React, { memo, useState, useCallback, useMemo } from 'react';
import { JsonViewer } from './JsonViewer';
import { CopyButton } from './CopyButton';
import type { ToolCallsData, ToolCallRecord } from '../../types/toolCallTypes';

interface ToolCallsTabProps {
    toolCalls: ToolCallsData | null;
    onCopy?: (text: string) => void;
}

/**
 * Formats tool calls data as markdown for clipboard export
 */
const formatToolCallsAsMarkdown = (toolCalls: ToolCallsData): string => {
    const lines: string[] = [
        '# Tool Calls Report',
        '',
        '## Summary',
        '',
        `- **Total Calls:** ${toolCalls.totalCalls}`,
        `- **Successful:** ${toolCalls.successfulCalls}`,
        `- **Failed:** ${toolCalls.failedCalls}`,
        `- **Analysis Completed:** ${toolCalls.analysisCompleted ? 'Yes' : 'No'}`,
    ];

    if (toolCalls.analysisError) {
        lines.push(`- **Error:** ${toolCalls.analysisError}`);
    }

    lines.push('', '## Tool Calls', '');

    const formatCall = (call: ToolCallRecord, prefix: string, isNested: boolean = false) => {
        const status = call.success ? '✅' : '❌';
        const duration = call.durationMs !== undefined ? ` (${call.durationMs}ms)` : '';
        const headingLevel = isNested ? '####' : '###';

        lines.push(`${headingLevel} ${prefix} ${status} ${call.toolName}${duration}`);
        lines.push('');

        lines.push('**Arguments:**');
        lines.push('```json');
        lines.push(JSON.stringify(call.arguments, null, 2));
        lines.push('```');
        lines.push('');

        if (call.error) {
            lines.push('**Error:**');
            lines.push(`> ${call.error}`);
        } else {
            lines.push('**Result:**');
            if (typeof call.result === 'string') {
                lines.push('```');
                lines.push(call.result);
                lines.push('```');
            } else {
                lines.push('```json');
                lines.push(JSON.stringify(call.result, null, 2));
                lines.push('```');
            }
        }
        lines.push('');

        // Format nested calls if present (for subagent)
        if (call.nestedCalls && call.nestedCalls.length > 0) {
            lines.push('**Subagent Tool Calls:**', '');
            call.nestedCalls.forEach((nestedCall, nestedIndex) => {
                formatCall(nestedCall, `${prefix}.${nestedIndex + 1}`, true);
            });
        }
    };

    toolCalls.calls.forEach((call, index) => {
        formatCall(call, `${index + 1}`);
    });

    return lines.join('\n');
};

interface ToolCallItemProps {
    call: ToolCallRecord;
    index: number;
    prefix?: string;
    isNested?: boolean;
}

const ChevronIcon = ({ expanded }: { expanded: boolean }) => (
    <svg
        className={`tool-call-chevron ${expanded ? 'tool-call-chevron--expanded' : ''}`}
        viewBox="0 0 16 16"
        fill="currentColor"
    >
        <path d="M5.7 13.7L5 13l4.6-4.6L5 3.7l.7-.7 5 5.3-5 5.4z" />
    </svg>
);

const ToolCallItem = memo<ToolCallItemProps>(({ call, index, prefix = '', isNested = false }) => {
    const [expanded, setExpanded] = useState(false);
    const [nestedExpanded, setNestedExpanded] = useState(false);

    const handleToggle = useCallback(() => {
        setExpanded(prev => !prev);
    }, []);

    const handleNestedToggle = useCallback(() => {
        setNestedExpanded(prev => !prev);
    }, []);

    const formatDuration = (ms: number | undefined): string => {
        if (ms === undefined) return '';
        if (ms < 1000) return `${ms}ms`;
        return `${(ms / 1000).toFixed(2)}s`;
    };

    const displayIndex = prefix ? `${prefix}.${index + 1}` : `${index + 1}`;
    const hasNestedCalls = call.nestedCalls && call.nestedCalls.length > 0;

    return (
        <div className={`tool-call-item ${isNested ? 'tool-call-item--nested' : ''}`}>
            <div
                className="tool-call-header"
                onClick={handleToggle}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && handleToggle()}
            >
                <ChevronIcon expanded={expanded} />
                <span
                    className={`tool-call-status ${call.success ? 'tool-call-status--success' : 'tool-call-status--failed'}`}
                />
                <span className="tool-call-name">
                    {displayIndex}. {call.toolName}
                </span>
                {hasNestedCalls && (
                    <span className="tool-call-subagent-badge">
                        {call.nestedCalls!.length} subagent calls
                    </span>
                )}
                {call.durationMs !== undefined && (
                    <span className="tool-call-duration">
                        {formatDuration(call.durationMs)}
                    </span>
                )}
            </div>
            <div className={`tool-call-body ${expanded ? 'tool-call-body--expanded' : ''}`}>
                <div className="tool-call-section">
                    <div className="tool-call-section-title">Arguments</div>
                    <div className="tool-call-json-wrapper">
                        <JsonViewer
                            data={call.arguments}
                            rootKey="args"
                            collapseDepth={3}
                            maxHeight="200px"
                        />
                    </div>
                </div>

                {call.error ? (
                    <div className="tool-call-section">
                        <div className="tool-call-section-title">Error</div>
                        <div className="tool-call-error-message">{call.error}</div>
                    </div>
                ) : (
                    <div className="tool-call-section">
                        <div className="tool-call-section-title">Result</div>
                        <div className="tool-call-json-wrapper">
                            {typeof call.result === 'string' ? (
                                <pre style={{
                                    margin: 0,
                                    padding: '0.5rem',
                                    fontSize: '0.75rem',
                                    whiteSpace: 'pre-wrap',
                                    wordBreak: 'break-word',
                                    fontFamily: 'var(--vscode-editor-font-family, monospace)',
                                    color: 'var(--vscode-editor-foreground)',
                                    maxHeight: '200px',
                                    overflow: 'auto'
                                }}>
                                    {call.result}
                                </pre>
                            ) : (
                                <JsonViewer
                                    data={call.result}
                                    rootKey="result"
                                    collapseDepth={2}
                                    maxHeight="200px"
                                />
                            )}
                        </div>
                    </div>
                )}

                {/* Nested tool calls from subagent */}
                {hasNestedCalls && (
                    <div className="tool-call-section tool-call-nested-section">
                        <div
                            className="tool-call-section-title tool-call-nested-header"
                            onClick={handleNestedToggle}
                            role="button"
                            tabIndex={0}
                            onKeyDown={(e) => e.key === 'Enter' && handleNestedToggle()}
                        >
                            <ChevronIcon expanded={nestedExpanded} />
                            Subagent Tool Calls ({call.nestedCalls!.length})
                        </div>
                        <div className={`tool-call-nested-list ${nestedExpanded ? 'tool-call-nested-list--expanded' : ''}`}>
                            {call.nestedCalls!.map((nestedCall, nestedIndex) => (
                                <ToolCallItem
                                    key={nestedCall.id}
                                    call={nestedCall}
                                    index={nestedIndex}
                                    prefix={displayIndex}
                                    isNested={true}
                                />
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
});

const EmptyState = () => (
    <div className="tool-calls-empty">
        <svg
            className="tool-calls-empty-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
        >
            <path d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
        </svg>
        <div className="tool-calls-empty-title">No Tool Calls</div>
        <div className="tool-calls-empty-description">
            The analysis was performed without using any tools.
        </div>
    </div>
);

export const ToolCallsTab = memo<ToolCallsTabProps>(({ toolCalls, onCopy }) => {
    if (!toolCalls || toolCalls.calls.length === 0) {
        return <EmptyState />;
    }

    const { calls, totalCalls, successfulCalls, failedCalls, analysisCompleted, analysisError } = toolCalls;

    const markdownText = useMemo(() => formatToolCallsAsMarkdown(toolCalls), [toolCalls]);

    return (
        <div className="tool-calls-container">
            <div className="tool-calls-summary">
                <div className="tool-calls-stat">
                    <span className="tool-calls-stat-label">Total:</span>
                    <span className="tool-calls-stat-value">{totalCalls}</span>
                </div>
                {successfulCalls > 0 && (
                    <div className="tool-calls-stat tool-calls-stat--success">
                        <span className="tool-calls-stat-label">Success:</span>
                        <span className="tool-calls-stat-value">{successfulCalls}</span>
                    </div>
                )}
                {failedCalls > 0 && (
                    <div className="tool-calls-stat tool-calls-stat--failed">
                        <span className="tool-calls-stat-label">Failed:</span>
                        <span className="tool-calls-stat-value">{failedCalls}</span>
                    </div>
                )}
                {!analysisCompleted && (
                    <div className="tool-calls-stat tool-calls-stat--error">
                        <span className="tool-calls-stat-label">Analysis incomplete</span>
                    </div>
                )}
                <div className="tool-calls-copy-button">
                    <CopyButton
                        text={markdownText}
                        onCopy={onCopy}
                    />
                </div>
            </div>

            {analysisError && (
                <div style={{ padding: '0.5rem' }}>
                    <div className="tool-call-error-message">
                        Analysis Error: {analysisError}
                    </div>
                </div>
            )}

            <div className="tool-calls-list">
                {calls.map((call, index) => (
                    <ToolCallItem key={call.id} call={call} index={index} />
                ))}
            </div>
        </div>
    );
});
