import React, { useState, useMemo, useRef } from 'react';
import {
    ChevronRight,
    Bot,
    Wrench,
    AlertCircle,
    CheckCircle2,
    XCircle,
    Clock,
    MessageSquare,
    Info,
    Search,
    X,
    Filter,
} from 'lucide-react';
import { JsonViewer } from './JsonViewer';
import { CopyButton } from './CopyButton';
import type { ToolCallsData, ToolCallRecord } from '../../types/toolCallTypes';
import { countAllCalls } from '../utils/toolCallCounting';

interface ToolCallsTabProps {
    toolCalls: ToolCallsData | null;
    onCopy?: (text: string) => void;
}

// ── Helpers ──

/** Recursively collect tool name → call count across the entire tree */
function collectToolNameCounts(calls: ToolCallRecord[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const call of calls) {
        counts.set(call.toolName, (counts.get(call.toolName) ?? 0) + 1);
        if (call.nestedCalls?.length) {
            const nested = collectToolNameCounts(call.nestedCalls);
            for (const [name, count] of nested) {
                counts.set(name, (counts.get(name) ?? 0) + count);
            }
        }
    }
    return counts;
}

/**
 * Filter call tree by tool name substring match.
 * Subagents are included if they or any of their nested calls match.
 * Returns a new array with only matching calls (subagents get filtered nestedCalls).
 */
function filterCallTree(
    calls: ToolCallRecord[],
    filter: string
): ToolCallRecord[] {
    const lowerFilter = filter.toLowerCase();
    const result: ToolCallRecord[] = [];
    for (const call of calls) {
        const nameMatches = call.toolName.toLowerCase().includes(lowerFilter);
        if (call.nestedCalls?.length) {
            // Subagent: include if name matches (show all nested) or if any nested matches
            if (nameMatches) {
                result.push(call);
            } else {
                const filteredNested = filterCallTree(call.nestedCalls, filter);
                if (filteredNested.length > 0) {
                    result.push({
                        ...call,
                        nestedCalls: filteredNested,
                    });
                }
            }
        } else if (nameMatches) {
            result.push(call);
        }
    }
    return result;
}

function countAllFailed(calls: ToolCallRecord[]): number {
    let count = 0;
    for (const call of calls) {
        if (!call.success) {
            count++;
        }
        if (call.nestedCalls?.length) {
            count += countAllFailed(call.nestedCalls);
        }
    }
    return count;
}

function countAgents(calls: ToolCallRecord[]): number {
    let count = 0;
    for (const call of calls) {
        if (call.toolName === 'run_subagent') {
            count += 1;
            if (call.nestedCalls?.length) {
                count += countAgents(call.nestedCalls);
            }
        }
    }
    return count;
}

function countAllIterations(
    calls: ToolCallRecord[],
    rootIterations: number | undefined
): number {
    let count = rootIterations ?? 0;
    for (const call of calls) {
        if (
            call.toolName === 'run_subagent' &&
            call.iterationsUsed !== undefined
        ) {
            count += call.iterationsUsed;
        }
        if (call.nestedCalls?.length) {
            count += countAllIterations(call.nestedCalls, 0);
        }
    }
    return count;
}

function formatDuration(ms: number | undefined): string {
    if (ms === undefined) {
        return '';
    }
    if (ms < 1000) {
        return `${ms}ms`;
    }
    if (ms < 60000) {
        return `${(ms / 1000).toFixed(1)}s`;
    }
    const mins = Math.floor(ms / 60000);
    const secs = Math.round((ms % 60000) / 1000);
    return `${mins}m ${secs}s`;
}

function extractAgentName(call: ToolCallRecord): string {
    const args = call.arguments as Record<string, unknown>;
    if (
        args.investigation_focus &&
        typeof args.investigation_focus === 'string'
    ) {
        const focus = args.investigation_focus;
        return focus.length > 60 ? focus.slice(0, 57) + '...' : focus;
    }
    if (args.task && typeof args.task === 'string') {
        const task = args.task;
        return task.length > 60 ? task.slice(0, 57) + '...' : task;
    }
    return 'Subagent';
}

function getArgPreview(call: ToolCallRecord): string {
    const args = call.arguments as Record<string, unknown>;
    const previewKeys = [
        'symbol_name',
        'file_path',
        'pattern',
        'directory_path',
        'investigation_focus',
        'topic',
        'content',
        'task',
    ];
    for (const key of previewKeys) {
        const val = args[key];
        if (typeof val === 'string' && val.length > 0) {
            return val.length > 50 ? val.slice(0, 47) + '...' : val;
        }
    }
    const keys = Object.keys(args);
    if (keys.length === 0) {
        return '';
    }
    const firstVal = args[keys[0]!];
    if (typeof firstVal === 'string') {
        return firstVal.length > 50 ? firstVal.slice(0, 47) + '...' : firstVal;
    }
    return '';
}

// ── Markdown export ──

function formatCallsMarkdown(calls: ToolCallRecord[], depth: number): string[] {
    const lines: string[] = [];
    const indent = '  '.repeat(depth);
    for (const call of calls) {
        const status = call.success ? '\u2705' : '\u274c';
        const dur = call.durationMs
            ? ` (${formatDuration(call.durationMs)})`
            : '';
        if (call.toolName === 'run_subagent' && call.nestedCalls?.length) {
            const name = extractAgentName(call);
            const total = countAllCalls(call.nestedCalls);
            lines.push(
                `${indent}## ${status} ${name} (${total} calls)${dur}`,
                ''
            );
            lines.push(...formatCallsMarkdown(call.nestedCalls, depth + 1));
        } else {
            lines.push(`${indent}### ${status} ${call.toolName}${dur}`, '');
            lines.push(`${indent}**Arguments:**`, '```json');
            lines.push(JSON.stringify(call.arguments, null, 2));
            lines.push('```', '');
            if (call.error) {
                lines.push(`${indent}**Error:**`, `> ${call.error}`, '');
            } else {
                lines.push(`${indent}**Result:**`);
                if (typeof call.result === 'string') {
                    lines.push('```', call.result, '```');
                } else {
                    lines.push(
                        '```json',
                        JSON.stringify(call.result, null, 2),
                        '```'
                    );
                }
                lines.push('');
            }
        }
    }
    return lines;
}

function formatToolCallsAsMarkdown(toolCalls: ToolCallsData): string {
    const totalCalls = countAllCalls(toolCalls.calls);
    const totalFailed = countAllFailed(toolCalls.calls);
    const totalIterations = countAllIterations(
        toolCalls.calls,
        toolCalls.iterationsUsed
    );
    const lines: string[] = [
        '# Tool Calls Report',
        '',
        `- **Total Calls:** ${totalCalls}`,
        totalFailed > 0 ? `- **Failed:** ${totalFailed}` : '',
        totalIterations > 0 ? `- **Total Iterations:** ${totalIterations}` : '',
        '',
    ].filter(Boolean);
    lines.push(...formatCallsMarkdown(toolCalls.calls, 0));
    return lines.join('\n');
}

// ── Components ──

/** A regular (non-subagent) tool call row */
const ToolCallRow = ({
    call,
    index,
}: {
    call: ToolCallRecord;
    index: number;
}) => {
    const [expanded, setExpanded] = useState(false);
    const preview = getArgPreview(call);

    return (
        <div className="tc-row">
            <div
                className="tc-row-header"
                onClick={() => setExpanded((p) => !p)}
                role="button"
                tabIndex={0}
                aria-expanded={expanded}
                onKeyDown={(e) =>
                    (e.key === 'Enter' || e.key === ' ') &&
                    setExpanded((p) => !p)
                }
            >
                <ChevronRight
                    size={14}
                    className={`tc-chevron ${expanded ? 'tc-chevron--open' : ''}`}
                />
                <span className="tc-row-index">{index}</span>
                {call.success ? (
                    <CheckCircle2 size={14} className="tc-icon--success" />
                ) : (
                    <XCircle size={14} className="tc-icon--failed" />
                )}
                <span className="tc-row-name">{call.toolName}</span>
                {preview && <span className="tc-row-preview">{preview}</span>}
                {call.durationMs !== undefined && (
                    <span className="tc-row-duration">
                        {formatDuration(call.durationMs)}
                    </span>
                )}
            </div>
            {expanded && (
                <div className="tc-row-detail">
                    <div className="tc-detail-section">
                        <div className="tc-detail-label">Arguments</div>
                        <div className="tc-detail-content">
                            <JsonViewer
                                data={call.arguments}
                                rootKey="args"
                                collapseDepth={3}
                                maxHeight="none"
                            />
                        </div>
                    </div>
                    {call.error ? (
                        <div className="tc-detail-section">
                            <div className="tc-detail-label">Error</div>
                            <div className="tc-error-box">{call.error}</div>
                        </div>
                    ) : (
                        <div className="tc-detail-section">
                            <div className="tc-detail-label">Result</div>
                            <div className="tc-detail-content">
                                {typeof call.result === 'string' ? (
                                    <pre className="tc-result-pre">
                                        {call.result}
                                    </pre>
                                ) : (
                                    <JsonViewer
                                        data={call.result}
                                        rootKey="result"
                                        collapseDepth={2}
                                        maxHeight="none"
                                    />
                                )}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

/**
 * Renders an inline agent section for a run_subagent call.
 * Shows the agent header with summary stats, and when expanded,
 * renders its nested calls as a true tree (recursively).
 */
const InlineAgent = ({
    call,
    index,
    depth,
}: {
    call: ToolCallRecord;
    index: number;
    depth: number;
}) => {
    const [expanded, setExpanded] = useState(false);
    const [detailExpanded, setDetailExpanded] = useState(false);

    const nestedCalls = call.nestedCalls ?? [];
    const name = extractAgentName(call);
    const totalNested = countAllCalls(nestedCalls);
    const failedNested = countAllFailed(nestedCalls);
    const displayDuration = call.executionTimeMs ?? call.durationMs;

    return (
        <div className="tc-agent">
            <div
                className="tc-agent-header"
                onClick={() => setExpanded((p) => !p)}
                role="button"
                tabIndex={0}
                aria-expanded={expanded}
                onKeyDown={(e) =>
                    (e.key === 'Enter' || e.key === ' ') &&
                    setExpanded((p) => !p)
                }
            >
                <ChevronRight
                    size={14}
                    className={`tc-chevron ${expanded ? 'tc-chevron--open' : ''}`}
                />
                <span className="tc-row-index">{index}</span>
                {call.success ? (
                    <CheckCircle2 size={14} className="tc-icon--success" />
                ) : (
                    <XCircle size={14} className="tc-icon--failed" />
                )}
                <Bot size={14} className="tc-agent-icon" />
                <span className="tc-agent-name">{name}</span>
                <span className="tc-agent-meta">
                    {totalNested} call{totalNested !== 1 ? 's' : ''}
                </span>
                {call.iterationsUsed !== undefined && (
                    <span className="tc-agent-meta">
                        <MessageSquare size={11} />
                        {call.iterationsUsed} iter
                    </span>
                )}
                {displayDuration !== undefined && (
                    <span className="tc-agent-meta">
                        <Clock size={12} />
                        {formatDuration(displayDuration)}
                    </span>
                )}
                {failedNested > 0 && (
                    <span className="tc-agent-failed">
                        {failedNested} failed
                    </span>
                )}
            </div>
            {expanded && (
                <div className="tc-agent-body">
                    {/* Expandable row to show the raw run_subagent args/result */}
                    <div className="tc-row tc-row--meta">
                        <div
                            className="tc-row-header tc-row-header--meta"
                            onClick={() => setDetailExpanded((p) => !p)}
                            role="button"
                            tabIndex={0}
                            aria-expanded={detailExpanded}
                            onKeyDown={(e) =>
                                (e.key === 'Enter' || e.key === ' ') &&
                                setDetailExpanded((p) => !p)
                            }
                        >
                            <ChevronRight
                                size={12}
                                className={`tc-chevron ${detailExpanded ? 'tc-chevron--open' : ''}`}
                            />
                            <span className="tc-row-metaLabel">
                                task &amp; result
                            </span>
                        </div>
                        {detailExpanded && (
                            <div className="tc-row-detail">
                                <div className="tc-detail-section">
                                    <div className="tc-detail-label">Task</div>
                                    <div className="tc-detail-content">
                                        <JsonViewer
                                            data={call.arguments}
                                            rootKey="args"
                                            collapseDepth={3}
                                            maxHeight="none"
                                        />
                                    </div>
                                </div>
                                {call.error ? (
                                    <div className="tc-detail-section">
                                        <div className="tc-detail-label">
                                            Error
                                        </div>
                                        <div className="tc-error-box">
                                            {call.error}
                                        </div>
                                    </div>
                                ) : (
                                    <div className="tc-detail-section">
                                        <div className="tc-detail-label">
                                            Result
                                        </div>
                                        <div className="tc-detail-content">
                                            {typeof call.result === 'string' ? (
                                                <pre className="tc-result-pre">
                                                    {call.result}
                                                </pre>
                                            ) : (
                                                <JsonViewer
                                                    data={call.result}
                                                    rootKey="result"
                                                    collapseDepth={2}
                                                    maxHeight="none"
                                                />
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                    {/* Nested tool calls rendered as a tree */}
                    <CallList calls={nestedCalls} depth={depth + 1} />
                </div>
            )}
        </div>
    );
};

/**
 * Renders a list of tool calls. Subagent calls are rendered as
 * inline agent sections; other calls as regular rows.
 * Counter is sequential across the entire list.
 */
const CallList = ({
    calls,
    depth,
    startIndex = 1,
}: {
    calls: ToolCallRecord[];
    depth: number;
    startIndex?: number;
}) => {
    let idx = startIndex;
    return (
        <>
            {calls.map((call) => {
                const currentIdx = idx++;
                if (call.toolName === 'run_subagent') {
                    return (
                        <InlineAgent
                            key={call.id}
                            call={call}
                            index={currentIdx}
                            depth={depth}
                        />
                    );
                }
                return (
                    <ToolCallRow key={call.id} call={call} index={currentIdx} />
                );
            })}
        </>
    );
};

const EmptyState = () => (
    <div className="tc-empty">
        <Wrench size={36} strokeWidth={1.2} className="tc-empty-icon" />
        <div className="tc-empty-title">No Tool Calls</div>
        <div className="tc-empty-desc">
            The analysis completed without using any tools.
        </div>
    </div>
);

const FilterEmptyState = () => (
    <div className="tc-empty">
        <Filter size={28} strokeWidth={1.2} className="tc-empty-icon" />
        <div className="tc-empty-title">No Matching Tool Calls</div>
        <div className="tc-empty-desc">
            Try a different filter or clear the search.
        </div>
    </div>
);

export const ToolCallsTab = ({ toolCalls, onCopy }: ToolCallsTabProps) => {
    const [filterText, setFilterText] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);

    if (!toolCalls || toolCalls.calls.length === 0) {
        return <EmptyState />;
    }

    const totalCalls = useMemo(
        () => countAllCalls(toolCalls.calls),
        [toolCalls.calls]
    );
    const totalFailed = useMemo(
        () => countAllFailed(toolCalls.calls),
        [toolCalls.calls]
    );
    const agentCount = useMemo(
        () => countAgents(toolCalls.calls) + 1,
        [toolCalls.calls]
    );
    const totalIterations = useMemo(
        () => countAllIterations(toolCalls.calls, toolCalls.iterationsUsed),
        [toolCalls.calls, toolCalls.iterationsUsed]
    );

    const markdownText = useMemo(
        () => formatToolCallsAsMarkdown(toolCalls),
        [toolCalls]
    );

    const toolNameCounts = useMemo(
        () => collectToolNameCounts(toolCalls.calls),
        [toolCalls.calls]
    );

    const sortedToolNames = useMemo(
        () => [...toolNameCounts.entries()].sort((a, b) => b[1] - a[1]),
        [toolNameCounts]
    );

    const trimmedFilter = filterText.trim();
    const isFiltering = trimmedFilter.length > 0;

    const filteredCalls = useMemo(
        () =>
            isFiltering
                ? filterCallTree(toolCalls.calls, trimmedFilter)
                : toolCalls.calls,
        [toolCalls.calls, trimmedFilter, isFiltering]
    );

    const filteredTotal = useMemo(
        () => (isFiltering ? countAllCalls(filteredCalls) : totalCalls),
        [isFiltering, filteredCalls, totalCalls]
    );

    const handleChipClick = (toolName: string) => {
        if (filterText === toolName) {
            setFilterText('');
        } else {
            setFilterText(toolName);
        }
        inputRef.current?.focus();
    };

    const handleClearFilter = () => {
        setFilterText('');
        inputRef.current?.focus();
    };

    return (
        <div className="tc-container">
            {/* Stats bar */}
            <div className="tc-stats">
                {totalIterations > 0 && (
                    <>
                        <div
                            className="tc-stat tc-stat--primary"
                            title="LLM iterations (turns) — each iteration consumes Copilot credits"
                        >
                            <MessageSquare size={13} />
                            <span className="tc-stat-value">
                                {totalIterations}
                            </span>
                            <span className="tc-stat-label">iterations</span>
                            <Info size={11} className="tc-stat-info" />
                        </div>
                        <span className="tc-stat-sep" />
                    </>
                )}
                <div className="tc-stat">
                    <Wrench size={13} />
                    <span className="tc-stat-value">{totalCalls}</span>
                    <span className="tc-stat-label">tool calls</span>
                </div>
                <span className="tc-stat-sep" />
                <div className="tc-stat">
                    <Bot size={13} />
                    <span className="tc-stat-value">{agentCount}</span>
                    <span className="tc-stat-label">
                        agent{agentCount !== 1 ? 's' : ''}
                    </span>
                </div>
                {totalFailed > 0 && (
                    <>
                        <span className="tc-stat-sep" />
                        <div className="tc-stat tc-stat--failed">
                            <AlertCircle size={13} />
                            <span className="tc-stat-value">{totalFailed}</span>
                            <span className="tc-stat-label">failed</span>
                        </div>
                    </>
                )}
                {!toolCalls.analysisCompleted && (
                    <>
                        <span className="tc-stat-sep" />
                        <div className="tc-stat tc-stat--warn">
                            <AlertCircle size={13} />
                            <span className="tc-stat-label">incomplete</span>
                        </div>
                    </>
                )}
                <div className="tc-stats-spacer" />
                <CopyButton text={markdownText} onCopy={onCopy} />
            </div>

            {toolCalls.analysisError && (
                <div className="tc-error-banner">
                    <AlertCircle size={14} />
                    {toolCalls.analysisError}
                </div>
            )}

            {/* Filter bar */}
            <div className="tc-filter">
                <div className="tc-filter-row">
                    <div className="tc-filter-input-wrap">
                        <Search size={13} className="tc-filter-icon" />
                        <input
                            ref={inputRef}
                            type="text"
                            className="tc-filter-input"
                            placeholder="Filter by tool name..."
                            value={filterText}
                            onChange={(e) => setFilterText(e.target.value)}
                        />
                        {isFiltering && (
                            <button
                                className="tc-filter-clear"
                                onClick={handleClearFilter}
                                aria-label="Clear filter"
                            >
                                <X size={13} />
                            </button>
                        )}
                    </div>
                    {isFiltering && (
                        <span className="tc-filter-count">
                            {filteredTotal} of {totalCalls}
                        </span>
                    )}
                </div>
                <div className="tc-filter-chips">
                    {sortedToolNames.map(([name, count]) => (
                        <button
                            key={name}
                            className={`tc-filter-chip ${
                                filterText === name
                                    ? 'tc-filter-chip--active'
                                    : ''
                            }`}
                            onClick={() => handleChipClick(name)}
                        >
                            {name}
                            <span className="tc-filter-chip-count">
                                {count}
                            </span>
                        </button>
                    ))}
                </div>
            </div>

            {/* Unified call tree — root agent's calls rendered inline */}
            <div className="tc-list">
                {isFiltering && filteredCalls.length === 0 ? (
                    <FilterEmptyState />
                ) : (
                    <CallList calls={filteredCalls} depth={0} />
                )}
            </div>
        </div>
    );
};
