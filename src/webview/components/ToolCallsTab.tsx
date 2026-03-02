import React, { useState, useMemo } from 'react';
import {
    ChevronRight,
    Bot,
    Wrench,
    AlertCircle,
    CheckCircle2,
    XCircle,
    Clock,
    GitBranch,
} from 'lucide-react';
import { JsonViewer } from './JsonViewer';
import { CopyButton } from './CopyButton';
import type { ToolCallsData, ToolCallRecord } from '../../types/toolCallTypes';

interface ToolCallsTabProps {
    toolCalls: ToolCallsData | null;
    onCopy?: (text: string) => void;
}

interface AgentSection {
    id: string;
    name: string;
    depth: number;
    calls: ToolCallRecord[];
    executionTimeMs: number | undefined;
    success: boolean;
    failedCount: number;
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

function flattenToAgents(
    calls: ToolCallRecord[],
    parentName: string = 'Root Agent',
    depth: number = 0,
    idPrefix: string = 'agent'
): AgentSection[] {
    const sections: AgentSection[] = [];
    const ownCalls: ToolCallRecord[] = [];
    let childCounter = 0;

    for (const call of calls) {
        ownCalls.push(call);
        if (call.toolName === 'run_subagent' && call.nestedCalls?.length) {
            childCounter++;
            const childId = `${idPrefix}-${childCounter}`;
            const childName = extractAgentName(call);
            const childSections = flattenToAgents(
                call.nestedCalls,
                childName,
                depth + 1,
                childId
            );
            sections.push(...childSections);
        }
    }

    const failedCount = ownCalls.filter((c) => !c.success).length;

    // Insert this agent at the beginning
    sections.unshift({
        id: idPrefix,
        name: parentName,
        depth,
        calls: ownCalls,
        executionTimeMs: undefined, // Root doesn't have a single execution time
        success: failedCount === 0,
        failedCount,
    });

    return sections;
}

function countAllCalls(calls: ToolCallRecord[]): number {
    let count = 0;
    for (const call of calls) {
        count++;
        if (call.nestedCalls?.length) {
            count += countAllCalls(call.nestedCalls);
        }
    }
    return count;
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

function getArgPreview(call: ToolCallRecord): string {
    const args = call.arguments as Record<string, unknown>;
    // Show the most useful argument as a preview
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
            const preview = val.length > 50 ? val.slice(0, 47) + '...' : val;
            return preview;
        }
    }
    const keys = Object.keys(args);
    if (keys.length === 0) {
        return '';
    }
    const firstKey = keys[0]!;
    const firstVal = args[firstKey];
    if (typeof firstVal === 'string') {
        return firstVal.length > 50 ? firstVal.slice(0, 47) + '...' : firstVal;
    }
    return '';
}

const formatToolCallsAsMarkdown = (
    toolCalls: ToolCallsData,
    agents: AgentSection[]
): string => {
    const totalCalls = countAllCalls(toolCalls.calls);
    const totalFailed = countAllFailed(toolCalls.calls);
    const lines: string[] = [
        '# Tool Calls Report',
        '',
        `- **Total Calls:** ${totalCalls}`,
        `- **Agents:** ${agents.length}`,
        totalFailed > 0 ? `- **Failed:** ${totalFailed}` : '',
        '',
    ].filter(Boolean);

    for (const agent of agents) {
        const depthPrefix = agent.depth > 0 ? '  '.repeat(agent.depth) : '';
        lines.push(
            `## ${depthPrefix}${agent.name} (${agent.calls.length} calls)`,
            ''
        );

        for (const call of agent.calls) {
            const status = call.success ? '✅' : '❌';
            const duration =
                call.durationMs !== undefined
                    ? ` (${formatDuration(call.durationMs)})`
                    : '';
            lines.push(`### ${status} ${call.toolName}${duration}`, '');
            lines.push('**Arguments:**', '```json');
            lines.push(JSON.stringify(call.arguments, null, 2));
            lines.push('```', '');

            if (call.error) {
                lines.push('**Error:**', `> ${call.error}`, '');
            } else {
                lines.push('**Result:**');
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

    return lines.join('\n');
};

interface ToolCallRowProps {
    call: ToolCallRecord;
    index: number;
}

const ToolCallRow = ({ call, index }: ToolCallRowProps) => {
    const [expanded, setExpanded] = useState(false);

    const preview = getArgPreview(call);
    const isSubagent = call.toolName === 'run_subagent';
    const displayDuration = isSubagent
        ? (call.executionTimeMs ?? call.durationMs)
        : call.durationMs;

    return (
        <div className="tc-row">
            <div
                className="tc-row-header"
                onClick={() => setExpanded((p) => !p)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && setExpanded((p) => !p)}
            >
                <ChevronRight
                    size={14}
                    className={`tc-chevron ${expanded ? 'tc-chevron--open' : ''}`}
                />
                <span className="tc-row-index">{index + 1}</span>
                {call.success ? (
                    <CheckCircle2 size={14} className="tc-icon--success" />
                ) : (
                    <XCircle size={14} className="tc-icon--failed" />
                )}
                <span className="tc-row-name">{call.toolName}</span>
                {preview && <span className="tc-row-preview">{preview}</span>}
                {isSubagent && call.nestedCalls && (
                    <span className="tc-subagent-pill">
                        <GitBranch size={10} />
                        {call.nestedCalls.length} calls
                    </span>
                )}
                {displayDuration !== undefined && (
                    <span className="tc-row-duration">
                        {formatDuration(displayDuration)}
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
                                maxHeight="200px"
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
                                        maxHeight="200px"
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

interface AgentCardProps {
    agent: AgentSection;
    defaultExpanded?: boolean;
}

const AgentCard = ({ agent, defaultExpanded = false }: AgentCardProps) => {
    const [expanded, setExpanded] = useState(defaultExpanded);

    return (
        <div
            className={`tc-agent ${agent.depth > 0 ? 'tc-agent--child' : ''}`}
            style={
                agent.depth > 1
                    ? { marginLeft: `${(agent.depth - 1) * 12}px` }
                    : undefined
            }
        >
            <div
                className="tc-agent-header"
                onClick={() => setExpanded((p) => !p)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && setExpanded((p) => !p)}
            >
                <ChevronRight
                    size={16}
                    className={`tc-chevron ${expanded ? 'tc-chevron--open' : ''}`}
                />
                <Bot
                    size={16}
                    className={
                        agent.depth === 0
                            ? 'tc-agent-icon--root'
                            : 'tc-agent-icon--child'
                    }
                />
                <span className="tc-agent-name">{agent.name}</span>
                <span className="tc-agent-meta">
                    {agent.calls.length} call
                    {agent.calls.length !== 1 ? 's' : ''}
                </span>
                {agent.executionTimeMs !== undefined && (
                    <span className="tc-agent-meta">
                        <Clock size={12} />
                        {formatDuration(agent.executionTimeMs)}
                    </span>
                )}
                {agent.failedCount > 0 && (
                    <span className="tc-agent-failed">
                        {agent.failedCount} failed
                    </span>
                )}
            </div>
            {expanded && (
                <div className="tc-agent-body">
                    {agent.calls.map((call, i) => (
                        <ToolCallRow key={call.id} call={call} index={i} />
                    ))}
                </div>
            )}
        </div>
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

export const ToolCallsTab = ({ toolCalls, onCopy }: ToolCallsTabProps) => {
    if (!toolCalls || toolCalls.calls.length === 0) {
        return <EmptyState />;
    }

    const agents = useMemo(
        () => flattenToAgents(toolCalls.calls),
        [toolCalls.calls]
    );

    // Compute execution time for child agents from their run_subagent parent records
    // (handled in agentsWithTimes below)

    // Simpler: set execution time on child agents by walking the original structure
    const agentsWithTimes = useMemo(() => {
        // Build execution time map by walking original calls
        const timeMap = new Map<number, number | undefined>();
        let childIdx = 0;
        const walkForTimes = (calls: ToolCallRecord[], depth: number) => {
            for (const call of calls) {
                if (
                    call.toolName === 'run_subagent' &&
                    call.nestedCalls?.length
                ) {
                    childIdx++;
                    timeMap.set(
                        childIdx,
                        call.executionTimeMs ?? call.durationMs
                    );
                    walkForTimes(call.nestedCalls, depth + 1);
                }
            }
        };
        walkForTimes(toolCalls.calls, 0);

        // Apply times to agent sections (children are indexed 1..N in order)
        let childAgentIdx = 0;
        return agents.map((agent) => {
            if (agent.depth > 0) {
                childAgentIdx++;
                return {
                    ...agent,
                    executionTimeMs: timeMap.get(childAgentIdx),
                };
            }
            return agent;
        });
    }, [agents, toolCalls.calls]);

    const totalCalls = useMemo(
        () => countAllCalls(toolCalls.calls),
        [toolCalls.calls]
    );
    const totalFailed = useMemo(
        () => countAllFailed(toolCalls.calls),
        [toolCalls.calls]
    );

    const markdownText = useMemo(
        () => formatToolCallsAsMarkdown(toolCalls, agentsWithTimes),
        [toolCalls, agentsWithTimes]
    );

    return (
        <div className="tc-container">
            {/* Stats bar */}
            <div className="tc-stats">
                <div className="tc-stat">
                    <Wrench size={13} />
                    <span className="tc-stat-value">{totalCalls}</span>
                    <span className="tc-stat-label">tool calls</span>
                </div>
                <span className="tc-stat-sep" />
                <div className="tc-stat">
                    <Bot size={13} />
                    <span className="tc-stat-value">
                        {agentsWithTimes.length}
                    </span>
                    <span className="tc-stat-label">
                        agent{agentsWithTimes.length !== 1 ? 's' : ''}
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

            {/* Agent tree */}
            <div className="tc-list">
                {agentsWithTimes.map((agent, i) => (
                    <AgentCard
                        key={agent.id}
                        agent={agent}
                        defaultExpanded={i === 0}
                    />
                ))}
            </div>
        </div>
    );
};
