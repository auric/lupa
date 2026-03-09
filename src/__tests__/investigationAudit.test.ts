import { describe, it, expect } from 'vitest';
import {
    buildInvestigationAudit,
    formatAuditSection,
} from '../utils/investigationAudit';
import type { ToolCallRecord } from '../types/toolCallTypes';

function makeToolCall(overrides: Partial<ToolCallRecord>): ToolCallRecord {
    return {
        id: overrides.id ?? 'tc-1',
        toolName: overrides.toolName ?? 'read_file',
        arguments: overrides.arguments ?? {},
        result: overrides.result ?? '',
        success: overrides.success ?? true,
        error: overrides.error ?? undefined,
        durationMs: overrides.durationMs ?? 100,
        timestamp: overrides.timestamp ?? Date.now(),
        nestedCalls: overrides.nestedCalls,
    };
}

describe('buildInvestigationAudit', () => {
    it('returns empty audit for empty tool calls', () => {
        const audit = buildInvestigationAudit([]);

        expect(audit.filesRead).toHaveLength(0);
        expect(audit.symbolsResolved).toHaveLength(0);
        expect(audit.usagesChecked).toHaveLength(0);
        expect(audit.patternsSearched).toHaveLength(0);
        expect(audit.diffsExamined).toHaveLength(0);
        expect(audit.depthScores.size).toBe(0);
    });

    it('builds file entries from read_file tool calls', () => {
        const calls: ToolCallRecord[] = [
            makeToolCall({
                toolName: 'read_file',
                arguments: {
                    file_path: 'src/foo.ts',
                    start_line: 1,
                    end_line: 50,
                },
            }),
            makeToolCall({
                toolName: 'read_file',
                arguments: {
                    file_path: 'src/bar.ts',
                    start_line: 10,
                    end_line: 30,
                },
            }),
        ];

        const audit = buildInvestigationAudit(calls);

        expect(audit.filesRead).toHaveLength(2);
        expect(audit.filesRead[0]).toEqual({
            path: 'src/foo.ts',
            lineRange: [1, 50],
        });
        expect(audit.filesRead[1]).toEqual({
            path: 'src/bar.ts',
            lineRange: [10, 30],
        });
    });

    it('skips read_file calls without file_path', () => {
        const calls: ToolCallRecord[] = [
            makeToolCall({ toolName: 'read_file', arguments: {} }),
        ];
        const audit = buildInvestigationAudit(calls);
        expect(audit.filesRead).toHaveLength(0);
    });

    it('builds symbol resolution entries from find_symbol calls', () => {
        const calls: ToolCallRecord[] = [
            makeToolCall({
                toolName: 'find_symbol',
                arguments: {
                    symbol_name: 'MyClass',
                    file_path: 'src/model.ts',
                },
                result: 'Found class definition at line 10',
            }),
        ];

        const audit = buildInvestigationAudit(calls);

        expect(audit.symbolsResolved).toHaveLength(1);
        expect(audit.symbolsResolved[0]).toEqual({
            name: 'MyClass',
            file: 'src/model.ts',
            kind: 'class',
        });
    });

    it('defaults file to "unknown" when find_symbol has no file_path', () => {
        const calls: ToolCallRecord[] = [
            makeToolCall({
                toolName: 'find_symbol',
                arguments: { symbol_name: 'foo' },
                result: 'function foo()',
            }),
        ];

        const audit = buildInvestigationAudit(calls);
        expect(audit.symbolsResolved[0].file).toBe('unknown');
    });

    it('builds usage entries from find_usages calls', () => {
        const calls: ToolCallRecord[] = [
            makeToolCall({
                toolName: 'find_usages',
                arguments: { symbol_name: 'getData' },
                result: 'Found 5 references',
            }),
        ];

        const audit = buildInvestigationAudit(calls);

        expect(audit.usagesChecked).toHaveLength(1);
        expect(audit.usagesChecked[0]).toEqual({
            symbol: 'getData',
            referenceCount: 5,
        });
    });

    it('builds pattern search entries from search_for_pattern calls', () => {
        const calls: ToolCallRecord[] = [
            makeToolCall({
                toolName: 'search_for_pattern',
                arguments: { pattern: 'TODO' },
                result: '3 matches found',
            }),
        ];

        const audit = buildInvestigationAudit(calls);

        expect(audit.patternsSearched).toHaveLength(1);
        expect(audit.patternsSearched[0]).toEqual({
            query: 'TODO',
            matchCount: 3,
        });
    });

    it('computes correct depth scores (+2 per signal type per file)', () => {
        const calls: ToolCallRecord[] = [
            // File read
            makeToolCall({
                toolName: 'read_file',
                arguments: {
                    file_path: 'src/main.ts',
                    start_line: 1,
                    end_line: 100,
                },
            }),
            // Diff examined
            makeToolCall({
                toolName: 'get_file_diff',
                arguments: { file_paths: ['src/main.ts'] },
            }),
            // Symbol resolved for same file
            makeToolCall({
                toolName: 'find_symbol',
                arguments: { symbol_name: 'init', file_path: 'src/main.ts' },
                result: 'function init()',
            }),
            // Usage for the same symbol
            makeToolCall({
                toolName: 'find_usages',
                arguments: { symbol_name: 'init' },
                result: '2 references',
            }),
            // Pattern search (applies to files that were read or diffed)
            makeToolCall({
                toolName: 'search_for_pattern',
                arguments: { pattern: 'init' },
                result: '1 match',
            }),
        ];

        const audit = buildInvestigationAudit(calls);
        const depth = audit.depthScores.get('src/main.ts');

        expect(depth).toBeDefined();
        // read(2) + diff(2) + symbols(2) + usages(2) + patterns(2) = 10, capped at 10
        expect(depth!.score).toBe(10);
        expect(depth!.breakdown).toContain('diff');
        expect(depth!.breakdown).toContain('read');
        expect(depth!.breakdown).toContain('symbols');
        expect(depth!.breakdown).toContain('usages');
        expect(depth!.breakdown).toContain('patterns');
    });

    it('caps depth score at 10', () => {
        const calls: ToolCallRecord[] = [
            makeToolCall({
                toolName: 'read_file',
                arguments: { file_path: 'a.ts', start_line: 1, end_line: 10 },
            }),
            makeToolCall({
                toolName: 'get_file_diff',
                arguments: { file_paths: ['a.ts'] },
            }),
            makeToolCall({
                toolName: 'find_symbol',
                arguments: { symbol_name: 'x', file_path: 'a.ts' },
                result: 'function x()',
            }),
            makeToolCall({
                toolName: 'find_usages',
                arguments: { symbol_name: 'x' },
                result: '1 ref',
            }),
            makeToolCall({
                toolName: 'search_for_pattern',
                arguments: { pattern: 'x' },
                result: '1 match',
            }),
        ];

        const audit = buildInvestigationAudit(calls);
        expect(audit.depthScores.get('a.ts')!.score).toBeLessThanOrEqual(10);
    });

    it('flattens nested tool calls', () => {
        const calls: ToolCallRecord[] = [
            makeToolCall({
                toolName: 'run_subagent',
                arguments: {},
                nestedCalls: [
                    makeToolCall({
                        toolName: 'read_file',
                        arguments: {
                            file_path: 'src/nested.ts',
                            start_line: 1,
                            end_line: 10,
                        },
                    }),
                    makeToolCall({
                        toolName: 'find_symbol',
                        arguments: {
                            symbol_name: 'nestedFn',
                            file_path: 'src/nested.ts',
                        },
                        result: 'function nestedFn()',
                    }),
                ],
            }),
        ];

        const audit = buildInvestigationAudit(calls);

        expect(audit.filesRead).toHaveLength(1);
        expect(audit.filesRead[0].path).toBe('src/nested.ts');
        expect(audit.symbolsResolved).toHaveLength(1);
        expect(audit.symbolsResolved[0].name).toBe('nestedFn');
    });

    it('handles deeply nested tool calls', () => {
        const calls: ToolCallRecord[] = [
            makeToolCall({
                toolName: 'run_subagent',
                nestedCalls: [
                    makeToolCall({
                        toolName: 'run_subagent',
                        nestedCalls: [
                            makeToolCall({
                                toolName: 'read_file',
                                arguments: {
                                    file_path: 'deep.ts',
                                    start_line: 1,
                                    end_line: 5,
                                },
                            }),
                        ],
                    }),
                ],
            }),
        ];

        const audit = buildInvestigationAudit(calls);
        expect(audit.filesRead).toHaveLength(1);
        expect(audit.filesRead[0].path).toBe('deep.ts');
    });
});

describe('formatAuditSection', () => {
    it('returns empty string for empty audit', () => {
        const audit = buildInvestigationAudit([]);
        expect(formatAuditSection(audit)).toBe('');
    });

    it('returns formatted string with depth scores', () => {
        const calls: ToolCallRecord[] = [
            makeToolCall({
                toolName: 'read_file',
                arguments: {
                    file_path: 'src/app.ts',
                    start_line: 1,
                    end_line: 50,
                },
            }),
            makeToolCall({
                toolName: 'get_file_diff',
                arguments: { file_paths: ['src/app.ts'] },
            }),
        ];

        const audit = buildInvestigationAudit(calls);
        const section = formatAuditSection(audit);

        expect(section).toContain('## Investigation Audit');
        expect(section).toContain('Files examined:');
        expect(section).toContain('src/app.ts');
        expect(section).toContain('Depth scores:');
        expect(section).toContain('**Symbols resolved:** 0');
        expect(section).toContain('**Usages checked:** 0');
        expect(section).toContain('**Patterns searched:** 0');
    });
});
