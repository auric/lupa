import { describe, it, expect } from 'vitest';
import {
    EvidenceAuditor,
    extractClaimedToolNames,
    extractFilesFromArgs,
    extractPrimaryIdentifier,
    aggregateToolOutputText,
    isZeroResultCall,
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

/**
 * Default result includes 'someFunction' to match the default affectedComponent
 * in createTestFinding. This prevents the claim-vs-output check from
 * triggering spuriously in tests that don't focus on cross-referencing.
 */
function createToolCallRecord(
    overrides: Partial<ToolCallRecord> = {}
): ToolCallRecord {
    return {
        id: `tc-${Math.random().toString(36).slice(2, 8)}`,
        toolName: 'read_file',
        arguments: { file_path: 'src/foo.ts' },
        result: 'function someFunction() { return true; }',
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

        it('downgrades finding when claimed tool not called but file was investigated', () => {
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

        it('does not treat tool names in title as fabrication claims', () => {
            const findings = [
                createTestFinding({
                    file: 'src/foo.ts',
                    title: 'read_file confirmed the bug',
                    description:
                        'The function has an issue with error handling',
                    severity: 'MEDIUM',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'find_symbol',
                    arguments: {
                        symbol_name: 'someFunction',
                        relative_path: 'src/other.ts',
                    },
                    result: 'function someFunction() { return true; }',
                }),
            ];

            const result = auditor.audit(findings, records);

            // Title contains 'read_file' but title is excluded from fabrication detection
            // No tools on src/foo.ts → depth downgrade, not fabrication drop
            expect(result.entries[0]!.verdict).toBe('downgrade');
        });

        it('downgrades finding when claimed tool was called on wrong file but file was investigated', () => {
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
            expect(result.entries[0]!.verdict).toBe('downgrade');
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

            const result = auditor.audit(findings, records);
            expect(findings[0]!.supportingToolCalls).toEqual([]);
            // Failed call excluded → no tools on file → read_file claim is fabricated → drop
            expect(result.entries[0]!.verdict).toBe('drop');
        });

        it('includes zero-result tool calls as supporting evidence', () => {
            const findings = [
                createTestFinding({
                    severity: 'MEDIUM',
                    file: 'src/foo.ts',
                    description: 'find_usages confirmed no callers',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src/foo.ts' },
                }),
                createToolCallRecord({
                    id: 'tc-zero',
                    toolName: 'find_usages',
                    arguments: {
                        file_path: 'src/foo.ts',
                        symbol_name: 'someFunction',
                    },
                    success: false,
                    error: 'No usages found for someFunction',
                    result: undefined as unknown as string,
                }),
                createToolCallRecord({
                    toolName: 'get_file_diff',
                    arguments: { file_paths: ['src/foo.ts'] },
                    result: '+ someFunction change',
                }),
            ];

            const result = auditor.audit(findings, records);

            // Zero-result find_usages should be included as supporting evidence
            expect(findings[0]!.supportingToolCalls).toContain('tc-zero');
            expect(result.entries[0]!.actualToolsOnFile).toContain(
                'find_usages'
            );
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
            expect(result.weakEvidence).toBe(0);
            expect(result.entries.length).toBe(3);
        });

        it('counts weak-evidence in summary', () => {
            const findings = [
                createTestFinding({
                    file: 'src/foo.ts',
                    title: 'Missing return type',
                    affectedComponent: 'doesNotExistAnywhere()',
                    severity: 'MEDIUM',
                }),
                createTestFinding({
                    file: 'src/bar.ts',
                    title: 'Unused variable',
                    affectedComponent: 'actualFunction()',
                    severity: 'MEDIUM',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src/foo.ts' },
                    result: 'export function otherThing() {}',
                }),
                createToolCallRecord({
                    toolName: 'get_file_diff',
                    arguments: { file_paths: ['src/foo.ts'] },
                    result: '+ export function otherThing() {}',
                }),
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src/bar.ts' },
                    result: 'function actualFunction() { return 42; }',
                }),
                createToolCallRecord({
                    toolName: 'get_file_diff',
                    arguments: { file_paths: ['src/bar.ts'] },
                    result: '+ function actualFunction() { return 42; }',
                }),
            ];

            const result = auditor.audit(findings, records);

            expect(result.weakEvidence).toBe(1);
            expect(result.kept).toBe(1);
            expect(
                result.entries.filter((e) => e.verdict === 'weak-evidence')
            ).toHaveLength(1);
            expect(
                result.entries.filter((e) => e.verdict === 'keep')
            ).toHaveLength(1);
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
                    success: false,
                    error: '0 results found for handleClick',
                    result: undefined as unknown as string,
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
                    success: false,
                    error: 'No results found',
                    result: undefined as unknown as string,
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
                    severity: 'MEDIUM',
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
                    success: false,
                    error: '0 results',
                    result: undefined as unknown as string,
                }),
            ];

            const result = auditor.audit(findings, records);

            expect(result.entries[0]!.verdict).toBe('keep');
        });

        it('does not false-drop when title has deletion language but finding is not about deletion', () => {
            const findings = [
                createTestFinding({
                    severity: 'HIGH',
                    title: 'Dropped parameter in processOrder breaks callers',
                    affectedComponent: 'processOrder()',
                    description:
                        'The processOrder function signature changed, removing the discount parameter',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src/foo.ts' },
                    result: 'function processOrder(items) { return items.length; }',
                }),
                createToolCallRecord({
                    toolName: 'find_usages',
                    arguments: {
                        file_path: 'src/foo.ts',
                        symbol_name: 'processOrder',
                    },
                    result: '3 references found in checkout.ts, cart.ts',
                }),
                createToolCallRecord({
                    toolName: 'get_file_diff',
                    arguments: { file_paths: ['src/foo.ts'] },
                    result: '- function processOrder(items, discount)\n+ function processOrder(items)',
                }),
            ];

            const result = auditor.audit(findings, records);

            // Should NOT be dropped: although title says "Dropped", find_usages found references
            expect(result.entries[0]!.verdict).toBe('keep');
            expect(result.dropped).toBe(0);
        });

        it('keeps test-coverage findings even with deletion language and zero references', () => {
            const findings = [
                createTestFinding({
                    severity: 'MEDIUM',
                    title: 'Coverage gap: tests removed',
                    description:
                        'Tool thinking tests were deleted, reducing test coverage',
                    file: 'src/__tests__/thinkTool.test.ts',
                    affectedComponent: 'thinkTool()',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src/__tests__/thinkTool.test.ts' },
                    result: 'describe("thinkTool", () => { it("works", () => {}) });',
                }),
                createToolCallRecord({
                    toolName: 'find_usages',
                    arguments: {
                        file_path: 'src/__tests__/thinkTool.test.ts',
                        symbol_name: 'thinkTool',
                    },
                    success: false,
                    error: '0 results found',
                    result: undefined as unknown as string,
                }),
                createToolCallRecord({
                    toolName: 'get_file_diff',
                    arguments: {
                        file_paths: ['src/__tests__/thinkTool.test.ts'],
                    },
                    result: '- describe("thinkTool", ...) removed tests',
                }),
            ];

            const result = auditor.audit(findings, records);

            // Test-coverage findings should NOT be dropped by deletion-safety
            expect(result.entries[0]!.verdict).toBe('keep');
        });

        it('does not drop findings about untested code even with deletion language', () => {
            const findings = [
                createTestFinding({
                    severity: 'HIGH',
                    title: 'Removed validation is now untested',
                    affectedComponent: 'validateInput()',
                    description:
                        'The validateInput function was removed but the untested code path remains',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src/foo.ts' },
                    result: 'function validateInput() { return true; }',
                }),
                createToolCallRecord({
                    toolName: 'find_usages',
                    arguments: {
                        file_path: 'src/foo.ts',
                        symbol_name: 'validateInput',
                    },
                    success: false,
                    error: '0 results found',
                    result: undefined as unknown as string,
                }),
                createToolCallRecord({
                    toolName: 'get_file_diff',
                    arguments: { file_paths: ['src/foo.ts'] },
                    result: '- validateInput removed',
                }),
            ];

            const result = auditor.audit(findings, records);

            // "untested" triggers isTestCoverageFinding → deletion safety skipped
            expect(result.entries[0]!.verdict).not.toBe('drop');
        });

        it('does not drop findings about test coverage gaps even with deletion language', () => {
            const findings = [
                createTestFinding({
                    severity: 'HIGH',
                    title: 'Removed function causes coverage gap',
                    affectedComponent: 'helperFunc()',
                    description:
                        'The deleted helper function leaves a coverage gap in the test suite',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src/foo.ts' },
                    result: 'function helperFunc() { return true; }',
                }),
                createToolCallRecord({
                    toolName: 'find_symbol',
                    arguments: {
                        file_path: 'src/foo.ts',
                        symbol_name: 'helperFunc',
                    },
                    success: false,
                    error: '0 results found',
                    result: undefined as unknown as string,
                }),
                createToolCallRecord({
                    toolName: 'get_file_diff',
                    arguments: { file_paths: ['src/foo.ts'] },
                    result: '- helperFunc deleted',
                }),
            ];

            const result = auditor.audit(findings, records);

            // "coverage gap" triggers isTestCoverageFinding → deletion safety skipped
            expect(result.entries[0]!.verdict).not.toBe('drop');
        });

        it('drops deletion finding when find_symbol returns zero results', () => {
            const findings = [
                createTestFinding({
                    severity: 'HIGH',
                    title: 'someFunction was deleted',
                    affectedComponent: 'someFunction()',
                    description: 'someFunction was removed from the codebase',
                    verificationEvidence:
                        'Used find_symbol to check for remaining references',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src/foo.ts' },
                    result: 'function someFunction() { return true; }',
                }),
                createToolCallRecord({
                    toolName: 'find_symbol',
                    arguments: {
                        file_path: 'src/foo.ts',
                        symbol_name: 'someFunction',
                    },
                    success: false,
                    error: '0 results found',
                    result: undefined as unknown as string,
                }),
                createToolCallRecord({
                    toolName: 'get_file_diff',
                    arguments: { file_paths: ['src/foo.ts'] },
                    result: '- function someFunction() { return true; }',
                }),
            ];

            const result = auditor.audit(findings, records);

            expect(result.entries[0]!.verdict).toBe('drop');
            expect(result.entries[0]!.reason).toContain('Deletion safety');
        });

        it('keeps deletion finding when only some reference tools show zero results', () => {
            const findings = [
                createTestFinding({
                    severity: 'MEDIUM',
                    title: 'processOrder was removed',
                    affectedComponent: 'processOrder()',
                    description: 'processOrder was deleted from the codebase',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src/foo.ts' },
                    result: 'function processOrder() { return true; }',
                }),
                createToolCallRecord({
                    toolName: 'find_symbol',
                    arguments: {
                        file_path: 'src/foo.ts',
                        symbol_name: 'processOrder',
                    },
                    success: false,
                    error: 'not found',
                    result: undefined as unknown as string,
                }),
                createToolCallRecord({
                    toolName: 'find_usages',
                    arguments: {
                        file_path: 'src/foo.ts',
                        symbol_name: 'processOrder',
                    },
                    result: 'src/routes/api.ts:15: processOrder(req)',
                }),
                createToolCallRecord({
                    toolName: 'get_file_diff',
                    arguments: { file_paths: ['src/foo.ts'] },
                    result: '- function processOrder() { return true; }',
                }),
            ];

            const result = auditor.audit(findings, records);

            // find_usages found callers → deletion NOT safe → should NOT be dropped
            expect(result.entries[0]!.verdict).not.toBe('drop');
        });

        it('keeps finding with deletion language when no reference tools were called', () => {
            const findings = [
                createTestFinding({
                    severity: 'MEDIUM',
                    title: 'Helper function was removed',
                    description:
                        'The deprecated helper was deleted from the codebase',
                    affectedComponent: 'deprecatedHelper()',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src/foo.ts' },
                    result: 'function deprecatedHelper() { return true; }',
                }),
                createToolCallRecord({
                    toolName: 'get_file_diff',
                    arguments: { file_paths: ['src/foo.ts'] },
                    result: '- function deprecatedHelper() {}',
                }),
            ];

            const result = auditor.audit(findings, records);

            // No find_usages or find_symbol called → deletion safety can't confirm zero refs → should NOT drop
            expect(result.entries[0]!.verdict).not.toBe('drop');
        });

        it('does not treat multi-digit counts as zero references in deletion safety', () => {
            const findings = [
                createTestFinding({
                    file: 'src/utils.ts',
                    severity: 'MEDIUM',
                    title: 'Deprecated function removed',
                    description: 'The deprecated utility was deleted',
                    affectedComponent: 'deprecatedUtil()',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src/utils.ts' },
                    result: 'function deprecatedUtil() { return true; }',
                }),
                createToolCallRecord({
                    toolName: 'find_usages',
                    arguments: {
                        file_path: 'src/utils.ts',
                        symbol_name: 'deprecatedUtil',
                    },
                    result: '10 results found across the codebase',
                }),
                createToolCallRecord({
                    toolName: 'get_file_diff',
                    arguments: { file_paths: ['src/utils.ts'] },
                    result: '- function deprecatedUtil() { return true; }',
                }),
            ];

            const result = auditor.audit(findings, records);

            // "10 results" should NOT match zero-reference patterns
            // Finding should be kept (references exist, deletion is potentially unsafe)
            expect(result.entries[0]!.verdict).toBe('keep');
        });

        it('excludes reverse-phrased no-caller findings from contradiction check', () => {
            const findings = [
                createTestFinding({
                    file: 'src/utils/handler.ts',
                    title: 'References do not exist for handleRequest',
                    description:
                        'The callers of handleRequest do not exist in the codebase',
                    affectedComponent: 'handleRequest()',
                    severity: 'MEDIUM',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src/utils/handler.ts' },
                    result: 'function handleRequest() { return true; }',
                }),
                createToolCallRecord({
                    toolName: 'find_usages',
                    arguments: {
                        file_path: 'src/utils/handler.ts',
                        symbol_name: 'handleRequest',
                    },
                    success: false,
                    error: 'No usages found',
                    result: undefined as unknown as string,
                }),
                createToolCallRecord({
                    toolName: 'get_file_diff',
                    arguments: { file_paths: ['src/utils/handler.ts'] },
                    result: '+ function handleRequest() {}',
                }),
            ];

            const result = auditor.audit(findings, records);

            // Title "References do not exist for handleRequest" matches NO_CALLERS_REVERSE_PATTERN
            // via "references do not exist" → skip contradiction check
            expect(result.entries[0]!.verdict).toBe('keep');
        });

        it('drops fabricated finding when only search_for_pattern matches (no file-targeted tools)', () => {
            const findings = [
                createTestFinding({
                    severity: 'MEDIUM',
                    file: 'src/utils/helper.ts',
                    description: 'read_file confirmed the issue',
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

            // read_file was claimed but only search_for_pattern was called on file
            // search_for_pattern is NOT a file-targeted tool → fabrication not waived
            expect(result.entries[0]!.verdict).toBe('drop');
            expect(result.entries[0]!.reason).toContain('Fabricated evidence');
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

        it('does not match search_for_pattern by bare filename (prevents false evidence from same-named files)', () => {
            const findings = [
                createTestFinding({
                    severity: 'MEDIUM',
                    file: 'src/utils/helper.ts',
                    description: 'search_for_pattern found issue',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'search_for_pattern',
                    arguments: { pattern: 'helper', code_files_only: true },
                    // Result mentions a DIFFERENT helper.ts, not the finding's file
                    result: 'src/other/helper.ts:10: export function helper() {',
                }),
            ];

            const result = auditor.audit(findings, records);

            // search_for_pattern result mentions different path → NOT supporting evidence
            expect(result.entries[0]!.actualToolsOnFile).not.toContain(
                'search_for_pattern'
            );
        });

        it('does not match search_for_pattern result for path prefix (foo.ts vs foo.tsx)', () => {
            const findings = [
                createTestFinding({
                    file: 'src/foo.ts',
                    affectedComponent: 'someFunction()',
                    severity: 'HIGH',
                    verificationEvidence:
                        'Used search_for_pattern to find usages',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'search_for_pattern',
                    arguments: { pattern: 'something' },
                    result: 'src/foo.tsx:10: const x = something;',
                }),
            ];

            const result = auditor.audit(findings, records);

            // search_for_pattern matched foo.tsx, NOT foo.ts — should NOT count as evidence
            expect(result.entries[0]!.verdict).toBe('drop');
        });

        it('rejects search_for_pattern result when finding path is a suffix of another path', () => {
            const findings = [
                createTestFinding({
                    file: 'bar.ts',
                    affectedComponent: 'someFunction()',
                    severity: 'HIGH',
                    verificationEvidence:
                        'Used search_for_pattern to find usages',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'search_for_pattern',
                    arguments: { pattern: 'something' },
                    result: 'foobar.ts:10: const x = something;',
                }),
            ];

            const result = auditor.audit(findings, records);

            // 'bar.ts' is a suffix of 'foobar.ts' — should NOT match
            expect(result.entries[0]!.verdict).toBe('drop');
        });

        it('matches file path at end of search result string', () => {
            const findings = [
                createTestFinding({
                    file: 'src/utils/parser.ts',
                    severity: 'HIGH',
                    title: 'Parser lacks validation',
                    description: 'The parser does not validate input',
                    affectedComponent: 'parseInput()',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'search_for_pattern',
                    arguments: { pattern: 'parseInput' },
                    result: 'Found in src/utils/parser.ts',
                }),
                createToolCallRecord({
                    toolName: 'get_file_diff',
                    arguments: { file_paths: ['src/utils/parser.ts'] },
                    result: '+ function parseInput() {}',
                }),
            ];

            const result = auditor.audit(findings, records);

            // File path at end of string (no trailing boundary char) should still match
            expect(
                result.entries[0]!.supportingToolCallIds.length
            ).toBeGreaterThanOrEqual(1);
            expect(result.entries[0]!.verdict).toBe('keep');
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
            expect(result.entries[0]!.verdict).toBe('downgrade');
        });

        it('matches search_for_pattern results with ./ prefix in tool output', () => {
            const findings = [
                createTestFinding({
                    severity: 'LOW',
                    file: 'src/foo.ts',
                    description: 'search_for_pattern found the issue',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'search_for_pattern',
                    arguments: { pattern: 'something', code_files_only: true },
                    result: './src/foo.ts:10: some match',
                }),
            ];

            const result = auditor.audit(findings, records);

            expect(result.entries[0]!.actualToolsOnFile).toContain(
                'search_for_pattern'
            );
            expect(result.kept).toBe(1);
        });

        it('matches when finding file has ./ prefix', () => {
            const findings = [
                createTestFinding({
                    severity: 'LOW',
                    file: './src/foo.ts',
                    description: 'search_for_pattern found the issue',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'search_for_pattern',
                    arguments: { pattern: 'something', code_files_only: true },
                    result: 'src/foo.ts:10: match',
                }),
            ];

            const result = auditor.audit(findings, records);

            expect(result.entries[0]!.actualToolsOnFile).toContain(
                'search_for_pattern'
            );
            expect(result.kept).toBe(1);
        });

        it('matches tool calls with ./ prefix in file arguments', () => {
            const findings = [
                createTestFinding({
                    file: 'src/foo.ts',
                    affectedComponent: 'someFunction()',
                    severity: 'MEDIUM',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: './src/foo.ts' },
                    result: 'function someFunction() { return true; }',
                }),
                createToolCallRecord({
                    toolName: 'get_file_diff',
                    arguments: { file_paths: ['./src/foo.ts'] },
                    result: '+ someFunction change',
                }),
            ];

            const result = auditor.audit(findings, records);

            expect(result.entries[0]!.verdict).toBe('keep');
            expect(
                result.entries[0]!.supportingToolCallIds.length
            ).toBeGreaterThan(0);
        });

        it('matches tool calls with Windows backslash paths', () => {
            const findings = [
                createTestFinding({
                    file: 'src/utils/handler.ts',
                    affectedComponent: 'someFunction()',
                    severity: 'MEDIUM',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src\\utils\\handler.ts' },
                    result: 'function someFunction() { return true; }',
                }),
                createToolCallRecord({
                    toolName: 'get_file_diff',
                    arguments: { file_paths: ['src/utils/handler.ts'] },
                    result: '+ function someFunction() { return true; }',
                }),
            ];

            const result = auditor.audit(findings, records);

            expect(result.entries[0]!.verdict).toBe('keep');
            expect(
                result.entries[0]!.supportingToolCallIds.length
            ).toBeGreaterThan(0);
        });

        it('does not double-extract tool names when disproof result equals method', () => {
            const findings = [
                createTestFinding({
                    file: 'src/foo.ts',
                    title: 'Issue in module',
                    description: 'The module has a problem',
                    severity: 'MEDIUM',
                    disproof: {
                        attempted: true,
                        method: 'Used find_symbol to check',
                        result: 'Used find_symbol to check',
                    },
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src/foo.ts' },
                    result: 'function someFunction() { return true; }',
                }),
                createToolCallRecord({
                    toolName: 'get_file_diff',
                    arguments: { file_paths: ['src/foo.ts'] },
                    result: '+ function someFunction() { return true; }',
                }),
                createToolCallRecord({
                    toolName: 'find_symbol',
                    arguments: {
                        symbol_name: 'someFunction',
                        relative_path: 'src/foo.ts',
                    },
                    result: 'symbol info',
                }),
            ];

            const result = auditor.audit(findings, records);

            // find_symbol is mentioned in disproof and exists in records — should be fine
            expect(result.entries[0]!.verdict).toBe('keep');
        });

        it('attributes subagent-nested tool calls as supporting evidence', () => {
            const findings = [
                createTestFinding({
                    file: 'src/foo.ts',
                    affectedComponent: 'someFunction()',
                    severity: 'HIGH',
                }),
            ];
            const records: ToolCallRecord[] = [
                {
                    id: 'outer-1',
                    toolName: 'run_subagent_batch',
                    arguments: { tasks: ['investigate foo'] },
                    result: 'completed',
                    success: true,
                    error: undefined,
                    durationMs: 5000,
                    timestamp: Date.now(),
                    nestedCalls: [
                        {
                            id: 'inner-1',
                            toolName: 'read_file',
                            arguments: { file_path: 'src/foo.ts' },
                            result: 'function someFunction() { return true; }',
                            success: true,
                            error: undefined,
                            durationMs: 50,
                            timestamp: Date.now(),
                        },
                        {
                            id: 'inner-2',
                            toolName: 'find_usages',
                            arguments: {
                                file_path: 'src/foo.ts',
                                symbol_name: 'someFunction',
                            },
                            result: '3 references found',
                            success: true,
                            error: undefined,
                            durationMs: 100,
                            timestamp: Date.now(),
                        },
                    ],
                },
                createToolCallRecord({
                    toolName: 'get_file_diff',
                    arguments: { file_paths: ['src/foo.ts'] },
                    result: '+ someFunction update',
                }),
            ];

            const result = auditor.audit(findings, records);

            expect(result.entries[0]!.verdict).toBe('keep');
            expect(result.entries[0]!.supportingToolCallIds).toContain(
                'inner-1'
            );
            expect(result.entries[0]!.supportingToolCallIds).toContain(
                'inner-2'
            );
            expect(result.entries[0]!.actualToolsOnFile).toContain('read_file');
            expect(result.entries[0]!.actualToolsOnFile).toContain(
                'find_usages'
            );
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

    it('handles path argument', () => {
        expect(extractFilesFromArgs({ path: 'src/components' })).toEqual([
            'src/components',
        ]);
    });

    it('ignores "." as relative_path', () => {
        expect(extractFilesFromArgs({ relative_path: '.' })).toEqual([]);
    });

    it('filters out "." from file_path argument', () => {
        const result = extractFilesFromArgs({ file_path: '.' });
        expect(result).toEqual([]);
    });

    it('filters out "." from file_paths array', () => {
        const result = extractFilesFromArgs({
            file_paths: ['.', 'src/foo.ts'],
        });
        expect(result).toEqual(['src/foo.ts']);
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

describe('extractPrimaryIdentifier', () => {
    it('extracts function name from simple identifier', () => {
        expect(extractPrimaryIdentifier('processOrder')).toBe('processOrder');
    });

    it('strips trailing parentheses', () => {
        expect(extractPrimaryIdentifier('handleClick()')).toBe('handleClick');
    });

    it('strips trailing parentheses with arguments', () => {
        expect(extractPrimaryIdentifier('processOrder(order)')).toBe(
            'processOrder'
        );
    });

    it('returns undefined when last dotted part is single char', () => {
        expect(extractPrimaryIdentifier('A.x')).toBeUndefined();
    });

    it('extracts last part of dotted path', () => {
        expect(extractPrimaryIdentifier('MyClass.myMethod')).toBe('myMethod');
    });

    it('handles dotted path with trailing parens', () => {
        expect(extractPrimaryIdentifier('OrderService.processOrder()')).toBe(
            'processOrder'
        );
    });

    it('returns undefined for empty/undefined input', () => {
        expect(extractPrimaryIdentifier(undefined)).toBeUndefined();
        expect(extractPrimaryIdentifier('')).toBeUndefined();
    });

    it('returns undefined for single-char identifier', () => {
        expect(extractPrimaryIdentifier('x')).toBeUndefined();
    });

    it('returns undefined for two-char identifier', () => {
        expect(extractPrimaryIdentifier('fn')).toBeUndefined();
    });

    it('returns undefined when last segment after dot split is too short', () => {
        expect(extractPrimaryIdentifier('Foo.ab')).toBeUndefined();
        expect(extractPrimaryIdentifier('Module.xy')).toBeUndefined();
    });
});

describe('aggregateToolOutputText', () => {
    it('concatenates string results from successful calls', () => {
        const calls = [
            createToolCallRecord({ result: 'output one' }),
            createToolCallRecord({ result: 'output two' }),
        ];
        const text = aggregateToolOutputText(calls);
        expect(text).toContain('output one');
        expect(text).toContain('output two');
    });

    it('excludes failed calls', () => {
        const calls = [
            createToolCallRecord({ result: 'good output', success: true }),
            createToolCallRecord({
                result: 'bad output',
                success: false,
                error: 'failed',
            }),
        ];
        const text = aggregateToolOutputText(calls);
        expect(text).toContain('good output');
        expect(text).not.toContain('bad output');
    });

    it('excludes non-string results', () => {
        const calls = [
            createToolCallRecord({ result: 'text result' }),
            createToolCallRecord({
                result: { key: 'value' } as unknown as string,
            }),
        ];
        const text = aggregateToolOutputText(calls);
        expect(text).toContain('text result');
        expect(text).not.toContain('key');
    });

    it('returns empty string when no calls', () => {
        expect(aggregateToolOutputText([])).toBe('');
    });

    it('includes error text from zero-result calls', () => {
        const calls = [
            createToolCallRecord({ result: 'good output', success: true }),
            createToolCallRecord({
                toolName: 'find_usages',
                success: false,
                error: 'No usages found for symbol',
                result: undefined as unknown as string,
            }),
        ];
        const text = aggregateToolOutputText(calls);
        expect(text).toContain('good output');
        expect(text).toContain('No usages found for symbol');
    });

    it('excludes error text from real errors (not zero-result)', () => {
        const calls = [
            createToolCallRecord({ result: 'good output', success: true }),
            createToolCallRecord({
                toolName: 'find_usages',
                success: false,
                error: 'Timeout: operation took too long',
                result: undefined as unknown as string,
            }),
        ];
        const text = aggregateToolOutputText(calls);
        expect(text).toContain('good output');
        expect(text).not.toContain('Timeout');
    });
});

describe('isZeroResultCall', () => {
    it('returns true for find_usages with zero-result error', () => {
        const tc = createToolCallRecord({
            toolName: 'find_usages',
            success: false,
            error: 'No usages found for symbol',
            result: undefined as unknown as string,
        });
        expect(isZeroResultCall(tc)).toBe(true);
    });

    it('returns true for find_symbol with not-found error', () => {
        const tc = createToolCallRecord({
            toolName: 'find_symbol',
            success: false,
            error: 'Symbol not found',
            result: undefined as unknown as string,
        });
        expect(isZeroResultCall(tc)).toBe(true);
    });

    it('returns true for search_for_pattern with no matches error', () => {
        const tc = createToolCallRecord({
            toolName: 'search_for_pattern',
            success: false,
            error: 'No matches found for pattern',
            result: undefined as unknown as string,
        });
        expect(isZeroResultCall(tc)).toBe(true);
    });

    it('returns false for successful calls', () => {
        const tc = createToolCallRecord({
            toolName: 'find_usages',
            success: true,
            result: '3 references found',
        });
        expect(isZeroResultCall(tc)).toBe(false);
    });

    it('returns false for real errors (timeout)', () => {
        const tc = createToolCallRecord({
            toolName: 'find_usages',
            success: false,
            error: 'Operation timed out after 5000ms',
            result: undefined as unknown as string,
        });
        expect(isZeroResultCall(tc)).toBe(false);
    });

    it('returns false for non-zero-result tools', () => {
        const tc = createToolCallRecord({
            toolName: 'read_file',
            success: false,
            error: 'File not found',
            result: undefined as unknown as string,
        });
        expect(isZeroResultCall(tc)).toBe(false);
    });

    it('returns false when error is empty', () => {
        const tc = createToolCallRecord({
            toolName: 'find_usages',
            success: false,
            error: '',
            result: undefined as unknown as string,
        });
        expect(isZeroResultCall(tc)).toBe(false);
    });

    it('returns false when error is undefined', () => {
        const tc = createToolCallRecord({
            toolName: 'find_usages',
            success: false,
            error: undefined,
            result: undefined as unknown as string,
        });
        expect(isZeroResultCall(tc)).toBe(false);
    });
});

describe('EvidenceAuditor — claim-vs-output cross-referencing', () => {
    const auditor = new EvidenceAuditor();

    it('flags weak-evidence when primary identifier not in any tool output', () => {
        const findings = [
            createTestFinding({
                severity: 'HIGH',
                affectedComponent: 'processOrder()',
                description: 'processOrder has a critical bug',
            }),
        ];
        const records = [
            createToolCallRecord({
                toolName: 'read_file',
                arguments: { file_path: 'src/foo.ts' },
                result: 'function handleClick() { return null; }',
            }),
            createToolCallRecord({
                toolName: 'find_usages',
                arguments: {
                    file_path: 'src/foo.ts',
                    symbol_name: 'handleClick',
                },
                result: '3 references found',
            }),
            createToolCallRecord({
                toolName: 'get_file_diff',
                arguments: { file_paths: ['src/foo.ts'] },
                result: '+ added line\n- removed line',
            }),
        ];

        const result = auditor.audit(findings, records);

        expect(result.weakEvidence).toBe(1);
        expect(result.entries[0]!.verdict).toBe('weak-evidence');
        expect(result.entries[0]!.reason).toContain('processOrder');
        expect(result.entries[0]!.reason).toContain(
            'not found in any tool output'
        );
    });

    it('keeps finding when primary identifier IS in tool output', () => {
        const findings = [
            createTestFinding({
                severity: 'HIGH',
                affectedComponent: 'processOrder()',
                description: 'processOrder has a critical bug',
            }),
        ];
        const records = [
            createToolCallRecord({
                toolName: 'read_file',
                arguments: { file_path: 'src/foo.ts' },
                result: 'export function processOrder(order: Order) { return order.items; }',
            }),
            createToolCallRecord({
                toolName: 'find_usages',
                arguments: {
                    file_path: 'src/foo.ts',
                    symbol_name: 'processOrder',
                },
                result: '3 references found',
            }),
            createToolCallRecord({
                toolName: 'get_file_diff',
                arguments: { file_paths: ['src/foo.ts'] },
                result: '+ added line',
            }),
        ];

        const result = auditor.audit(findings, records);

        expect(result.kept).toBe(1);
        expect(result.entries[0]!.verdict).toBe('keep');
    });

    it('keeps finding when primary identifier found in tool output', () => {
        const findings = [
            createTestFinding({
                severity: 'HIGH',
                affectedComponent: 'handleError()',
                description: 'handleError does not log',
            }),
        ];
        const records = [
            createToolCallRecord({
                toolName: 'find_usages',
                arguments: {
                    file_path: 'src/foo.ts',
                    symbol_name: 'handleError',
                },
                result: '2 references found in upstream.ts',
            }),
            createToolCallRecord({
                toolName: 'read_file',
                arguments: { file_path: 'src/foo.ts' },
                result: 'export function handleError(e: Error) { console.log(e); }',
            }),
            createToolCallRecord({
                toolName: 'get_file_diff',
                arguments: { file_paths: ['src/foo.ts'] },
                result: '+ new code here',
            }),
        ];

        const result = auditor.audit(findings, records);

        expect(result.entries[0]!.verdict).toBe('keep');
    });

    it('flags weak-evidence when identifier appears only in tool arguments, not output', () => {
        const findings = [
            createTestFinding({
                severity: 'HIGH',
                affectedComponent: 'processOrder()',
                description:
                    'processOrder has a critical flaw in its implementation',
            }),
        ];
        const records = [
            createToolCallRecord({
                toolName: 'find_usages',
                arguments: {
                    file_path: 'src/foo.ts',
                    symbol_name: 'processOrder',
                },
                success: false,
                error: '0 results found',
                result: undefined as unknown as string,
            }),
            createToolCallRecord({
                toolName: 'read_file',
                arguments: { file_path: 'src/foo.ts' },
                result: 'export function doStuff() { return 1; }',
            }),
            createToolCallRecord({
                toolName: 'get_file_diff',
                arguments: { file_paths: ['src/foo.ts'] },
                result: '+ doStuff update',
            }),
        ];

        const result = auditor.audit(findings, records);

        // Tool was called WITH the identifier but output doesn't contain it
        // → should flag as weak-evidence (argument-only evidence is insufficient)
        expect(result.weakEvidence).toBe(1);
        expect(result.entries[0]!.verdict).toBe('weak-evidence');
        expect(result.entries[0]!.reason).toContain(
            'not found in any tool output'
        );
    });

    it('skips weak-evidence check for LOW severity findings', () => {
        const findings = [
            createTestFinding({
                severity: 'LOW',
                affectedComponent: 'unusedHelper()',
                description: 'unusedHelper is not documented',
            }),
        ];
        const records = [
            createToolCallRecord({
                toolName: 'read_file',
                arguments: { file_path: 'src/foo.ts' },
                result: 'function other() { return 1; }',
            }),
        ];

        const result = auditor.audit(findings, records);

        expect(result.entries[0]!.verdict).toBe('keep');
    });

    it('downgrades MEDIUM finding with no tool calls via depth check', () => {
        const findings = [
            createTestFinding({
                severity: 'MEDIUM',
                file: 'src/unvisited.ts',
                affectedComponent: 'missingFunc()',
                description: 'missingFunc is broken',
            }),
        ];
        const records: ToolCallRecord[] = [];

        const result = auditor.audit(findings, records);

        // No supporting calls → depth downgrade, not weak-evidence
        expect(result.entries[0]!.verdict).not.toBe('weak-evidence');
    });

    it('skips weak-evidence check when affectedComponent is too short', () => {
        const findings = [
            createTestFinding({
                severity: 'MEDIUM',
                affectedComponent: 'fn',
                description: 'fn is broken',
            }),
        ];
        const records = [
            createToolCallRecord({
                toolName: 'read_file',
                arguments: { file_path: 'src/foo.ts' },
                result: 'no matching identifier here',
            }),
        ];

        const result = auditor.audit(findings, records);

        // 'fn' is only 2 chars, skip the check
        expect(result.entries[0]!.verdict).not.toBe('weak-evidence');
    });

    it('flags weak-evidence when identifier absent from available string outputs', () => {
        const findings = [
            createTestFinding({
                severity: 'HIGH',
                affectedComponent: 'notInOutput()',
                description: 'notInOutput has an issue',
            }),
        ];
        const records = [
            createToolCallRecord({
                toolName: 'read_file',
                arguments: { file_path: 'src/foo.ts' },
                result: { structured: 'data' } as unknown as string,
            }),
            createToolCallRecord({
                toolName: 'find_usages',
                arguments: { file_path: 'src/foo.ts', symbol_name: 'other' },
                result: { refs: [] } as unknown as string,
            }),
            createToolCallRecord({
                toolName: 'get_file_diff',
                arguments: { file_paths: ['src/foo.ts'] },
                result: '+ some diff content',
            }),
        ];

        const result = auditor.audit(findings, records);

        // aggregateToolOutputText returns only string results, the structured ones
        // will be excluded. get_file_diff has a string result but doesn't contain
        // 'notInOutput'. So this should flag weak-evidence.
        expect(result.entries[0]!.verdict).toBe('weak-evidence');
        expect(result.entries[0]!.reason).toContain(
            'not found in any tool output'
        );
    });

    it('handles dotted affectedComponent — checks last part', () => {
        const findings = [
            createTestFinding({
                severity: 'HIGH',
                affectedComponent: 'OrderService.processOrder()',
                description: 'processOrder does not validate',
            }),
        ];
        const records = [
            createToolCallRecord({
                toolName: 'read_file',
                arguments: { file_path: 'src/foo.ts' },
                result: 'class OrderService { processOrder(data) { return data; } }',
            }),
            createToolCallRecord({
                toolName: 'find_usages',
                arguments: {
                    file_path: 'src/foo.ts',
                    symbol_name: 'processOrder',
                },
                result: '1 reference found',
            }),
            createToolCallRecord({
                toolName: 'get_file_diff',
                arguments: { file_paths: ['src/foo.ts'] },
                result: '+ something',
            }),
        ];

        const result = auditor.audit(findings, records);

        // 'processOrder' IS in the read_file output → keep
        expect(result.entries[0]!.verdict).toBe('keep');
    });

    it('does not count file_path argument matching identifier as evidence', () => {
        const findings = [
            createTestFinding({
                severity: 'HIGH',
                file: 'src/processOrder.ts',
                affectedComponent: 'processOrder()',
                description: 'processOrder has a critical bug',
            }),
        ];
        const records = [
            createToolCallRecord({
                toolName: 'read_file',
                arguments: { file_path: 'src/processOrder.ts' },
                result: 'function helper() { return 1; }',
            }),
            createToolCallRecord({
                toolName: 'find_usages',
                arguments: {
                    file_path: 'src/processOrder.ts',
                    symbol_name: 'helper',
                },
                result: '3 references found',
            }),
            createToolCallRecord({
                toolName: 'get_file_diff',
                arguments: { file_paths: ['src/processOrder.ts'] },
                result: '+ some change',
            }),
        ];

        const result = auditor.audit(findings, records);

        // file_path contains 'processOrder' but that's not a symbol argument —
        // only symbol_name, name, name_path, pattern, query count
        expect(result.entries[0]!.verdict).toBe('weak-evidence');
        expect(result.entries[0]!.reason).toContain('processOrder');
    });

    it('keeps finding when tool results are non-string (empty output text bypasses check)', () => {
        const findings = [
            createTestFinding({
                severity: 'HIGH',
                affectedComponent: 'someFunction()',
                description: 'someFunction has a bug',
            }),
        ];
        const records = [
            createToolCallRecord({
                toolName: 'read_file',
                arguments: { file_path: 'src/foo.ts' },
                result: { structured: 'data' } as unknown as string,
                success: true,
            }),
            createToolCallRecord({
                toolName: 'get_file_diff',
                arguments: { file_paths: ['src/foo.ts'] },
                result: { lines: ['+change'] } as unknown as string,
            }),
        ];

        const result = auditor.audit(findings, records);

        expect(result.entries[0]!.verdict).toBe('keep');
    });

    it('keeps finding when $-prefixed identifier appears in tool output', () => {
        const findings = [
            createTestFinding({
                severity: 'MEDIUM',
                affectedComponent: '$state()',
                description: '$state reactive declaration has a bug',
            }),
        ];
        const records = [
            createToolCallRecord({
                toolName: 'read_file',
                arguments: { file_path: 'src/foo.ts' },
                result: 'const $state = writable(0);',
            }),
            createToolCallRecord({
                toolName: 'get_file_diff',
                arguments: { file_paths: ['src/foo.ts'] },
                result: '+ const $state = writable(0);',
            }),
        ];

        const result = auditor.audit(findings, records);

        expect(result.entries[0]!.verdict).toBe('keep');
    });

    it('flags weak-evidence when $-prefixed identifier not in tool output', () => {
        const findings = [
            createTestFinding({
                severity: 'MEDIUM',
                affectedComponent: '$onClick()',
                description: '$onClick handler has a memory leak',
            }),
        ];
        const records = [
            createToolCallRecord({
                toolName: 'read_file',
                arguments: { file_path: 'src/foo.ts' },
                result: 'function handleClick() { return true; }',
            }),
            createToolCallRecord({
                toolName: 'get_file_diff',
                arguments: { file_paths: ['src/foo.ts'] },
                result: '+ function handleClick() { return true; }',
            }),
        ];

        const result = auditor.audit(findings, records);

        expect(result.entries[0]!.verdict).toBe('weak-evidence');
    });
});

describe('EvidenceAuditor — pattern-specific checks', () => {
    const auditor = new EvidenceAuditor();

    it('prefers pattern-specific reason over generic claim-vs-output reason', () => {
        const findings = [
            createTestFinding({
                severity: 'HIGH',
                title: 'Callers do not validate input to someFunction',
                affectedComponent: 'someFunction()',
                description:
                    'The callers of someFunction do not validate input',
            }),
        ];
        const records = [
            createToolCallRecord({
                toolName: 'read_file',
                arguments: { file_path: 'src/foo.ts' },
                result: 'function otherFunc() { return null; }',
            }),
            createToolCallRecord({
                toolName: 'find_usages',
                arguments: {
                    file_path: 'src/foo.ts',
                    symbol_name: 'someFunction',
                },
                success: false,
                error: '0 results found',
                result: undefined as unknown as string,
            }),
            createToolCallRecord({
                toolName: 'get_file_diff',
                arguments: { file_paths: ['src/foo.ts'] },
                result: '+ added line without relevant symbol',
            }),
        ];

        const result = auditor.audit(findings, records);

        // Pattern-specific check (caller contradiction) should fire before
        // the broader claim-vs-output check
        expect(result.entries[0]!.verdict).toBe('weak-evidence');
        expect(result.entries[0]!.reason).toContain('callers');
    });

    describe('caller claim contradiction', () => {
        it('flags weak-evidence when finding claims callers but find_usages returned zero', () => {
            const findings = [
                createTestFinding({
                    severity: 'HIGH',
                    title: 'Callers do not handle error return from someFunction',
                    affectedComponent: 'someFunction()',
                    description:
                        'The callers of someFunction ignore the error return value',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src/foo.ts' },
                    result: 'function someFunction() { return new Error("fail"); }',
                }),
                createToolCallRecord({
                    toolName: 'find_usages',
                    arguments: {
                        file_path: 'src/foo.ts',
                        symbol_name: 'someFunction',
                    },
                    success: false,
                    error: '0 results found for someFunction',
                    result: undefined as unknown as string,
                }),
                createToolCallRecord({
                    toolName: 'get_file_diff',
                    arguments: { file_paths: ['src/foo.ts'] },
                    result: '+ someFunction change',
                }),
            ];

            const result = auditor.audit(findings, records);

            expect(result.weakEvidence).toBe(1);
            expect(result.entries[0]!.verdict).toBe('weak-evidence');
            expect(result.entries[0]!.reason).toContain('callers');
            expect(result.entries[0]!.reason).toContain('zero results');
        });

        it('keeps finding when callers mentioned AND find_usages found references', () => {
            const findings = [
                createTestFinding({
                    severity: 'HIGH',
                    title: 'Callers do not handle error return from someFunction',
                    affectedComponent: 'someFunction()',
                    description:
                        'The callers of someFunction ignore the error return',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src/foo.ts' },
                    result: 'function someFunction() { return new Error("fail"); }',
                }),
                createToolCallRecord({
                    toolName: 'find_usages',
                    arguments: {
                        file_path: 'src/foo.ts',
                        symbol_name: 'someFunction',
                    },
                    result: '3 references found in caller.ts, handler.ts',
                }),
                createToolCallRecord({
                    toolName: 'get_file_diff',
                    arguments: { file_paths: ['src/foo.ts'] },
                    result: '+ someFunction updated',
                }),
            ];

            const result = auditor.audit(findings, records);

            expect(result.entries[0]!.verdict).toBe('keep');
        });

        it('keeps finding when some find_usages calls return results', () => {
            const findings = [
                createTestFinding({
                    file: 'src/utils/handler.ts',
                    title: 'Callers of handleRequest pass unvalidated input',
                    description:
                        'The callers of handleRequest skip input validation',
                    affectedComponent: 'handleRequest()',
                    severity: 'MEDIUM',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src/utils/handler.ts' },
                    result: 'function handleRequest() { return true; }',
                }),
                createToolCallRecord({
                    toolName: 'find_usages',
                    arguments: {
                        file_path: 'src/utils/handler.ts',
                        symbol_name: 'handleRequest',
                    },
                    success: false,
                    error: 'No usages found',
                    result: undefined as unknown as string,
                }),
                createToolCallRecord({
                    toolName: 'find_usages',
                    arguments: {
                        file_path: 'src/utils/handler.ts',
                        symbol_name: 'handleRequest',
                    },
                    result: 'src/routes/api.ts:15: handleRequest(req)',
                }),
            ];

            const result = auditor.audit(findings, records);

            expect(result.entries[0]!.verdict).toBe('keep');
        });

        it('skips caller check when finding says "no callers" (valid zero-ref finding)', () => {
            const findings = [
                createTestFinding({
                    severity: 'HIGH',
                    title: 'Dead code: no callers for someFunction',
                    affectedComponent: 'someFunction()',
                    description:
                        'someFunction has no callers and can be safely removed',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src/foo.ts' },
                    result: 'function someFunction() { return 1; }',
                }),
                createToolCallRecord({
                    toolName: 'find_usages',
                    arguments: {
                        file_path: 'src/foo.ts',
                        symbol_name: 'someFunction',
                    },
                    success: false,
                    error: '0 results found',
                    result: undefined as unknown as string,
                }),
                createToolCallRecord({
                    toolName: 'get_file_diff',
                    arguments: { file_paths: ['src/foo.ts'] },
                    result: '+ someFunction',
                }),
            ];

            const result = auditor.audit(findings, records);

            // "no callers" is a valid claim supported by zero results — should NOT be weak-evidence
            expect(result.entries[0]!.verdict).not.toBe('weak-evidence');
        });

        it('skips caller check for LOW severity', () => {
            const findings = [
                createTestFinding({
                    severity: 'LOW',
                    title: 'Callers ignore return value',
                    affectedComponent: 'someFunction()',
                    description: 'someFunction callers ignore the return',
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
                        symbol_name: 'someFunction',
                    },
                    success: false,
                    error: '0 results',
                    result: undefined as unknown as string,
                }),
            ];

            const result = auditor.audit(findings, records);

            expect(result.entries[0]!.verdict).toBe('keep');
        });

        it('filters find_usages calls by symbol using name_path arg key', () => {
            const findings = [
                createTestFinding({
                    file: 'src/utils/handler.ts',
                    title: 'Callers of handleRequest skip validation',
                    description:
                        'The callers of handleRequest pass unvalidated input',
                    affectedComponent: 'handleRequest()',
                    severity: 'MEDIUM',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src/utils/handler.ts' },
                    result: 'function handleRequest() { return true; }',
                }),
                createToolCallRecord({
                    toolName: 'find_usages',
                    arguments: {
                        file_path: 'src/utils/handler.ts',
                        name_path: 'handleRequest',
                    },
                    success: false,
                    error: 'No usages found',
                    result: undefined as unknown as string,
                }),
            ];

            const result = auditor.audit(findings, records);

            // find_usages with name_path arg should be recognized, empty result = zero refs
            expect(result.entries[0]!.verdict).toBe('weak-evidence');
            expect(result.entries[0]!.reason).toContain('caller');
        });

        it('does not trigger when only find_symbol (not find_usages) returned zero', () => {
            const findings = [
                createTestFinding({
                    severity: 'HIGH',
                    title: 'Callers do not handle error from someFunction',
                    affectedComponent: 'someFunction()',
                    description:
                        'The callers of someFunction ignore the error return',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src/foo.ts' },
                    result: 'function someFunction() { throw new Error("fail"); }',
                }),
                createToolCallRecord({
                    toolName: 'find_symbol',
                    arguments: {
                        file_path: 'src/foo.ts',
                        symbol_name: 'someFunction',
                    },
                    success: false,
                    error: '0 results found',
                    result: undefined as unknown as string,
                }),
                createToolCallRecord({
                    toolName: 'get_file_diff',
                    arguments: { file_paths: ['src/foo.ts'] },
                    result: '+ someFunction changed',
                }),
            ];

            const result = auditor.audit(findings, records);

            // find_symbol zero results should NOT trigger caller contradiction —
            // only find_usages is checked (conservative design)
            expect(result.entries[0]!.verdict).toBe('keep');
        });

        it('does not flag when find_usages for a different symbol returned zero', () => {
            const findings = [
                createTestFinding({
                    severity: 'HIGH',
                    title: 'Callers do not handle error return from someFunction',
                    affectedComponent: 'someFunction()',
                    description:
                        'The callers of someFunction ignore the error return value',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src/foo.ts' },
                    result: 'function someFunction() { return new Error("fail"); }',
                }),
                createToolCallRecord({
                    toolName: 'find_usages',
                    arguments: {
                        file_path: 'src/foo.ts',
                        symbol_name: 'otherFunction',
                    },
                    success: false,
                    error: '0 results found',
                    result: undefined as unknown as string,
                }),
                createToolCallRecord({
                    toolName: 'get_file_diff',
                    arguments: { file_paths: ['src/foo.ts'] },
                    result: '+ someFunction change',
                }),
            ];

            const result = auditor.audit(findings, records);

            // find_usages was for 'otherFunction', not 'someFunction' — should not trigger
            expect(result.entries[0]!.verdict).toBe('keep');
        });

        it('flags when find_usages for the same symbol returned zero', () => {
            const findings = [
                createTestFinding({
                    severity: 'HIGH',
                    title: 'Callers do not handle error return from someFunction',
                    affectedComponent: 'someFunction()',
                    description:
                        'The callers of someFunction ignore the error return value',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src/foo.ts' },
                    result: 'function someFunction() { return new Error("fail"); }',
                }),
                createToolCallRecord({
                    toolName: 'find_usages',
                    arguments: {
                        file_path: 'src/foo.ts',
                        symbol_name: 'someFunction',
                    },
                    success: false,
                    error: '0 results found for someFunction',
                    result: undefined as unknown as string,
                }),
                createToolCallRecord({
                    toolName: 'get_file_diff',
                    arguments: { file_paths: ['src/foo.ts'] },
                    result: '+ someFunction change',
                }),
            ];

            const result = auditor.audit(findings, records);

            expect(result.weakEvidence).toBe(1);
            expect(result.entries[0]!.verdict).toBe('weak-evidence');
            expect(result.entries[0]!.reason).toContain('callers');
        });

        it('skips caller check when primaryIdentifier is too short to match', () => {
            const findings = [
                createTestFinding({
                    severity: 'HIGH',
                    title: 'Callers do not handle error return',
                    affectedComponent: 'fn', // too short for extractPrimaryIdentifier
                    description:
                        'The callers of fn ignore the error return value',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src/foo.ts' },
                    result: 'function fn() { return new Error("fail"); }',
                }),
                createToolCallRecord({
                    toolName: 'find_usages',
                    arguments: {
                        file_path: 'src/foo.ts',
                        symbol_name: 'otherSymbol',
                    },
                    result: '0 results found for otherSymbol',
                }),
                createToolCallRecord({
                    toolName: 'get_file_diff',
                    arguments: { file_paths: ['src/foo.ts'] },
                    result: '+ fn change',
                }),
            ];

            const result = auditor.audit(findings, records);

            // When primaryIdentifier is undefined (too short), caller check is skipped entirely
            expect(result.weakEvidence).toBe(0);
            expect(result.entries[0]!.verdict).toBe('keep');
        });

        it('matches find_usages with dotted symbol_name against primary identifier', () => {
            const findings = [
                createTestFinding({
                    severity: 'HIGH',
                    title: 'Callers of someFunction pass invalid args',
                    affectedComponent: 'MyClass.someFunction()',
                    description:
                        'The callers of someFunction pass invalid arguments',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src/foo.ts' },
                    result: 'class MyClass { someFunction() { return true; } }',
                }),
                createToolCallRecord({
                    toolName: 'find_usages',
                    arguments: {
                        file_path: 'src/foo.ts',
                        symbol_name: 'MyClass.someFunction',
                    },
                    success: false,
                    error: '0 results found',
                    result: undefined as unknown as string,
                }),
                createToolCallRecord({
                    toolName: 'get_file_diff',
                    arguments: { file_paths: ['src/foo.ts'] },
                    result: '+ MyClass.someFunction update',
                }),
            ];

            const result = auditor.audit(findings, records);

            // symbol_name 'MyClass.someFunction' endsWith '.someFunction' → matches
            expect(result.weakEvidence).toBe(1);
            expect(result.entries[0]!.verdict).toBe('weak-evidence');
            expect(result.entries[0]!.reason).toContain('callers');
        });
    });

    describe('function body not read', () => {
        it('flags weak-evidence when behavior claim but no read_file on file', () => {
            const findings = [
                createTestFinding({
                    severity: 'MEDIUM',
                    title: 'someFunction fails to validate input',
                    affectedComponent: 'someFunction()',
                    description:
                        'someFunction does not validate the input parameter before use',
                }),
            ];
            const records = [
                // find_usages + find_symbol give depth, but no read_file/get_file_diff
                // find_symbol result does NOT contain the function name
                createToolCallRecord({
                    toolName: 'find_usages',
                    arguments: {
                        file_path: 'src/foo.ts',
                        symbol_name: 'someFunction',
                    },
                    result: '2 references found for someFunction',
                }),
                createToolCallRecord({
                    toolName: 'find_symbol',
                    arguments: {
                        file_path: 'src/foo.ts',
                        name_path: 'otherSymbol',
                    },
                    result: 'Found symbol otherSymbol at line 10',
                }),
            ];

            const result = auditor.audit(findings, records);

            expect(result.weakEvidence).toBe(1);
            expect(result.entries[0]!.verdict).toBe('weak-evidence');
            expect(result.entries[0]!.reason).toContain(
                'function name not found in read_file, diff, find_symbol, or search_for_pattern output'
            );
        });

        it('keeps finding when function visible in get_file_diff output', () => {
            const findings = [
                createTestFinding({
                    severity: 'MEDIUM',
                    title: "someFunction doesn't handle errors",
                    affectedComponent: 'someFunction()',
                    description:
                        'someFunction does not handle thrown exceptions',
                }),
            ];
            const records = [
                // No read_file call, but diff shows the function
                createToolCallRecord({
                    toolName: 'get_file_diff',
                    arguments: { file_paths: ['src/foo.ts'] },
                    result: '+ function someFunction() { try { api.call() } catch(e) { } }',
                }),
            ];

            const result = auditor.audit(findings, records);

            // Function visible in diff → body was seen → keep
            expect(result.entries[0]!.verdict).toBe('keep');
        });

        it('flags weak-evidence when behavior claim and read_file lacks function name', () => {
            const findings = [
                createTestFinding({
                    severity: 'MEDIUM',
                    title: "someFunction doesn't handle errors properly",
                    affectedComponent: 'someFunction()',
                    description:
                        'someFunction does not handle thrown exceptions',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src/foo.ts' },
                    result: 'function otherFunc() { try { } catch(e) { } }',
                }),
                createToolCallRecord({
                    toolName: 'find_usages',
                    arguments: {
                        file_path: 'src/foo.ts',
                        symbol_name: 'someFunction',
                    },
                    result: '3 references found for someFunction',
                }),
            ];

            const result = auditor.audit(findings, records);

            expect(result.entries[0]!.verdict).toBe('weak-evidence');
            expect(result.entries[0]!.reason).toContain(
                'function name not found in read_file, diff, find_symbol, or search_for_pattern output'
            );
        });

        it('keeps finding when behavior claim and read_file contains function name', () => {
            const findings = [
                createTestFinding({
                    severity: 'MEDIUM',
                    title: "someFunction doesn't handle errors properly",
                    affectedComponent: 'someFunction()',
                    description:
                        'someFunction does not handle thrown exceptions',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src/foo.ts' },
                    result: 'function someFunction() { const x = 1; return x; }',
                }),
            ];

            const result = auditor.audit(findings, records);

            expect(result.entries[0]!.verdict).toBe('keep');
        });

        it('skips function body check when title has no behavior pattern', () => {
            const findings = [
                createTestFinding({
                    severity: 'MEDIUM',
                    title: 'Unused import in file',
                    affectedComponent: 'notInOutput()',
                    description: 'The import is unused and should be removed',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src/foo.ts' },
                    result: 'import { x } from "y";',
                }),
            ];

            const result = auditor.audit(findings, records);

            // No behavior pattern match → function body check skipped
            // But claim-vs-output WILL fire because 'notInOutput' is not in tool output
            expect(result.entries[0]!.verdict).toBe('weak-evidence');
            expect(result.entries[0]!.reason).toContain('notInOutput');
        });

        it('triggers on positive-framing behavior patterns', () => {
            const findings = [
                createTestFinding({
                    severity: 'MEDIUM',
                    title: 'someFunction incorrectly handles edge case',
                    affectedComponent: 'someFunction()',
                    description:
                        'someFunction incorrectly handles the empty array edge case',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src/foo.ts' },
                    result: 'function otherFunc() { return []; }',
                }),
                // find_usages mentions someFunction so claim-vs-output passes
                createToolCallRecord({
                    toolName: 'find_usages',
                    arguments: {
                        file_path: 'src/foo.ts',
                        symbol_name: 'someFunction',
                    },
                    result: '2 references found for someFunction',
                }),
            ];

            const result = auditor.audit(findings, records);

            // "incorrectly handles" matches FUNCTION_BEHAVIOR_PATTERN (positive framing)
            // Step 7 (pattern-specific): function body check triggers —
            // someFunction NOT in read_file output → weak-evidence
            expect(result.entries[0]!.verdict).toBe('weak-evidence');
            expect(result.entries[0]!.reason).toContain(
                'function name not found in read_file, diff, find_symbol, or search_for_pattern output'
            );
        });

        it('detects gerund verb forms (handling, validating)', () => {
            const findings = [
                createTestFinding({
                    severity: 'MEDIUM',
                    title: 'No handling of edge cases in someFunction',
                    affectedComponent: 'someFunction()',
                    description: 'Missing handling leads to crashes',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src/foo.ts' },
                    result: 'function otherFunc() { return []; }',
                }),
                createToolCallRecord({
                    toolName: 'get_file_diff',
                    arguments: { file_paths: ['src/foo.ts'] },
                    result: '+ some diff content without the target function',
                }),
            ];

            const result = auditor.audit(findings, records);

            expect(result.entries[0]!.verdict).toBe('weak-evidence');
            expect(result.entries[0]!.reason).toContain('someFunction');
            expect(result.entries[0]!.reason).toContain(
                'function name not found'
            );
        });

        it('detects past tense verb forms (failed to)', () => {
            const findings = [
                createTestFinding({
                    file: 'src/auth.ts',
                    title: 'Function failed to validate token',
                    description:
                        'The authentication handler failed to validate the JWT token properly',
                    affectedComponent: 'validateToken()',
                    severity: 'MEDIUM',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'get_file_diff',
                    arguments: { file_paths: ['src/auth.ts'] },
                    result: '+ // auth module header updated',
                }),
            ];

            const result = auditor.audit(findings, records);

            expect(result.entries[0]!.verdict).toBe('weak-evidence');
            expect(result.entries[0]!.reason).toContain(
                'function name not found'
            );
        });

        it('detects function behavior claim in description when body not read', () => {
            const findings = [
                createTestFinding({
                    file: 'src/api.ts',
                    title: 'Issue in request module',
                    description:
                        'processRequest fails to validate user input before processing',
                    affectedComponent: 'processRequest()',
                    severity: 'MEDIUM',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'find_usages',
                    arguments: {
                        file_path: 'src/api.ts',
                        symbol_name: 'processRequest',
                    },
                    result: 'src/routes.ts:10: processRequest()',
                }),
                createToolCallRecord({
                    toolName: 'get_file_diff',
                    arguments: { file_paths: ['src/api.ts'] },
                    result: '+ // added a comment to the module header',
                }),
            ];

            const result = auditor.audit(findings, records);

            // Pattern matches in description, but function body not in read_file/get_file_diff output
            expect(result.entries[0]!.verdict).toBe('weak-evidence');
            expect(result.entries[0]!.reason).toContain('read_file');
        });
    });

    describe('normalizeRelativePath (via findToolCallsForFile integration)', () => {
        it('matches tool calls with ./ segments in file path', () => {
            const findings = [
                createTestFinding({
                    file: 'src/foo.ts',
                    affectedComponent: 'someFunction()',
                    severity: 'MEDIUM',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src/./foo.ts' },
                    result: 'function someFunction() { return true; }',
                }),
                createToolCallRecord({
                    toolName: 'get_file_diff',
                    arguments: { file_paths: ['src/foo.ts'] },
                    result: '+ someFunction change',
                }),
            ];

            const result = auditor.audit(findings, records);

            expect(result.entries[0]!.verdict).toBe('keep');
            expect(
                result.entries[0]!.supportingToolCallIds.length
            ).toBeGreaterThan(0);
        });

        it('matches tool calls with ../ segments in file path', () => {
            const findings = [
                createTestFinding({
                    file: 'src/foo.ts',
                    affectedComponent: 'someFunction()',
                    severity: 'MEDIUM',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src/utils/../foo.ts' },
                    result: 'function someFunction() { return true; }',
                }),
                createToolCallRecord({
                    toolName: 'get_file_diff',
                    arguments: { file_paths: ['src/foo.ts'] },
                    result: '+ someFunction change',
                }),
            ];

            const result = auditor.audit(findings, records);

            expect(result.entries[0]!.verdict).toBe('keep');
            expect(
                result.entries[0]!.supportingToolCallIds.length
            ).toBeGreaterThan(0);
        });
    });

    describe('additional pattern and evidence checks', () => {
        it('keeps finding claiming no call sites when NO_CALLERS_PATTERN matches', () => {
            const findings = [
                createTestFinding({
                    file: 'src/utils/handler.ts',
                    title: 'No call sites for handleRequest',
                    description:
                        'The function has no call sites in the codebase',
                    affectedComponent: 'handleRequest()',
                    severity: 'MEDIUM',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src/utils/handler.ts' },
                    result: 'function handleRequest() { return true; }',
                }),
                createToolCallRecord({
                    toolName: 'find_usages',
                    arguments: {
                        file_path: 'src/utils/handler.ts',
                        symbol_name: 'handleRequest',
                    },
                    success: false,
                    error: 'No usages found',
                    result: undefined as unknown as string,
                }),
            ];

            const result = auditor.audit(findings, records);

            // "no call sites" matches NO_CALLERS_PATTERN → caller contradiction check skipped → keep
            expect(result.entries[0]!.verdict).toBe('keep');
        });

        it('does not match adjective phrases as function behavior (no clear documentation)', () => {
            const findings = [
                createTestFinding({
                    file: 'src/api.ts',
                    title: 'No clear documentation for API endpoints',
                    description: 'The module lacks clear documentation',
                    affectedComponent: 'ApiModule',
                    severity: 'MEDIUM',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src/api.ts' },
                    result: 'export class ApiModule { handle() { return true; } }',
                }),
                createToolCallRecord({
                    toolName: 'get_file_diff',
                    arguments: { file_paths: ['src/api.ts'] },
                    result: '+ export class ApiModule { handle() { return true; } }',
                }),
            ];

            const result = auditor.audit(findings, records);

            // Should NOT be caught by FUNCTION_BEHAVIOR_PATTERN
            expect(result.entries[0]!.verdict).toBe('keep');
        });

        it('does not match short identifier as substring of longer word', () => {
            const findings = [
                createTestFinding({
                    file: 'src/utils.ts',
                    affectedComponent: 'get()',
                    severity: 'MEDIUM',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'src/utils.ts' },
                    result: 'function target() { return offset; }',
                }),
                createToolCallRecord({
                    toolName: 'get_file_diff',
                    arguments: { file_paths: ['src/utils.ts'] },
                    result: '+ function target() { return offset; }',
                }),
            ];

            const result = auditor.audit(findings, records);

            // "get" should NOT match inside "target" or "offset"
            expect(result.entries[0]!.verdict).toBe('weak-evidence');
            expect(result.entries[0]!.reason).toContain('not found in');
        });

        it('flags weak-evidence when function name not found in any body-reading tool output', () => {
            const findings = [
                createTestFinding({
                    file: 'src/api.ts',
                    title: 'processRequest never validates input',
                    description:
                        'processRequest does not validate the incoming request',
                    affectedComponent: 'processRequest()',
                    severity: 'MEDIUM',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'find_usages',
                    arguments: {
                        file_path: 'src/api.ts',
                        symbol_name: 'processRequest',
                    },
                    result: 'src/routes.ts:10: processRequest()',
                }),
                createToolCallRecord({
                    toolName: 'get_file_diff',
                    arguments: { file_paths: ['src/api.ts'] },
                    result: '+ // added a comment to the module header',
                }),
            ];

            const result = auditor.audit(findings, records);

            expect(result.entries[0]!.verdict).toBe('weak-evidence');
            expect(result.entries[0]!.reason).toContain(
                'function name not found in read_file'
            );
        });

        it('keeps finding when function body found via find_symbol output', () => {
            const findings = [
                createTestFinding({
                    file: 'src/api.ts',
                    title: 'processRequest never validates input',
                    description:
                        'processRequest does not validate the incoming request',
                    affectedComponent: 'processRequest()',
                    severity: 'MEDIUM',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'find_symbol',
                    arguments: {
                        symbol_name: 'processRequest',
                        relative_path: 'src/api.ts',
                    },
                    result: 'function processRequest(req: Request) { validate(req); }',
                }),
                createToolCallRecord({
                    toolName: 'get_file_diff',
                    arguments: { file_paths: ['src/api.ts'] },
                    result: '+ export { handler };',
                }),
            ];

            const result = auditor.audit(findings, records);

            // find_symbol output contains 'processRequest' → body was "read"
            expect(result.entries[0]!.verdict).toBe('keep');
        });

        it('keeps finding when function name found in search_for_pattern output', () => {
            const findings = [
                createTestFinding({
                    file: 'src/handler.ts',
                    title: 'processRequest does not validate input',
                    description:
                        'The function processRequest fails to validate',
                    affectedComponent: 'processRequest()',
                    severity: 'MEDIUM',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'search_for_pattern',
                    arguments: { pattern: 'processRequest' },
                    result: 'src/handler.ts:10: function processRequest(req: Request) { return req; }',
                }),
                createToolCallRecord({
                    toolName: 'get_file_diff',
                    arguments: { file_paths: ['src/handler.ts'] },
                    result: '+ // module updated',
                }),
            ];

            const result = auditor.audit(findings, records);

            // search_for_pattern shows function body → should not flag weak-evidence
            expect(result.entries[0]!.verdict).not.toBe('weak-evidence');
        });

        it('downgrades when no body-reading tools called on file (depth catch)', () => {
            const findings = [
                createTestFinding({
                    file: 'src/api.ts',
                    title: 'processRequest never validates input',
                    description:
                        'processRequest does not validate the incoming request',
                    affectedComponent: 'processRequest()',
                    severity: 'MEDIUM',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'find_usages',
                    arguments: {
                        file_path: 'src/api.ts',
                        symbol_name: 'processRequest',
                    },
                    result: 'src/routes.ts:10: processRequest()',
                }),
            ];

            const result = auditor.audit(findings, records);

            // Only find_usages on file → depth score 0 for MEDIUM (requires ≥2) → downgrade
            // Depth check fires before pattern-specific body check
            expect(result.entries[0]!.verdict).toBe('downgrade');
            expect(result.entries[0]!.reason).toContain('depth score');
        });
    });

    describe('getFileDepthScore suffix matching', () => {
        it('uses suffix matching when exact depth score lookup fails', () => {
            const findings = [
                createTestFinding({
                    file: 'utils/helper.ts',
                    severity: 'MEDIUM',
                    title: 'helper has issue',
                    description: 'The helper function is buggy',
                    affectedComponent: 'helperFunc()',
                }),
            ];
            const records = [
                createToolCallRecord({
                    toolName: 'read_file',
                    arguments: { file_path: 'project/src/utils/helper.ts' },
                    result: 'function helperFunc() { return true; }',
                }),
                createToolCallRecord({
                    toolName: 'get_file_diff',
                    arguments: {
                        file_paths: ['project/src/utils/helper.ts'],
                    },
                    result: '+ function helperFunc() {}',
                }),
            ];

            const result = auditor.audit(findings, records);

            // Suffix match: 'project/src/utils/helper.ts'.endsWith('/utils/helper.ts') → true
            // Depth score should be > 0, finding should not be downgraded for insufficient depth
            expect(result.entries[0]!.verdict).not.toBe('downgrade');
        });
    });
});
