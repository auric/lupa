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
            ];

            const result = auditor.audit(findings, records);

            expect(result.kept).toBe(1);
            expect(result.dropped).toBe(0);
            expect(result.entries[0]!.verdict).toBe('keep');
        });

        it('drops finding when claimed tools were never called on the file', () => {
            const findings = [
                createTestFinding({
                    description:
                        'find_usages showed no callers, validate_claim confirmed',
                    disproof: {
                        attempted: true,
                        method: 'Used validate_claim to verify',
                        result: 'Confirmed',
                    },
                }),
            ];
            // Only read_file was called, but finding claims find_usages and validate_claim
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

        it('drops finding when claimed tool was called on wrong file', () => {
            const findings = [
                createTestFinding({
                    file: 'src/foo.ts',
                    description:
                        'read_file and find_usages confirmed the issue',
                }),
            ];
            // find_usages was called but on a different file
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

            expect(result.dropped).toBe(1);
            expect(result.entries[0]!.reason).toContain('Fabricated evidence');
            expect(result.entries[0]!.reason).toContain('find_usages');
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
            expect(result.entries[0]!.reason).toContain('only read_file');
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
            expect(result.entries[0]!.reason).toContain(
                'no deep investigation tools'
            );
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
                    description: 'Some generic description',
                    verificationEvidence:
                        'validate_claim confirmed symbol_unused on handleClick',
                    disproof: {
                        attempted: true,
                        method: 'Thought about it',
                        result: 'OK',
                    },
                }),
            ];
            // validate_claim was never called on this file → fabricated
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src/foo.ts' },
                }),
            ];

            const result = auditor.audit(findings, records);

            expect(result.dropped).toBe(1);
            expect(result.entries[0]!.reason).toContain('validate_claim');
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
                    description: 'validate_claim confirmed',
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
                // No tools for src/baz.ts → validate_claim claim is fabricated
            ];

            const result = auditor.audit(findings, records);

            expect(result.kept).toBe(1); // f1: MEDIUM with read_file + find_usages
            expect(result.downgraded).toBe(1); // f2: CRITICAL with only read_file
            expect(result.dropped).toBe(1); // f3: claimed validate_claim but never called
            expect(result.entries.length).toBe(3);
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
        const text = 'validate_claim(symbol_unused, handleClick) returned true';
        expect(extractClaimedToolNames(text)).toContain('validate_claim');
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
            'read_file showed the code, find_symbol found the definition, validate_claim verified it';
        const tools = extractClaimedToolNames(text);
        expect(tools).toContain('read_file');
        expect(tools).toContain('find_symbol');
        expect(tools).toContain('validate_claim');
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
