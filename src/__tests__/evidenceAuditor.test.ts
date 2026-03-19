import { describe, it, expect } from 'vitest';
import {
    EvidenceAuditor,
    extractClaimedToolNames,
    extractFilesFromArgs,
} from '../services/evidenceAuditor';
import type { RecordedFinding } from '../types/findingTypes';
import type { ToolCallRecord } from '../types/toolCallTypes';

function createTestFinding(
    overrides: Partial<RecordedFinding> = {}
): RecordedFinding {
    return {
        id: 'f1',
        agentId: 'agent1',
        timestamp: Date.now(),
        severity: 'HIGH',
        category: 'logic_error',
        title: 'Test finding',
        file: 'src/foo.ts',
        lineRange: [10, 20],
        description: 'Found issue in the code',
        affectedComponent: 'someFunction()',
        failureMechanism: 'wrong_return_value',
        supportingToolCalls: [],
        disproof: {
            attempted: true,
            method: 'Checked if intentional',
            result: 'Not disproved',
        },
        verifiableClaims: [],
        lspValidation: undefined,
        ...overrides,
    };
}

function createToolCallRecord(
    overrides: Partial<ToolCallRecord> = {}
): ToolCallRecord {
    return {
        id: `tc-${Math.random().toString(36).slice(2, 8)}`,
        toolName: 'read_file',
        arguments: { file_path: 'src/foo.ts' },
        result: 'file contents...',
        success: true,
        error: undefined,
        durationMs: 50,
        timestamp: Date.now(),
        ...overrides,
    };
}

describe('EvidenceAuditor', () => {
    const auditor = new EvidenceAuditor();

    describe('audit()', () => {
        it('keeps finding with matching tool calls on file', () => {
            const findings = [
                createTestFinding({
                    description: 'Found issue via read_file and find_usages',
                    disproof: {
                        attempted: true,
                        method: 'Checked callers with find_usages',
                        result: 'Not disproved',
                    },
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src/foo.ts' },
                }),
                createToolCallRecord({
                    toolName: 'find_usages',
                    arguments: { file_path: 'src/foo.ts', symbol_name: 'bar' },
                }),
                createToolCallRecord({
                    toolName: 'get_file_diff',
                    arguments: { file_paths: ['src/foo.ts'] },
                }),
            ];

            const result = auditor.audit(findings, records);

            expect(result.kept).toBe(1);
            expect(result.dropped).toBe(0);
            expect(result.entries[0]!.verdict).toBe('keep');
        });

        it('keeps finding when claimed tool not called but file was investigated', () => {
            const findings = [
                createTestFinding({
                    description: 'find_usages showed no callers',
                    disproof: {
                        attempted: true,
                        method: 'Used find_usages to verify',
                        result: 'Confirmed',
                    },
                }),
            ];
            // Only read_file was called, but finding claims find_usages.
            // Since the file WAS investigated (read_file), this is misattribution not fabrication.
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src/foo.ts' },
                }),
            ];

            const result = auditor.audit(findings, records);

            expect(result.kept).toBe(0);
            expect(result.downgraded).toBe(1);
            expect(result.entries[0]!.verdict).toBe('downgrade');
        });

        it('drops finding when claimed tools never called and file not investigated', () => {
            const findings = [
                createTestFinding({
                    file: 'src/bar.ts',
                    description: 'find_usages showed no callers on src/bar.ts',
                    disproof: {
                        attempted: true,
                        method: 'Used find_usages to verify',
                        result: 'Confirmed',
                    },
                }),
            ];
            // No tools called on src/bar.ts at all
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src/foo.ts' },
                }),
            ];

            const result = auditor.audit(findings, records);

            expect(result.dropped).toBe(1);
            expect(result.entries[0]!.verdict).toBe('drop');
            expect(result.entries[0]!.reason).toContain('Fabricated evidence');
            expect(result.entries[0]!.reason).toContain('find_usages');
        });

        it('keeps finding when claimed tool was called on wrong file but file was investigated', () => {
            const findings = [
                createTestFinding({
                    file: 'src/foo.ts',
                    description:
                        'read_file and find_usages confirmed the issue',
                }),
            ];
            // find_usages was called but on a different file; read_file was on the right file
            // Since the file WAS investigated (read_file matched), this is misattribution
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src/foo.ts' },
                }),
                createToolCallRecord({
                    toolName: 'find_usages',
                    arguments: {
                        file_path: 'src/other.ts',
                        symbol_name: 'bar',
                    },
                }),
            ];

            const result = auditor.audit(findings, records);

            // File was investigated via read_file — not fabricated, just misattributed
            expect(result.entries[0]!.verdict).not.toBe('drop');
        });

        it('downgrades CRITICAL finding with only one investigation tool type', () => {
            const findings = [
                createTestFinding({
                    severity: 'CRITICAL',
                    description: 'Critical bug found via read_file',
                    disproof: {
                        attempted: true,
                        method: 'Read the file',
                        result: 'Not disproved',
                    },
                }),
            ];
            // Only read_file was used (single tool type)
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src/foo.ts' },
                }),
            ];

            const result = auditor.audit(findings, records);

            expect(result.downgraded).toBe(1);
            expect(result.entries[0]!.verdict).toBe('downgrade');
            expect(result.entries[0]!.reason).toContain('depth score');
        });

        it('downgrades HIGH finding with no deep investigation tools', () => {
            const findings = [
                createTestFinding({
                    severity: 'HIGH',
                    description: 'Issue in the diff',
                    disproof: {
                        attempted: true,
                        method: 'Looked at diff',
                        result: 'Not disproved',
                    },
                }),
            ];
            // Only get_file_diff was used (shallow tool)
            const records = [
                createToolCallRecord({
                    toolName: 'get_file_diff',
                    arguments: { file_paths: ['src/foo.ts'] },
                }),
            ];

            const result = auditor.audit(findings, records);

            expect(result.downgraded).toBe(1);
            expect(result.entries[0]!.verdict).toBe('downgrade');
            expect(result.entries[0]!.reason).toContain('depth score');
        });

        it('keeps HIGH finding with ≥2 different deep tool types', () => {
            const findings = [
                createTestFinding({
                    severity: 'HIGH',
                    description: 'Used read_file and find_usages to confirm',
                    disproof: {
                        attempted: true,
                        method: 'Checked with find_usages',
                        result: 'Not disproved',
                    },
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src/foo.ts' },
                }),
                createToolCallRecord({
                    toolName: 'find_usages',
                    arguments: { file_path: 'src/foo.ts', symbol_name: 'x' },
                }),
                createToolCallRecord({
                    toolName: 'get_file_diff',
                    arguments: { file_paths: ['src/foo.ts'] },
                }),
            ];

            const result = auditor.audit(findings, records);

            expect(result.kept).toBe(1);
            expect(result.entries[0]!.verdict).toBe('keep');
        });

        it('keeps MEDIUM finding with only one tool type', () => {
            const findings = [
                createTestFinding({
                    severity: 'MEDIUM',
                    description: 'Found via read_file',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src/foo.ts' },
                }),
            ];

            const result = auditor.audit(findings, records);

            expect(result.kept).toBe(1);
        });

        it('keeps LOW finding with only one tool type', () => {
            const findings = [
                createTestFinding({
                    severity: 'LOW',
                    description: 'Minor issue found via read_file',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src/foo.ts' },
                }),
            ];

            const result = auditor.audit(findings, records);

            expect(result.kept).toBe(1);
        });

        it('populates supportingToolCalls with matching record IDs', () => {
            const findings = [
                createTestFinding({
                    description: 'read_file and find_usages confirmed',
                    disproof: {
                        attempted: true,
                        method: 'Used find_usages to verify',
                        result: 'Confirmed',
                    },
                }),
            ];
            const records = [
                createToolCallRecord({
                    id: 'tc-1',
                    toolName: 'read_file',
                    arguments: { file_path: 'src/foo.ts' },
                }),
                createToolCallRecord({
                    id: 'tc-2',
                    toolName: 'find_usages',
                    arguments: { file_path: 'src/foo.ts', symbol_name: 'x' },
                }),
                createToolCallRecord({
                    id: 'tc-3',
                    toolName: 'read_file',
                    arguments: { file_path: 'src/other.ts' },
                }),
            ];

            auditor.audit(findings, records);

            expect(findings[0]!.supportingToolCalls).toEqual(['tc-1', 'tc-2']);
        });

        it('handles multiple findings independently', () => {
            const findings = [
                createTestFinding({
                    id: 'f1',
                    file: 'src/foo.ts',
                    description: 'read_file and find_usages confirmed',
                    disproof: {
                        attempted: true,
                        method: 'Used find_usages to check',
                        result: 'OK',
                    },
                }),
                createTestFinding({
                    id: 'f2',
                    file: 'src/bar.ts',
                    severity: 'CRITICAL',
                    description: 'Only read the diff',
                    disproof: {
                        attempted: true,
                        method: 'Looked at diff',
                        result: 'OK',
                    },
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src/foo.ts' },
                }),
                createToolCallRecord({
                    toolName: 'find_usages',
                    arguments: { file_path: 'src/foo.ts', symbol_name: 'x' },
                }),
                createToolCallRecord({
                    toolName: 'get_file_diff',
                    arguments: { file_paths: ['src/foo.ts'] },
                }),
                createToolCallRecord({
                    toolName: 'get_file_diff',
                    arguments: { file_paths: ['src/bar.ts'] },
                }),
            ];

            const result = auditor.audit(findings, records);

            expect(result.kept).toBe(1);
            expect(result.downgraded).toBe(1);
            expect(result.entries[0]!.verdict).toBe('keep');
            expect(result.entries[1]!.verdict).toBe('downgrade');
        });

        it('ignores failed tool calls when matching', () => {
            const findings = [
                createTestFinding({
                    severity: 'MEDIUM',
                    description: 'read_file confirmed the issue',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src/foo.ts' },
                    success: false,
                    error: 'File not found',
                }),
            ];

            auditor.audit(findings, records);
            expect(findings[0]!.supportingToolCalls).toEqual([]);
        });

        it('matches files with path suffix (relative vs absolute)', () => {
            const findings = [
                createTestFinding({
                    file: 'src/utils/helper.ts',
                    severity: 'MEDIUM',
                    description: 'read_file showed issue',
                    disproof: {
                        attempted: true,
                        method: 'Checked the code',
                        result: 'Not disproved',
                    },
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: {
                        file_path: 'd:/project/src/utils/helper.ts',
                    },
                }),
            ];

            const result = auditor.audit(findings, records);

            expect(result.kept).toBe(1);
            expect(findings[0]!.supportingToolCalls.length).toBe(1);
        });

        it('uses verificationEvidence field when available', () => {
            const findings = [
                createTestFinding({
                    file: 'src/unvisited.ts',
                    description: 'Some generic description',
                    verificationEvidence:
                        'find_usages confirmed no callers for handleClick',
                    disproof: {
                        attempted: true,
                        method: 'Thought about it',
                        result: 'OK',
                    },
                }),
            ];
            // No tools called on src/unvisited.ts at all → fabricated
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src/other.ts' },
                }),
            ];

            const result = auditor.audit(findings, records);

            expect(result.dropped).toBe(1);
            expect(result.entries[0]!.reason).toContain('find_usages');
        });

        it('handles finding with no evidence text mentioning tools', () => {
            const findings = [
                createTestFinding({
                    severity: 'MEDIUM',
                    description: 'This function has a bug',
                    disproof: {
                        attempted: true,
                        method: 'Tried to disprove',
                        result: 'Could not',
                    },
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src/foo.ts' },
                }),
            ];

            const result = auditor.audit(findings, records);

            // No claimed tools → no fabrication check → passes
            // MEDIUM severity → no deep investigation depth requirement
            expect(result.kept).toBe(1);
        });

        it('returns correct summary counts', () => {
            const findings = [
                createTestFinding({ id: 'f1', severity: 'MEDIUM' }),
                createTestFinding({
                    id: 'f2',
                    severity: 'CRITICAL',
                    file: 'src/bar.ts',
                    description: 'read_file only',
                }),
                createTestFinding({
                    id: 'f3',
                    severity: 'HIGH',
                    file: 'src/baz.ts',
                    description: 'find_usages confirmed the issue',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src/foo.ts' },
                }),
                createToolCallRecord({
                    toolName: 'find_usages',
                    arguments: { file_path: 'src/foo.ts', symbol_name: 'x' },
                }),
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src/bar.ts' },
                }),
                // No tools for src/baz.ts → find_usages claim is fabricated
            ];

            const result = auditor.audit(findings, records);

            expect(result.kept).toBe(1); // f1: MEDIUM with read_file + find_usages
            expect(result.downgraded).toBe(1); // f2: CRITICAL with only read_file
            expect(result.dropped).toBe(1); // f3: claimed find_usages but file never investigated
            expect(result.entries.length).toBe(3);
        });

        it('drops finding when deletion language + zero-reference evidence present', () => {
            const findings = [
                createTestFinding({
                    title: 'Unused function deleted',
                    description:
                        'The function handleClick was deleted but callers may break',
                    verificationEvidence:
                        'find_usages showed the function is no longer referenced',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src/foo.ts' },
                }),
                createToolCallRecord({
                    toolName: 'find_usages',
                    arguments: {
                        file_path: 'src/foo.ts',
                        symbol_name: 'handleClick',
                    },
                    result: '0 results found for handleClick',
                }),
            ];

            const result = auditor.audit(findings, records);

            expect(result.dropped).toBe(1);
            expect(result.entries[0]!.verdict).toBe('drop');
            expect(result.entries[0]!.reason).toContain('Deletion safety');
        });

        it('drops finding when "removed" language + "no references" in tool result', () => {
            const findings = [
                createTestFinding({
                    severity: 'MEDIUM',
                    title: 'Helper function removed',
                    description:
                        'The helper was removed but may still be imported elsewhere',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src/foo.ts' },
                }),
                createToolCallRecord({
                    toolName: 'find_usages',
                    arguments: {
                        file_path: 'src/foo.ts',
                        symbol_name: 'helper',
                    },
                    result: 'No results found',
                }),
            ];

            const result = auditor.audit(findings, records);

            expect(result.dropped).toBe(1);
            expect(result.entries[0]!.reason).toContain('Deletion safety');
        });

        it('keeps finding with deletion language but callers found', () => {
            const findings = [
                createTestFinding({
                    description:
                        'The function was deleted but callers depend on it',
                    verificationEvidence: 'find_usages confirmed callers exist',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src/foo.ts' },
                }),
                createToolCallRecord({
                    toolName: 'find_usages',
                    arguments: { file_path: 'src/foo.ts', symbol_name: 'fn' },
                    result: '3 references found in src/bar.ts, src/baz.ts',
                }),
                createToolCallRecord({
                    toolName: 'find_symbol',
                    arguments: { file_path: 'src/foo.ts', symbol_name: 'fn' },
                }),
                createToolCallRecord({
                    toolName: 'get_file_diff',
                    arguments: { file_paths: ['src/foo.ts'] },
                }),
            ];

            const result = auditor.audit(findings, records);

            expect(result.kept).toBe(1);
            expect(result.entries[0]!.verdict).toBe('keep');
        });

        it('keeps finding without deletion language even if zero references', () => {
            const findings = [
                createTestFinding({
                    description: 'The function has a null pointer bug',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src/foo.ts' },
                }),
                createToolCallRecord({
                    toolName: 'find_usages',
                    arguments: { file_path: 'src/foo.ts', symbol_name: 'fn' },
                    result: '0 results',
                }),
            ];

            const result = auditor.audit(findings, records);

            expect(result.entries[0]!.verdict).not.toBe('drop');
        });

        it('keeps test-coverage findings even with deletion language and zero references', () => {
            const findings = [
                createTestFinding({
                    title: 'Coverage gap: tests removed',
                    description:
                        'Tool thinking tests were deleted, reducing test coverage',
                    file: 'src/__tests__/thinkTool.test.ts',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'find_usages',
                    arguments: {
                        file_path: 'src/__tests__/thinkTool.test.ts',
                        symbol_name: 'thinkTool',
                    },
                    result: '0 results found',
                }),
            ];

            const result = auditor.audit(findings, records);

            // Test-coverage findings should NOT be dropped by deletion-safety
            expect(result.entries[0]!.verdict).not.toBe('drop');
        });

        it('counts global search_for_pattern results as supporting evidence', () => {
            const findings = [
                createTestFinding({
                    severity: 'LOW',
                    file: 'src/utils/helper.ts',
                    description: 'search_for_pattern found the issue',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'search_for_pattern',
                    arguments: { pattern: 'helper', code_files_only: true },
                    result: 'src/utils/helper.ts:42: export function helper() {',
                }),
            ];

            const result = auditor.audit(findings, records);

            // search_for_pattern result mentions the file → counts as evidence
            expect(result.entries[0]!.actualToolsOnFile).toContain(
                'search_for_pattern'
            );
            expect(result.kept).toBe(1);
        });

        it('does not extract non-investigation tools from evidence text', () => {
            const findings = [
                createTestFinding({
                    severity: 'MEDIUM',
                    file: 'src/unvisited.ts',
                    description:
                        'validate_claim and think confirmed the issue, also used retract_finding',
                }),
            ];
            const records: ToolCallRecord[] = [];

            const result = auditor.audit(findings, records);

            // Non-investigation tools should not trigger fabrication drops
            expect(result.entries[0]!.claimedTools).toEqual([]);
            // No investigation tools used → depth downgrade, not fabrication drop
            expect(result.entries[0]!.verdict).not.toBe('drop');
        });
    });
});

describe('extractClaimedToolNames', () => {
    it('extracts tool names from evidence text', () => {
        const text =
            'Used read_file to check src/foo.ts, then find_usages(bar) showed 3 callers';
        expect(extractClaimedToolNames(text)).toEqual(
            expect.arrayContaining(['read_file', 'find_usages'])
        );
    });

    it('handles tool names with parentheses', () => {
        const text = 'find_usages(handleClick) returned 3 callers';
        expect(extractClaimedToolNames(text)).toContain('find_usages');
    });

    it('handles tool names with spaces instead of underscores', () => {
        const text = 'Used find usages to check callers';
        expect(extractClaimedToolNames(text)).toContain('find_usages');
    });

    it('returns empty array for text without tool names', () => {
        const text = 'I found a bug in the code';
        expect(extractClaimedToolNames(text)).toEqual([]);
    });

    it('returns empty array for empty/null text', () => {
        expect(extractClaimedToolNames('')).toEqual([]);
    });

    it('does not match partial tool names', () => {
        const text = 'The pattern search was inconclusive';
        // Should not match "search_for_pattern" from "search"
        expect(extractClaimedToolNames(text)).toEqual([]);
    });

    it('extracts multiple distinct tool names', () => {
        const text =
            'read_file showed the code, find_symbol found the definition, find_usages verified it';
        const tools = extractClaimedToolNames(text);
        expect(tools).toContain('read_file');
        expect(tools).toContain('find_symbol');
        expect(tools).toContain('find_usages');
    });
});

describe('extractFilesFromArgs', () => {
    it('extracts file_path argument', () => {
        expect(extractFilesFromArgs({ file_path: 'src/foo.ts' })).toEqual([
            'src/foo.ts',
        ]);
    });

    it('extracts file argument', () => {
        expect(extractFilesFromArgs({ file: 'src/foo.ts' })).toEqual([
            'src/foo.ts',
        ]);
    });

    it('extracts file_paths array', () => {
        expect(
            extractFilesFromArgs({
                file_paths: ['src/foo.ts', 'src/bar.ts'],
            })
        ).toEqual(['src/foo.ts', 'src/bar.ts']);
    });

    it('extracts relative_path argument', () => {
        expect(
            extractFilesFromArgs({ relative_path: 'src/components' })
        ).toEqual(['src/components']);
    });

    it('ignores "." as relative_path', () => {
        expect(extractFilesFromArgs({ relative_path: '.' })).toEqual([]);
    });

    it('handles multiple argument types', () => {
        const files = extractFilesFromArgs({
            file_path: 'src/a.ts',
            file: 'src/b.ts',
        });
        expect(files).toContain('src/a.ts');
        expect(files).toContain('src/b.ts');
    });

    it('returns empty array for args with no file-like keys', () => {
        expect(extractFilesFromArgs({ pattern: 'foo' })).toEqual([]);
    });
});
