import { describe, it, expect } from 'vitest';
import {
    buildInvestigationAudit,
    normalizeRelativePath,
    formatCompactAudit,
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
        const audit = buildInvestigationAudit([], undefined);

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

        const audit = buildInvestigationAudit(calls, undefined);

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
        const audit = buildInvestigationAudit(calls, undefined);
        expect(audit.filesRead).toHaveLength(0);
    });

    it('builds symbol resolution entries from find_symbol calls', () => {
        const calls: ToolCallRecord[] = [
            makeToolCall({
                toolName: 'find_symbol',
                arguments: {
                    name_path: 'MyClass',
                    file_path: 'src/model.ts',
                },
                result: 'Found class definition at line 10',
            }),
        ];

        const audit = buildInvestigationAudit(calls, undefined);

        expect(audit.symbolsResolved).toHaveLength(1);
        expect(audit.symbolsResolved[0]).toEqual({
            name: 'MyClass',
            file: 'src/model.ts',
            kind: 'class',
        });
    });

    it('filters out find_symbol entries when no file_path is available', () => {
        const calls: ToolCallRecord[] = [
            makeToolCall({
                toolName: 'find_symbol',
                arguments: { name_path: 'foo' },
                result: 'function foo()',
            }),
        ];

        const audit = buildInvestigationAudit(calls, undefined);
        expect(audit.symbolsResolved).toHaveLength(0);
    });

    it('builds usage entries from find_usages calls', () => {
        const calls: ToolCallRecord[] = [
            makeToolCall({
                toolName: 'find_usages',
                arguments: { symbol_name: 'getData' },
                result: 'Found 5 references',
            }),
        ];

        const audit = buildInvestigationAudit(calls, undefined);

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

        const audit = buildInvestigationAudit(calls, undefined);

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
                arguments: { name_path: 'init', file_path: 'src/main.ts' },
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

        const audit = buildInvestigationAudit(calls, undefined);
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
                arguments: { name_path: 'x', file_path: 'a.ts' },
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

        const audit = buildInvestigationAudit(calls, undefined);
        expect(audit.depthScores.get('a.ts')!.score).toBeLessThanOrEqual(10);
    });

    it('flattens nested tool calls', () => {
        const calls: ToolCallRecord[] = [
            makeToolCall({
                toolName: 'run_subagent_batch',
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
                            name_path: 'nestedFn',
                            file_path: 'src/nested.ts',
                        },
                        result: 'function nestedFn()',
                    }),
                ],
            }),
        ];

        const audit = buildInvestigationAudit(calls, undefined);

        expect(audit.filesRead).toHaveLength(1);
        expect(audit.filesRead[0].path).toBe('src/nested.ts');
        expect(audit.symbolsResolved).toHaveLength(1);
        expect(audit.symbolsResolved[0].name).toBe('nestedFn');
    });

    it('handles deeply nested tool calls', () => {
        const calls: ToolCallRecord[] = [
            makeToolCall({
                toolName: 'run_subagent_batch',
                nestedCalls: [
                    makeToolCall({
                        toolName: 'run_subagent_batch',
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

        const audit = buildInvestigationAudit(calls, undefined);
        expect(audit.filesRead).toHaveLength(1);
        expect(audit.filesRead[0].path).toBe('deep.ts');
    });
});

describe('normalizeRelativePath', () => {
    it('returns empty string for empty input', () => {
        expect(normalizeRelativePath('')).toBe('');
    });

    it("returns empty string for '.'", () => {
        expect(normalizeRelativePath('.')).toBe('');
    });

    it('strips leading ./', () => {
        expect(normalizeRelativePath('./src/foo.ts')).toBe('src/foo.ts');
    });

    it('converts backslashes to forward slashes', () => {
        expect(normalizeRelativePath('src\\foo.ts')).toBe('src/foo.ts');
    });

    it('collapses double slashes', () => {
        expect(normalizeRelativePath('src//foo.ts')).toBe('src/foo.ts');
    });

    it('resolves parent traversal in the middle', () => {
        expect(normalizeRelativePath('src/bar/../foo.ts')).toBe('src/foo.ts');
    });

    it("preserves lone '..' (no parent to resolve)", () => {
        expect(normalizeRelativePath('..')).toBe('..');
    });

    it('strips trailing slash from directory paths', () => {
        expect(normalizeRelativePath('src/foo/')).toBe('src/foo');
    });

    it('handles complex combo of normalizations', () => {
        expect(normalizeRelativePath('./src\\bar//../baz//file.ts')).toBe(
            'src/baz/file.ts'
        );
    });

    it('strips Windows drive letter prefix', () => {
        expect(normalizeRelativePath('C:\\Users\\src\\file.ts')).toBe(
            'Users/src/file.ts'
        );
        expect(normalizeRelativePath('D:/projects/app/index.ts')).toBe(
            'projects/app/index.ts'
        );
    });
});

describe('formatCompactAudit', () => {
    it('returns empty string for empty audit', () => {
        const audit = buildInvestigationAudit([], undefined);
        expect(formatCompactAudit(audit)).toBe('');
    });

    it('formats stats for populated audit', () => {
        const records = [
            makeToolCall({
                toolName: 'read_file',
                arguments: { file_path: 'src/foo.ts' },
                result: 'file contents',
            }),
            makeToolCall({
                toolName: 'get_file_diff',
                arguments: { file_paths: ['src/foo.ts'] },
                result: '+ added line',
            }),
        ];
        const audit = buildInvestigationAudit(records, undefined);
        const result = formatCompactAudit(audit);

        expect(result).toContain('files');
        expect(result).toContain('depth');
        expect(result.length).toBeGreaterThan(0);
    });
});

describe('buildInvestigationAudit preFlattened', () => {
    it('uses preFlattened records when provided', () => {
        const toolCalls: ToolCallRecord[] = [];
        const preFlattened = [
            makeToolCall({
                toolName: 'read_file',
                arguments: { file_path: 'src/bar.ts' },
                result: 'bar contents',
            }),
        ];

        const audit = buildInvestigationAudit(toolCalls, preFlattened);

        expect(audit.filesRead.length).toBe(1);
        expect(audit.filesRead[0]!.path).toBe('src/bar.ts');
    });

    it('falls back to flattenToolCalls when preFlattened is empty array', () => {
        const records = [
            makeToolCall({
                toolName: 'read_file',
                arguments: { file_path: 'src/bar.ts' },
                result: 'bar file contents',
            }),
        ];

        const audit = buildInvestigationAudit(records, []);

        // Empty preFlattened should be treated as undefined, falling back to flattenToolCalls
        expect(audit.filesRead.length).toBe(1);
        expect(audit.filesRead[0]!.path).toBe('src/bar.ts');
    });

    it('excludes failed tool calls from all extractions', () => {
        // Error messages deliberately include zero-result phrases combined with
        // timeout/failure indicators, so isZeroResultCall's timeout guard is
        // actually exercised (without it, these would be misclassified as
        // valid zero-result investigations and included instead of excluded).
        const records = [
            makeToolCall({
                toolName: 'read_file',
                arguments: { file_path: 'src/foo.ts' },
                result: undefined as unknown as string,
                error: 'Error: timeout',
                success: false,
            }),
            makeToolCall({
                toolName: 'find_symbol',
                arguments: {
                    name_path: 'myFunc',
                    relative_path: 'src/foo.ts',
                },
                result: undefined as unknown as string,
                error: "Symbol 'myFunc' not found - search timed out",
                success: false,
            }),
            makeToolCall({
                toolName: 'find_usages',
                arguments: { symbol_name: 'myFunc', file_path: 'src/foo.ts' },
                result: undefined as unknown as string,
                error: 'No usages found - request timed out',
                success: false,
            }),
            makeToolCall({
                toolName: 'search_for_pattern',
                arguments: { pattern: 'myFunc' },
                result: undefined as unknown as string,
                error: 'No matches found - search timed out',
                success: false,
            }),
            makeToolCall({
                toolName: 'get_file_diff',
                arguments: { file_paths: ['src/foo.ts'] },
                result: undefined as unknown as string,
                error: 'Error: diff failed',
                success: false,
            }),
        ];

        const audit = buildInvestigationAudit(records, undefined);

        expect(audit.filesRead).toHaveLength(0);
        expect(audit.symbolsResolved).toHaveLength(0);
        expect(audit.usagesChecked).toHaveLength(0);
        expect(audit.patternsSearched).toHaveLength(0);
        expect(audit.diffsExamined).toHaveLength(0);
    });
});

describe('zero-result tool calls count toward depth', () => {
    it('counts find_symbol zero-result calls as symbol resolutions', () => {
        const calls: ToolCallRecord[] = [
            makeToolCall({
                toolName: 'find_symbol',
                arguments: {
                    name_path: 'MissingClass',
                    file_path: 'src/foo.ts',
                },
                success: false,
                error: "Symbol 'MissingClass' not found in src/foo.ts",
            }),
        ];

        const audit = buildInvestigationAudit(calls, undefined);

        expect(audit.symbolsResolved).toHaveLength(1);
        expect(audit.symbolsResolved[0]).toEqual({
            name: 'MissingClass',
            file: 'src/foo.ts',
            kind: 'unknown',
        });
        expect(audit.depthScores.get('src/foo.ts')).toBeDefined();
        expect(audit.depthScores.get('src/foo.ts')!.score).toBeGreaterThan(0);
    });

    it('counts find_usages zero-result calls as usage checks', () => {
        const calls: ToolCallRecord[] = [
            makeToolCall({
                toolName: 'find_usages',
                arguments: { symbol_name: 'deprecatedFn' },
                success: false,
                error: 'No usages found for deprecatedFn',
            }),
        ];

        const audit = buildInvestigationAudit(calls, undefined);

        expect(audit.usagesChecked).toHaveLength(1);
        expect(audit.usagesChecked[0]).toEqual({
            symbol: 'deprecatedFn',
            referenceCount: 0,
        });
    });

    it('counts search_for_pattern zero-result calls as pattern searches', () => {
        const calls: ToolCallRecord[] = [
            makeToolCall({
                toolName: 'search_for_pattern',
                arguments: { pattern: 'dangerouslySetInnerHTML' },
                success: false,
                error: "No matches found for pattern 'dangerouslySetInnerHTML'",
            }),
        ];

        const audit = buildInvestigationAudit(calls, undefined);

        expect(audit.patternsSearched).toHaveLength(1);
        expect(audit.patternsSearched[0]).toEqual({
            query: 'dangerouslySetInnerHTML',
            matchCount: 0,
        });
    });

    it('does NOT count genuine failures as zero-result investigations', () => {
        const calls: ToolCallRecord[] = [
            makeToolCall({
                toolName: 'find_symbol',
                arguments: { name_path: 'Foo', file_path: 'src/bar.ts' },
                success: false,
                error: 'Timeout exceeded',
            }),
            makeToolCall({
                toolName: 'find_usages',
                arguments: { symbol_name: 'bar' },
                success: false,
                error: 'Request failed: rate limited',
            }),
            makeToolCall({
                toolName: 'search_for_pattern',
                arguments: { pattern: 'baz' },
                success: false,
                error: 'Search service unavailable',
            }),
        ];

        const audit = buildInvestigationAudit(calls, undefined);

        expect(audit.symbolsResolved).toHaveLength(0);
        expect(audit.usagesChecked).toHaveLength(0);
        expect(audit.patternsSearched).toHaveLength(0);
    });

    it('does NOT count find_symbol timeout with no-results phrasing as zero-result', () => {
        const calls: ToolCallRecord[] = [
            makeToolCall({
                toolName: 'find_symbol',
                arguments: { name_path: 'X', file_path: 'src/foo.ts' },
                success: false,
                error: "Symbol 'X' search timed out with no results",
            }),
        ];

        const audit = buildInvestigationAudit(calls, undefined);

        expect(audit.symbolsResolved).toHaveLength(0);
    });

    it('does NOT count find_symbol truncated search as zero-result', () => {
        const calls: ToolCallRecord[] = [
            makeToolCall({
                toolName: 'find_symbol',
                arguments: { name_path: 'Foo', file_path: 'src/bar.ts' },
                success: false,
                error: "Symbol 'Foo' not found in searched files (search was limited due to file count)",
            }),
        ];

        const audit = buildInvestigationAudit(calls, undefined);

        expect(audit.symbolsResolved).toHaveLength(0);
    });

    it('counts zero-result when symbol name contains timeout keyword', () => {
        const calls: ToolCallRecord[] = [
            makeToolCall({
                toolName: 'find_usages',
                arguments: {
                    symbol_name: 'handleTimeout',
                    file_path: 'src/server.ts',
                },
                success: false,
                error: "No usages found for symbol 'handleTimeout' in file src/server.ts",
            }),
        ];

        const audit = buildInvestigationAudit(calls, undefined);

        expect(audit.usagesChecked).toHaveLength(1);
    });

    it('counts zero-result when pattern contains timeout keyword', () => {
        const calls: ToolCallRecord[] = [
            makeToolCall({
                toolName: 'search_for_pattern',
                arguments: { pattern: 'connectionTimeout' },
                success: false,
                error: "No matches found for pattern 'connectionTimeout'",
            }),
        ];

        const audit = buildInvestigationAudit(calls, undefined);

        expect(audit.patternsSearched).toHaveLength(1);
    });

    it('counts zero-result when symbol name contains truncat keyword', () => {
        const calls: ToolCallRecord[] = [
            makeToolCall({
                toolName: 'find_symbol',
                arguments: {
                    name_path: 'TruncatedResponse',
                    file_path: 'src/types.ts',
                },
                success: false,
                error: "Symbol 'TruncatedResponse' not found in searched files",
            }),
        ];

        const audit = buildInvestigationAudit(calls, undefined);

        expect(audit.symbolsResolved).toHaveLength(1);
    });

    it('zero-result find_usages contributes to depth when combined with symbol resolution', () => {
        const calls: ToolCallRecord[] = [
            makeToolCall({
                toolName: 'read_file',
                arguments: {
                    file_path: 'src/api.ts',
                    start_line: 1,
                    end_line: 50,
                },
            }),
            makeToolCall({
                toolName: 'find_symbol',
                arguments: {
                    name_path: 'handleRequest',
                    file_path: 'src/api.ts',
                },
                result: 'function handleRequest()',
            }),
            makeToolCall({
                toolName: 'find_usages',
                arguments: { symbol_name: 'handleRequest' },
                success: false,
                error: 'No usages found for handleRequest',
            }),
        ];

        const audit = buildInvestigationAudit(calls, undefined);
        const depth = audit.depthScores.get('src/api.ts');

        expect(depth).toBeDefined();
        // read(2) + symbols(2) + usages(2) = 6
        expect(depth!.score).toBe(6);
        expect(depth!.breakdown).toContain('usages');
    });
});
